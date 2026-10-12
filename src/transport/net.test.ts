import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { connect as netConnect, createServer, Server, Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineDictionary } from '../dictionary/define.ts';
import { resolveDictionary } from '../dictionary/resolve.ts';
import { VERSIONS } from '../version.ts';
import { checksum } from '../wire/checksum.ts';
import { buildFrame } from '../wire/frame.ts';
import { FrameSplitter } from '../wire/splitter.ts';
import { fromMessage } from '../wire/message.ts';
import { fakeClock, systemClock, type Clock } from './clock.ts';
import { connect, openSocket, parseAddress, socketLink } from './net.ts';
import type { Server as FixServer } from './api.ts';
import { listen } from './server.ts';
import { peerClose } from './sockets.ts';
import type { FixSession } from './session.ts';
import { fileStore, memoryStore } from './store.ts';
import type { ConnectionEntry, Entry, Store } from './types.ts';

// A refused or closed peer gets 200 ms, not 1 s, to close its end: many tests here wait that out on real time.
peerClose.waitMs = 200;

const clientOf = (server: FixServer, sender = 'CLIENT', extra: Record<string, unknown> = {}) =>
  connect({ host: '127.0.0.1', port: server.port }, { sender, target: 'EXCHANGE', ...extra });

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** Resolve with `promise`, or reject if it takes longer than `ms`. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const closeOf = (socket: Socket) => new Promise<void>(resolve => socket.once('close', () => resolve()));

function messageFrame(msgType: string, sender: string, target: string, seq: number, fields: Record<string, unknown>, version = 'FIX.4.4'): Buffer {
  const dict = resolveDictionary(version);
  const { fields: raw, framing } = fromMessage(msgType, {
    BeginString: version, SenderCompID: sender, TargetCompID: target, MsgSeqNum: seq, SendingTime: new Date(), ...fields,
  }, dict, { version });
  return Buffer.from(buildFrame(raw, framing));
}

function logonFrame(sender: string, target = 'EXCHANGE', extra: Record<string, unknown> = {}, version = 'FIX.4.4'): Buffer {
  return messageFrame('Logon', sender, target, 1, { EncryptMethod: 'None', HeartBtInt: 30, ...extra }, version);
}

/** A Logon frame that is whole (BodyLength and CheckSum fit) but holds a field the session can't read: it ignores the frame and keeps waiting for a Logon. */
function unreadableLogonFrame(sender: string): Buffer {
  const text = logonFrame(sender).toString('latin1');
  const bodyStart = text.indexOf('\x01', text.indexOf('\x019=') + 1) + 1;
  const body = `${text.slice(bodyStart, text.lastIndexOf('10='))}junk\x01`;
  const head = `8=FIX.4.4\x019=${body.length}\x01${body}`;
  let sum = 0;
  for (let i = 0; i < head.length; i++) sum += head.charCodeAt(i);
  return Buffer.from(`${head}10=${String(sum % 256).padStart(3, '0')}\x01`, 'latin1');
}

function rawConnect(port: number, opts: { allowHalfOpen?: boolean } = {}): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ port, host: '127.0.0.1', allowHalfOpen: opts.allowHalfOpen ?? false });
    let connected = false;
    socket.once('connect', () => { connected = true; resolve(socket); });
    socket.once('error', error => { if (!connected) reject(error); });
    // Once connected, a refusal is answered with a TCP RST: that's an expected 'error' (ECONNRESET) here,
    // not a test failure, so it must have a listener or Node treats it as an uncaught exception.
    socket.on('error', () => undefined);
  });
}

/**
 * A store whose load() waits until release() is called, so a connection can be caught mid-admission.
 * `loading` resolves once load() has been called. Also counts append() calls: a session is never supposed to
 * be created (let alone record the buffered Logon into its history) for a connection whose socket already
 * closed, so appendCount() is the reliable way to tell.
 */
function heldLoadStore() {
  const base = memoryStore();
  let appends = 0;
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const loading = new Promise<void>(resolve => { started = resolve; });
  const store: Store = {
    ...base,
    load: async (id, context) => { started(); await released; return base.load(id, context); },
    append: async (id, records, context) => { appends++; await base.append(id, records, context); },
  };
  return { store, loading, release, appendCount: () => appends };
}

/** Resolve once `condition` holds, checking after each turn of the event loop; reject if it takes longer than `ms`. */
async function waitFor(condition: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${ms} ms waiting for ${what}`);
    await tick();
  }
}

/** Watch a server's connection feed into an array. */
function feedOf(server: FixServer, options: { replay?: boolean } = {}): ConnectionEntry[] {
  const entries: ConnectionEntry[] = [];
  server.watch(entry => { entries.push(entry); }, options);
  return entries;
}

test('parseAddress', () => {
  assert.deepEqual(parseAddress('localhost:9878'), { host: 'localhost', port: 9878 });
  assert.deepEqual(parseAddress('[::1]:9878'), { host: '::1', port: 9878 });
  assert.deepEqual(parseAddress({ host: 'h', port: 1 }), { host: 'h', port: 1 });
  assert.throws(() => parseAddress('no-port'), RangeError);
});

// ─── Talking over TCP ───────────────────────────────────────────────────────

test('a client logs on to a server and they talk', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  t.after(() => server.close(), { timeout: 5_000 });
  const seen: string[] = [];
  server.on('NewOrderSingle', (message, session) => { seen.push(`${String(message.ClOrdID)} from ${session.id.target}`); });
  const client = await clientOf(server);
  const serverSide = await server.whenConnected('CLIENT');
  assert.equal(server.session('CLIENT'), serverSide);
  assert.equal(server.sessions.length, 1);
  await client.send('TestRequest', { TestReqID: 'ping' });
  assert.equal((await client.next('Heartbeat', { where: { TestReqID: 'ping' } })).TestReqID, 'ping');
  await client.send('NewOrderSingle', { ClOrdID: 'o1', Side: 'Buy', OrdType: 'Market' });
  await serverSide.next('NewOrderSingle');
  assert.deepEqual(seen, ['o1 from CLIENT']);
  await client.logout();
  assert.equal((await serverSide.closed).by, 'them');
  assert.equal(server.sessions.length, 0);
});

test('a TCP session knows its peer, its key and when it connected and logged on', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  t.after(() => server.close(), { timeout: 5_000 });
  const client = await clientOf(server);
  const serverSide = await server.whenConnected('CLIENT');
  assert.deepEqual(client.peer, { address: '127.0.0.1', port: server.port });
  assert.equal(serverSide.peer?.address, '127.0.0.1');
  assert.equal(serverSide.key, 'FIX.4.4:EXCHANGE:CLIENT');
  assert.equal(client.key, 'FIX.4.4:CLIENT:EXCHANGE');
  assert.ok(serverSide.loggedOnAt && serverSide.connectedAt <= serverSide.loggedOnAt);
  assert.notEqual(client.connectionId, serverSide.connectionId);
  await client.logout();
});

test('sequence numbers carry over to the next connection through a file store', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', store: fileStore(await mkdtemp(join(tmpdir(), 'fixjs-server-'))) });
  t.after(() => server.close(), { timeout: 5_000 });
  const clientStore = fileStore(await mkdtemp(join(tmpdir(), 'fixjs-client-')));
  const first = await clientOf(server, 'CLIENT', { store: clientStore });
  const serverSide = await server.whenConnected('CLIENT');
  await first.send('TestRequest', { TestReqID: 'one' });
  await first.next('Heartbeat');
  await first.logout();
  await serverSide.closed;
  const second = await clientOf(server, 'CLIENT', { store: clientStore });
  assert.ok(second.seqNums.next > 2, `next is ${second.seqNums.next}`);
  assert.equal(second.state, 'active');
  await second.logout();
});

const acme = defineDictionary({ fields: { DeskName: { tag: 9703 } }, messages: { NewOrderSingle: ['DeskName'] } });

test('the session hands its custom dictionary to the store', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', dictionary: acme });
  t.after(() => server.close(), { timeout: 5_000 });
  const store = fileStore(await mkdtemp(join(tmpdir(), 'fixjs-custom-')));   // no dictionary of its own
  const client = await clientOf(server, 'CLIENT', { dictionary: acme, store });
  client.outgoing(message => (message.MsgType === 'NewOrderSingle' ? null : message));
  await client.send('NewOrderSingle', { ClOrdID: 'x', Side: 'Buy', OrdType: 'Market', DeskName: 'desk1' });
  assert.equal(client.state, 'active');
  await client.logout();
  const loaded = await store.load(client.id, { dictionary: acme });
  const dropped = loaded.history.find(e => e.kind === 'message' && e.message.ClOrdID === 'x');
  assert.ok(dropped?.kind === 'message', 'the dropped custom message was stored with its frame');
  assert.equal(dropped.message.DeskName, 'desk1');
  assert.equal(dropped.bytes, undefined);
});

test('store.load() is told how much history the session keeps, on both sides', { timeout: 10_000 }, async t => {
  const contexts: { side: string; history: unknown }[] = [];
  const spy = (side: string): Store => {
    const base = memoryStore();
    return { ...base, load: (id, context) => { contexts.push({ side, history: context?.history }); return base.load(id, context); } };
  };
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', store: spy('server'), memory: { history: 7 } });
  t.after(() => server.close(), { timeout: 5_000 });
  const client = await clientOf(server, 'CLIENT', { store: spy('client'), memory: { historyBytes: 5_000 } });
  await client.logout();
  assert.deepEqual(contexts, [
    { side: 'client', history: { entries: 1_000, bytes: 5_000 } },
    { side: 'server', history: { entries: 7, bytes: 1_048_576 } },
  ]);
});

test('onHandlerError and memory options pass through to server sessions', { timeout: 10_000 }, async t => {
  const errors: unknown[] = [];
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', onHandlerError: error => errors.push(error), memory: { inbox: 5 } });
  t.after(() => server.close(), { timeout: 5_000 });
  server.on('NewOrderSingle', () => { throw new Error('boom'); });
  const client = await clientOf(server);
  const serverSide = await server.whenConnected('CLIENT');
  await client.send('NewOrderSingle', { ClOrdID: 'x', Side: 'Buy', OrdType: 'Market' });
  await serverSide.next('NewOrderSingle');
  await tick();
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as Error).message, 'boom');
  await client.logout();
});

test('server.on()\'s remover also detaches from a session that connected after on() but before remove()', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  t.after(() => server.close(), { timeout: 5_000 });
  const seen: string[] = [];
  const remove = server.on('NewOrderSingle', message => { seen.push(String(message.ClOrdID)); });
  const client = await clientOf(server);
  const serverSide = await server.whenConnected('CLIENT');
  remove();
  await client.send('NewOrderSingle', { ClOrdID: 'after-remove', Side: 'Buy', OrdType: 'Market' });
  await serverSide.next('NewOrderSingle');
  assert.deepEqual(seen, [], 'the handler must not fire once removed, even for a session that arrived after on()');
  await client.logout();
});

test('whenConnected rejects (rather than throwing) on an invalid timeout', async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  t.after(() => server.close(), { timeout: 5_000 });
  let threw = false;
  let result: Promise<unknown> | undefined;
  try {
    result = server.whenConnected('CLIENT', { timeout: 'not-a-duration' as never });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'whenConnected must not throw synchronously on a bad timeout');
  await assert.rejects(result!, RangeError);
});

test('socketLink wires pause()/resume() to the socket (read backpressure)', () => {
  const calls: string[] = [];
  const fakeSocket = {
    on: () => fakeSocket,
    write: (_bytes: Uint8Array, cb: (error?: Error) => void) => cb(),
    end: () => undefined,
    pause: () => calls.push('pause'),
    resume: () => calls.push('resume'),
  } as unknown as Socket;
  const link = socketLink(fakeSocket, {} as FixSession);
  link.pause?.();
  link.resume?.();
  assert.deepEqual(calls, ['pause', 'resume']);
});

// ─── Closing ────────────────────────────────────────────────────────────────

test('closing the server logs every session out, with its reason', { timeout: 10_000 }, async () => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  const client = await clientOf(server);
  await server.close();
  assert.deepEqual(await client.closed, { by: 'them', text: 'Server shutting down' });
});

test('whenConnected times out on the server clock, saying which counterparty it waited for', { timeout: 10_000 }, async t => {
  const clock = fakeClock();
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', clock });
  t.after(() => server.close(), { timeout: 5_000 });
  const waiting = server.whenConnected('NOBODY', { timeout: '2s' });
  const check = assert.rejects(waiting, { name: 'TimeoutError', waitingFor: { kind: 'logon', target: 'NOBODY' } });
  await clock.advance('2s');
  await check;
});

test('server.close() rejects pending whenConnected waiters', { timeout: 10_000 }, async () => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  const waiting = server.whenConnected('NOBODY', { timeout: '5s' });
  await server.close();
  await assert.rejects(waiting, (error: unknown) => error instanceof Error && error.name === 'FIXStateError' && error.message === 'Server closed');
});

test('closing a server session frees its socket even when the peer keeps its side open', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  t.after(() => server.close(), { timeout: 5_000 });
  const peer = await rawConnect(server.port, { allowHalfOpen: true });
  const peerClosed = closeOf(peer);
  peer.write(logonFrame('CLIENT'));
  const session = await server.whenConnected('CLIENT', { timeout: '2s' });
  // Our end is reset once it has waited for theirs; their next write then fails and their socket closes.
  const writing = setInterval(() => { if (!peer.destroyed) peer.write('still here'); }, 100);
  t.after(() => { clearInterval(writing); peer.destroy(); });
  session.close();
  await within(peerClosed, 3000, 'the server dropping the half-open connection');
  assert.equal(server.sessions.length, 0);
});

test('a closed link frees its socket even when the peer keeps its side open', { timeout: 10_000 }, async t => {
  const connected = new Promise<Socket>(resolve => {
    let accepted: Socket | undefined;
    const server = createServer(socket => resolve(accepted = socket));
    t.after(() => new Promise<void>(done => { accepted?.destroy(); server.close(() => done()); }), { timeout: 5_000 });
    server.listen(0, '127.0.0.1', () => {
      const peer = netConnect({ port: (server.address() as { port: number }).port, host: '127.0.0.1', allowHalfOpen: true });
      peer.on('error', () => undefined);
      peer.resume();
      const writing = setInterval(() => { if (!peer.destroyed) peer.write('still here'); }, 100);
      t.after(() => { clearInterval(writing); peer.destroy(); });
    });
  });
  const socket = await connected;
  const session = { receiveBytes: () => undefined, linkClosed: () => undefined } as unknown as FixSession;
  const link = socketLink(socket, session);
  const closed = closeOf(socket);
  link.end();
  await within(closed, 1500, 'closing our socket');
});

// ─── The server's pre-session checks ────────────────────────────────────────

test('accept() can refuse a Logon; connect rejects with the reason', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', accept: logon => logon.Password === 'secret' || 'bad password' });
  t.after(() => server.close(), { timeout: 5_000 });
  await assert.rejects(clientOf(server, 'CLIENT', { logon: { Password: 'nope' } }),
    (error: unknown) => error instanceof Error && error.name === 'FIXLogonError' && error.message === 'Logon failed: bad password');
  const ok = await clientOf(server, 'CLIENT', { logon: { Password: 'secret' } });
  assert.equal(ok.state, 'active');
  await ok.logout();
});

test('a Logon for another CompID, or an unsupported version, is refused', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', versions: ['FIX.4.4'] });
  t.after(() => server.close(), { timeout: 5_000 });
  await assert.rejects(connect({ host: '127.0.0.1', port: server.port }, { sender: 'CLIENT', target: 'SOMEONE_ELSE' }), /TargetCompID SOMEONE_ELSE is not EXCHANGE/);
  await assert.rejects(clientOf(server, 'CLIENT', { version: 'FIX.4.2' }), /BeginString FIX.4.2 is not supported/);
});

test('a Logon of a version the server does not serve is refused without the custom dictionary, whose fields may clash with that version', { timeout: 10_000 }, async t => {
  // SessionStatus (1409) is a standard FIXT.1.1 field with a standard meaning, so this dictionary cannot extend FIXT.1.1's.
  const acme = defineDictionary({ fields: { SessionStatus: { tag: 1409 } }, messages: { Logon: ['SessionStatus'] } });
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', dictionary: acme, versions: ['FIX.4.4'] });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  const socket = await rawConnect(server.port);
  let reply = '';
  socket.on('data', chunk => { reply += chunk.toString('latin1'); });
  const closed = closeOf(socket);
  socket.write(logonFrame('CLIENT', 'EXCHANGE', { DefaultApplVerID: 'FIX50SP2' }, 'FIXT.1.1'));
  await within(closed, 3000, 'the refused connection to close');
  await waitFor(() => feed.some(entry => entry.event === 'closed'), 2000, 'the closed entry');
  assert.match(reply, /^8=FIXT\.1\.1\x019=\d+\x0135=5\x01/);
  assert.ok(reply.includes('\x0158=BeginString FIXT.1.1 is not supported\x01'), reply);
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'received', 'rejected', 'closed']);
  const rejected = feed.find(entry => entry.event === 'rejected');
  assert.deepEqual(rejected?.problem, { code: 'LogonRefused', text: 'BeginString FIXT.1.1 is not supported', action: 'LoggedOut' });
  assert.deepEqual(rejected?.logon, { BeginString: 'FIXT.1.1', SenderCompID: 'CLIENT', TargetCompID: 'EXCHANGE' });
  assert.equal(feed.some(entry => entry.event === 'error'), false);
});

test('a server that speaks only FIXT.1.1 refuses a FIX 4 Logon without its custom dictionary, which cannot extend FIX 4.2 or FIX 4.4', { timeout: 10_000 }, async t => {
  // Made by hand: defineDictionary() refuses a definition that cannot extend FIX 4.2 and FIX 4.4. ClientID (109) is a
  // field of FIX 4.2, and ExecsGrp a group of FIX 4.4; FIX 5.0 SP2 has neither name.
  const fixtOnly = { definition: { fields: { ClientID: { tag: 9109 }, ExecsGrp: { tag: 9110 } }, messages: { Logon: ['ClientID', 'ExecsGrp'] } } };
  assert.throws(() => defineDictionary(fixtOnly.definition), /Custom field ClientID has the same name as a standard field/);
  assert.throws(() => resolveDictionary('FIX.4.4', fixtOnly), /Custom field ExecsGrp has the same name as a group of FIX\.4\.4/);
  const seen: unknown[] = [];
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', dictionary: fixtOnly, versions: ['FIXT.1.1'], accept: logon => { seen.push(logon.ClientID); return true; } });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  for (const version of ['FIX.4.2', 'FIX.4.4']) {
    const socket = await rawConnect(server.port);
    let reply = '';
    socket.on('data', chunk => { reply += chunk.toString('latin1'); });
    const closed = closeOf(socket);
    socket.write(logonFrame('CLIENT', 'EXCHANGE', {}, version));
    await within(closed, 3000, 'the refused connection to close');
    assert.ok(reply.startsWith(`8=${version}\x01`) && reply.includes(`\x0135=5\x01`) && reply.includes(`\x0158=BeginString ${version} is not supported\x01`), reply);
  }
  await waitFor(() => feed.filter(entry => entry.event === 'closed').length === 2, 2000, 'the closed entries');
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'received', 'rejected', 'closed', 'opened', 'received', 'rejected', 'closed']);
  assert.deepEqual(feed.flatMap(entry => (entry.event === 'rejected' ? [entry.problem.text] : [])), ['BeginString FIX.4.2 is not supported', 'BeginString FIX.4.4 is not supported']);
  // Where the server does speak the version, the dictionary is used: its field reaches accept() by its name.
  await (await clientOf(server, 'CLIENT', { version: 'FIXT.1.1', dictionary: fixtOnly, logon: { ClientID: 'C1' } })).logout();
  assert.deepEqual(seen, ['C1']);
});

test("a server reads each Logon with its own version's dictionary: a FIX 4.2 Logon carrying Username, which FIX 4.2 lacks, is refused as FIX 4.2 refuses it, and accept() saw the field without a name", { timeout: 10_000 }, async t => {
  const seen: unknown[] = [];
  const server = await listen(0, {
    compID: 'EXCHANGE', host: '127.0.0.1',
    accept: logon => { seen.push([logon.BeginString, logon.Username, logon[553], logon.OnBehalfOfSendingTime instanceof Date, logon[370]]); return true; },
  });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  // Username (553) is a field of FIX 4.4 and of FIXT.1.1, and not of FIX 4.2.
  await assert.rejects(clientOf(server, 'OLD', { version: 'FIX.4.2', logon: { 553: 'trader' } }), /Logon failed: Tag 553 is not defined in FIX\.4\.2/);
  await waitFor(() => feed.some(entry => entry.event === 'rejected'), 2000, 'the rejected entry');
  assert.deepEqual(feed.find(entry => entry.event === 'rejected')?.problem, { code: 'InvalidTagNumber', text: 'Tag 553 is not defined in FIX.4.2', action: 'LoggedOut', refSeqNum: 1 });
  for (const version of ['FIX.4.4', 'FIXT.1.1']) await (await clientOf(server, 'NEW', { version, logon: { Username: 'trader' } })).logout();
  // OnBehalfOfSendingTime (370) is a header field of FIX 4.2 alone: a time there, and a tag without a name in FIX 4.4.
  const sentAt = new Date('2026-10-02T12:00:00.000Z');
  await (await clientOf(server, 'OLD', { version: 'FIX.4.2', logon: { OnBehalfOfCompID: 'DESK', OnBehalfOfSendingTime: sentAt } })).logout();
  await assert.rejects(clientOf(server, 'NEW', { logon: { OnBehalfOfCompID: 'DESK', 370: '20261002-12:00:00' } }), /Logon failed: Tag 370 is not defined in FIX\.4\.4/);
  assert.deepEqual(seen, [
    ['FIX.4.2', undefined, 'trader', false, undefined],
    ['FIX.4.4', 'trader', undefined, false, undefined],
    ['FIXT.1.1', 'trader', undefined, false, undefined],
    ['FIX.4.2', undefined, undefined, true, undefined],
    ['FIX.4.4', undefined, undefined, false, '20261002-12:00:00'],
  ]);
});

test('a custom field on a Logon reaches accept() by its name, and its value by its, in every version the server serves', { timeout: 10_000 }, async t => {
  const acme = defineDictionary({
    fields: { LogonToken: { tag: 9710 }, Tier: { tag: 9711, values: { Gold: 'G', Silver: 'S' } } },
    messages: { Logon: ['LogonToken', 'Tier'] },
  });
  const seen: unknown[] = [];
  const server = await listen(0, {
    compID: 'EXCHANGE', host: '127.0.0.1', dictionary: acme,
    accept: logon => { seen.push([logon.BeginString, logon.LogonToken, logon.Tier, logon[9710], logon[9711]]); return true; },
  });
  t.after(() => server.close(), { timeout: 5_000 });
  for (const version of VERSIONS) {
    const session = await clientOf(server, 'CLIENT', { version, dictionary: acme, logon: { LogonToken: 'T1', Tier: 'Gold' } });
    const sent = session.history.find(entry => entry.kind === 'message' && entry.direction === 'out');
    assert.ok(sent?.kind === 'message' && Buffer.from(sent.bytes ?? []).toString('latin1').includes('\x019710=T1\x019711=G\x01'), version);
    // The session reads it as accept() did.
    const theirs = server.session('CLIENT')?.history.find(entry => entry.kind === 'message' && entry.direction === 'in');
    assert.deepEqual(theirs?.kind === 'message' && [theirs.message.LogonToken, theirs.message.Tier], ['T1', 'Gold'], version);
    await session.logout();
  }
  assert.deepEqual(seen, VERSIONS.map(version => [version, 'T1', 'Gold', undefined, undefined]));
});

test('a second Logon for a connected counterparty is refused', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  t.after(() => server.close(), { timeout: 5_000 });
  const first = await clientOf(server);
  await assert.rejects(clientOf(server), /CLIENT is already logged on/);
  assert.equal(first.state, 'active');
  await first.logout();
});

test('the first message must be a Logon; the server just hangs up', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  t.after(() => server.close(), { timeout: 5_000 });
  const manual = await clientOf(server, 'CLIENT', { manual: true });
  await manual.send('Heartbeat');
  assert.equal((await manual.closed).by, 'network');
  assert.equal(server.sessions.length, 0);
});

test('a connection that never logs on is dropped after the logon timeout (a number is milliseconds)', async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', limits: { logonTimeout: 200 } });
  t.after(() => server.close(), { timeout: 5_000 });
  const socket = netConnect(server.port, '127.0.0.1');
  await new Promise(resolve => socket.once('connect', resolve));
  await within(new Promise(resolve => socket.once('close', resolve)), 2000, 'dropping the silent connection');
  assert.equal(server.sessions.length, 0);
});

test('a refused peer that never sends its own FIN is still closed by the server', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  t.after(() => server.close(), { timeout: 5_000 });
  const socket = await rawConnect(server.port, { allowHalfOpen: true });
  const closed = closeOf(socket);
  socket.write(logonFrame('CLIENT', 'WRONG_TARGET'));   // TargetCompID mismatch: refused
  await within(closed, 3000, 'closing the refused half-open socket');
  socket.destroy();
});

test('a hung accept() does not lock the CompID out forever', { timeout: 10_000 }, async t => {
  let calls = 0;
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', limits: { logonTimeout: '200ms' },
    accept: () => (++calls === 1 ? new Promise<true>(() => { /* never settles */ }) : true) });
  t.after(() => server.close(), { timeout: 5_000 });
  const socket = await rawConnect(server.port);
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.write(logonFrame('VICTIM'));
  await closed;   // dropped by the logon timeout while accept() hangs
  assert.equal(server.sessions.length, 0);
  const second = await connect({ host: '127.0.0.1', port: server.port }, { sender: 'VICTIM', target: 'EXCHANGE' });
  assert.equal(second.state, 'active');
  assert.equal(calls, 2, 'the second Logon attempt must reach accept() again, i.e. VICTIM was released');
  await second.logout();
});

test('a socket closed during a slow store.load leaves no session behind', { timeout: 10_000 }, async t => {
  const { store, loading, release, appendCount } = heldLoadStore();
  // The server clears its logon timer when its side of the socket closes: that's how the test sees it.
  let serverSideClosed!: () => void;
  const serverClosed = new Promise<void>(resolve => { serverSideClosed = resolve; });
  const clock: Clock = { ...systemClock, clearTimeout: handle => { systemClock.clearTimeout(handle); serverSideClosed(); } };
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', store, clock });
  t.after(() => server.close(), { timeout: 5_000 });
  const socket = await rawConnect(server.port);
  socket.write(logonFrame('CLIENT'));
  await loading;
  socket.destroy();
  await within(serverClosed, 1000, 'the server seeing the socket close');
  release();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(server.sessions.length, 0);
  assert.equal(appendCount(), 0, 'no session should ever have been created for a connection whose socket already closed');
  const second = await connect({ host: '127.0.0.1', port: server.port }, { sender: 'CLIENT', target: 'EXCHANGE' });
  assert.equal(second.state, 'active');
  await second.logout();
});

test('server.close() during a slow store.load leaves no session behind, and close() itself resolves', { timeout: 10_000 }, async () => {
  const { store, loading, release, appendCount } = heldLoadStore();
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', store });
  const socket = await rawConnect(server.port);
  socket.write(logonFrame('CLIENT'));
  await loading;
  await server.close();
  release();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(server.sessions.length, 0);
  // A session created and then quickly closed (its first write failing on the dead socket) would leave
  // server.sessions empty too; appendCount shows whether one was ever created (it records the Logon first).
  assert.equal(appendCount(), 0, 'no session should ever have been created for a connection whose socket already closed');
  socket.destroy();
});

test('a store whose load fails is reported, and the connection is closed', { timeout: 10_000 }, async t => {
  const errors: unknown[] = [];
  const store: Store = { ...memoryStore(), load: async () => { throw new Error('store down'); } };
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', store, onHandlerError: error => errors.push(error) });
  t.after(() => server.close(), { timeout: 5_000 });
  const socket = await rawConnect(server.port);
  const closed = closeOf(socket);
  socket.write(logonFrame('CLIENT'));
  await within(closed, 1000, 'closing the connection');
  assert.deepEqual(errors.map(e => (e as Error).message), ['store down']);
  assert.equal(server.sessions.length, 0);
});

test('a pause the session asks for while taking in pipelined bytes holds', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', memory: { inbox: 2 } });   // reads pause past 1 unprocessed frame
  t.after(() => server.close(), { timeout: 5_000 });
  const calls: string[] = [];
  const { pause, resume } = Socket.prototype;
  Socket.prototype.pause = function (this: Socket) { if (this.localPort === server.port) calls.push('pause'); return pause.call(this); };
  Socket.prototype.resume = function (this: Socket) { if (this.localPort === server.port) calls.push('resume'); return resume.call(this); };
  t.after(() => { Socket.prototype.pause = pause; Socket.prototype.resume = resume; });
  const socket = await rawConnect(server.port);
  const order = messageFrame('NewOrderSingle', 'CLIENT', 'EXCHANGE', 2, { ClOrdID: 'pipe1', Side: 'Buy', OrdType: 'Market' });
  socket.write(Buffer.concat([logonFrame('CLIENT'), order]));
  const serverSide = await server.whenConnected('CLIENT', { timeout: '2s' });
  await serverSide.next('NewOrderSingle', { timeout: '2s' });
  await tick();
  socket.destroy();
  // Reads pause once the Logon is found and resume at handover. The session's own pause for the two buffered
  // frames must come after that resume (or the handover would undo it), and reads end up resumed.
  const logonFound = calls.indexOf('pause');
  const handover = calls.indexOf('resume', logonFound + 1);
  assert.ok(logonFound >= 0 && handover > logonFound, `reads pause at the Logon and resume at handover: ${calls.join(', ')}`);
  assert.ok(calls.indexOf('pause', handover + 1) > handover, `the session's pause comes after the handover: ${calls.join(', ')}`);
  assert.equal(calls.at(-1), 'resume', `reads end resumed: ${calls.join(', ')}`);
});

test('a server socket error after listening is reported, not thrown', { timeout: 10_000 }, async t => {
  const errors: unknown[] = [];
  let net: Server | undefined;
  const { listen: netListen } = Server.prototype;
  Server.prototype.listen = function (this: Server, ...args: unknown[]) { net = this; return (netListen as (...a: unknown[]) => Server).apply(this, args); } as typeof netListen;
  let server: FixServer;
  try {
    server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', onHandlerError: error => errors.push(error) });
  } finally {
    Server.prototype.listen = netListen;
  }
  t.after(() => server.close(), { timeout: 5_000 });
  const error = Object.assign(new Error('accept failed'), { code: 'EMFILE' });
  assert.doesNotThrow(() => net!.emit('error', error));
  assert.deepEqual(errors, [error]);
});

test('more than maxMessageSize of junk before a complete Logon frame gets the connection dropped', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', limits: { maxMessageSize: 128 } });
  t.after(() => server.close(), { timeout: 5_000 });
  const socket = await rawConnect(server.port);
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.write(Buffer.alloc(256, 'x'));   // no "8=FIX" ever; well over the 128-byte bound
  await closed;
  assert.equal(server.sessions.length, 0);
});

test('accept() that fails with no onHandlerError refuses the Logon and does not crash', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', accept: async () => { throw new Error('db down'); } });
  t.after(() => server.close(), { timeout: 5_000 });
  await assert.rejects(clientOf(server), (error: unknown) => error instanceof Error && error.message === 'Logon failed: Logon refused');
  assert.equal(server.sessions.length, 0);
});

test('accept() that throws, or rejects, refuses the connection without crashing', { timeout: 10_000 }, async t => {
  /** Connect, send a Logon, and hang up as soon as the refusal arrives. */
  const refusedLogon = async (server: FixServer, sender: string) => {
    const socket = await rawConnect(server.port);
    socket.once('data', () => socket.destroy());
    const closed = closeOf(socket);
    socket.write(logonFrame(sender));
    await closed;
  };
  const errors1: unknown[] = [];
  const server1 = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', onHandlerError: e => errors1.push(e), accept: () => { throw new Error('accept boom'); } });
  t.after(() => server1.close(), { timeout: 5_000 });
  await refusedLogon(server1, 'C1');
  assert.equal(server1.sessions.length, 0);
  assert.equal(errors1.length, 1);

  const errors2: unknown[] = [];
  const server2 = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', onHandlerError: e => errors2.push(e), accept: () => Promise.reject(new Error('accept rejected')) });
  t.after(() => server2.close(), { timeout: 5_000 });
  await refusedLogon(server2, 'C2');
  assert.equal(server2.sessions.length, 0);
  assert.equal(errors2.length, 1);
});

test('listen() validates limits up front, instead of crashing on the first connection', { timeout: 10_000 }, async () => {
  await assert.rejects(listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', limits: { maxMessageSize: 10 } }), RangeError);
  await assert.rejects(listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', limits: { maxMessageSize: 1.5 } }), RangeError);
  await assert.rejects(listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', limits: { logonTimeout: 0 } }), RangeError);
  await assert.rejects(listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', limits: { logonTimeout: -1 } }), RangeError);
});

test('messages pipelined right after Logon, while accept() is slow, are delivered once accepted', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', accept: () => sleep(200).then(() => true as const) });
  t.after(() => server.close(), { timeout: 5_000 });
  const socket = await rawConnect(server.port);
  const logon = logonFrame('CLIENT');
  const order = messageFrame('NewOrderSingle', 'CLIENT', 'EXCHANGE', 2, { ClOrdID: 'pipe1', Side: 'Buy', OrdType: 'Market' });
  socket.write(Buffer.concat([logon, order]));
  const serverSide = await server.whenConnected('CLIENT', { timeout: '2s' });
  const msg = await serverSide.next('NewOrderSingle', { timeout: '2s' });
  assert.equal(msg.ClOrdID, 'pipe1');
  socket.destroy();
});

// ─── Per-counterparty settings ──────────────────────────────────────────────

test('accept() can return settings for one counterparty', { timeout: 10_000 }, async t => {
  const goldStore = memoryStore();
  const server = await listen(0, {
    compID: 'EXCHANGE', host: '127.0.0.1',
    accept: logon => (logon.SenderCompID === 'GOLD' ? { store: goldStore, heartbeat: { max: 600 }, context: { tier: 'gold' } } : true),
  });
  t.after(() => server.close(), { timeout: 5_000 });
  const gold = await clientOf(server, 'GOLD', { heartbeat: 300 });
  const serverSide = await server.whenConnected('GOLD');
  assert.deepEqual(serverSide.context, { tier: 'gold' });
  assert.equal(serverSide.heartbeat, 300);
  assert.ok((await goldStore.load(serverSide.id)).history.length > 0, 'the counterparty\'s own store was used');
  await gold.logout();
});

test('accept() returning anything but true, text or settings refuses the Logon', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', accept: (() => false) as never });
  t.after(() => server.close(), { timeout: 5_000 });
  await assert.rejects(clientOf(server), /Logon failed: Logon refused/);
});

test('accept() returning nothing refuses the Logon at once, rather than leaving it to the logon timeout', async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', accept: (() => undefined) as never });
  t.after(() => server.close(), { timeout: 5_000 });
  const start = Date.now();
  await assert.rejects(clientOf(server), /Logon failed: Logon refused/);
  assert.ok(Date.now() - start < 2000, `took ${Date.now() - start} ms`);
});

test('a HeartBtInt outside the allowed range is refused; the default range is 1 to 120 s', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  t.after(() => server.close(), { timeout: 5_000 });
  await assert.rejects(clientOf(server, 'CLIENT', { heartbeat: 300 }), /HeartBtInt 300 is outside 1 to 120 s/);
  await assert.rejects(clientOf(server, 'CLIENT', { heartbeat: 0 }), /HeartBtInt 0 is outside 1 to 120 s/);
  const narrow = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', heartbeat: { min: 5, max: 60 } });
  t.after(() => narrow.close(), { timeout: 5_000 });
  await assert.rejects(clientOf(narrow, 'CLIENT', { heartbeat: 61 }), /HeartBtInt 61 is outside 5 to 60 s/);
  const ok = await clientOf(narrow, 'CLIENT', { heartbeat: 60 });
  await ok.logout();
  await assert.rejects(listenAndClose({ compID: 'EXCHANGE', host: '127.0.0.1', heartbeat: { min: 10, max: 5 } }), RangeError);
});

test('a heartbeat range from accept() that makes no sense refuses the Logon and is reported', { timeout: 10_000 }, async t => {
  const errors: unknown[] = [];
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', accept: () => ({ heartbeat: { min: 1.5 } }), onHandlerError: error => errors.push(error) });
  t.after(() => server.close(), { timeout: 5_000 });
  await assert.rejects(clientOf(server), /Logon failed: Logon refused/);
  assert.match(String(errors[0]), /RangeError: accept\(\) heartbeat must be whole seconds/);
});

for (const [label, verdict, problem] of [
  ['an unknown setting (a typo)', { heartbeats: { max: 10 } }, /unknown setting 'heartbeats'/],
  ['a Date', new Date(0), /plain settings object/],
  ['manual that is not a boolean', { manual: 'yes' }, /manual must be true or false/],
  ['a dictionary that is not one', { dictionary: 5 }, /dictionary must be/],
  ['a store that is not one', { store: 42 }, /store must have load, append, read, sent, list and reset functions/],
  ['a memory bound that is not a positive integer', { memory: { inbox: -5 } }, /memory\.inbox must be a whole number of at least 1, got -5/],
] as const) {
  test(`accept() settings with ${label} are an error entry, and the Logon is refused`, { timeout: 10_000 }, async t => {
    const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', accept: () => verdict as never });
    t.after(() => server.close(), { timeout: 5_000 });
    const feed = feedOf(server);
    await assert.rejects(clientOf(server), /Logon failed: Logon refused/);
    await waitFor(() => feed.some(entry => entry.event === 'closed'), 3000, 'the closed entry');
    assert.deepEqual(feed.map(entry => entry.event), ['opened', 'received', 'error', 'rejected', 'closed']);
    assert.match(feed[2]?.error?.text ?? '', problem);
    assert.deepEqual(feed[3]?.problem, { code: 'LogonRefused', text: 'Logon refused', action: 'LoggedOut' });
    assert.equal(server.sessions.length, 0);
  });
}

test('listen() and connect() refuse memory bounds that are not positive integers, up front', { timeout: 10_000 }, async t => {
  for (const memory of [{ inbox: -5 }, { history: 0 }, { inboxBytes: 1.5 }, { storeBytes: '4MB' }, { pendingBytes: 0 }, { pendingBytes: '16KiB' }, { inboxs: 5 }, 5]) {
    await assert.rejects(listenAndClose({ compID: 'EXCHANGE', host: '127.0.0.1', memory: memory as never }), RangeError, JSON.stringify(memory));
  }
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  t.after(() => server.close(), { timeout: 5_000 });
  for (const memory of [{ inbox: -5 }, { outgoingBytes: 0 }, { pendingBytes: -1 }, { inboxs: 5 }]) {
    await assert.rejects(clientOf(server, 'CLIENT', { memory }), RangeError, JSON.stringify(memory));
  }
});

/** A store over `base` (a memoryStore unless given) whose append() waits, after hold(), until release() lets every waiting call go on (and ends the holding). */
function gatedStore(base: Store = memoryStore()) {
  let holding = false;
  const waiting: (() => void)[] = [];
  const store: Store = {
    ...base,
    async append(id, records, context) {
      if (holding) await new Promise<void>(resolve => { waiting.push(resolve); });
      return base.append(id, records, context);
    },
  };
  return { store, base, hold: () => { holding = true; }, release: () => { holding = false; for (const go of waiting.splice(0)) go(); }, waiting: () => waiting.length };
}

test('memory.pendingBytes given to listen() and to connect() is the amount at which their sessions stop reading the socket', { timeout: 10_000 }, async t => {
  // Every pause() of a socket, by the server's port and which end of the connection it is.
  const paused: { port: number | undefined; end: 'server' | 'client' }[] = [];
  const serverPorts = new Set<number>();
  const pause = Socket.prototype.pause;
  Socket.prototype.pause = function (this: Socket) {
    const server = this.localPort !== undefined && serverPorts.has(this.localPort);
    paused.push({ port: server ? this.localPort : this.remotePort, end: server ? 'server' : 'client' });
    return pause.call(this);
  };
  t.after(() => { Socket.prototype.pause = pause; });
  for (const [pendingBytes, pauses] of [[500, 1], [100_000, 0]] as const) {
    const theirs = gatedStore();
    const ours = gatedStore();
    const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', store: theirs.store, memory: { pendingBytes } });
    serverPorts.add(server.port);
    t.after(() => server.close(), { timeout: 5_000 });
    const client = await clientOf(server, 'CLIENT', { store: ours.store, memory: { pendingBytes } });
    const serverSide = await server.whenConnected('CLIENT');
    await sleep(20);
    paused.length = 0;
    const at = (end: 'server' | 'client') => paused.filter(each => each.port === server.port && each.end === end).length;
    // Four messages of 200 bytes and more are sent to the server while its store keeps nothing: three of them are 600 bytes received and not kept.
    theirs.hold();
    for (let n = 0; n < 4; n++) void client.send('Heartbeat', { TestReqID: `${n}`.padEnd(150, 'x') });
    await waitFor(() => serverSide.seqNums.expected >= 5, 3000, 'the server to take three of them in');
    await sleep(20);
    assert.deepEqual([at('server'), at('client')], [pauses, 0], `listen() with memory.pendingBytes ${pendingBytes}`);
    theirs.release();
    await sleep(20);
    // And four the other way, while the client's store keeps nothing.
    paused.length = 0;
    ours.hold();
    for (let n = 0; n < 4; n++) void serverSide.send('Heartbeat', { TestReqID: `${n}`.padEnd(150, 'y') });
    await waitFor(() => client.seqNums.expected >= 5, 3000, 'the client to take three of them in');
    await sleep(20);
    assert.deepEqual([at('server'), at('client')], [0, pauses], `connect() with memory.pendingBytes ${pendingBytes}`);
    ours.release();
    await sleep(20);
    assert.deepEqual([client.state, serverSide.state], ['active', 'active']);
    client.close();
  }
});

/** Wait for `condition`, checking after each turn of the event loop, for `ms` of real time at most; whether it came to hold. */
async function reached(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await tick();
  }
  return true;
}

test('a server session that sends without pause while its store is slow goes on reading: a counterparty that answers stays logged on past its heartbeat interval, and one that has gone silent is still found out', { timeout: 60_000 }, async t => {
  // The engine's own timers run here, on a clock the test moves a second at a time, so no bound below is missed by a
  // machine that is busy; the sockets are real. HeartBtInt 1: silence is noticed after 1.2 s and given up on a second later.
  const clock = fakeClock(new Date());
  const base = memoryStore();
  const slow: Store = { ...base, async append(id, records, context) { await sleep(50); return base.append(id, records, context); } };
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', store: slow, clock });
  // The clock stands still once the test is over: both connections are closed first, so that the server waits for no Logout.
  let sending: ReturnType<typeof setInterval> | undefined;
  const ends: (() => void)[] = [];
  t.after(() => { clearInterval(sending); for (const end of ends) end(); return server.close(); }, { timeout: 5_000 });
  const alive = await clientOf(server, 'ALIVE', { heartbeat: 1, clock });
  ends.push(() => alive.close());
  const silent = await rawConnect(server.port);
  ends.push(() => silent.destroy());
  silent.on('data', () => {});                              // it reads, and says nothing after its Logon
  silent.write(logonFrame('SILENT', 'EXCHANGE', { HeartBtInt: 1 }));
  const sides = [await server.whenConnected('ALIVE'), await server.whenConnected('SILENT')];
  let second = 0;
  const closed: (string | undefined)[] = [undefined, undefined];
  const closedAt: number[] = [0, 0];
  sides.forEach((side, index) => { void side.closed.then(reason => { closed[index] = reason.text; closedAt[index] = second; }); });
  // In real time, 2,000 messages of 200 bytes and more a second to each, where the store keeps a list in 50 ms: its backlog is never below 20 KB.
  let sent = 0;
  sending = setInterval(() => {
    for (const side of sides) {
      if (side.state !== 'active') continue;
      for (let n = 0; n < 10; n++) { sent++; side.send('Heartbeat', { TestReqID: 'x'.repeat(150) }).catch(() => {}); }
    }
  }, 5);
  for (second = 1; second <= 6; second++) {
    const had = alive.seqNums.expected;
    await clock.advance(1000);
    await sleep(200);
    // What crossed the sockets during this second is given real time to be read before the clock moves on: the Heartbeat
    // ALIVE sent, by a server that reads, and some of what the server sent, by ALIVE. A server that does not read is not waited for long.
    await reached(() => sides[0]!.state !== 'active' || (sides[0]!.seqNums.expected >= alive.seqNums.next && alive.seqNums.expected > had), 3000);
  }
  clearInterval(sending);
  assert.ok(sent > 200, `only ${sent} messages were sent`);
  assert.equal(closed[0], undefined, `the counterparty that answers was closed after ${closedAt[0]} s`);
  assert.deepEqual([sides[0]!.state, alive.state], ['active', 'active']);
  assert.equal(closed[1], 'Heartbeat timeout');
  assert.ok(closedAt[1]! >= 2 && closedAt[1]! <= 4, `the silent one was closed after ${closedAt[1]} s`);
  alive.close();
});

test('a server session with 2.7 MiB of its own messages waiting for its file store, at the defaults, goes on reading: a counterparty that sends a Heartbeat every second is not taken for dead', { timeout: 60_000 }, async t => {
  // The engine's own timers on a clock the test moves; real sockets; a fileStore that keeps nothing for five heartbeat intervals.
  const clock = fakeClock(new Date());
  const folder = await mkdtemp(join(tmpdir(), 'fixjs-net-own-'));
  const { store, hold, release } = gatedStore(fileStore(folder));
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', store, clock });
  const socket = await rawConnect(server.port);
  // The clock stands still once the test is over: the store is let go and the connection closed first, so that the server waits for nothing.
  t.after(async () => { release(); socket.destroy(); await server.close(); await rm(folder, { recursive: true, force: true }); }, { timeout: 5_000 });
  let received = 0;
  socket.on('data', (chunk: Buffer) => { received += chunk.length; });
  socket.write(logonFrame('ALIVE', 'EXCHANGE', { HeartBtInt: 1 }));
  const side = await server.whenConnected('ALIVE');
  await waitFor(() => side.state === 'active' && received > 0, 3000, 'the Logon to be answered');
  let second = 0;
  let closedAt: number | undefined;
  hold();
  // 900 messages of 3,000 bytes and more: over half of memory.storeBytes (4 MiB) and under it, and under memory.outgoingBytes.
  const sends = Array.from({ length: 900 }, () => side.send('Heartbeat', { TestReqID: 'x'.repeat(3000) }).then(() => {}));
  for (const send of sends) send.catch(() => {});
  const bytes = 900 * side.encode('Heartbeat', { TestReqID: 'x'.repeat(3000) }).length;
  assert.ok(bytes > 2.5 * 1024 * 1024 && bytes < 3.5 * 1024 * 1024, `${bytes} bytes`);
  let seq = 2;
  for (second = 1; second <= 5; second++) {
    socket.write(messageFrame('Heartbeat', 'ALIVE', 'EXCHANGE', seq++, {}));
    // The Heartbeat crosses a real socket: a server that reads has it before the clock moves on, and one that does not is not waited for long.
    await reached(() => side.state !== 'active' || side.seqNums.expected === seq, 2000);
    await clock.advance(1000);
    if (side.state !== 'active') closedAt ??= second;
  }
  assert.equal(closedAt, undefined, `a live counterparty was dropped after ${closedAt} s`);
  assert.equal(side.seqNums.expected, seq, 'the server read every Heartbeat');
  assert.ok(received < bytes / 100, 'something of the burst was written before its records were kept');
  release();
  await within(Promise.all(sends), 20_000, 'the 900 sends');
  await waitFor(() => received > bytes, 20_000, 'the counterparty to receive them');
  assert.equal(side.state, 'active');
  socket.destroy();
  await waitFor(() => side.state === 'closed', 3000, 'the session to close');
});

test('a burst of 2.5 MiB sent in one turn through an outgoing route that changes each message is carried at the default memory.outgoingBytes, and nothing is counted once it is written', { timeout: 60_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  t.after(() => server.close(), { timeout: 5_000 });
  const client = await clientOf(server) as unknown as FixSession;
  const side = await server.whenConnected('CLIENT');
  client.outgoing(message => (message.MsgType === 'NewOrderSingle' ? { ...message, Text: 'y'.repeat(100) } : message));
  const fields = (n: number) => ({ ClOrdID: `c${n}`, Symbol: 'MSFT', Side: 'Buy', OrdType: 'Limit', OrderQty: 1, Price: 1, TransactTime: new Date(), Text: 'x'.repeat(100) });
  const count = Math.ceil(2.5 * 1024 * 1024 / client.encode('NewOrderSingle', fields(10_000)).length);
  let rejected = 0;
  let why = '';
  const sends = Array.from({ length: count }, (_, n) => client.send('NewOrderSingle', fields(n)).then(() => {}, (error: Error) => { rejected++; why ||= error.message; }));
  await within(Promise.all(sends), 30_000, 'the sends to settle');
  assert.equal(rejected, 0, `${rejected} of ${count} sends were rejected: ${why}`);
  assert.equal(client.state, 'active');
  await waitFor(() => side.seqNums.expected === count + 2, 30_000, 'the server to receive them all');
  assert.equal(client.outgoingBytesForTests, 0);
  assert.equal(side.state, 'active');
  client.close();
});

// ─── One session for an id hands its records to a store at a time ───────────

/** The TestReqIDs of the TestRequests a store holds as received, in the order it was given them. */
const testReqIDs = (records: readonly { entry?: Entry }[]) => records.flatMap(({ entry }) => (entry?.kind === 'message' && entry.direction === 'in' && entry.message.MsgType === 'TestRequest' ? [String(entry.message.TestReqID)] : []));

/** A gatedStore that also notes every record it has kept, in order. */
function gatedRecordingStore() {
  const gated = gatedStore();
  const kept: { entry?: Entry; seqNums: { next: number; expected: number } }[] = [];
  const append = gated.base.append.bind(gated.base);
  gated.base.append = async (id, records, context) => { await append(id, records, context); kept.push(...records); };
  return { ...gated, kept };
}

test('a server takes a new session for a counterparty only once the last one has handed its store every record it had made: until then the Logon waits, and the records reach the store one session after the other', { timeout: 15_000 }, async t => {
  const { store, base, kept, hold, release, waiting } = gatedRecordingStore();
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', store, logoutTimeout: '300ms', storeTimeout: '5s' });
  t.after(() => server.close(), { timeout: 5_000 });
  const ours = memoryStore();
  let client = await clientOf(server, 'CLIENT', { store: ours });
  const first = await server.whenConnected('CLIENT');
  hold();
  // The first is with the store, which keeps nothing; the rest wait behind it, with the answers to them.
  for (let n = 0; n < 6; n++) client.send('TestRequest', { TestReqID: `first-${n}` }).catch(() => {});
  await waitFor(() => first.seqNums.expected === 8 && waiting() === 1, 3000, 'the server to take the six in');
  client.close();
  await within(first.closed, 3000, 'the first session to close');           // after logoutTimeout: its store has not kept what it was given
  // The counterparty logs on again at once. Its Logon waits for the first session's records.
  const again = clientOf(server, 'CLIENT', { store: ours });
  let loggedOn = false;
  void again.then(() => { loggedOn = true; }, () => {});
  await sleep(400);
  assert.equal(loggedOn, false, 'logged on while the store still had a call of the last session');
  assert.equal(server.session('CLIENT'), undefined);
  release();
  client = await within(again, 3000, 'the second Logon to be answered');
  const second = await server.whenConnected('CLIENT');
  assert.notEqual(second, first);
  for (let n = 0; n < 6; n++) await client.send('TestRequest', { TestReqID: `second-${n}` });
  await client.next('Heartbeat', { where: { TestReqID: 'second-5' }, timeout: '3s' });
  await sleep(50);
  assert.deepEqual(testReqIDs(kept), [...Array.from({ length: 6 }, (_, n) => `first-${n}`), ...Array.from({ length: 6 }, (_, n) => `second-${n}`)]);
  // What a restart would load is what the live session has: no MsgSeqNum it sent would be used again.
  const loaded = await base.load(second.id);
  assert.deepEqual({ next: loaded.next, expected: loaded.expected }, second.seqNums);
  const behind = kept.findIndex((record, index) => index > 0 && record.seqNums.next < kept[index - 1]!.seqNums.next);
  assert.equal(behind, -1, `record ${behind} brought the store's next down`);
  client.close();
});

test('a Logon that has waited storeTimeout for the last session of its counterparty to hand over its records is refused as when the store cannot be read, and taken once it has', { timeout: 15_000 }, async t => {
  const { store, base, kept, hold, release, waiting } = gatedRecordingStore();
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', store, logoutTimeout: '200ms', storeTimeout: '600ms' });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  const ours = memoryStore();
  let client = await clientOf(server, 'CLIENT', { store: ours });
  const first = await server.whenConnected('CLIENT');
  hold();
  for (let n = 0; n < 3; n++) client.send('TestRequest', { TestReqID: `first-${n}` }).catch(() => {});
  await waitFor(() => first.seqNums.expected === 5 && waiting() === 1, 3000, 'the server to take the three in');
  client.close();
  await within(first.closed, 3000, 'the first session to close');
  // Another counterparty is not kept waiting: its session begins at once (its Logon is answered when the store keeps it).
  const other = clientOf(server, 'OTHER');
  other.catch(() => {});
  await waitFor(() => server.session('OTHER') !== undefined, 400, 'a session for another counterparty');
  feed.length = 0;
  const asked = Date.now();
  // (With a store of its own, so that the Logon nobody answers uses no MsgSeqNum of the session that follows.)
  await assert.rejects(within(clientOf(server, 'CLIENT'), 5000, 'the Logon to be refused'), { name: 'FIXLogonError' });
  const waited = Date.now() - asked;
  assert.ok(waited >= 550 && waited < 3000, `refused after ${waited} ms, with storeTimeout 600 ms`);
  await waitFor(() => feed.some(entry => entry.event === 'closed'), 3000, 'the closed entry');
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'received', 'error', 'rejected', 'closed']);
  assert.equal(feed[2]?.error?.text, 'The store has not settled the records of the last session with "CLIENT": a Logon has waited 0.6 s for it');
  assert.deepEqual(feed[3]?.problem, { code: 'LogonRefused', text: 'Store unavailable', action: 'Disconnected' });
  assert.deepEqual(testReqIDs(kept), [], 'the store was given nothing meanwhile');
  release();
  (await within(other, 3000, 'the other counterparty to log on')).close();
  client = await within(clientOf(server, 'CLIENT', { store: ours }), 3000, 'a Logon after the store answered');
  const second = await server.whenConnected('CLIENT');
  await client.send('TestRequest', { TestReqID: 'second-0' });
  await client.next('Heartbeat', { where: { TestReqID: 'second-0' }, timeout: '3s' });
  await sleep(50);
  assert.deepEqual(testReqIDs(kept), ['first-0', 'first-1', 'first-2', 'second-0']);
  const loaded = await base.load(second.id);
  assert.deepEqual({ next: loaded.next, expected: loaded.expected }, second.seqNums);
  client.close();
});

/** The system clock, and how many timers of `ms` are waiting on it now. */
function watchedClock(): { clock: Clock; waiting(ms: number): number } {
  const timers = new Map<unknown, number>();
  const clock: Clock = {
    now: () => systemClock.now(),
    setTimeout(fn, ms) {
      const handle: unknown = systemClock.setTimeout(() => { timers.delete(handle); fn(); }, ms);
      timers.set(handle, ms);
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle);
      systemClock.clearTimeout(handle);
    },
  };
  return { clock, waiting: ms => [...timers.values()].filter(each => each === ms).length };
}

/** A server whose session with CLIENT has closed with three records its store keeps only once release() is called. */
async function serverHandingOver(t: { after(fn: () => unknown, options?: { timeout: number }): void }, options: Record<string, unknown>, sender = 'CLIENT') {
  const gated = gatedRecordingStore();
  const watched = watchedClock();
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', store: gated.store, clock: watched.clock, logoutTimeout: '200ms', ...options });
  t.after(() => { gated.release(); return server.close(); }, { timeout: 5_000 });
  const client = await clientOf(server, sender);
  const first = await server.whenConnected(sender);
  gated.hold();
  for (let n = 0; n < 3; n++) client.send('TestRequest', { TestReqID: `first-${n}` }).catch(() => {});
  await waitFor(() => first.seqNums.expected === 5 && gated.waiting() === 1, 3000, 'the server to take the three in');
  client.close();
  await within(first.closed, 3000, 'the first session to close');
  return { server, ...gated, timers: watched.waiting };
}

test('a Logon waiting for the last session of its counterparty stops waiting when its connection closes: its timer is cleared and its CompIDs are free for the next Logon, which waits in its turn', { timeout: 15_000 }, async t => {
  const { server, release, timers } = await serverHandingOver(t, { storeTimeout: '7s', limits: { logonTimeout: '8s' } });
  const feed = feedOf(server);
  const dropped = await rawConnect(server.port);
  dropped.write(logonFrame('CLIENT'));
  await waitFor(() => timers(7000) === 1, 3000, 'the Logon to wait');
  dropped.destroy();
  await waitFor(() => timers(7000) === 0, 3000, 'the timer of a wait whose connection closed to be cleared');
  // The next Logon of the same counterparty is not told that it is already logged on: it waits as the first did.
  const next = await rawConnect(server.port);
  t.after(() => next.destroy());
  const got = receivedBy(next);
  next.write(logonFrame('CLIENT', 'EXCHANGE', { ResetSeqNumFlag: true }));
  await waitFor(() => timers(7000) === 1, 3000, 'the next Logon to wait');
  await sleep(100);
  assert.deepEqual(feed.filter(entry => entry.event === 'rejected').map(entry => entry.problem?.text), []);
  assert.equal(got(), '');
  release();
  await waitFor(() => got().includes('\x0135=A\x01'), 3000, 'the Logon to be answered');
  assert.equal(timers(7000), 0, 'the timer of a wait that ended in time');
  assert.notEqual(server.session('CLIENT'), undefined);
  assert.deepEqual(feed.filter(entry => entry.event === 'error'), [], 'a Logon that waited and was taken leaves no error entry');
});

test('closing a server while a Logon waits for the last session of its counterparty leaves no timer of the wait behind', { timeout: 15_000 }, async t => {
  const { server, timers } = await serverHandingOver(t, { storeTimeout: '7s', limits: { logonTimeout: '8s' } });
  const socket = await rawConnect(server.port);
  t.after(() => socket.destroy());
  socket.write(logonFrame('CLIENT'));
  await waitFor(() => timers(7000) === 1, 3000, 'the Logon to wait');
  await within(server.close(), 3000, 'the server to close');
  assert.equal(timers(7000), 0);
});

test('a Logon still waiting for the last session of its counterparty when limits.logonTimeout ends is refused with Logon timed out, as at the defaults, where storeTimeout is no shorter, and one error entry before the refusal says that it waited for the store', { timeout: 15_000 }, async t => {
  const { server, timers } = await serverHandingOver(t, { storeTimeout: '7s', limits: { logonTimeout: '600ms' } });
  const feed = feedOf(server);
  const asked = Date.now();
  await assert.rejects(within(clientOf(server, 'CLIENT'), 5000, 'the Logon to be refused'), { name: 'FIXLogonError', message: /Logon timed out/ });
  const waited = Date.now() - asked;
  assert.ok(waited >= 550, `refused after ${waited} ms, with limits.logonTimeout 600 ms`);
  await waitFor(() => feed.some(entry => entry.event === 'closed'), 3000, 'the closed entry');
  const refusals = feed.filter(entry => entry.event === 'rejected').map(entry => [entry.problem?.code, entry.problem?.text]);
  assert.deepEqual(refusals, [['LogonTimeout', 'Logon timed out']]);
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'received', 'error', 'rejected', 'closed']);
  assert.match(feed[2]?.error?.text ?? '', /^The store has not settled the records of the last session with "CLIENT": a Logon has waited 0\.[56]\d* s for it$/);
  assert.equal(timers(7000), 0, 'the timer of the wait');
});

test('when limits.logonTimeout and storeTimeout are the same, as at the defaults, a Logon that waits for the last session of its counterparty is refused with Logon timed out and the store is named once, not again when storeTimeout ends', { timeout: 15_000 }, async t => {
  const { server, timers } = await serverHandingOver(t, { storeTimeout: '600ms', limits: { logonTimeout: '600ms' } });
  const feed = feedOf(server);
  // A counterparty that does not close when it is refused: its connection is still open when storeTimeout ends, a moment after the time it had to log on.
  const socket = await rawConnect(server.port);
  t.after(() => socket.destroy());
  const got = receivedBy(socket);
  const closed = closeOf(socket);
  socket.write(logonFrame('CLIENT'));
  await within(closed, 5000, 'the connection to be closed');
  assert.match(got(), /\x0135=5\x01.*\x0158=Logon timed out\x01/);
  await waitFor(() => feed.some(entry => entry.event === 'closed'), 3000, 'the closed entry');
  await sleep(200);
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'received', 'error', 'rejected', 'closed']);
  assert.match(feed[2]?.error?.text ?? '', /^The store has not settled the records of the last session with "CLIENT": a Logon has waited /);
  assert.deepEqual([feed[3]?.problem?.code, feed[3]?.problem?.text], ['LogonTimeout', 'Logon timed out']);
  assert.equal(timers(600), 0);
});

test('at the default timeouts, a Logon behind a store call that never returns is refused with Logon timed out, and one error entry, a TimeoutError waiting for the store, says what it waited for and how long', { timeout: 15_000 }, async t => {
  const gated = gatedRecordingStore();
  const clock = fakeClock(new Date());
  const errors: unknown[] = [];
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', store: gated.store, clock, logoutTimeout: '1s', onHandlerError: error => { errors.push(error); } });
  t.after(() => { gated.release(); return server.close(); }, { timeout: 5_000 });
  const client = await clientOf(server, 'CLIENT');
  const first = await server.whenConnected('CLIENT');
  gated.hold();
  for (let n = 0; n < 3; n++) client.send('TestRequest', { TestReqID: `first-${n}` }).catch(() => {});
  await waitFor(() => first.seqNums.expected === 5 && gated.waiting() === 1, 3000, 'the server to take the three in');
  client.close();
  // The server's Logout waits for the store too: the session closes when its logoutTimeout ends, on the server's clock.
  await sleep(50);
  await clock.advance('2s');
  await within(first.closed, 3000, 'the first session to close');
  errors.length = 0;
  const feed = feedOf(server);
  const socket = await rawConnect(server.port);
  t.after(() => socket.destroy());
  const got = receivedBy(socket);
  const closed = closeOf(socket);
  await waitFor(() => feed.some(entry => entry.event === 'opened'), 3000, 'the server to take the connection');
  // Two seconds pass before the Logon comes: it has eight of the ten its connection has to log on.
  await clock.advance('2s');
  socket.write(logonFrame('CLIENT'));
  await waitFor(() => feed.some(entry => entry.event === 'received'), 3000, 'the Logon to be read');
  await sleep(50);
  await clock.advance('7999ms');
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'received']);
  await clock.advance('1ms');
  await within(closed, 3000, 'the connection to be closed');
  assert.match(got(), /\x0135=5\x01.*\x0158=Logon timed out\x01/);
  await waitFor(() => feed.some(entry => entry.event === 'closed'), 3000, 'the closed entry');
  // storeTimeout ends two seconds later: nothing more is said.
  await clock.advance('3s');
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'received', 'error', 'rejected', 'closed']);
  assert.equal(feed[2]?.error?.text, 'The store has not settled the records of the last session with "CLIENT": a Logon has waited 8 s for it');
  assert.deepEqual(feed[3]?.problem, { code: 'LogonTimeout', text: 'Logon timed out', action: 'LoggedOut' });
  assert.equal(errors.length, 1);
  const error = errors[0] as { name?: unknown; waitingFor?: unknown };
  assert.deepEqual([error.name, error.waitingFor], ['TimeoutError', { kind: 'store' }]);
});

test('a connection that sends nothing while the store has yet to settle the last session of a counterparty is dropped at limits.logonTimeout with no error entry: it waited for no store', { timeout: 15_000 }, async t => {
  const { server } = await serverHandingOver(t, { storeTimeout: '7s', limits: { logonTimeout: '600ms' } });
  const feed = feedOf(server);
  const socket = await rawConnect(server.port);
  t.after(() => socket.destroy());
  await within(closeOf(socket), 5000, 'the connection to be closed');
  await waitFor(() => feed.some(entry => entry.event === 'closed'), 3000, 'the closed entry');
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'rejected', 'closed']);
  assert.deepEqual([feed[1]?.problem?.code, feed[1]?.problem?.text], ['LogonTimeout', 'No Logon within 0.6 s']);
});

test('a Logon that times out while accept() has not answered gets no error entry about the store', { timeout: 15_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', limits: { logonTimeout: '600ms' }, accept: () => new Promise<true>(() => {}) });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  await assert.rejects(within(clientOf(server, 'CLIENT'), 5000, 'the Logon to be refused'), { name: 'FIXLogonError', message: /Logon timed out/ });
  await waitFor(() => feed.some(entry => entry.event === 'closed'), 3000, 'the closed entry');
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'received', 'rejected', 'closed']);
});

test('the error entry for a Logon that waited for the store writes the CompID of its counterparty in quotes, in plain ASCII, whatever it holds', { timeout: 15_000 }, async t => {
  const sender = 'A"B\\C\nD\u00e9';
  const { server } = await serverHandingOver(t, { storeTimeout: '600ms', limits: { logonTimeout: '7s' } }, sender);
  const feed = feedOf(server);
  await assert.rejects(within(clientOf(server, sender), 5000, 'the Logon to be refused'), { name: 'FIXLogonError' });
  await waitFor(() => feed.some(entry => entry.event === 'closed'), 3000, 'the closed entry');
  const texts = feed.filter(entry => entry.event === 'error').map(entry => entry.error?.text);
  assert.deepEqual(texts, ['The store has not settled the records of the last session with "A\\"B\\\\C\\nD\\u00e9": a Logon has waited 0.6 s for it']);
});

test('connect() with the store of a session that was just closed waits until that session has handed over its records, and gives up after storeTimeout', { timeout: 15_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', logoutTimeout: '200ms' });
  t.after(() => server.close(), { timeout: 5_000 });
  const { store, base, kept, hold, release, waiting } = gatedRecordingStore();
  const sentIDs = () => kept.flatMap(({ entry }) => (entry?.kind === 'message' && entry.direction === 'out' && entry.message.MsgType === 'TestRequest' ? [String(entry.message.TestReqID)] : []));
  const first = await clientOf(server, 'CLIENT', { store, logoutTimeout: '200ms' });
  hold();
  for (let n = 0; n < 3; n++) first.send('TestRequest', { TestReqID: `first-${n}` }).catch(() => {});
  await waitFor(() => waiting() === 1, 3000, 'the store to be given the first');
  first.close();
  await waitFor(() => server.session('CLIENT') === undefined, 3000, 'the server to see the connection close');
  // Too long a wait: connect() gives up as it does when the store cannot be loaded, and has opened no connection.
  const feed = feedOf(server);
  await assert.rejects(within(clientOf(server, 'CLIENT', { store, storeTimeout: '300ms' }), 3000, 'connect() to give up'), { name: 'TimeoutError', message: 'Store load took longer than 0.3 s' });
  assert.deepEqual(feed, []);
  // A wait that ends in time: the session begins from what the first one left.
  const again = clientOf(server, 'CLIENT', { store, storeTimeout: '5s' });
  await sleep(100);
  assert.deepEqual(sentIDs(), []);
  release();
  const second = await within(again, 3000, 'the second connect()');
  await second.send('TestRequest', { TestReqID: 'second-0' });
  await sleep(50);
  assert.deepEqual(sentIDs(), ['first-0', 'first-1', 'first-2', 'second-0']);
  const loaded = await base.load(second.id);
  assert.deepEqual({ next: loaded.next, expected: loaded.expected }, second.seqNums);
  second.close();
});

test('a failure while admitting a Logon, before any session exists, still refuses it with a Logout', { timeout: 10_000 }, async t => {
  const store: Store = { ...memoryStore(), load: async () => undefined as never };   // a broken store: no history to build a session from
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', store });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  await assert.rejects(clientOf(server), /Logon failed: Logon refused/);
  await waitFor(() => feed.some(entry => entry.event === 'closed'), 3000, 'the closed entry');
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'received', 'error', 'rejected', 'closed']);
  assert.deepEqual(feed[3]?.problem, { code: 'LogonRefused', text: 'Logon refused', action: 'LoggedOut' });
});

test('HeartBtInt=0 (no heartbeats) is refused by default, and allowed with heartbeat: { min: 0 }', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', heartbeat: { min: 0 } });
  t.after(() => server.close(), { timeout: 5_000 });
  const client = await clientOf(server, 'CLIENT', { heartbeat: 0 });
  assert.equal((await server.whenConnected('CLIENT')).heartbeat, 0);
  await client.logout();
});

test('a server can answer to several CompIDs; each session sends as the one addressed', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: ['EXCHANGE', 'EXCHANGE2'], host: '127.0.0.1' });
  t.after(() => server.close(), { timeout: 5_000 });
  const address = { host: '127.0.0.1', port: server.port };
  const first = await connect(address, { sender: 'CLIENT', target: 'EXCHANGE' });
  const second = await connect(address, { sender: 'CLIENT', target: 'EXCHANGE2' });
  assert.deepEqual(server.sessions.map(session => session.id.sender).sort(), ['EXCHANGE', 'EXCHANGE2']);
  assert.equal((await second.send('TestRequest', { TestReqID: 'x' })).TargetCompID, 'EXCHANGE2');
  assert.equal((await second.next('Heartbeat')).SenderCompID, 'EXCHANGE2');
  await assert.rejects(connect(address, { sender: 'CLIENT', target: 'OTHER' }), /TargetCompID OTHER is not one of EXCHANGE, EXCHANGE2/);
  await assert.rejects(connect(address, { sender: 'CLIENT', target: 'EXCHANGE2' }), /CLIENT is already logged on/);
  await Promise.all([first.logout(), second.logout()]);
});

test('session() and whenConnected() can choose among our CompIDs; without one, the first to log on is found', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: ['EXCHANGE', 'EXCHANGE2'], host: '127.0.0.1' });
  t.after(() => server.close(), { timeout: 5_000 });
  const address = { host: '127.0.0.1', port: server.port };
  const first = await connect(address, { sender: 'CLIENT', target: 'EXCHANGE2' });
  const second = await connect(address, { sender: 'CLIENT', target: 'EXCHANGE' });
  assert.equal(server.session('CLIENT')?.id.sender, 'EXCHANGE2');
  assert.equal(server.session('CLIENT', { compID: 'EXCHANGE' })?.id.sender, 'EXCHANGE');
  assert.equal(server.session('CLIENT', { compID: 'OTHER' }), undefined);
  assert.equal((await server.whenConnected('CLIENT', { compID: 'EXCHANGE' })).id.sender, 'EXCHANGE');
  const late = server.whenConnected('LATE', { compID: 'EXCHANGE2', timeout: '3s' });
  const lateFirst = await connect(address, { sender: 'LATE', target: 'EXCHANGE' });
  const lateSecond = await connect(address, { sender: 'LATE', target: 'EXCHANGE2' });
  assert.equal((await late).id.sender, 'EXCHANGE2');
  await assert.rejects(server.whenConnected('CLIENT', { compID: 'OTHER', timeout: 50 }), { name: 'TimeoutError' });
  await Promise.all([first.logout(), second.logout(), lateFirst.logout(), lateSecond.logout()]);
});

test('listen() refuses a compID that is empty, or a list with no CompIDs', { timeout: 10_000 }, async () => {
  for (const compID of ['', [], ['EXCHANGE', '']]) {
    await assert.rejects(listenAndClose({ compID, host: '127.0.0.1' }), { name: 'RangeError', message: 'compID must be a CompID or a list of CompIDs' }, JSON.stringify(compID));
  }
});

test('a session from connect() has no context', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  t.after(() => server.close(), { timeout: 5_000 });
  const client = await clientOf(server);
  assert.equal(client.context, undefined);
  assert.equal((await server.whenConnected('CLIENT')).context, undefined);
  await client.logout();
});

// ─── Connect ────────────────────────────────────────────────────────────────

test('connect rejects when nothing is listening', { timeout: 10_000 }, async () => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  const port = server.port;
  await server.close();
  await assert.rejects(connect({ host: '127.0.0.1', port }, { sender: 'CLIENT', target: 'EXCHANGE' }), { code: 'ECONNREFUSED' });
});

test('opening a socket gives up after the connect timeout, on the clock, and destroys the socket', { timeout: 2000 }, async () => {
  const clock = fakeClock();
  let destroyed = false;
  const neverConnects = () => Object.assign(new EventEmitter(), { destroy: () => { destroyed = true; } }) as unknown as Socket;
  const opening = openSocket('192.0.2.1', 65000, 300, clock, neverConnects);
  const check = assert.rejects(opening, (error: unknown) => error instanceof Error && error.name === 'TimeoutError');
  await clock.advance(299);
  assert.equal(destroyed, false);
  await clock.advance(1);
  await check;
  assert.equal(destroyed, true);
});

test('connect() gives up after connectTimeout, on its clock, when TCP never connects', { timeout: 2000 }, async t => {
  // Swap node:net's createConnection for one whose socket never connects. connect() reads the live binding.
  const net = createRequire(import.meta.url)('node:net') as typeof import('node:net');
  const original = net.createConnection;
  let destroyed = false;
  net.createConnection = (() => Object.assign(new EventEmitter(), { destroy: () => { destroyed = true; } })) as never;
  syncBuiltinESMExports();
  // t.after, not finally: if node:test times this test out it abandons the body, and a finally there would never run.
  t.after(() => {
    net.createConnection = original;
    syncBuiltinESMExports();
  });
  const clock = fakeClock();
  const connecting = connect('192.0.2.1:9878', { sender: 'CLIENT', target: 'EXCHANGE', clock, connectTimeout: '3s' });
  const check = assert.rejects(connecting, { name: 'TimeoutError', message: 'Could not connect to 192.0.2.1:9878 within 3000 ms', waitingFor: { kind: 'connect', address: '192.0.2.1:9878' } });
  await clock.advance('2999ms');
  assert.equal(destroyed, false);
  await clock.advance(1);
  await check;
  assert.equal(destroyed, true);
});

test('connect() waits for store.load() no longer than storeTimeout, on its clock, and then opens no connection', { timeout: 2000 }, async t => {
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())), { timeout: 5_000 });
  const port = (server.address() as { port: number }).port;
  const stuck: Store = { ...memoryStore(), load: () => new Promise(() => {}) };
  const clock = fakeClock();
  const connecting = connect({ host: '127.0.0.1', port }, { sender: 'CLIENT', target: 'EXCHANGE', clock, store: stuck, storeTimeout: '3s' });
  const check = assert.rejects(connecting, { name: 'TimeoutError', message: 'Store load took longer than 3 s', waitingFor: { kind: 'store' } });
  await clock.advance('2999ms');
  await clock.advance(1);
  await check;
  await sleep(50);
  assert.equal(connections, 0);
});

test('connect() honours logonTimeout', { timeout: 10_000 }, async () => {
  // A stream that's never read from never notices the peer's FIN either, which would leave this test's own
  // server.close() hanging forever; resume() it so it drains normally once the client (correctly) hangs up.
  const silent = createServer(socket => { socket.resume(); });
  await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve));
  const port = (silent.address() as { port: number }).port;
  const start = Date.now();
  await assert.rejects(connect({ host: '127.0.0.1', port }, { sender: 'CLIENT', target: 'EXCHANGE', logonTimeout: '300ms' }));
  assert.ok(Date.now() - start < 3000, 'logonTimeout should cut this off well short of the default 10s');
  await new Promise<void>(resolve => silent.close(() => resolve()));
});

test('connect() rejects bad options at once, before opening a socket', { timeout: 10_000 }, async t => {
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())), { timeout: 5_000 });
  const address = { host: '127.0.0.1', port: (server.address() as { port: number }).port };
  const cases: [Record<string, unknown>, string][] = [
    [{ logon: { NotAField: 1 } }, 'FIXEncodeError'],
    [{ logon: { ResetSeqNumFlag: 'maybe' } }, 'FIXEncodeError'],
    [{ heartbeat: 1.5 }, 'RangeError'],
    [{ heartbeat: -1 }, 'RangeError'],
    [{ logonTimeout: Number.NaN }, 'RangeError'],
    [{ logonTimeout: 0 }, 'RangeError'],
    [{ connectTimeout: 'soon' }, 'RangeError'],
    [{ storeTimeout: 0 }, 'RangeError'],
    [{ storeTimeout: 'soon' }, 'RangeError'],
    [{ version: 'FIX.9' }, 'RangeError'],
  ];
  for (const [options, name] of cases) {
    const start = Date.now();
    await assert.rejects(connect(address, { sender: 'CLIENT', target: 'EXCHANGE', logonTimeout: '2s', ...options }), { name }, JSON.stringify(options));
    assert.ok(Date.now() - start < 500, `${JSON.stringify(options)} took ${Date.now() - start} ms`);
  }
  assert.equal(connections, 0);
});

/** listen() with these options, closing the server if it starts anyway, so a failing check can't leave it open. */
async function listenAndClose(options: Parameters<typeof listen>[1]): Promise<void> {
  const server = await listen(0, options);
  await server.close();
}

test('listen() and connect() refuse a store without read, sent or list, up front', { timeout: 10_000 }, async () => {
  for (const missing of ['read', 'sent', 'list'] as const) {
    const { [missing]: _missing, ...store } = memoryStore();
    const refused = { name: 'RangeError', message: 'store must have load, append, read, sent, list and reset functions' };
    await assert.rejects(listenAndClose({ compID: 'EXCHANGE', host: '127.0.0.1', store: store as never }), refused, missing);
    await assert.rejects(connect({ host: '127.0.0.1', port: 1 }, { sender: 'CLIENT', target: 'EXCHANGE', store: store as never }), refused, missing);
  }
});

test('listen() refuses versions it does not support', { timeout: 10_000 }, async () => {
  await assert.rejects(listenAndClose({ compID: 'EXCHANGE', host: '127.0.0.1', versions: ['FIX.9' as never] }), { name: 'RangeError', message: /versions: FIX\.9 is not supported/ });
  await assert.rejects(listenAndClose({ compID: 'EXCHANGE', host: '127.0.0.1', versions: [] }), RangeError);
});

test('connect({ logoutTimeout }) bounds the wait for a Logout reply', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  t.after(() => server.close(), { timeout: 5_000 });
  const client = await clientOf(server, 'CLIENT', { logoutTimeout: '300ms' });
  const serverSide = await server.whenConnected('CLIENT');
  serverSide.incoming(message => (message.MsgType === 'Logout' ? null : message));
  const reason = await within(client.logout(), 3000, 'the unanswered Logout');
  assert.deepEqual([reason.by, reason.text], ['us', 'Logout was not answered']);
});

// ─── Timeouts pinned on a fake clock: never early, at most one tick late ─────

for (const value of [2500, '2500ms', '2.5s'] as const) {
  test(`listen({ limits: { logonTimeout } }) drops a silent connection at the timeout, not before (${JSON.stringify(value)})`, { timeout: 10_000 }, async t => {
    const clock = fakeClock();
    const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', clock, limits: { logonTimeout: value } });
    t.after(() => server.close(), { timeout: 5_000 });
    // The server arms its logon timer when it takes the connection, which can be after the client sees 'connect':
    // the fake clock must not move before then.
    const opened = new Promise<void>(resolve => { server.watch(entry => { if (entry.event === 'opened') resolve(); }); });
    const socket = netConnect(server.port, '127.0.0.1');
    await new Promise(resolve => socket.once('connect', resolve));
    await within(opened, 2000, 'the server taking the connection');
    const closed = closeOf(socket);
    let didClose = false;
    closed.then(() => { didClose = true; });
    socket.on('error', () => undefined);
    await clock.advance(2499);
    assert.equal(didClose, false, 'must not be dropped before the timeout');
    await clock.advance(1);
    await within(closed, 2000, 'dropping the silent connection at 2500 ms');
  });
}

test("connect({ logonTimeout: '3s' }) gives up on the session clock, not before, within one tick after", { timeout: 5000 }, async t => {
  const clock = fakeClock();
  let logonArrived!: () => void;
  const arrived = new Promise<void>(resolve => { logonArrived = resolve; });
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', clock, accept: () => { logonArrived(); return new Promise<true>(() => { /* never settles */ }); } });
  t.after(() => server.close(), { timeout: 5_000 });
  let outcome: unknown;
  const connecting = connect({ host: '127.0.0.1', port: server.port }, { sender: 'CLIENT', target: 'EXCHANGE', clock, logonTimeout: '3s' })
    .then(() => { outcome = 'active'; }, error => { outcome = error; });
  // The client's logon clock starts once TCP connects and its Logon goes out: the fake clock must not move before the Logon arrives.
  await within(arrived, 2000, 'the Logon reaching the server');
  await clock.advance(2999);
  assert.equal(typeof outcome, 'undefined', 'must not give up before logonTimeout');
  await clock.advance(1001);   // the check runs on a once-a-second tick; allow it to notice
  await connecting;
  assert.ok(outcome instanceof Error && outcome.name === 'FIXLogonError' && /Logon timed out/.test(outcome.message), `expected a logon timeout, got ${String(outcome)}`);
});

for (const side of ['client', 'server'] as const) {
  test(`${side} logoutTimeout closes on the session clock, not before, within one tick after`, { timeout: 10_000 }, async t => {
    const clock = fakeClock();
    const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', clock, ...(side === 'server' ? { logoutTimeout: 4000 } : {}) });
    t.after(() => server.close(), { timeout: 5_000 });
    const client = await connect({ host: '127.0.0.1', port: server.port }, { sender: 'CLIENT', target: 'EXCHANGE', clock, ...(side === 'client' ? { logoutTimeout: 4000 } : {}) });
    t.after(() => client.close(), { timeout: 5_000 });
    const serverSide = await server.whenConnected('CLIENT');
    const [loggingOut, peer] = side === 'client' ? [client, serverSide] : [serverSide, client];
    peer.incoming(message => (message.MsgType === 'Logout' ? null : message));
    let reason: { by: string; text: string } | undefined;
    const closing = loggingOut.logout().then(r => { reason = r; });
    await clock.advance(3999);
    assert.equal(typeof reason, 'undefined', 'must not close before logoutTimeout');
    await clock.advance(1001);
    await closing;
    assert.equal(reason?.text, 'Logout was not answered');
  });
}

for (const side of ['client', 'server'] as const) {
  test(`${side} storeTimeout closes a session whose store stops, on the session clock`, { timeout: 10_000 }, async t => {
    const clock = fakeClock();
    const base = memoryStore();
    let stopped = false;
    const store: Store = { ...base, append: (id, record, context) => (stopped ? new Promise<void>(() => {}) : base.append(id, record, context)) };
    const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', clock, ...(side === 'server' ? { store, storeTimeout: '3s' } : {}) });
    t.after(() => server.close(), { timeout: 5_000 });
    const client = await connect({ host: '127.0.0.1', port: server.port }, { sender: 'CLIENT', target: 'EXCHANGE', clock, ...(side === 'client' ? { store, storeTimeout: '3s' } : {}) });
    t.after(() => client.close(), { timeout: 5_000 });
    const serverSide = await server.whenConnected('CLIENT');
    const stopping = side === 'client' ? client : serverSide;
    stopped = true;
    void stopping.send('TestRequest', { TestReqID: 'held' }).catch(() => {});
    await new Promise<void>(resolve => setImmediate(resolve));
    await clock.advance('2s');
    assert.notEqual(stopping.state, 'closed', 'must not close before storeTimeout');
    await clock.advance('2s');   // storeTimeout, and up to one tick more
    assert.equal(stopping.state, 'closed');
    await clock.advance('10s');   // the bounded wait for the store to flush (logoutTimeout)
    const reason = await within(stopping.closed, 3000, 'the session closing');
    assert.deepEqual([reason.by, reason.text], ['us', 'Store write took longer than 3 s']);
  });
}

test('credentials are redacted in history and the store, but reach the counterparty as written', { timeout: 10_000 }, async t => {
  let seen: unknown;
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-redact-'));
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', store: fileStore(dir), accept: logon => { seen = logon.Password; return true; } });
  t.after(() => server.close(), { timeout: 5_000 });
  const client = await clientOf(server, 'CLIENT', { logon: { Username: 'desk7', Password: 'secret' } });
  const serverSide = await server.whenConnected('CLIENT');
  assert.equal(seen, 'secret');
  for (const [session, direction] of [[client, 'out'], [serverSide, 'in']] as const) {
    const logon = session.history.find(e => e.kind === 'message' && e.direction === direction && e.message.MsgType === 'Logon');
    assert.ok(logon?.kind === 'message' && logon.bytes);
    assert.deepEqual([logon.message.Username, logon.message.Password], ['desk7', '*****']);
    assert.match(Buffer.from(logon.bytes).toString('latin1'), /\x01554=\*\*\*\*\*\x01/);
  }
  await client.logout();
  await serverSide.closed;
  const stored = (await fileStore(dir).load(serverSide.id)).history.find(e => e.kind === 'message' && e.message.MsgType === 'Logon');
  assert.ok(stored?.kind === 'message' && stored.bytes, 'the redacted Logon is restored although its CheckSum no longer matches');
  assert.equal(stored.message.Password, '*****');
  assert.doesNotMatch(Buffer.from(stored.bytes).toString('latin1'), /secret/);
});

// ─── The connection feed ────────────────────────────────────────────────────

test('server.watch follows a connection from opened to closed, under the session\'s connection id', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  const client = await clientOf(server, 'CLIENT', { logon: { Password: 'secret' } });
  const serverSide = await server.whenConnected('CLIENT');
  await client.logout();
  await waitFor(() => feed.some(entry => entry.event === 'closed'), 2000, 'the closed entry');
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'received', 'loggedOn', 'closed']);
  assert.ok(feed.every(entry => entry.connectionId === serverSide.connectionId));
  assert.ok(feed.every(entry => entry.peer?.port === serverSide.peer?.port));
  const [, received, loggedOn, closed] = feed;
  const text = Buffer.from(received?.bytes ?? []).toString('latin1');
  assert.match(text, /\x0135=A\x01/);
  assert.match(text, /\x01554=\*\*\*\*\*\x01/);
  assert.doesNotMatch(text, /secret/);
  assert.deepEqual(loggedOn?.logon, { BeginString: 'FIX.4.4', SenderCompID: 'CLIENT', TargetCompID: 'EXCHANGE' });
  assert.equal(loggedOn?.sessionKey, serverSide.key);
  assert.equal(closed?.sessionKey, serverSide.key);
});

test('a refused Logon is in the feed with its CompIDs and the reason', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', accept: () => 'bad password' });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  await assert.rejects(clientOf(server), /bad password/);
  await waitFor(() => feed.some(entry => entry.event === 'closed'), 3000, 'the closed entry');
  const rejected = feed.find(entry => entry.event === 'rejected');
  assert.deepEqual(rejected?.problem, { code: 'LogonRefused', text: 'bad password', action: 'LoggedOut' });
  assert.deepEqual(rejected?.logon, { BeginString: 'FIX.4.4', SenderCompID: 'CLIENT', TargetCompID: 'EXCHANGE' });
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'received', 'rejected', 'closed']);
});

test('bytes that never become a Logon are in the feed, and the connection is dropped', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', limits: { maxMessageSize: 128 } });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  const socket = await rawConnect(server.port);
  const closed = closeOf(socket);
  socket.write(Buffer.alloc(256, 'x'));
  await closed;
  await waitFor(() => feed.some(entry => entry.event === 'closed'), 2000, 'the closed entry');
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'received', 'rejected', 'closed']);
  assert.equal(feed[1]?.bytes?.length, 256);
  assert.equal(feed[2]?.problem?.code, 'MessageTooLarge');
});

test('a TLS handshake on a plain listener is rejected as TLS on the plain port, and the connection is closed', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  const client = tlsConnect({ host: '127.0.0.1', port: server.port, rejectUnauthorized: false });
  await within(new Promise(resolve => client.once('error', resolve)), 2000, 'the TLS client to be cut off');
  await waitFor(() => feed.some(entry => entry.event === 'closed'), 2000, 'the closed entry');
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'received', 'rejected', 'closed']);
  assert.equal(feed[1]?.bytes?.[0], 0x16, 'the ClientHello is what was received');
  assert.deepEqual(feed[2]?.problem, { code: 'TLSMismatch', text: 'TLS on the plain port: this port does not use TLS', action: 'Disconnected' });
});

test('a Logon the session itself refuses is rejected in the feed with its problem', { timeout: 10_000 }, async t => {
  const store = memoryStore();
  await store.append({ version: 'FIX.4.4', sender: 'EXCHANGE', target: 'CLIENT' }, [{ at: new Date(), seqNums: { next: 1, expected: 5 } }]);
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', store });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  const socket = await rawConnect(server.port);
  socket.write(logonFrame('CLIENT'));   // MsgSeqNum 1, but 5 is expected
  await waitFor(() => feed.some(entry => entry.event === 'rejected'), 2000, 'the rejected entry');
  const rejected = feed.find(entry => entry.event === 'rejected');
  assert.equal(rejected?.problem?.code, 'SeqNumTooLow');
  assert.equal(rejected?.logon?.SenderCompID, 'CLIENT');
  assert.ok(!feed.some(entry => entry.event === 'loggedOn'));
  socket.destroy();
});

test('replay: true first reports the connections already open', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  t.after(() => server.close(), { timeout: 5_000 });
  const client = await clientOf(server);
  const serverSide = await server.whenConnected('CLIENT');
  const feed = feedOf(server, { replay: true });
  assert.deepEqual(feed.map(entry => [entry.event, entry.connectionId]), [['opened', serverSide.connectionId], ['loggedOn', serverSide.connectionId]]);
  assert.deepEqual(feed[0]?.at, serverSide.connectedAt);
  assert.deepEqual(feed[1]?.at, serverSide.loggedOnAt);
  await client.logout();
});

test('server-level failures are error entries in the feed, and never crash', { timeout: 10_000 }, async t => {
  const store: Store = { ...memoryStore(), load: async () => { throw new Error('store down'); } };
  const server = await listen(0, {
    compID: 'EXCHANGE', host: '127.0.0.1', store,
    accept: logon => { if (logon.SenderCompID === 'BAD') throw new Error('db down'); return true; },
  });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  await assert.rejects(clientOf(server, 'BAD'), /Logon refused/);
  const socket = await rawConnect(server.port);
  const closed = closeOf(socket);
  socket.write(logonFrame('CLIENT'));
  await closed;
  await waitFor(() => feed.filter(entry => entry.event === 'error').length >= 2, 2000, 'two error entries');
  const errors = feed.filter(entry => entry.event === 'error');
  assert.deepEqual(errors.map(entry => entry.error?.text), ['db down', 'store down']);
  assert.ok(errors.every(entry => typeof entry.connectionId === 'string' && entry.error?.stack?.includes('Error:')));
});

test('a watcher that throws is recorded as an error entry once, and never loops', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  let calls = 0;
  server.watch(entry => { calls++; if (entry.event === 'opened' || entry.event === 'error') throw new Error('watcher bug'); });
  const client = await clientOf(server);
  const errors = feed.filter(entry => entry.event === 'error');
  assert.deepEqual(errors.map(entry => entry.error?.text), ['watcher bug']);
  assert.equal(feed[1]?.event, 'error');
  assert.equal(feed[1]?.connectionId, feed[0]?.connectionId);
  assert.ok(calls >= 3);
  await client.logout();
});

test('a store that fails to load rejects the connection as Store unavailable, after its error entry', { timeout: 10_000 }, async t => {
  const store: Store = { ...memoryStore(), load: async () => { throw new Error('store down'); } };
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', store });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  const socket = await rawConnect(server.port);
  const closed = closeOf(socket);
  socket.write(logonFrame('CLIENT'));
  await within(closed, 2000, 'closing the connection');
  await waitFor(() => feed.some(entry => entry.event === 'closed'), 2000, 'the closed entry');
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'received', 'error', 'rejected', 'closed']);
  const rejected = feed.find(entry => entry.event === 'rejected');
  assert.deepEqual(rejected?.problem, { code: 'LogonRefused', text: 'Store unavailable', action: 'Disconnected' });
  assert.equal(rejected?.logon?.SenderCompID, 'CLIENT');
});

test('a connection dropped while its Logon is still pending is closed, not rejected', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  const socket = await rawConnect(server.port);
  socket.write(unreadableLogonFrame('CLIENT'));
  await waitFor(() => server.sessions.length === 1, 2000, 'the session to be created');
  assert.equal(server.sessions[0]?.state, 'loggingOn');
  socket.destroy();
  await waitFor(() => feed.some(entry => entry.event === 'closed'), 2000, 'the closed entry');
  await sleep(20);
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'received', 'closed']);
});

test('a connection is never rejected after it closed', { timeout: 10_000 }, async t => {
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const loading = new Promise<void>(resolve => { started = resolve; });
  const store: Store = { ...memoryStore(), load: async () => { started(); await released; throw new Error('store down'); } };
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', store });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  const socket = await rawConnect(server.port);
  socket.write(logonFrame('CLIENT'));
  await loading;
  socket.destroy();
  await waitFor(() => feed.some(entry => entry.event === 'closed'), 2000, 'the closed entry');
  release();
  await waitFor(() => feed.some(entry => entry.event === 'error'), 2000, 'the store\'s error entry');
  await sleep(20);
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'received', 'closed', 'error']);
});

test('accept() throwing and store.load failing never crash the process, even when onHandlerError throws', { timeout: 10_000 }, async t => {
  const crashes: string[] = [];
  const onUncaught = (error: unknown) => { crashes.push(`uncaughtException: ${String(error)}`); };
  const onUnhandled = (error: unknown) => { crashes.push(`unhandledRejection: ${String(error)}`); };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandled);
  });
  for (const onHandlerError of [undefined, () => { throw new Error('onHandlerError bug'); }]) {
    for (const fault of ['accept bug', 'store down'] as const) {
      const base = memoryStore();
      const store: Store = { ...base, load: async (id, context) => { if (fault === 'store down') throw new Error(fault); return base.load(id, context); } };
      const server = await listen(0, {
        compID: 'EXCHANGE', host: '127.0.0.1', store,
        ...(fault === 'accept bug' ? { accept: () => { throw new Error(fault); } } : {}),
        ...(onHandlerError ? { onHandlerError } : {}),
      });
      t.after(() => server.close(), { timeout: 5_000 });
      const feed = feedOf(server);
      await assert.rejects(clientOf(server, 'CLIENT', { logonTimeout: '2s' }));
      await waitFor(() => feed.some(entry => entry.event === 'closed'), 2000, 'the closed entry');
      await sleep(20);
      const errors = feed.filter(entry => entry.event === 'error').map(entry => entry.error?.text);
      assert.deepEqual(errors, onHandlerError ? [fault, 'onHandlerError bug'] : [fault]);
    }
  }
  await sleep(20);
  assert.deepEqual(crashes, []);
});

// ─── Server limits ──────────────────────────────────────────────────────────

test('connections past limits.connectionsPerAddress are closed at once, and reported', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', limits: { connectionsPerAddress: 2 } });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  const open = [await rawConnect(server.port), await rawConnect(server.port)];
  t.after(() => { for (const socket of open) socket.destroy(); });
  const third = await rawConnect(server.port);
  await within(closeOf(third), 2000, 'closing the third connection');
  const rejected = feed.find(entry => entry.event === 'rejected');
  assert.deepEqual(rejected?.problem, { code: 'ConnectionLimit', text: 'Too many connections from 127.0.0.1', action: 'Disconnected' });
});

test('connections past limits.pendingLogons are closed at once', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', limits: { pendingLogons: 1 } });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  const waiting = await rawConnect(server.port);
  t.after(() => waiting.destroy());
  const second = await rawConnect(server.port);
  await within(closeOf(second), 2000, 'closing the second connection');
  assert.equal(feed.find(entry => entry.event === 'rejected')?.problem?.text, 'Too many connections waiting to log on');
});

test('a Logon past limits.maxSessions is refused with a Logout saying so', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', limits: { maxSessions: 1 } });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  const first = await clientOf(server, 'A');
  await assert.rejects(clientOf(server, 'B'), /Logon failed: Too many sessions \(limit 1\)/);
  const rejected = feed.find(entry => entry.event === 'rejected');
  assert.equal(rejected?.problem?.code, 'ConnectionLimit');
  assert.equal(rejected?.logon?.SenderCompID, 'B');
  await first.logout();
});

test('listen() validates the server limits up front', { timeout: 10_000 }, async () => {
  for (const limits of [{ maxSessions: 0 }, { connectionsPerAddress: 1.5 }, { pendingLogons: -1 }, { processingTimeout: 0 }]) {
    await assert.rejects(listenAndClose({ compID: 'EXCHANGE', host: '127.0.0.1', limits }), RangeError, JSON.stringify(limits));
  }
});

test('a connection over a limit is opened, rejected and closed in the feed, in that order', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', limits: { pendingLogons: 1 } });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  const waiting = await rawConnect(server.port);
  t.after(() => waiting.destroy());
  await waitFor(() => feed.some(entry => entry.event === 'opened'), 2000, 'the server taking the first connection');
  const second = await rawConnect(server.port);
  await within(closeOf(second), 2000, 'closing the second connection');
  await waitFor(() => feed.some(entry => entry.event === 'closed'), 2000, 'the closed entry');
  const refused = feed.find(entry => entry.event === 'rejected')?.connectionId;
  assert.deepEqual(feed.filter(entry => entry.connectionId === refused).map(entry => entry.event), ['opened', 'rejected', 'closed']);
});

test('a connection that closes frees its place under limits.connectionsPerAddress and limits.pendingLogons', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', limits: { connectionsPerAddress: 1, pendingLogons: 1 } });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  const first = await rawConnect(server.port);
  first.destroy();
  await waitFor(() => feed.some(entry => entry.event === 'closed'), 2000, 'the first connection closing');
  const client = await clientOf(server, 'CLIENT');
  assert.equal(client.state, 'active');
  assert.ok(!feed.some(entry => entry.event === 'rejected'));
  await client.logout();
});

test('a session that logged on no longer counts against limits.pendingLogons', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', limits: { pendingLogons: 1 } });
  t.after(() => server.close(), { timeout: 5_000 });
  const a = await clientOf(server, 'A');
  const b = await clientOf(server, 'B');
  assert.deepEqual([a.state, b.state], ['active', 'active']);
  await Promise.all([a.logout(), b.logout()]);
});

test('a session whose received messages make no progress is closed after limits.processingTimeout', { timeout: 10_000 }, async t => {
  const clock = fakeClock();
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', manual: true, clock, limits: { processingTimeout: '5s' } });
  t.after(() => server.close(), { timeout: 5_000 });
  const socket = await rawConnect(server.port);
  t.after(() => socket.destroy());
  socket.write(logonFrame('CLIENT'));
  const serverSide = await server.whenConnected('CLIENT');
  let stuck!: () => void;
  const arrived = new Promise<void>(resolve => { stuck = resolve; });
  serverSide.incoming(() => { stuck(); return new Promise(() => {}); });   // never lets a message through
  socket.write(messageFrame('Heartbeat', 'CLIENT', 'EXCHANGE', 2, {}));
  await arrived;
  await clock.advance('6s');
  const reason = await within(serverSide.closed, 3000, 'the stalled session closing');
  assert.deepEqual([reason.by, reason.text], ['us', 'No progress on received messages for 5 s']);
});

test('a session is not closed while a handler holds a message for longer than limits.processingTimeout', { timeout: 10_000 }, async t => {
  const clock = fakeClock();
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', manual: true, clock, limits: { processingTimeout: '5s' } });
  t.after(() => server.close(), { timeout: 5_000 });
  const socket = await rawConnect(server.port);
  t.after(() => socket.destroy());
  socket.write(logonFrame('CLIENT'));
  const serverSide = await server.whenConnected('CLIENT');
  let held!: () => void;
  const holding = new Promise<void>(resolve => { held = resolve; });
  serverSide.on('NewOrderSingle', () => { held(); return new Promise(() => {}); });   // waits for a person who never answers
  socket.write(messageFrame('NewOrderSingle', 'CLIENT', 'EXCHANGE', 2, { ClOrdID: 'held', Side: 'Buy', OrdType: 'Market' }));
  await within(holding, 2000, 'the handler taking the order');
  await clock.advance('20s');
  assert.equal(serverSide.state, 'active');
  socket.write(messageFrame('NewOrderSingle', 'CLIENT', 'EXCHANGE', 3, { ClOrdID: 'next', Side: 'Buy', OrdType: 'Market' }));
  const next = await within(serverSide.next('NewOrderSingle', { where: { ClOrdID: 'next' }, timeout: 60_000 }), 2000, 'the next order');
  assert.equal(next.ClOrdID, 'next');
  await clock.advance('20s');
  assert.equal(serverSide.state, 'active');
});

test('a failure while starting an admitted session is an error entry, and the connection is closed', { timeout: 10_000 }, async t => {
  const crashes: unknown[] = [];
  const onUnhandled = (error: unknown) => { crashes.push(error); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => { process.off('unhandledRejection', onUnhandled); });
  // The session's once-a-second tick is armed when it attaches to its socket: make arming it fail.
  const clock: Clock = { ...systemClock, setTimeout: (fn, ms) => { if (ms === 1000) throw new Error('timer unavailable'); return systemClock.setTimeout(fn, ms); } };
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', clock });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  const socket = await rawConnect(server.port);
  const closed = closeOf(socket);
  socket.write(logonFrame('CLIENT'));
  await within(closed, 3000, 'closing the connection');
  await waitFor(() => feed.some(entry => entry.event === 'closed'), 2000, 'the closed entry');
  await sleep(20);
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'received', 'error', 'rejected', 'closed']);
  assert.equal(feed.find(entry => entry.event === 'error')?.error?.text, 'timer unavailable');
  await waitFor(() => server.sessions.length === 0, 2000, 'the session to be gone');
  assert.deepEqual(crashes, []);
});

test('listen() refuses a limits key it does not know, naming it', { timeout: 10_000 }, async () => {
  await assert.rejects(
    listenAndClose({ compID: 'EXCHANGE', host: '127.0.0.1', limits: { maxSesions: 1 } as never }),
    { name: 'RangeError', message: /limits: unknown setting 'maxSesions'/ },
  );
});

/** Move a fake clock a second at a time until `session` closes (or `seconds` pass); `each` runs before every step. Returns the seconds it took. */
async function secondsUntilClosed(clock: ReturnType<typeof fakeClock>, session: { state: string }, seconds: number, each: (second: number) => void = () => {}): Promise<number | undefined> {
  for (let second = 1; second <= seconds; second++) {
    each(second);
    await clock.advance(1000);
    if (session.state === 'closed') return second;
  }
  return undefined;
}

test('our own outgoing messages are not progress on received messages that are stuck', { timeout: 10_000 }, async t => {
  const clock = fakeClock();
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', manual: true, clock, limits: { processingTimeout: '5s' } });
  t.after(() => server.close(), { timeout: 5_000 });
  const socket = await rawConnect(server.port);
  t.after(() => socket.destroy());
  socket.write(logonFrame('CLIENT'));
  const serverSide = await server.whenConnected('CLIENT');
  let stuck!: () => void;
  const arrived = new Promise<void>(resolve => { stuck = resolve; });
  serverSide.incoming(() => { stuck(); return new Promise(() => {}); });
  socket.write(messageFrame('Heartbeat', 'CLIENT', 'EXCHANGE', 2, {}));
  await arrived;
  // The stuck session keeps sending every other second.
  let sent = 0;
  const took = await secondsUntilClosed(clock, serverSide, 20, second => {
    if (second % 2 === 0) void serverSide.send('TestRequest', { TestReqID: `t${second}` }).then(() => { sent++; }, () => undefined);
  });
  assert.ok(sent >= 2, `only ${sent} messages went out`);
  assert.ok(took !== undefined && took >= 5 && took <= 7, `closed after ${took} s; expected 5 to 7 s`);
  const reason = await serverSide.closed;
  assert.equal(reason.text, 'No progress on received messages for 5 s');
});

test('a stuck route closes the session after processingTimeout, before the heartbeat timeout would', { timeout: 20_000 }, async t => {
  const clock = fakeClock(new Date());
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', clock, limits: { processingTimeout: '45s' } });
  t.after(() => server.close(), { timeout: 5_000 });
  const socket = await rawConnect(server.port);
  t.after(() => socket.destroy());
  socket.write(logonFrame('CLIENT'));   // HeartBtInt 30
  const serverSide = await server.whenConnected('CLIENT');
  let stuck!: () => void;
  const arrived = new Promise<void>(resolve => { stuck = resolve; });
  serverSide.incoming(message => {
    if (message.MsgType !== 'NewOrderSingle') return message;
    stuck();
    return new Promise(() => {});
  });
  socket.write(messageFrame('NewOrderSingle', 'CLIENT', 'EXCHANGE', 2, { ClOrdID: 'stuck', Side: 'Buy', OrdType: 'Market' }));
  await arrived;
  const took = await secondsUntilClosed(clock, serverSide, 80);
  const reason = await serverSide.closed;
  assert.equal(reason.text, 'No progress on received messages for 45 s');
  assert.ok(took !== undefined && took >= 45 && took <= 47, `closed after ${took} s; expected 45 to 47 s`);
});

// ─── Credentials in what the server reports ─────────────────────────────────

/** Bytes as latin1 text inside JSON, so a test can search everything an entry shows. */
function shown(value: unknown): string {
  // The replacer sees a Buffer after its toJSON(); `this[key]` is still the Buffer itself.
  return JSON.stringify(value, function (this: Record<string, unknown>, key: string, item: unknown) {
    const original = this[key];
    return original instanceof Uint8Array ? Buffer.from(original).toString('latin1') : item;
  });
}

/** Everything a raw socket receives, as latin1 text. */
function receivedBy(socket: Socket): () => string {
  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => { chunks.push(chunk); });
  return () => Buffer.concat(chunks).toString('latin1');
}

for (const [label, fail] of [
  ['throws', (password: unknown) => { throw new Error(`bad password '${String(password)}'`); }],
  ['rejects', (password: unknown) => Promise.reject(new Error(`bad password '${String(password)}'`))],
] as const) {
  test(`accept() that ${label} quoting the Logon's password: neither the feed nor onHandlerError sees the password`, { timeout: 10_000 }, async t => {
    const errors: unknown[] = [];
    const server = await listen(0, {
      compID: 'EXCHANGE', host: '127.0.0.1', onHandlerError: error => errors.push(error),
      accept: logon => fail(logon.Password) as never,
    });
    t.after(() => server.close(), { timeout: 5_000 });
    const feed = feedOf(server);
    await assert.rejects(clientOf(server, 'CLIENT', { logon: { Password: 'S3cretPw' } }), /Logon refused/);
    await waitFor(() => feed.some(entry => entry.event === 'closed'), 3000, 'the closed entry');
    assert.equal(feed.find(entry => entry.event === 'error')?.error?.text, "bad password '*****'");
    assert.doesNotMatch(shown(feed), /S3cretPw/);
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof Error);
    assert.equal(errors[0].message, "bad password '*****'");
    assert.doesNotMatch(String(errors[0].stack), /S3cretPw/);
  });
}

test('a refusal from accept() quoting the password is masked in the feed, and the Logout carries it as written', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', accept: logon => `wrong password '${String(logon.Password)}'` });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  const socket = await rawConnect(server.port);
  t.after(() => socket.destroy());
  const reply = receivedBy(socket);
  socket.write(logonFrame('CLIENT', 'EXCHANGE', { Password: 'S3cretPw' }));
  await waitFor(() => feed.some(entry => entry.event === 'rejected'), 2000, 'the rejected entry');
  assert.deepEqual(feed.find(entry => entry.event === 'rejected')?.problem, { code: 'LogonRefused', text: "wrong password '*****'", action: 'LoggedOut' });
  assert.doesNotMatch(shown(feed), /S3cretPw/);
  await waitFor(() => reply().includes('\x0110='), 2000, 'the Logout');
  assert.match(reply(), /\x0158=wrong password 'S3cretPw'\x01/);
});

/** A frame from fields in the order given, with BodyLength and CheckSum that fit. */
function rawFrame(fields: readonly (readonly [string, string])[]): Buffer {
  const body = fields.map(([tag, value]) => `${tag}=${value}\x01`).join('');
  const head = `8=FIX.4.4\x019=${body.length}\x01${body}`;
  return Buffer.from(`${head}10=${checksum(Buffer.from(head, 'latin1'))}\x01`, 'latin1');
}

/** SendingTime as FIX writes it. */
const sendingTime = (date: Date) => date.toISOString().replace(/-/g, '').replace('T', '-').replace('Z', '');

test('a Logon whose MsgType is not the third field is ignored as garbled, and its RawData is hidden wherever it is shown', { timeout: 10_000 }, async t => {
  const base = memoryStore();
  const appended: Entry[] = [];
  const store: Store = { ...base, append: (id, records, context) => { for (const { entry } of records) if (entry) appended.push(entry); return base.append(id, records, context); } };
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', store });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  const socket = await rawConnect(server.port);
  socket.write(rawFrame([
    ['49', 'CLIENT'], ['56', 'EXCHANGE'], ['34', '1'], ['52', sendingTime(new Date())],
    ['95', '13'], ['96', 'R4wD@taSecret'], ['35', 'A'], ['98', '0'], ['108', '30'],
  ]));
  await waitFor(() => server.sessions.length === 1, 2000, 'the session to be created');
  const serverSide = server.sessions[0]!;
  await waitFor(() => serverSide.history.length > 0, 2000, 'the frame to be read');
  // Still waiting for a Logon it can read: this one was not answered.
  assert.equal(serverSide.state, 'loggingOn');
  assert.deepEqual(serverSide.history.map(entry => (entry.kind === 'problem' ? entry.problem : entry.kind)), [
    { code: 'Garbled', text: 'MsgType (35) must be the third field', action: 'Ignored' },
  ]);
  assert.ok(feed.some(entry => entry.event === 'received'));
  for (const [where, what] of [['the feed', feed], ['the history', serverSide.history], ['the store', appended]] as const) {
    assert.doesNotMatch(shown(what), /R4wD@taSecret/, where);
  }
  socket.destroy();
  await serverSide.closed;
});

// ─── Options checked up front ───────────────────────────────────────────────

test('listen() refuses options of the wrong kind, or with names it does not know, saying what is wrong', { timeout: 10_000 }, async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ heartbeat: 30 }, /heartbeat must be \{ min, max \} in whole seconds, got 30/],
    [{ limit: { maxSessions: 1 } }, /listen\(\) options: unknown setting 'limit'/],
    [{ store: 42 }, /store must have load, append, read, sent, list and reset functions/],
    [{ dictionary: 5 }, /dictionary must be one from defineDictionary\(\)/],
    [{ manual: 'yes' }, /manual must be true or false, got 'yes'/],
    [{ storeTimeout: 0 }, /storeTimeout must be a duration greater than 0/],
  ];
  for (const [options, message] of cases) {
    await assert.rejects(listenAndClose({ compID: 'EXCHANGE', host: '127.0.0.1', ...options } as never), { name: 'RangeError', message }, JSON.stringify(options));
  }
});

test('connect() refuses an empty sender or target before opening a socket', { timeout: 10_000 }, async t => {
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())), { timeout: 5_000 });
  const address = { host: '127.0.0.1', port: (server.address() as { port: number }).port };
  await assert.rejects(connect(address, { sender: '', target: 'EXCHANGE' }), { name: 'RangeError', message: /sender must be a CompID/ });
  await assert.rejects(connect(address, { sender: 'CLIENT', target: '' }), { name: 'RangeError', message: /target must be a CompID/ });
  assert.equal(connections, 0);
});

// ─── Closing the server ─────────────────────────────────────────────────────

test('a Logon that arrives while the server is closing is refused, and close() resolves once every connection closed', { timeout: 10_000 }, async () => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', logoutTimeout: '1s' });
  const feed = feedOf(server);
  const first = await rawConnect(server.port);   // logs on, then never answers our Logout
  first.write(logonFrame('FIRST'));
  await server.whenConnected('FIRST');
  const late = await rawConnect(server.port);
  const reply = receivedBy(late);
  await waitFor(() => feed.filter(entry => entry.event === 'opened').length === 2, 2000, 'the second connection');
  const closing = server.close();
  late.write(logonFrame('LATE'));
  await waitFor(() => feed.some(entry => entry.event === 'rejected'), 2000, 'the late Logon to be refused');
  assert.deepEqual(feed.find(entry => entry.event === 'rejected')?.problem, { code: 'LogonRefused', text: 'Server shutting down', action: 'LoggedOut' });
  await waitFor(() => reply().includes('\x0158=Server shutting down\x01'), 2000, 'the Logout to the late Logon');
  assert.ok(!server.sessions.some(session => session.id.target === 'LATE'));
  await within(closing, 5000, 'close()');
  assert.equal(feed.filter(entry => entry.event === 'closed').length, 2, 'both connections are closed before close() resolves');
  assert.ok(!feed.some(entry => entry.event === 'loggedOn' && entry.logon.SenderCompID === 'LATE'));
  first.destroy();
  late.destroy();
});

// ─── Timeouts that refuse with a Logout ─────────────────────────────────────

test('a session closed for making no progress on received messages first sends a Logout saying so', { timeout: 10_000 }, async t => {
  const clock = fakeClock(new Date());
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', clock, limits: { processingTimeout: '5s' } });
  t.after(() => server.close(), { timeout: 5_000 });
  const socket = await rawConnect(server.port);
  t.after(() => socket.destroy());
  const reply = receivedBy(socket);
  socket.write(logonFrame('CLIENT'));
  const serverSide = await server.whenConnected('CLIENT');
  let stuck!: () => void;
  const arrived = new Promise<void>(resolve => { stuck = resolve; });
  serverSide.incoming(message => {
    if (message.MsgType !== 'NewOrderSingle') return message;
    stuck();
    return new Promise(() => {});
  });
  socket.write(messageFrame('NewOrderSingle', 'CLIENT', 'EXCHANGE', 2, { ClOrdID: 'stuck', Side: 'Buy', OrdType: 'Market' }));
  await arrived;
  const took = await secondsUntilClosed(clock, serverSide, 20);
  assert.ok(took !== undefined && took >= 5 && took <= 7, `closed after ${took} s; expected 5 to 7 s`);
  const reason = await within(serverSide.closed, 3000, 'the session to close');
  assert.equal(reason.text, 'No progress on received messages for 5 s');
  await waitFor(() => /\x0135=5\x01/.test(reply()), 2000, 'the Logout');
  assert.match(reply(), /\x0135=5\x01[^]*\x0158=No progress on received messages for 5 s\x01/);
});

test('a Logon still waiting for accept() at the logon timeout is refused with a Logout saying so', { timeout: 10_000 }, async t => {
  const clock = fakeClock();
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', clock, limits: { logonTimeout: '2s' }, accept: () => new Promise<true>(() => {}) });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  const socket = await rawConnect(server.port);
  t.after(() => socket.destroy());
  const reply = receivedBy(socket);
  const closed = closeOf(socket);
  socket.write(logonFrame('CLIENT'));
  await waitFor(() => feed.some(entry => entry.event === 'received'), 2000, 'the server reading the Logon');
  await clock.advance('2s');
  await waitFor(() => reply().includes('\x0110='), 2000, 'the Logout');
  assert.match(reply(), /\x0135=5\x01[^]*\x0158=Logon timed out\x01/);
  assert.deepEqual(feed.find(entry => entry.event === 'rejected')?.problem, { code: 'LogonTimeout', text: 'Logon timed out', action: 'LoggedOut' });
  await within(closed, 3000, 'the connection to close');
  await waitFor(() => feed.some(entry => entry.event === 'closed'), 2000, 'the closed entry');
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'received', 'rejected', 'closed']);
  assert.equal(server.sessions.length, 0);
});

test('a connection that sent bytes but no Logon by the logon timeout is opened, received, rejected and closed in the feed, in that order', { timeout: 10_000 }, async t => {
  const clock = fakeClock();
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', clock, limits: { logonTimeout: '2s' } });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed = feedOf(server);
  const socket = await rawConnect(server.port);
  t.after(() => socket.destroy());
  const closed = closeOf(socket);
  await waitFor(() => feed.some(entry => entry.event === 'opened'), 2000, 'the server taking the connection');
  socket.write('8=FIX.4.4\x019=');   // the start of a frame, never finished
  await sleep(200);   // for the server to read it: nothing in the feed shows it until the connection ends
  await clock.advance('2s');
  await within(closed, 2000, 'the connection to close');
  await waitFor(() => feed.some(entry => entry.event === 'closed'), 2000, 'the closed entry');
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'received', 'rejected', 'closed']);
  assert.equal(feed.find(entry => entry.event === 'rejected')?.problem?.code, 'LogonTimeout');
});

test('a refused peer that keeps its side open is reset on real time, whatever the server clock says', { timeout: 10_000 }, async t => {
  const clock = fakeClock();   // never moved
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', clock });
  t.after(() => server.close(), { timeout: 5_000 });
  const socket = await rawConnect(server.port, { allowHalfOpen: true });
  const closed = closeOf(socket);
  socket.write(logonFrame('CLIENT', 'WRONG_TARGET'));
  await within(closed, 3000, 'the refused connection to be reset');
  socket.destroy();
});

test('a store.load() that never settles does not hold the CompID once the logon timeout closes the connection', { timeout: 15_000 }, async t => {
  let hang = true;
  const base = memoryStore();
  const store: Store = { ...base, load: (id, context) => (hang ? new Promise(() => {}) : base.load(id, context)) };
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', store, limits: { logonTimeout: 300, maxSessions: 1 } });
  t.after(() => server.close(), { timeout: 5_000 });
  await assert.rejects(clientOf(server), { name: 'FIXLogonError' });
  hang = false;
  const second = await clientOf(server);
  assert.equal(second.state, 'active');
  await second.logout();
});

test('settings the spec describes but that are not built yet are refused as not supported', { timeout: 10_000 }, async () => {
  await assert.rejects(listen(0, { compID: 'EXCHANGE', marketPrice: () => 1 } as never), /marketPrice is not supported yet/);
  await assert.rejects(listen(0, Object.create({ compID: 'EXCHANGE' }) as never), /an object with a custom prototype/);
});

// ─── A server offered more than it can answer ───────────────────────────────

const floodOrder = (n: number) => ({ ClOrdID: `o${n}`, Symbol: 'MSFT', Side: 'Buy', OrdType: 'Limit', OrderQty: 100, Price: 25.5, TransactTime: new Date() });
const reportFor = (order: Record<string, unknown>, n: number) => ({
  OrderID: `O${n}`, ExecID: `E${n}`, ClOrdID: order.ClOrdID, Symbol: order.Symbol, Side: order.Side,
  ExecType: 'New', OrdStatus: 'New', LeavesQty: order.OrderQty, CumQty: 0, AvgPx: 0,
});

/**
 * A memoryStore that keeps a list only when next() is called, one list a call, in the order the
 * lists were given; `kept` counts, for each counterparty, the NewOrderSingles received from it
 * whose records are kept.
 */
function listAtATimeStore() {
  const base = memoryStore();
  const waiting: (() => void)[] = [];
  const kept = new Map<string, number>();
  const store: Store = {
    ...base,
    async append(id, records, context) {
      await new Promise<void>(resolve => { waiting.push(resolve); });
      await base.append(id, records, context);
      for (const { entry } of records) {
        if (entry?.kind === 'message' && entry.direction === 'in' && entry.message.MsgType === 'NewOrderSingle') kept.set(id.target, (kept.get(id.target) ?? 0) + 1);
      }
    },
  };
  return { store, kept, next: () => { waiting.shift()?.(); } };
}

test('a server whose store keeps one list for each turn of the event loop, sent by four counterparties at once far more than it can keep: each session holds no more orders waiting for the store than memory.pendingBytes allows and no more bytes than one read, none is closed, and every order is answered in order', { timeout: 30_000 }, async t => {
  const pendingBytes = 4096;
  const clients = ['C1', 'C2', 'C3', 'C4'];
  const each = 1500;
  const { store, kept, next } = listAtATimeStore();
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', store, memory: { pendingBytes } });
  t.after(() => server.close(), { timeout: 5_000 });
  // The store's pace: one list, of whichever session, each turn of the event loop. Nothing here waits on the time of day.
  let pacing = true;
  t.after(() => { pacing = false; });
  const sides = new Map<string, FixSession>();
  let mostHeld = 0;
  void (async () => {
    while (pacing) {
      await tick();
      for (const side of sides.values()) mostHeld = Math.max(mostHeld, side.heldBytesForTests);
      next();
    }
  })();
  const closed: string[] = [];
  const handled = new Map<string, number>();
  let mostWaiting = 0;
  let reports = 0;
  server.on('Logon', (_logon, session) => { void session.closed.then(reason => { closed.push(`${session.id.target}: ${reason.text}`); }); });
  server.on('NewOrderSingle', (order, session) => {
    const from = session.id.target;
    handled.set(from, (handled.get(from) ?? 0) + 1);
    mostWaiting = Math.max(mostWaiting, handled.get(from)! - (kept.get(from) ?? 0));
    session.send('ExecutionReport', reportFor(order, ++reports)).catch(() => {});
  });
  const sessions = await Promise.all(clients.map(name => clientOf(server, name)));
  for (const name of clients) sides.set(name, await server.whenConnected(name) as unknown as FixSession);
  const orderBytes = sessions[0]!.encode('NewOrderSingle', floodOrder(each)).length;
  assert.ok(each * orderBytes > 40 * pendingBytes, `each counterparty sends ${each * orderBytes} bytes at once`);
  const answered = sessions.map(session => {
    const ids: string[] = [];
    session.on('ExecutionReport', report => { ids.push(String(report.ClOrdID)); });
    void session.closed.then(reason => { closed.push(`${session.id.sender}: ${reason.text}`); });
    return ids;
  });
  for (const session of sessions) for (let n = 0; n < each; n++) session.send('NewOrderSingle', floodOrder(n)).catch(() => {});
  await waitFor(() => closed.length > 0 || answered.every(ids => ids.length === each), 25_000, `every order to be answered (${answered.map(ids => ids.length).join(', ')} of ${each}; ${closed.join('; ')})`);
  assert.deepEqual(closed, [], 'no session is closed');
  const inOrder = Array.from({ length: each }, (_, n) => `o${n}`);
  for (const ids of answered) assert.deepEqual(ids, inOrder);
  // A slice is the orders up to the pause point and the one that passes it.
  const slice = Math.floor(pendingBytes / orderBytes) + 1;
  assert.ok(mostWaiting <= slice, `${mostWaiting} orders of one counterparty were taken in and not kept at once: more than the ${slice} that pass ${pendingBytes} bytes`);
  assert.ok(mostWaiting >= slice - 1, `only ${mostWaiting} at once: the store was never behind`);
  // One read of the socket, and the beginning of a message left from the read before.
  assert.ok(mostHeld <= 65_536 + orderBytes, `${mostHeld} bytes held by one session`);
  assert.ok(mostHeld > pendingBytes, `only ${mostHeld} bytes were ever held: nothing was sent faster than it was taken in`);
  assert.deepEqual([...sides.values()].map(side => [side.state, side.heldBytesForTests, side.unfinishedBytesForTests]), clients.map(() => ['active', 0, 0]));
});

test('a server with a memoryStore handles no more of one counterparty\'s flood between two turns of the event loop than memory.pendingBytes allows, and answers every order in order', { timeout: 30_000 }, async t => {
  const pendingBytes = 4096;
  const each = 3000;
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', memory: { pendingBytes } });
  t.after(() => server.close(), { timeout: 5_000 });
  // The turns of the event loop, counted.
  let turn = 0;
  let counting = true;
  t.after(() => { counting = false; });
  void (async () => { while (counting) { await tick(); turn++; } })();
  const inTurn = new Map<string, number>();
  let most = 0;
  let reports = 0;
  server.on('NewOrderSingle', (order, session) => {
    const key = `${session.id.target} ${turn}`;
    inTurn.set(key, (inTurn.get(key) ?? 0) + 1);
    most = Math.max(most, inTurn.get(key)!);
    session.send('ExecutionReport', reportFor(order, ++reports)).catch(() => {});
  });
  const sessions = await Promise.all(['C1', 'C2'].map(name => clientOf(server, name)));
  const orderBytes = sessions[0]!.encode('NewOrderSingle', floodOrder(each)).length;
  const answered = sessions.map(session => {
    const ids: string[] = [];
    session.on('ExecutionReport', report => { ids.push(String(report.ClOrdID)); });
    return ids;
  });
  for (const session of sessions) for (let n = 0; n < each; n++) session.send('NewOrderSingle', floodOrder(n)).catch(() => {});
  await waitFor(() => answered.every(ids => ids.length === each), 25_000, `every order to be answered (${answered.map(ids => ids.length).join(', ')} of ${each})`);
  const inOrder = Array.from({ length: each }, (_, n) => `o${n}`);
  for (const ids of answered) assert.deepEqual(ids, inOrder);
  const slice = Math.floor(pendingBytes / orderBytes) + 1;
  assert.ok(most <= slice, `${most} orders of one counterparty were handled in one turn of the event loop: more than the ${slice} that pass ${pendingBytes} bytes`);
  assert.deepEqual(sessions.map(session => session.state), ['active', 'active']);
});

test('two sessions that flood each other over a socket, each sending a megabyte at once, both receive everything: neither stops reading for good', { timeout: 30_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  t.after(() => server.close(), { timeout: 5_000 });
  const client = await clientOf(server);
  const side = await server.whenConnected('CLIENT');
  const each = 4000;
  const got = { client: 0, side: 0 };
  client.on('NewOrderSingle', () => { got.client++; });
  side.on('NewOrderSingle', () => { got.side++; });
  const fields = (n: number) => ({ ...floodOrder(n), Text: 'x'.repeat(120) });
  assert.ok(each * client.encode('NewOrderSingle', fields(each)).length > 1024 * 1024);
  for (let n = 0; n < each; n++) {
    client.send('NewOrderSingle', fields(n)).catch(() => {});
    side.send('NewOrderSingle', fields(n)).catch(() => {});
  }
  await waitFor(() => got.client === each && got.side === each, 25_000, `both to receive ${each} (${got.client}, ${got.side})`);
  assert.deepEqual([client.state, side.state], ['active', 'active']);
});

test('while its clock runs ahead of its store, a flooded server sends no TestRequest to a counterparty whose bytes it holds or whose socket it has paused, and closes none before it has answered it; one that logged on and sends nothing is asked and closed as ever', { timeout: 30_000 }, async t => {
  const clock = fakeClock(new Date());
  const { store, next } = listAtATimeStore();
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', store, clock, heartbeat: { min: 1, max: 60 }, memory: { pendingBytes: 4096 } });
  // Each turn of the event loop the store keeps one list of every session; once `running`, a second passes on
  // the server's clock for each turn. So a slice takes two seconds to keep, with the heartbeat interval one.
  let pacing = true;
  let running = false;
  const sockets: Socket[] = [];
  // The sockets first, and the clock running: the server's close() waits on its clock for the sessions still open.
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    running = true;
    await server.close();
    pacing = false;
  }, { timeout: 10_000 });
  void (async () => {
    while (pacing) {
      await tick();
      for (let session = 0; session < 4; session++) next();
      if (running) await clock.advance('1s');
    }
  })();
  const closed: string[] = [];
  const askedWhileBehind: string[] = [];
  let reports = 0;
  server.on('Logon', (_logon, session) => {
    const side = session as unknown as FixSession;
    void side.closed.then(reason => { closed.push(`${side.id.target}: ${reason.text}`); });
    side.outgoing(message => {
      if (message.MsgType === 'TestRequest' && (side.heldBytesForTests > 0 || side.readsPausedForTests)) askedWhileBehind.push(side.id.target);
      return message;
    });
  });
  server.on('NewOrderSingle', (order, session) => { session.send('ExecutionReport', reportFor(order, ++reports)).catch(() => {}); });
  // Counterparties that are sockets and nothing more: they answer no TestRequest and take no one for dead.
  const each = 300;
  const counterparty = async (name: string) => {
    const socket = await rawConnect(server.port);
    sockets.push(socket);
    const seen = { name, socket, answered: 0, asked: 0, gone: false, goneWhileOwed: false };
    const splitter = new FrameSplitter();
    socket.on('data', (chunk: Buffer) => {
      for (const frame of splitter.push(chunk)) {
        const text = Buffer.from(frame.bytes).toString('latin1');
        if (text.includes('\x0135=8\x01')) seen.answered++;
        if (text.includes('\x0135=1\x01')) seen.asked++;
      }
    });
    socket.once('close', () => { seen.gone = true; seen.goneWhileOwed = name !== 'SILENT' && seen.answered < each; });
    socket.write(logonFrame(name, 'EXCHANGE', { HeartBtInt: 1 }));
    await server.whenConnected(name);
    return seen;
  };
  const flooders = await Promise.all(['F1', 'F2', 'F3'].map(counterparty));
  const silent = await counterparty('SILENT');
  for (const { name, socket } of flooders) {
    socket.write(Buffer.concat(Array.from({ length: each }, (_, n) => messageFrame('NewOrderSingle', name, 'EXCHANGE', n + 2, floodOrder(n)))));
  }
  running = true;
  await waitFor(() => flooders.every(seen => seen.answered === each || seen.gone) && silent.gone, 25_000, `every order to be answered (${flooders.map(seen => seen.answered).join(', ')} of ${each}; closed: ${closed.join('; ')})`);
  running = false;
  assert.deepEqual(flooders.map(seen => [seen.name, seen.answered, seen.goneWhileOwed]), flooders.map(seen => [seen.name, each, false]), `closed: ${closed.join('; ')}`);
  assert.deepEqual(askedWhileBehind, [], 'TestRequests sent to counterparties while the server held their bytes or had paused their sockets');
  // The one that sent nothing had no bytes held and no read paused: 1.2 s of silence, a TestRequest, a second more, the end.
  assert.deepEqual([silent.asked, silent.gone], [1, true]);
  await waitFor(() => closed.includes('SILENT: Heartbeat timeout'), 5_000, `the silent one's session to close (${closed.join('; ')})`);
});
