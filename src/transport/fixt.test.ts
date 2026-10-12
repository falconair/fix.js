// FIXT.1.1 over real sockets: connect() and listen() carrying FIX 5.0 SP2.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connect as netConnect, createServer, type AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineDictionary, type DictionaryDef } from '../dictionary/define.ts';
import { FIXLogonError } from '../errors.ts';
import { ApplVerID, Version } from '../version.ts';
import type { MessageObject } from '../wire/message.ts';
import type { Server, Session } from './api.ts';
import { entryFromJSON, entryToJSON } from './json.ts';
import { connect, type ConnectOptions } from './net.ts';
import { listen, type ListenOptions } from './server.ts';
import { peerClose } from './sockets.ts';
import { fileStore, memoryStore } from './store.ts';
import type { ConnectionEntry, Entry, Store } from './types.ts';

// A refused peer gets 200 ms, not 1 s, to close its end.
peerClose.waitMs = 200;

const FIXT = Version['FIXT.1.1'];
const shown = (bytes: Uint8Array | undefined): string => Buffer.from(bytes ?? []).toString('latin1').replaceAll('\x01', '|');

/** A server on a free port (we are EXCHANGE), closed when the test ends. */
async function exchange(t: TestContext, options: Partial<ListenOptions> = {}): Promise<Server> {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', ...options });
  t.after(() => server.close(), { timeout: 5_000 });
  return server;
}

/** What listen() refuses these options with. A server that opens all the same is closed, so that the test fails and ends. */
async function refusal(options: Partial<ListenOptions>): Promise<{ name: string; message: string } | undefined> {
  try {
    await (await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', ...options })).close();
    return undefined;
  } catch (error) {
    return error instanceof Error ? { name: error.name, message: error.message } : { name: typeof error, message: String(error) };
  }
}

/** A FIXT.1.1 client (CLIENT, unless `options` says another) of `server`. */
const client = (server: Server, options: Partial<ConnectOptions> = {}): Promise<Session> =>
  connect({ host: '127.0.0.1', port: server.port }, { sender: 'CLIENT', target: 'EXCHANGE', version: FIXT, ...options });

/**
 * A FIXT.1.1 Logon written by hand, as no session would send it: `fields` are what follows SendingTime.
 * Sent on a socket of its own; resolves with what came back, each delimiter shown as '|'.
 */
function rawLogon(server: Server, sender: string, fields: readonly string[]): Promise<string> {
  const time = new Date().toISOString().replaceAll('-', '').replace('T', '-').slice(0, 21);
  const body = ['35=A', `49=${sender}`, '56=EXCHANGE', '34=1', `52=${time}`, ...fields, ''].join('\x01');
  const head = `8=FIXT.1.1\x019=${body.length}\x01${body}`;
  const sum = Buffer.from(head, 'latin1').reduce((total, byte) => total + byte, 0) % 256;
  return new Promise(resolve => {
    const socket = netConnect(server.port, '127.0.0.1', () => socket.write(`${head}10=${String(sum).padStart(3, '0')}\x01`, 'latin1'));
    let received = '';
    socket.on('data', chunk => { received += chunk.toString('latin1'); socket.destroy(); });
    socket.on('error', () => undefined);
    socket.on('close', () => resolve(received.replaceAll('\x01', '|')));
  });
}

/** An order only FIX 5.0 SP2 can carry: FIX 4.4 has no RateSource group. */
const ORDER = {
  ClOrdID: 'A1', Symbol: 'IBM', Side: 'Buy', OrderQty: 100, OrdType: 'Limit', Price: 10,
  RateSource: [{ RateSource: 'Bloomberg', RateSourceType: 'Primary' }],
};

const messages = (entries: readonly Entry[], direction?: 'in' | 'out'): Extract<Entry, { kind: 'message' }>[] =>
  entries.filter((entry): entry is Extract<Entry, { kind: 'message' }> => entry.kind === 'message' && (direction === undefined || entry.direction === direction));
const problemsOf = (session: Session): Entry[] => session.history.filter(entry => entry.kind === 'problem' || entry.kind === 'error');

test('connect() and listen() speak FIXT.1.1 carrying FIX 5.0 SP2: logon, an order and its report, logout', { timeout: 10_000 }, async t => {
  const server = await exchange(t);
  const orders: MessageObject[] = [];
  server.on('NewOrderSingle', async (order, session) => {
    orders.push(order);
    // Without AvgPx: FIX 4.4 requires it in an ExecutionReport, and FIX 5.0 SP2 does not.
    await session.send('ExecutionReport', {
      OrderID: 'O1', ExecID: 'E1', ExecType: 'New', OrdStatus: 'New', ClOrdID: order.ClOrdID, Symbol: order.Symbol, Side: order.Side, LeavesQty: 100, CumQty: 0,
    });
  });
  const session = await client(server);
  assert.deepEqual(session.id, { version: 'FIXT.1.1', sender: 'CLIENT', target: 'EXCHANGE' });
  assert.equal(session.key, 'FIXT.1.1:CLIENT:EXCHANGE');
  const theirs = server.session('CLIENT');
  assert.equal(theirs?.key, 'FIXT.1.1:EXCHANGE:CLIENT');

  await session.send('NewOrderSingle', ORDER);
  const report = await session.next('ExecutionReport');
  assert.deepEqual({ begin: report.BeginString, status: report.OrdStatus, leaves: report.LeavesQty }, { begin: 'FIXT.1.1', status: 'New', leaves: 100 });
  assert.deepEqual(orders[0]?.RateSource, ORDER.RateSource);

  // On the wire: the Logon each way names FIX 5.0 SP2 (1137=9), and the order carries its group.
  const frames = messages(session.history).map(entry => `${entry.direction} ${shown(entry.bytes)}`);
  assert.match(frames[0]!, /^out 8=FIXT\.1\.1\|9=\d+\|35=A\|.*\|98=0\|108=30\|1137=9\|10=\d{3}\|$/);
  assert.match(frames[1]!, /^in 8=FIXT\.1\.1\|9=\d+\|35=A\|.*\|98=0\|108=30\|1137=9\|10=\d{3}\|$/);
  assert.match(frames[2]!, /^out 8=FIXT\.1\.1\|9=\d+\|35=D\|.*\|1445=1\|1446=0\|1447=0\|/);

  assert.deepEqual(await session.logout(), { by: 'us', text: 'Logout confirmed' });
  assert.deepEqual([problemsOf(session), theirs && problemsOf(theirs)], [[], []]);
});

test('an order naming an application version fix.js does not read is rejected, the session carries on, and its later clean logout carries no problem', { timeout: 10_000 }, async t => {
  const server = await exchange(t);
  const session = await client(server);
  const theirs = server.session('CLIENT')!;
  const rejected = session.next('Reject');
  await session.send('NewOrderSingle', { ...ORDER, ApplVerID: 'FIX44' });
  assert.equal((await rejected).SessionRejectReason, 'InvalidUnsupportedAppVersion');
  assert.deepEqual(theirs.history.flatMap(entry => (entry.kind === 'problem' ? [[entry.problem.code, entry.problem.action]] : [])), [['InvalidUnsupportedAppVersion', 'Rejected']]);
  assert.deepEqual(await theirs.logout(), { by: 'us', text: 'Logout confirmed' });
});

test('a FIXT.1.1 Logon naming no application version, or one fix.js does not read, is refused before a session exists: accept() and the store are not asked', { timeout: 10_000 }, async t => {
  let accepted = 0;
  let loaded = 0;
  const kept = memoryStore();
  const store: Store = { ...kept, load: (id, context) => { loaded++; return kept.load(id, context); } };
  const server = await exchange(t, { store, accept: () => { accepted++; return true; } });
  const feed: ConnectionEntry[] = [];
  server.watch(entry => feed.push(entry));

  await assert.rejects(client(server, { logon: { DefaultApplVerID: 'FIX44' } }), /Logon failed: DefaultApplVerID FIX44 is not supported; use FIX50, FIX50SP1, FIX50SP2 or FIXLatest/);
  await assert.rejects(client(server, { sender: 'CLIENT2', logon: { DefaultApplVerID: null } }), /Logon failed: DefaultApplVerID \(1137\) is required in a FIXT\.1\.1 Logon/);
  await assert.rejects(client(server, { sender: 'CLIENT3', logon: { 1137: '33' } }), /Logon failed: DefaultApplVerID 33 is not supported; use FIX50, FIX50SP1, FIX50SP2 or FIXLatest/);
  // The frame's own text is what counts: a version's name where FIX sends its number, and the field twice, are refused there too.
  await assert.rejects(client(server, { sender: 'CLIENT5', logon: { 1137: 'FIX50SP2' } }), /Logon failed: DefaultApplVerID \(1137\) has no value 'FIX50SP2': FIX50SP2 is sent as 9$/);
  assert.match(await rawLogon(server, 'CLIENT6', ['98=0', '108=30', '1137=9', '1137=9']), /^8=FIXT\.1\.1\|9=\d+\|35=5\|.*\|58=Tag 1137 appears more than once\|10=\d{3}\|$/);
  assert.match(await rawLogon(server, 'CLIENT7', ['98=0', '108=30', '1137=6', '1137=9']), /\|35=5\|.*\|58=Tag 1137 appears more than once\|/);
  // Bytes that are not printable ASCII are not echoed: the Logout's Text is ASCII.
  const bytes = await rawLogon(server, 'CLIENT9', ['98=0', '108=30', `1137=${'\xff'.repeat(33)}`]);
  assert.match(bytes, /\|58=DefaultApplVerID \?{32}\.\.\. is not supported; use FIX50, FIX50SP1, FIX50SP2 or FIXLatest\|/);
  assert.doesNotMatch(bytes, /[^\x20-\x7e]/);
  // A value of 30 KB is quoted by its first 32 characters, not sent back whole.
  const long = await rawLogon(server, 'CLIENT8', ['98=0', '108=30', `1137=${'x'.repeat(30_000)}`]);
  assert.match(long, new RegExp(`\\|58=DefaultApplVerID ${'x'.repeat(32)}\\.\\.\\. is not supported; use FIX50, FIX50SP1, FIX50SP2 or FIXLatest\\|`));
  assert.ok(long.length < 400, `${long.length} characters came back`);
  assert.deepEqual([accepted, loaded, server.sessions.length], [0, 0, 0]);
  const rejected = feed.flatMap(entry => (entry.event === 'rejected' ? [[entry.logon?.SenderCompID, entry.logon?.BeginString, entry.problem.code, entry.problem.action]] : []));
  assert.deepEqual(rejected, ['CLIENT', 'CLIENT2', 'CLIENT3', 'CLIENT5', 'CLIENT6', 'CLIENT7', 'CLIENT9', 'CLIENT8'].map(sender => [sender, 'FIXT.1.1', 'LogonRefused', 'LoggedOut']));

  // One of the four is taken: then accept() and the store are asked, once each.
  const session = await client(server, { sender: 'CLIENT4', logon: { DefaultApplVerID: ApplVerID.FIX50 } });
  assert.deepEqual([accepted, loaded], [1, 1]);
  assert.equal(messages(session.history, 'in')[0]?.message.DefaultApplVerID, 'FIX50');
  await session.logout();
});

test('a FIXT.1.1 Logon that carries MsgType twice is refused like one with any other tag twice, and no session is left', { timeout: 10_000 }, async t => {
  const server = await exchange(t);
  const twice = await rawLogon(server, 'CLIENT', ['35=A', '98=0', '108=30', '1137=9']);
  assert.match(twice, /^8=FIXT\.1\.1\|9=\d+\|35=5\|.*\|58=Tag 35 appears more than once\|10=\d{3}\|$/);
  assert.match(await rawLogon(server, 'CLIENT', ['108=30', '108=30', '98=0', '1137=9']), /\|35=5\|.*\|58=Tag 108 appears more than once\|/);
  assert.equal(server.sessions.length, 0);
});

test('connect() refuses a Logon reply that does not name an application version it reads, with a problem that says which; one naming another of the four is taken', { timeout: 10_000 }, async t => {
  // A counterparty written by hand: it answers the first thing it is sent with a Logon carrying these fields.
  const answering = async (fields: readonly string[]): Promise<{ readonly logon: Promise<Session> }> => {
    const peer = createServer(socket => {
      socket.on('error', () => undefined);
      socket.once('data', () => {
        const time = new Date().toISOString().replaceAll('-', '').replace('T', '-').slice(0, 21);
        const body = ['35=A', '49=EXCHANGE', '56=CLIENT', '34=1', `52=${time}`, '98=0', '108=30', ...fields, ''].join('\x01');
        const head = `8=FIXT.1.1\x019=${body.length}\x01${body}`;
        const sum = Buffer.from(head, 'latin1').reduce((total, byte) => total + byte, 0) % 256;
        socket.write(`${head}10=${String(sum).padStart(3, '0')}\x01`, 'latin1');
      });
    });
    await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve));
    t.after(() => { peer.close(); });
    return { logon: connect({ host: '127.0.0.1', port: (peer.address() as AddressInfo).port }, { sender: 'CLIENT', target: 'EXCHANGE', version: FIXT }) };
  };
  const refused = async (fields: readonly string[]): Promise<unknown> => {
    const error = await (await answering(fields)).logon.then(() => undefined, (thrown: unknown) => thrown);
    assert.ok(error instanceof FIXLogonError, `a reply with ${fields.join(' ') || 'no 1137'} must be refused`);
    return [error.reason.problem?.code, error.reason.problem?.text, error.reason.problem?.action];
  };
  assert.deepEqual(await refused(['1137=6']), ['InvalidUnsupportedAppVersion', 'DefaultApplVerID FIX44 is not supported; use FIX50, FIX50SP1, FIX50SP2 or FIXLatest', 'LoggedOut']);
  assert.deepEqual(await refused([]), ['RequiredTagMissing', 'DefaultApplVerID (1137) is required', 'LoggedOut']);
  assert.deepEqual(await refused(['1137=']), ['TagSpecifiedWithoutAValue', 'DefaultApplVerID (1137) has no value', 'LoggedOut']);
  assert.deepEqual(await refused(['1137=33']), ['ValueIsIncorrect', "DefaultApplVerID (1137) has no value '33'", 'LoggedOut']);
  assert.deepEqual(await refused(['1137=9', '1137=9']), ['TagAppearsMoreThanOnce', 'Tag 1137 appears more than once', 'LoggedOut']);
  // FIX Latest in answer to FIX 5.0 SP2: both are read, so the session logs on.
  const session = await (await answering(['1137=10'])).logon;
  assert.deepEqual([session.state, problemsOf(session)], ['active', []]);
  session.close();
});

test('accept() sees the application version a Logon names and can turn one away; the answer to a Logon names the same version', { timeout: 10_000 }, async t => {
  const seen: unknown[] = [];
  const server = await exchange(t, {
    accept: logon => {
      seen.push(logon.DefaultApplVerID);
      return logon.DefaultApplVerID === ApplVerID.FIXLatest || 'Only FIX Latest here';
    },
  });
  await assert.rejects(client(server), /Logon failed: Only FIX Latest here/);
  const session = await client(server, { logon: { DefaultApplVerID: ApplVerID.FIXLatest } });
  assert.deepEqual(seen, ['FIX50SP2', 'FIXLatest']);
  assert.deepEqual(messages(session.history).map(entry => [entry.direction, entry.message.MsgType, entry.message.DefaultApplVerID]),
    [['out', 'Logon', 'FIXLatest'], ['in', 'Logon', 'FIXLatest']]);
  await session.logout();
});

test('a server takes FIXT.1.1 unless its versions leave it out; a version neither side knows is a RangeError naming the three', { timeout: 10_000 }, async t => {
  const fix44Only = await exchange(t, { versions: [Version['FIX.4.4']] });
  await assert.rejects(client(fix44Only), /Logon failed: BeginString FIXT\.1\.1 is not supported/);
  // The BeginString is looked at first: there, a FIXT.1.1 Logon that names no application version is refused for its version.
  await assert.rejects(client(fix44Only, { logon: { DefaultApplVerID: null } }), /Logon failed: BeginString FIXT\.1\.1 is not supported/);
  const fixtOnly = await exchange(t, { versions: [FIXT] });
  await assert.rejects(client(fixtOnly, { version: Version['FIX.4.4'] }), /Logon failed: BeginString FIX\.4\.4 is not supported/);
  await (await client(fixtOnly)).logout();

  await assert.rejects(client(fixtOnly, { version: 'FIX.5.0' as never }), { name: 'RangeError', message: 'version FIX.5.0 is not supported; use FIX.4.2, FIX.4.4 or FIXT.1.1' });
  await assert.rejects(listen(0, { compID: 'EXCHANGE', versions: ['FIX.5.0' as never] }), { name: 'RangeError', message: 'versions: FIX.5.0 is not supported; use FIX.4.2, FIX.4.4 or FIXT.1.1' });
});

test('a mid-session reset is sent the same way under FIXT.1.1: the session fills in the application version it named, in what it sends and in encode()', { timeout: 10_000 }, async t => {
  const server = await exchange(t);
  const session = await client(server, { logon: { DefaultApplVerID: ApplVerID.FIX50SP1 } });
  const sent = await session.send('Logon', { EncryptMethod: 'None', HeartBtInt: session.heartbeat, ResetSeqNumFlag: true });
  assert.deepEqual({ seq: sent.MsgSeqNum, named: sent.DefaultApplVerID }, { seq: 1, named: 'FIX50SP1' });
  const reply = await session.next('Logon', { where: { ResetSeqNumFlag: true } });
  assert.deepEqual({ seq: reply.MsgSeqNum, named: reply.DefaultApplVerID }, { seq: 1, named: 'FIX50SP1' });
  assert.deepEqual(session.seqNums, { next: 2, expected: 2 });
  assert.match(shown(session.encode('Logon', { EncryptMethod: 'None', HeartBtInt: 30 })), /\|98=0\|108=30\|1137=8\|/);
  assert.match(shown(session.encode('Logon', { EncryptMethod: 'None', HeartBtInt: 30, DefaultApplVerID: 'FIXLatest' })), /\|1137=10\|/);
  await session.logout();
});

test("a FIXT.1.1 session's log is kept by a fileStore and read back by a store that never saw the session; its sequence numbers carry over", { timeout: 10_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-fixt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const server = await exchange(t);
  const first = await client(server, { store: fileStore(dir) });
  await first.send('NewOrderSingle', ORDER);
  await first.logout();

  const reader = fileStore(dir);
  const [stored] = await reader.list();
  assert.deepEqual(stored?.id, { version: 'FIXT.1.1', sender: 'CLIENT', target: 'EXCHANGE' });
  const read: Entry[] = [];
  for await (const entry of reader.read(stored!.id)) read.push(entry);
  const kept = messages(read);
  assert.deepEqual(kept.map(entry => `${entry.direction} ${String(entry.message.MsgType)}`).sort(), ['in Logon', 'in Logout', 'out Logon', 'out Logout', 'out NewOrderSingle']);
  // Read with the FIX 5.0 SP2 dictionary, with no session at hand: the group by its name, the application version by its.
  const order = kept.find(entry => entry.message.MsgType === 'NewOrderSingle');
  assert.deepEqual(order?.message.RateSource, ORDER.RateSource);
  assert.equal(order?.message.BeginString, 'FIXT.1.1');
  assert.equal(kept.find(entry => entry.message.MsgType === 'Logon' && entry.direction === 'out')?.message.DefaultApplVerID, 'FIX50SP2');

  // A second session on that store carries on: its Logon is MsgSeqNum 4, and the answer is 3.
  const second = await client(server, { store: fileStore(dir) });
  assert.deepEqual(second.seqNums, { next: 5, expected: 4 });
  assert.deepEqual(problemsOf(second), []);
  await second.logout();
});

test('entryToJSON() and entryFromJSON() carry a FIXT.1.1 message both ways, a group and a field of one name included', { timeout: 10_000 }, async t => {
  const server = await exchange(t);
  const session = await client(server);
  await session.send('NewOrderSingle', ORDER);
  const entry = messages(session.history, 'out').find(each => each.message.MsgType === 'NewOrderSingle')!;
  const json = JSON.parse(JSON.stringify(entryToJSON(entry))) as { message: Record<string, unknown> };
  assert.equal(json.message.BeginString, 'FIXT.1.1');
  const back = entryFromJSON(json);
  assert.ok(back.kind === 'message');
  assert.deepEqual(back.message, { ...entry.message });
  assert.deepEqual(back.message.RateSource, ORDER.RateSource);
  assert.ok(back.message.TransactTime instanceof Date);
  assert.deepEqual(back.bytes, entry.bytes);
  assert.throws(() => entryFromJSON({ ...json, message: { ...json.message, BeginString: 'FIX.5.0' } }),
    { name: 'RangeError', message: "entryFromJSON: message.BeginString must be a supported version (FIX.4.2, FIX.4.4 or FIXT.1.1), got 'FIX.5.0'" });
  await session.logout();
});

test('EncryptedPassword and EncryptedNewPassword are hidden wherever a Logon is recorded; accept() and the wire have them', { timeout: 10_000 }, async t => {
  const seen: unknown[] = [];
  const server = await exchange(t, { accept: logon => { seen.push(logon.EncryptedPassword, logon.EncryptedNewPassword); return true; } });
  const feed: ConnectionEntry[] = [];
  server.watch(entry => feed.push(entry));
  // Data fields: any byte may be in them, a field delimiter included, so they are read by the length before them.
  const session = await client(server, {
    logon: { EncryptedPasswordLen: 9, EncryptedPassword: 's3cr3t\x01pw', EncryptedNewPasswordLen: 10, EncryptedNewPassword: 'n3w\x01s3cr3t' },
  });
  assert.deepEqual(seen, ['s3cr3t\x01pw', 'n3w\x01s3cr3t']);
  const theirs = server.session('CLIENT')!;
  const ours = messages(session.history, 'out')[0]!;
  assert.deepEqual([ours.message.EncryptedPassword, ours.message.EncryptedNewPassword], ['*****', '*****']);
  const recorded = [
    ...[...session.history, ...theirs.history].map(entry => JSON.stringify(entryToJSON(entry)) + shown(entry.kind === 'message' ? entry.bytes : undefined)),
    ...feed.map(entry => JSON.stringify(entryToJSON(entry)) + shown(entry.event === 'received' ? entry.bytes : undefined)),
  ];
  assert.deepEqual(recorded.filter(text => text.includes('s3cr3t')), []);
  // Before a session exists, too, each is hidden as the data field it is: what follows it in the Logon stays readable.
  const received = feed.find(entry => entry.event === 'received');
  assert.match(shown(received?.bytes), /\|1401=5\|1402=\*{5}\|1403=5\|1404=\*{5}\|1137=9\|10=\d{3}\|$/);
  await session.logout();
});

test('EncryptedPassword and EncryptedNewPassword are hidden in the store, in what watch() gives and in a refusal that quotes one, on both sides', { timeout: 10_000 }, async t => {
  const dirs = [await mkdtemp(join(tmpdir(), 'fixjs-fixt-')), await mkdtemp(join(tmpdir(), 'fixjs-fixt-'))] as const;
  t.after(() => Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))));
  const server = await exchange(t, {
    store: fileStore(dirs[0]),
    accept: logon => logon.SenderCompID === 'CLIENT' || `No account for '${String(logon.EncryptedPassword)}'`,
  });
  const feed: ConnectionEntry[] = [];
  server.watch(entry => feed.push(entry));
  const secrets = { EncryptedPasswordLen: 9, EncryptedPassword: 's3cr3t\x01pw', EncryptedNewPasswordLen: 10, EncryptedNewPassword: 'n3w\x01s3cr3t' };
  const session = await client(server, { store: fileStore(dirs[1]), logon: secrets });
  const theirs = server.session('CLIENT')!;
  const watched: Entry[] = [];
  session.watch(entry => watched.push(entry));
  theirs.watch(entry => watched.push(entry));
  // A Logon that resets the sequence numbers carries them again, and each side's watchers see it.
  await session.send('Logon', { EncryptMethod: 'None', HeartBtInt: session.heartbeat, ResetSeqNumFlag: true, ...secrets });
  await session.next('Logon', { where: { ResetSeqNumFlag: true } });
  const carried = messages(watched).filter(entry => entry.message.EncryptedPassword !== undefined);
  assert.deepEqual(carried.map(entry => [entry.direction, entry.message.MsgType, entry.message.EncryptedPassword, entry.message.EncryptedNewPassword]),
    [['out', 'Logon', '*****', '*****'], ['in', 'Logon', '*****', '*****']]);
  const recorded = (entry: Entry | ConnectionEntry): string => JSON.stringify(entryToJSON(entry)) + shown('bytes' in entry ? entry.bytes : undefined);
  assert.deepEqual(watched.map(recorded).filter(text => text.includes('s3cr3t')), []);
  await session.logout();
  await theirs.closed;

  // What each store kept, read back by a store that never saw the session: both Logons each way, with the masks.
  for (const dir of dirs) {
    const reader = fileStore(dir);
    const [stored] = await reader.list();
    const kept: Entry[] = [];
    for await (const entry of reader.read(stored!.id)) kept.push(entry);
    assert.deepEqual(messages(kept).filter(entry => entry.message.MsgType === 'Logon').map(entry => entry.message.EncryptedPassword).sort(), ['*****', '*****', undefined, undefined], dir);
    assert.deepEqual(kept.map(recorded).filter(text => text.includes('s3cr3t')), [], dir);
  }

  // A refusal that quotes one, before a session exists: the Logout says it as written; the connection feed has it masked.
  await assert.rejects(client(server, { sender: 'CLIENT2', logon: { EncryptedPasswordLen: 6, EncryptedPassword: 's3cr3t' } }), /Logon failed: No account for 's3cr3t'/);
  assert.deepEqual(feed.flatMap(entry => (entry.event === 'rejected' ? [entry.problem.text] : [])), ["No account for '*****'"]);
  assert.deepEqual(feed.map(recorded).filter(text => text.includes('s3cr3t')), []);
});

test('a custom dictionary works over FIXT.1.1 and may name a message only FIX 5.0 SP2 has; one that clashes with FIX 5.0 SP2 is refused where FIXT.1.1 is spoken, saying so', { timeout: 10_000 }, async t => {
  // ExecutionAck is a FIX 5.0 SP2 message: FIX 4.2 and FIX 4.4 have none.
  const acme = defineDictionary({
    fields: { AlgoStrategy: { tag: 9702, values: { VWAP: 'V', TWAP: 'T' } }, DeskName: { tag: 9703 } },
    messages: { NewOrderSingle: ['AlgoStrategy'], ExecutionAck: ['DeskName'] },
  } as DictionaryDef);
  assert.throws(() => defineDictionary({ fields: { DeskName: { tag: 9703 } }, messages: { NotAMessage: ['DeskName'] } } as DictionaryDef), /Custom dictionary lists unknown message NotAMessage/);
  const server = await exchange(t, { dictionary: acme });
  const orders: MessageObject[] = [];
  server.on('NewOrderSingle', order => { orders.push(order); });
  const session = await client(server, { dictionary: acme });
  const sent = await session.send('NewOrderSingle', { ...ORDER, AlgoStrategy: 'VWAP', 5001: 'anywhere' });
  await session.send('TestRequest', { TestReqID: 'DONE' });
  await session.next('Heartbeat', { where: { TestReqID: 'DONE' } });
  assert.deepEqual([orders[0]?.AlgoStrategy, orders[0]?.[5001], sent.AlgoStrategy], ['VWAP', 'anywhere', 'VWAP']);
  assert.match(shown(messages(session.history, 'out').find(entry => entry.message.MsgType === 'NewOrderSingle')?.bytes), /\|9702=V\|5001=anywhere\|/);
  assert.deepEqual(problemsOf(server.session('CLIENT')!), []);
  await session.logout();

  // RateSource is a field of FIX 5.0 SP2 and of neither FIX 4 version.
  const clash = defineDictionary({ fields: { RateSource: { tag: 9801 } } });
  assert.deepEqual(await refusal({ dictionary: clash }), {
    name: 'RangeError',
    message: "dictionary can't be used with FIXT.1.1: Custom field RateSource has the same name as a standard field. List the versions this server speaks in versions",
  });
  const fix4 = await exchange(t, { dictionary: clash, versions: [Version['FIX.4.2'], Version['FIX.4.4']] });
  await assert.rejects(client(fix4, { dictionary: clash }), {
    name: 'RangeError', message: "dictionary can't be used with FIXT.1.1: Custom field RateSource has the same name as a standard field",
  });
  await (await client(fix4, { dictionary: clash, version: Version['FIX.4.4'] })).logout();
});

test('a server reads and refuses a FIXT.1.1 Logon without the FIX 5.0 SP2 tables; they are read when its first FIXT.1.1 session is made', { timeout: 30_000 }, () => {
  // In a process of its own: here the tables are already loaded. The Logons are written by hand, so that only the server reads a dictionary.
  const script = `
    import fs from 'node:fs';
    import net from 'node:net';
    import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync;
    let tables = 0;
    fs.readFileSync = (path, ...rest) => {
      if (String(path).endsWith('fix50sp2.data.json')) tables++;
      return read(path, ...rest);
    };
    syncBuiltinESMExports();
    const { listen } = await import(${JSON.stringify(new URL('../index.ts', import.meta.url).href)});
    const listed = [];
    const server = await listen(0, {
      compID: 'EXCHANGE', host: '127.0.0.1',
      accept: logon => { listed.push(logon.MsgTypeGrp[0].RefMsgType); return logon.SenderCompID === 'FRIEND' || 'Not known here'; },
    });
    const logon = (sender, version = ['1137=9']) => new Promise(resolve => {
      const time = new Date().toISOString().replaceAll('-', '').replace('T', '-').slice(0, 21);
      const body = ['35=A', '49=' + sender, '56=EXCHANGE', '34=1', '52=' + time, '98=0', '108=30', '384=1', '372=D', '385=S', ...version, ''].join('\\x01');
      const head = '8=FIXT.1.1\\x019=' + body.length + '\\x01' + body;
      let sum = 0;
      for (const byte of Buffer.from(head, 'latin1')) sum += byte;
      const socket = net.connect(server.port, '127.0.0.1', () => socket.write(head + '10=' + String(sum % 256).padStart(3, '0') + '\\x01', 'latin1'));
      let received = '';
      socket.on('data', chunk => { received += chunk.toString('latin1'); socket.destroy(); });
      socket.on('close', () => resolve(received.replaceAll('\\x01', '|')));
    });
    const refused = await logon('STRANGER');
    // From a sender accept() would take, an application version the frame does not name readably: accept() is not asked.
    const unreadable = [await logon('FRIEND', ['1137=FIX50SP2']), await logon('FRIEND', ['1137=9', '1137=9']), await logon('FRIEND', [])];
    const afterRefusal = tables;
    const answered = await logon('FRIEND');
    console.log(JSON.stringify({
      refused: /\\|35=5\\|.*\\|58=Not known here\\|/.test(refused), unreadable: unreadable.map(reply => /\\|35=5\\|.*\\|58=/.test(reply)), afterRefusal,
      answered: /\\|35=A\\|.*\\|1137=9\\|/.test(answered), afterSession: tables, listed,
    }));
    process.exit(0);
  `;
  const printed = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
  // The application message type each Logon lists is read by its name without the tables, too: accept() saw two Logons, the stranger's and the one answered.
  assert.deepEqual(JSON.parse(printed), {
    refused: true, unreadable: [true, true, true], afterRefusal: 0, answered: true, afterSession: 1, listed: ['NewOrderSingle', 'NewOrderSingle'],
  });
});

test('a Logon that lists the application messages its sender sends and receives logs on: accept() and the session read each RefMsgType by its message name', { timeout: 10_000 }, async t => {
  const seen: unknown[] = [];
  const server = await exchange(t, { accept: logon => { seen.push(logon.MsgTypeGrp); return true; } });
  // ExecutionAck is a message only FIX 5.0 SP2 has.
  const listed = [
    { RefMsgType: 'NewOrderSingle', MsgDirection: 'Send' },
    { RefMsgType: 'ExecutionReport', MsgDirection: 'Receive', RefApplVerID: 'FIX50SP2' },
    { RefMsgType: 'ExecutionAck', MsgDirection: 'Send' },
  ];
  const session = await client(server, { logon: { MsgTypeGrp: listed } });
  const theirs = server.session('CLIENT')!;
  assert.match(shown(messages(session.history, 'out')[0]?.bytes), /\|98=0\|108=30\|384=3\|372=D\|385=S\|372=8\|385=R\|1130=9\|372=BN\|385=S\|1137=9\|/);
  assert.deepEqual(seen, [listed]);
  assert.deepEqual(messages(theirs.history, 'in')[0]?.message.MsgTypeGrp, listed);
  assert.deepEqual([problemsOf(session), problemsOf(theirs)], [[], []]);
  await session.logout();
});

test("a server that speaks FIXT.1.1 has its custom dictionary checked against FIX 5.0 SP2 too: a clash by tag or with a group's name is a RangeError naming the version and the field, and the remedy where versions was left out", { timeout: 10_000 }, async t => {
  const advice = '. List the versions this server speaks in versions';
  // Each is free in FIX 4.2 and FIX 4.4, so defineDictionary() takes it: 1409 is SessionStatus under FIXT.1.1, and RootParties a group of FIX 5.0 SP2.
  const byTag = defineDictionary({ fields: { VenueStatus: { tag: 1409 } }, messages: { Logon: ['VenueStatus'] } });
  const byGroup = defineDictionary({ fields: { RootParties: { tag: 9811 } }, messages: { Logon: ['RootParties'] } });
  const clashes = [
    [byTag, "dictionary can't be used with FIXT.1.1: Custom field VenueStatus uses tag 1409, which is SessionStatus"],
    [byGroup, "dictionary can't be used with FIXT.1.1: Custom field RootParties has the same name as a group of FIXT.1.1"],
  ] as const;
  for (const [dictionary, message] of clashes) {
    // The server speaks every version because none was listed: listing them is the way out, and the text says so.
    assert.deepEqual(await refusal({ dictionary }), { name: 'RangeError', message: `${message}${advice}` });
    // Where the versions were listed, the text names the one the dictionary cannot be used with, and that is all.
    assert.deepEqual(await refusal({ dictionary, versions: [Version['FIX.4.4'], FIXT] }), { name: 'RangeError', message });
    assert.deepEqual(await refusal({ dictionary, versions: [FIXT] }), { name: 'RangeError', message });
  }
  // The remedy works: with FIXT.1.1 left out, each is a custom field of the server's FIX 4 sessions, by its name.
  for (const [dictionary, name] of [[byTag, 'VenueStatus'], [byGroup, 'RootParties']] as const) {
    const seen: unknown[] = [];
    const server = await exchange(t, { dictionary, versions: [Version['FIX.4.2'], Version['FIX.4.4']], accept: logon => { seen.push(logon[name]); return true; } });
    for (const version of [Version['FIX.4.2'], Version['FIX.4.4']]) {
      const session = await client(server, { dictionary, version, logon: { [name]: 'open' } });
      assert.deepEqual(problemsOf(server.session('CLIENT')!), []);
      await session.logout();
    }
    assert.deepEqual(seen, ['open', 'open']);
  }
});

test('a program that speaks only FIX 4 never has the FIX 5.0 SP2 tables read: not to define a custom dictionary, for its server and sessions, or for a FIXT.1.1 Logon it refuses; a dictionary that names a FIX 5.0 SP2 message reads them', { timeout: 30_000 }, () => {
  const script = `
    import fs from 'node:fs';
    import net from 'node:net';
    import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync;
    let tables = 0;
    fs.readFileSync = (path, ...rest) => {
      if (String(path).endsWith('fix50sp2.data.json')) tables++;
      return read(path, ...rest);
    };
    syncBuiltinESMExports();
    const { connect, defineDictionary, entryFromJSON, entryToJSON, listen, Version } = await import(${JSON.stringify(new URL('../index.ts', import.meta.url).href)});
    const acme = defineDictionary({
      fields: { AlgoStrategy: { tag: 9702, values: { VWAP: 'V', TWAP: 'T' } }, LogonToken: { tag: 9710 } },
      messages: { NewOrderSingle: ['AlgoStrategy'], Logon: ['LogonToken'] },
    });
    const afterDefine = tables;
    const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', dictionary: acme, versions: [Version['FIX.4.2'], Version['FIX.4.4']] });
    const orders = [];
    server.on('NewOrderSingle', order => { orders.push(order.AlgoStrategy); });
    const session = await connect({ host: '127.0.0.1', port: server.port }, { sender: 'CLIENT', target: 'EXCHANGE', dictionary: acme, logon: { LogonToken: 'T' } });
    await session.send('NewOrderSingle', { ClOrdID: 'A1', Symbol: 'IBM', Side: 'Buy', OrderQty: 100, OrdType: 'Market', AlgoStrategy: 'VWAP' });
    await session.send('TestRequest', { TestReqID: 'DONE' });
    await session.next('Heartbeat', { where: { TestReqID: 'DONE' } });
    for (const entry of session.history) entryFromJSON(JSON.parse(JSON.stringify(entryToJSON(entry))), acme);
    await session.logout();
    // A FIXT.1.1 Logon, written by hand, to a server that does not speak it.
    const refused = await new Promise(resolve => {
      const time = new Date().toISOString().replaceAll('-', '').replace('T', '-').slice(0, 21);
      const body = ['35=A', '49=OTHER', '56=EXCHANGE', '34=1', '52=' + time, '98=0', '108=30', '1137=9', ''].join('\\x01');
      const head = '8=FIXT.1.1\\x019=' + body.length + '\\x01' + body;
      let sum = 0;
      for (const byte of Buffer.from(head, 'latin1')) sum += byte;
      const socket = net.connect(server.port, '127.0.0.1', () => socket.write(head + '10=' + String(sum % 256).padStart(3, '0') + '\\x01', 'latin1'));
      let received = '';
      socket.on('data', chunk => { received += chunk.toString('latin1'); socket.destroy(); });
      socket.on('close', () => resolve(received.replaceAll('\\x01', '|')));
    });
    const afterFix4 = tables;
    defineDictionary({ fields: { DeskName: { tag: 9703 } }, messages: { ExecutionAck: ['DeskName'] } });
    console.log(JSON.stringify({ afterDefine, orders, refused: /\\|35=5\\|.*\\|58=BeginString FIXT\\.1\\.1 is not supported\\|/.test(refused), afterFix4, afterFixtMessage: tables }));
    process.exit(0);
  `;
  const printed = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
  assert.deepEqual(JSON.parse(printed), { afterDefine: 0, orders: ['VWAP'], refused: true, afterFix4: 0, afterFixtMessage: 1 });
});
