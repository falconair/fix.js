import { afterEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dictionaryFor } from '../dictionary/index.ts';
import { FIXEncodeError } from '../errors.ts';
import { engineConfig } from '../session/types.ts';
import { checksum } from '../wire/checksum.ts';
import { buildFrame, parseFrame } from '../wire/frame.ts';
import { fromMessage, inspectMessage, type MessageObject } from '../wire/message.ts';
import { fakeClock, type FakeClock } from './clock.ts';
import { connectedPair, countingDrops, T0, type PairOptions } from './fixtures.ts';
import { FixSession, lastSessionSettled } from './session.ts';
import { entrySize } from './size.ts';
import { fileStore, memoryStore } from './store.ts';
import type { Entry, Link, SessionId, Store, StoreRecord } from './types.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** Resolve once `condition` holds, checking after each turn of the event loop; reject if it takes longer than `ms`. */
async function waitFor(condition: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${ms} ms waiting for ${what}`);
    await tick();
  }
}

async function loggedOn(options: PairOptions = {}) {
  const pair = connectedPair(options);
  pair.client.start();
  await Promise.all([pair.client.active, pair.exchange.active]);
  return pair;
}

/** A logged-on pair whose links have no pause()/resume(). */
const unpausableLoggedOn = (options: PairOptions = {}) => loggedOn({ ...options, pausable: false });

/** One CLIENT session on a link that goes nowhere. */
function lone(options: { store?: Store; clock?: FakeClock; memory?: ConstructorParameters<typeof FixSession>[0]['memory']; manual?: boolean; onHandlerError?: (error: unknown) => void; link?: Link; storeTimeoutMs?: number; processingTimeoutMs?: number; next?: number; redact?: readonly number[] | false; maxMessageSize?: number } = {}) {
  const session = new FixSession({
    config: engineConfig({ version: 'FIX.4.4', sender: 'CLIENT', target: 'EXCHANGE', role: 'initiator', ...(options.manual ? { manual: true } : {}) }),
    dictionary: dictionaryFor('FIX.4.4'), store: options.store ?? memoryStore(), clock: options.clock ?? fakeClock(T0),
    loaded: { history: [], next: options.next ?? 1, expected: 1 },
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.onHandlerError ? { onHandlerError: options.onHandlerError } : {}),
    ...(options.storeTimeoutMs === undefined ? {} : { storeTimeoutMs: options.storeTimeoutMs }),
    ...(options.redact === undefined ? {} : { redact: options.redact }),
    ...(options.maxMessageSize === undefined ? {} : { maxMessageSize: options.maxMessageSize }),
    ...(options.processingTimeoutMs === undefined ? {} : { processingTimeoutMs: options.processingTimeoutMs }),
  });
  session.attach(options.link ?? { write: async () => {}, end: () => {} });
  return session;
}

const order = (id: string) => ({ ClOrdID: id, Side: 'Buy', OrdType: 'Market' });

/** The texts of a session's error entries, oldest first. */
const errorTexts = (session: FixSession) => session.history.flatMap(entry => (entry.kind === 'error' ? [entry.text] : []));

/** An EXCHANGE → CLIENT frame, as the client would receive it. */
function fromExchange(msgType: string, seq: number, fields: Record<string, unknown> = {}): Uint8Array {
  const dict = dictionaryFor('FIX.4.4');
  const { fields: raw, framing } = fromMessage(msgType, { SenderCompID: 'EXCHANGE', TargetCompID: 'CLIENT', MsgSeqNum: seq, SendingTime: T0, ...fields }, dict, { version: 'FIX.4.4' });
  return buildFrame(raw, framing);
}

/** A memoryStore that also keeps every record it is given, in order. */
function recordingStore() {
  const base = memoryStore();
  const records: StoreRecord[] = [];
  const store: Store = { ...base, append: (id, list, context) => { records.push(...list); return base.append(id, list, context); } };
  return { store, records };
}

/**
 * A store over `base` that keeps every list it is given, in order, and how many append() calls were
 * in flight at once at most. After hold(), a list is kept only once release() is called for it (the
 * oldest waiting), or releaseAll() ends the holding; `fail` makes the oldest waiting reject instead.
 */
function listedStore(base: Store = memoryStore()) {
  const lists: StoreRecord[][] = [];
  const waiting: { go(): void; fail(error: unknown): void }[] = [];
  let holding = false;
  let inFlight = 0;
  let most = 0;
  const store: Store = {
    ...base,
    async append(id, records, context) {
      lists.push([...records]);
      most = Math.max(most, ++inFlight);
      try {
        if (holding) await new Promise<void>((resolve, reject) => { waiting.push({ go: resolve, fail: reject }); });
        return await base.append(id, records, context);
      } finally {
        inFlight--;
      }
    },
  };
  return {
    store, lists,
    hold(): void { holding = true; },
    release(): void { waiting.shift()?.go(); },
    fail(error: unknown): void { waiting.shift()?.fail(error); },
    releaseAll(): void { holding = false; for (const each of waiting.splice(0)) each.go(); },
    most: () => most,
  };
}

/** What a record holds, briefly: 'in Logon', 'out Heartbeat', 'error', or 'seqNums' for a record without an entry. */
function described(record: StoreRecord): string {
  const { entry } = record;
  if (!entry) return 'seqNums';
  return entry.kind === 'message' ? `${entry.direction} ${String(entry.message.MsgType)}` : entry.kind;
}

/** A message, briefly: 'Heartbeat 3', or 'SequenceReset 1 PossDup' for one resent. */
function brief(message: MessageObject): string {
  return `${String(message.MsgType)} ${String(message.MsgSeqNum)}${message.PossDupFlag === true ? ' PossDup' : ''}`;
}

/**
 * A logged-on pair whose CLIENT journals, in order, each sent message its store is given
 * ('store …') and each message it writes to the network ('wire …'). The journal starts empty
 * once both sides are logged on.
 */
async function journaledPair(options: PairOptions = {}) {
  const journal: string[] = [];
  const base = memoryStore();
  const dict = dictionaryFor('FIX.4.4');
  const store: Store = {
    ...base,
    append(id, records, context) {
      for (const { entry } of records) {
        if (entry?.kind === 'message' && entry.direction === 'out') journal.push(`store ${brief(entry.message)}`);
      }
      return base.append(id, records, context);
    },
  };
  const pair = await loggedOn({
    ...options,
    store: { client: store },
    onWrite: (side, bytes) => { if (side === 'client') journal.push(`wire ${brief(inspectMessage(parseFrame(bytes).fields, dict).message)}`); },
  });
  for (let i = 0; i < 5; i++) await tick();
  journal.length = 0;
  return { ...pair, journal };
}

/** An outgoing CLIENT → EXCHANGE entry, as a store would hold it. */
function outEntry(msgType: string, seq: number, fields: Record<string, unknown> = {}): Entry {
  const dict = dictionaryFor('FIX.4.4');
  const { fields: raw, framing } = fromMessage(msgType, { SenderCompID: 'CLIENT', TargetCompID: 'EXCHANGE', MsgSeqNum: seq, SendingTime: T0, ...fields }, dict, { version: 'FIX.4.4' });
  const bytes = buildFrame(raw, framing);
  return { kind: 'message', direction: 'out', at: T0, message: inspectMessage(parseFrame(bytes).fields, dict).message, bytes };
}

/** A CLIENT logged on over a link that keeps what it writes. Its Logon took MsgSeqNum `next` (default 1). `written` starts empty once it is logged on. */
async function loneLoggedOn(options: Parameters<typeof lone>[0] = {}) {
  const dict = dictionaryFor('FIX.4.4');
  const written: MessageObject[] = [];
  const link: Link = { write: async bytes => { written.push(inspectMessage(parseFrame(bytes).fields, dict).message); }, end: () => {} };
  const client = lone({ link, ...options });
  client.start();
  client.receiveBytes(fromExchange('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30 }));
  await client.active;
  for (let i = 0; i < 5; i++) await tick();
  written.length = 0;
  return { client, written };
}

/** A memoryStore that answers sent() with `sent` instead. */
const storeSending = (sent: Store['sent']): Store => ({ ...memoryStore(), sent });

/**
 * A store over `base` whose sent() waits, before it gives its second entry, until release() is
 * called; `reads` tells how many reads were begun and how many were closed.
 */
function heldStore(base: Store = memoryStore()) {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reads = { begun: 0, closed: 0 };
  const store: Store = {
    ...base,
    sent: (id, range, context) => (async function* () {
      reads.begun++;
      try {
        let given = 0;
        for await (const entry of base.sent(id, range, context)) {
          if (given++ === 1) await held;
          yield entry;
        }
      } finally {
        reads.closed++;
      }
    })(),
  };
  return { store, release, reads };
}

/** A new store of each kind the library has, for a test that must hold for both. */
const STORES = [['memoryStore', async (): Promise<Store> => memoryStore()], ['fileStore', async (): Promise<Store> => fileStore(await mkdtemp(join(tmpdir(), 'fixjs-session-')))]] as const;

/** A store that holds `entries` for CLIENT, as if an earlier connection had sent them; `next` is the sequence number after the last. */
async function storeHolding(make: () => Promise<Store>, entries: readonly Entry[], next: number): Promise<Store> {
  const store = await make();
  const id: SessionId = { version: 'FIX.4.4', sender: 'CLIENT', target: 'EXCHANGE' };
  for (const entry of entries) await store.append(id, [{ at: entry.at, entry, seqNums: { next, expected: 2 } }]);
  return store;
}

/** What EXCHANGE has received as possible duplicates, briefly, in order; a resent order by its ClOrdID. */
const resentTo = (exchange: FixSession) => exchange.history.flatMap(e => (e.kind === 'message' && e.direction === 'in' && e.message.PossDupFlag === true
  ? [e.message.MsgType === 'SequenceReset' ? `gap ${String(e.message.MsgSeqNum)}-${String(e.message.NewSeqNo)}` : `${String(e.message.MsgSeqNum)}:${String(e.message.ClOrdID)}`] : []));


// ─── Logging on ─────────────────────────────────────────────────────────────

test('two sessions log on', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  assert.deepEqual([client.state, exchange.state], ['active', 'active']);
  assert.deepEqual(client.seqNums, { next: 2, expected: 2 });
  assert.deepEqual(exchange.id, { version: 'FIX.4.4', sender: 'EXCHANGE', target: 'CLIENT' });
  assert.equal(exchange.heartbeat, 30);
});

test('a rejected Logon rejects active with the counterparty text', { timeout: 10_000 }, async () => {
  const { client, exchange } = connectedPair();
  exchange.incoming(message => {
    if (message.MsgType !== 'Logon') return message;
    void exchange.sendBytes(exchange.encode('Logout', { Text: 'bad password' }));   // send() needs an active session
    return null;
  });
  client.start();
  await assert.rejects(client.active, (error: unknown) => error instanceof Error && error.name === 'FIXLogonError' && error.message === 'Logon failed: bad password');
});

test('a session knows its key, its connection and when it logged on', { timeout: 10_000 }, async () => {
  const { client, exchange, clock } = connectedPair();
  assert.equal(exchange.key, 'FIX.4.4:EXCHANGE:CLIENT');
  assert.equal(exchange.peer, undefined);
  assert.deepEqual(exchange.connectedAt, T0);
  assert.equal(exchange.loggedOnAt, undefined);
  assert.match(exchange.connectionId, /^[0-9a-f-]{36}$/);
  assert.notEqual(client.connectionId, exchange.connectionId);
  await clock.advance('2s');
  client.start();
  await Promise.all([client.active, exchange.active]);
  assert.deepEqual(exchange.loggedOnAt, new Date(T0.getTime() + 2000));
});

test('a manual session\'s active resolves immediately', { timeout: 10_000 }, async () => {
  const client = lone({ manual: true });
  await client.active;
  assert.equal(client.state, 'active');
});

// ─── Sending ────────────────────────────────────────────────────────────────

test('send resolves with the message as sent; next waits for a reply', { timeout: 10_000 }, async () => {
  const { client } = await loggedOn();
  const sent = await client.send('TestRequest', { TestReqID: 'ping' });
  assert.equal(sent.MsgSeqNum, 2);
  const heartbeat = await client.next('Heartbeat', { where: { TestReqID: 'ping' } });
  assert.equal(heartbeat.TestReqID, 'ping');
});

test('sending needs an active session; mistakes use no sequence number', { timeout: 10_000 }, async () => {
  const { client } = connectedPair();
  await assert.rejects(client.send('Heartbeat'), { name: 'FIXStateError' });
  client.start();
  await client.active;
  await assert.rejects(client.send('NewOrderSingle', { ClOrdID: 'x', OrdType: 'Market' }), { name: 'FIXEncodeError' });
  assert.equal(client.seqNums.next, 2);
});

test('encode builds the bytes send() would, without using a sequence number', { timeout: 10_000 }, async () => {
  const { client } = await loggedOn();
  const bytes = Buffer.from(client.encode('Heartbeat')).toString('latin1');
  assert.match(bytes, /\x0134=2\x01/);
  assert.equal(client.seqNums.next, 2);
});

test('sendBytes goes out as is; the other side records the garbage', { timeout: 10_000 }, async () => {
  const { client, exchange, clock } = await loggedOn();
  await client.sendBytes('8=FIX.4.4\x019=5\x0135=0\x0110=000\x01');
  await clock.advance(10);
  assert.ok(exchange.history.some(e => e.kind === 'problem' && e.problem.code === 'Garbled'));
  assert.equal(exchange.state, 'active');
});

test('a frame whose MsgType is not the third field is ignored as garbled: its MsgSeqNum is not used', { timeout: 10_000 }, async () => {
  const { client, exchange, clock } = await loggedOn();
  const expected = exchange.seqNums.expected;
  const heartbeat = Buffer.from(client.encode('Heartbeat')).toString('latin1');
  // 35=0 moved behind the field after it: the body is as long as before, and its bytes add up to the same CheckSum.
  const moved = heartbeat.replace(/(\x0135=0)(\x01[^\x01]+)/, '$2$1');
  assert.notEqual(moved, heartbeat);
  await client.sendBytes(moved);
  await clock.advance(10);
  assert.deepEqual(
    exchange.history.flatMap(entry => (entry.kind === 'problem' ? [entry.problem] : [])),
    [{ code: 'Garbled', text: 'MsgType (35) must be the third field', action: 'Ignored' }],
  );
  assert.equal(exchange.seqNums.expected, expected);
  assert.equal(exchange.state, 'active');
});

test('a Logon with ResetSeqNumFlag=Y on a logged-on session starts both sides again at 1, each in a new epoch', { timeout: 10_000 }, async () => {
  const ours = recordingStore();
  const theirs = recordingStore();
  const { client, exchange, clock } = await loggedOn({ store: { client: ours.store, exchange: theirs.store } });
  await client.send('NewOrderSingle', order('a'));
  await clock.advance(10);
  assert.deepEqual([client.seqNums, exchange.seqNums], [{ next: 3, expected: 2 }, { next: 2, expected: 3 }]);

  const sent = await client.send('Logon', { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true });
  assert.equal(sent.MsgSeqNum, 1);
  await clock.advance(10);
  assert.deepEqual([client.seqNums, exchange.seqNums], [{ next: 2, expected: 2 }, { next: 2, expected: 2 }]);
  // One Logon each way at logon, one each way for the reset, and no more: the reply to a reset is not answered again.
  const logons = (session: FixSession) => session.history.flatMap(entry => (entry.kind === 'message' && entry.message.MsgType === 'Logon' ? [entry.direction] : []));
  assert.deepEqual([logons(client), logons(exchange)], [['out', 'in', 'out', 'in'], ['in', 'out', 'in', 'out']]);
  const epochs = (records: StoreRecord[]) => records.filter(record => record.newEpoch).map(described);
  assert.deepEqual([epochs(ours.records), epochs(theirs.records)], [['out Logon'], ['in Logon']]);

  await client.send('TestRequest', { TestReqID: 'after' });
  await clock.advance(10);
  assert.equal((await client.next('Heartbeat', { where: { TestReqID: 'after' } })).MsgSeqNum, 2);
  assert.deepEqual([client.state, exchange.state], ['active', 'active']);
});

test('a second Logon with ResetSeqNumFlag=Y while one awaits its reply is refused; each side resets once', { timeout: 10_000 }, async () => {
  const ours = recordingStore();
  const theirs = recordingStore();
  const { client, exchange, clock } = await loggedOn({ store: { client: ours.store, exchange: theirs.store } });
  const reset = { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true } as const;
  const first = client.send('Logon', reset);
  const second = client.send('Logon', reset);
  await assert.rejects(second, { name: 'FIXStateError' });
  await first;
  for (let turn = 0; turn < 20; turn++) await clock.advance(10);
  const logons = (session: FixSession) => session.history.flatMap(entry => (entry.kind === 'message' && entry.message.MsgType === 'Logon' ? [entry.direction] : []));
  assert.deepEqual([logons(client), logons(exchange)], [['out', 'in', 'out', 'in'], ['in', 'out', 'in', 'out']]);
  const epochs = (records: StoreRecord[]) => records.filter(record => record.newEpoch).map(described);
  assert.deepEqual([epochs(ours.records), epochs(theirs.records)], [['out Logon'], ['in Logon']]);
  assert.deepEqual([client.seqNums, exchange.seqNums], [{ next: 2, expected: 2 }, { next: 2, expected: 2 }]);
});

test('our Logon with ResetSeqNumFlag=Y begins the new epoch at its own record, after the messages queued ahead of it', { timeout: 10_000 }, async () => {
  const ours = recordingStore();
  const { client, exchange, clock } = await loggedOn({ store: { client: ours.store } });
  await clock.advance(10);
  ours.records.length = 0;
  void client.send('NewOrderSingle', order('a'));
  void client.send('NewOrderSingle', order('b'));
  const sent = await client.send('Logon', { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true });
  assert.equal(sent.MsgSeqNum, 1);
  await clock.advance(10);
  const written = (records: StoreRecord[]) => records.map(record => `${record.newEpoch ? 'new epoch: ' : ''}${described(record)} next ${record.seqNums.next}`);
  assert.deepEqual(written(ours.records).slice(0, 3), ['out NewOrderSingle next 3', 'out NewOrderSingle next 4', 'new epoch: out Logon next 2']);
  assert.equal(ours.records.filter(record => record.newEpoch).length, 1);
  const kept = await ours.store.load(client.id);
  assert.deepEqual([kept.next, kept.history.flatMap(entry => (entry.kind === 'message' ? [`${entry.direction} ${String(entry.message.MsgType)} ${String(entry.message.MsgSeqNum)}`] : []))], [2, ['out Logon 1', 'in Logon 1']]);
  assert.deepEqual([client.state, exchange.state], ['active', 'active']);
});

test('a message received while our Logon with ResetSeqNumFlag=Y waits in an outgoing route does not begin the new epoch', { timeout: 10_000 }, async () => {
  const ours = recordingStore();
  const { client, exchange, clock } = await loggedOn({ store: { client: ours.store } });
  await clock.advance(10);
  ours.records.length = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  client.outgoing(async message => { if (message.MsgType === 'Logon') await held; return message; });
  const sending = client.send('Logon', { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true });
  await exchange.send('NewOrderSingle', order('x'));
  await clock.advance(10);
  release();
  await sending;
  await clock.advance(10);
  const epochs = ours.records.filter(record => record.newEpoch).map(described);
  assert.deepEqual(epochs, ['out Logon']);
  assert.ok(ours.records.some(record => described(record) === 'in NewOrderSingle' && !record.newEpoch));
});

test('a Logon with ResetSeqNumFlag=Y sent from a handler begins the new epoch at its own record, not at the message being handled', { timeout: 10_000 }, async () => {
  const ours = recordingStore();
  const { client, exchange, clock } = await loggedOn({ store: { client: ours.store } });
  await clock.advance(10);
  ours.records.length = 0;
  client.on('NewOrderSingle', (_message, session) => session.send('Logon', { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true }));
  await exchange.send('NewOrderSingle', order('handled'));
  for (let turn = 0; turn < 5; turn++) await clock.advance(10);
  const written = ours.records.map(record => `${record.newEpoch ? 'new epoch: ' : ''}${described(record)} ${record.seqNums.next},${record.seqNums.expected}`);
  // The handled message's record keeps the numbers its own step left, in the epoch it arrived in.
  assert.deepEqual(written, ['in NewOrderSingle 2,3', 'new epoch: out Logon 2,1', 'in Logon 2,2']);
  const kept = await ours.store.load(client.id);
  assert.deepEqual([kept.next, kept.expected, kept.history.flatMap(entry => (entry.kind === 'message' ? [`${entry.direction} ${String(entry.message.MsgType)} ${String(entry.message.MsgSeqNum)}`] : []))], [2, 2, ['out Logon 1', 'in Logon 1']]);
  assert.deepEqual([client.state, exchange.state, client.seqNums, exchange.seqNums], ['active', 'active', { next: 2, expected: 2 }, { next: 2, expected: 2 }]);
});

test('a Logon sent with the reset flag written by tag number (141: Y) resets both sides like the named field', { timeout: 10_000 }, async () => {
  const { client, exchange, clock } = await loggedOn();
  await client.send('TestRequest', { TestReqID: 'before' });
  await clock.advance(10);
  const sent = await client.send('Logon', { EncryptMethod: 'None', HeartBtInt: 30, 141: 'Y' });
  assert.deepEqual([sent.MsgSeqNum, sent.ResetSeqNumFlag], [1, true]);
  for (let turn = 0; turn < 5; turn++) await clock.advance(10);
  assert.deepEqual([client.state, exchange.state, client.seqNums, exchange.seqNums], ['active', 'active', { next: 2, expected: 2 }, { next: 2, expected: 2 }]);
});

/**
 * A client that expects 1 logs on to an exchange whose numbers are ahead, so a resend from 1 is
 * outstanding when it is logged on, and resets at once. `afterResend`, when given, runs on the
 * exchange once it has answered that resend request; `prepare` runs on both before they start;
 * `rewrite` is what reaches the other side in place of each frame. Resolves once the two sides
 * are in step at `ends` (the client's sequence numbers; default 2 and 2), or as soon as more reset
 * Logons have gone round than one reset needs.
 */
async function resetWithResendOutstanding(options: {
  afterResend?: (exchange: FixSession) => void;
  prepare?: (client: FixSession, exchange: FixSession) => void;
  rewrite?: NonNullable<PairOptions['rewrite']>;
  ends?: { next: number; expected: number };
} = {}) {
  const { afterResend, ends = { next: 2, expected: 2 } } = options;
  const ours = recordingStore();
  const theirs = recordingStore();
  const { client, exchange } = connectedPair({
    store: { client: ours.store, exchange: theirs.store }, loaded: { exchange: { history: [], next: 5, expected: 1 } },
    ...(options.rewrite ? { rewrite: options.rewrite } : {}),
  });
  options.prepare?.(client, exchange);
  const resetLogons = { client: 0, exchange: 0 };
  for (const [side, session] of [['client', client], ['exchange', exchange]] as const) {
    session.watch(entry => {
      if (entry.kind === 'message' && entry.direction === 'out' && entry.message.MsgType === 'Logon' && entry.message.ResetSeqNumFlag === true) resetLogons[side]++;
    });
  }
  if (afterResend) exchange.on('ResendRequest', () => afterResend(exchange));
  client.start();
  await client.active;
  await client.send('Logon', { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true });
  const settled = () => client.seqNums.next === ends.next && client.seqNums.expected === ends.expected && exchange.seqNums.next === ends.expected && exchange.seqNums.expected === ends.next;
  const looping = () => resetLogons.client > 3 || resetLogons.exchange > 3;
  await waitFor(() => looping() || settled(), 5000, `the client at ${ends.next} and ${ends.expected}, and the exchange in step with it`);
  // Whatever is still on its way arrives within a few turns of the in-memory wire.
  for (let turn = 0; turn < 20 && !looping(); turn++) await tick();
  const result = {
    resetLogons: { ...resetLogons },
    epochs: { client: ours.records.filter(record => record.newEpoch).map(described), exchange: theirs.records.filter(record => record.newEpoch).map(described) },
    seqNums: { client: client.seqNums, exchange: exchange.seqNums },
    states: [client.state, exchange.state],
    received: client.history.flatMap(entry => (entry.kind === 'message' && entry.direction === 'in' ? [brief(entry.message)] : [])),
  };
  client.close();
  exchange.close();
  return result;
}

test('our reset sent while a resend from 1 is outstanding: the old resend is taken, the reply to the reset is taken, and one reset Logon goes each way', { timeout: 10_000 }, async () => {
  const result = await resetWithResendOutstanding();
  assert.deepEqual(result.resetLogons, { client: 1, exchange: 1 });
  assert.deepEqual(result.epochs, { client: ['out Logon'], exchange: ['in Logon'] });
  assert.deepEqual(result.seqNums, { client: { next: 2, expected: 2 }, exchange: { next: 2, expected: 2 } });
  assert.deepEqual(result.states, ['active', 'active']);
  assert.deepEqual(result.received, ['Logon 5', 'SequenceReset 1 PossDup', 'Logon 1']);
});

test('a message the counterparty sent after its old resend and before our reset reached it does not end the wait either: one reset Logon goes each way', { timeout: 10_000 }, async () => {
  const result = await resetWithResendOutstanding({ afterResend: exchange => { void exchange.send('Heartbeat', {}); } });
  assert.deepEqual(result.resetLogons, { client: 1, exchange: 1 });
  assert.deepEqual(result.epochs, { client: ['out Logon'], exchange: ['in Logon'] });
  assert.deepEqual(result.seqNums, { client: { next: 2, expected: 2 }, exchange: { next: 2, expected: 2 } });
  assert.deepEqual(result.states, ['active', 'active']);
  // The Heartbeat is MsgSeqNum 6 of the old sequence, in sequence after the gap fill to 6.
  assert.deepEqual(result.received, ['Logon 5', 'SequenceReset 1 PossDup', 'Heartbeat 6', 'Logon 1']);
});

/** The exchange's gap fills reach the client without PossDupFlag (43) and OrigSendingTime (122), as from an engine that does not mark what it resends. */
function unmarkedGapFills(side: 'client' | 'exchange', bytes: Uint8Array): Uint8Array {
  const fields = parseFrame(bytes).fields;
  if (side !== 'exchange' || !fields.some(field => field.tag === 35 && field.value === '4')) return bytes;
  return buildFrame(fields.filter(field => ![9, 10, 43, 122].includes(field.tag)));
}

test('a counterparty that resends without PossDupFlag: its gap fill from 1 arrives after our reset and ends the wait, and its reply is still taken: one reset Logon goes each way', { timeout: 10_000 }, async () => {
  const result = await resetWithResendOutstanding({ rewrite: unmarkedGapFills });
  assert.deepEqual(result.resetLogons, { client: 1, exchange: 1 });
  assert.deepEqual(result.epochs, { client: ['out Logon'], exchange: ['in Logon'] });
  assert.deepEqual(result.seqNums, { client: { next: 2, expected: 2 }, exchange: { next: 2, expected: 2 } });
  assert.deepEqual(result.states, ['active', 'active']);
  assert.deepEqual(result.received, ['Logon 5', 'SequenceReset 1', 'Logon 1']);
});

test('the same, and our own handler sends an order as soon as the wait ends: the reply is still taken, and the order is taken once', { timeout: 10_000 }, async () => {
  const orders: unknown[] = [];
  const result = await resetWithResendOutstanding({
    rewrite: unmarkedGapFills,
    prepare: (client, exchange) => {
      client.on('SequenceReset', (_message, session) => session.send('NewOrderSingle', order('after-the-gap-fill')));
      exchange.on('NewOrderSingle', message => { orders.push(message.ClOrdID); });
    },
    ends: { next: 3, expected: 2 },
  });
  assert.deepEqual(result.resetLogons, { client: 1, exchange: 1 });
  assert.deepEqual(result.epochs, { client: ['out Logon'], exchange: ['in Logon'] });
  assert.deepEqual(result.seqNums, { client: { next: 3, expected: 2 }, exchange: { next: 2, expected: 3 } });
  assert.deepEqual(result.states, ['active', 'active']);
  assert.deepEqual(orders, ['after-the-gap-fill']);
});

test('setSeqNums moves the counters on a live session', { timeout: 10_000 }, async () => {
  const { client } = await loggedOn();
  client.setSeqNums({ next: 50 });
  assert.deepEqual(client.seqNums, { next: 50, expected: 2 });
});

test('a handler that sends during delivery does not reorder sequence numbers', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  exchange.on('TestRequest', (_message, session) => { void session.send('TestRequest', { TestReqID: 'from-handler' }); });
  const seqs: number[] = [];
  const problems: string[] = [];
  exchange.watch(entry => {
    if (entry.kind === 'message' && entry.direction === 'out') seqs.push(Number(entry.message.MsgSeqNum));
    if (entry.kind === 'problem') problems.push(entry.problem.code);
  });
  await client.send('TestRequest', { TestReqID: 'x' });
  await exchange.next('Heartbeat', { where: { TestReqID: 'from-handler' } });   // client auto-replies to the handler's TestRequest; exchange receives it
  for (let i = 0; i < seqs.length - 1; i++) assert.ok(seqs[i]! < seqs[i + 1]!, `expected strictly increasing seqs, got ${seqs}`);
  assert.deepEqual(problems.filter(code => code === 'SeqNumGap' || code === 'SeqNumTooLow'), []);
});

test('a link write failure rejects sendBytes, closes the session, and a later send rejects', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  let failed = false;
  client.attach({
    write: async bytes => {
      if (!failed) { failed = true; throw new Error('boom'); }
      setImmediate(() => exchange.receiveBytes(bytes));
    },
    end: () => {},
  });
  await assert.rejects(client.sendBytes('8=FIX.4.4\x019=5\x0135=0\x0110=000\x01'), { message: 'boom' });
  assert.equal(client.state, 'closed');
  await assert.rejects(client.send('Heartbeat'), { name: 'FIXStateError' });
});

test('a send queued behind a failed write rejects instead of resolving', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  let failed = false;
  client.attach({
    write: async bytes => {
      if (!failed) { failed = true; throw new Error('boom'); }
      setImmediate(() => exchange.receiveBytes(bytes));
    },
    end: () => {},
  });
  const a = client.send('TestRequest', { TestReqID: 'A' });
  const b = client.send('TestRequest', { TestReqID: 'B' });
  await assert.rejects(a, { message: 'boom' });
  await assert.rejects(b, { name: 'FIXStateError' });
});

// ─── Receiving ──────────────────────────────────────────────────────────────

test('a reply that arrived before next() is still found', { timeout: 10_000 }, async () => {
  const { client, clock } = await loggedOn();
  await client.send('TestRequest', { TestReqID: 'early' });
  await clock.advance(10);
  assert.equal((await client.next('Heartbeat')).TestReqID, 'early');
});

test('next times out on the session clock', { timeout: 10_000 }, async () => {
  const { client, clock } = await loggedOn();
  const waiting = client.next('ExecutionReport', { timeout: '2s' });
  const check = assert.rejects(waiting, { name: 'TimeoutError', waitingFor: { kind: 'message', msgType: 'ExecutionReport' } });   // attached before advancing: a caller that never awaits later must still see the rejection
  await clock.advance('2s');
  await check;
});

test('next() removes the message it takes: the inbox shrinks, and it cannot be taken twice', { timeout: 10_000 }, async () => {
  const { client, exchange, clock } = await loggedOn();
  await client.send('NewOrderSingle', order('once'));
  await tick();
  const sizeBefore = exchange.inboxSizeForTests;
  assert.ok(sizeBefore > 0, 'expected the delivered message to be sitting in the inbox');
  const first = await exchange.next('NewOrderSingle');
  assert.equal(first.ClOrdID, 'once');
  assert.ok(exchange.inboxSizeForTests < sizeBefore, `expected the inbox to shrink once next() took the message (before=${sizeBefore}, after=${exchange.inboxSizeForTests})`);
  const waiting = exchange.next('NewOrderSingle', { timeout: '10ms' });
  const check = assert.rejects(waiting, { name: 'TimeoutError' });
  await clock.advance('10ms');
  await check;
});

test('handlers get every message of their type; removing one stops it', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  const seen: unknown[] = [];
  const remove = exchange.on('NewOrderSingle', (message, session) => seen.push([message.ClOrdID, session === exchange]));
  await client.send('NewOrderSingle', order('o1'));
  await exchange.next('NewOrderSingle');
  remove();
  await client.send('NewOrderSingle', order('o2'));
  await exchange.next('NewOrderSingle');
  assert.deepEqual(seen, [['o1', true]]);
});

test('a handler error is reported and does not break the session', { timeout: 10_000 }, async () => {
  const errors: unknown[] = [];
  const { client, exchange } = await loggedOn({ onHandlerError: error => errors.push(error) });
  exchange.on('NewOrderSingle', () => { throw new Error('handler bug'); });
  exchange.on('NewOrderSingle', async () => { throw new Error('async handler bug'); });
  await client.send('NewOrderSingle', order('o1'));
  const received: MessageObject = await exchange.next('NewOrderSingle');
  assert.equal(received.ClOrdID, 'o1');
  await tick();
  assert.deepEqual(errors.map(error => (error as Error).message), ['handler bug', 'async handler bug']);
  await client.send('TestRequest', { TestReqID: 'still alive' });
  assert.equal((await client.next('Heartbeat')).TestReqID, 'still alive');
});

test('a handler returning a non-Promise thenable that rejects is still reported', { timeout: 10_000 }, async () => {
  const errors: unknown[] = [];
  const { client, exchange } = await loggedOn({ onHandlerError: error => errors.push(error) });
  exchange.on('TestRequest', () => ({ then: (_resolve: unknown, reject: (error: unknown) => void) => { reject(new Error('thenable bug')); } }));
  await client.send('TestRequest', { TestReqID: 'z' });
  await exchange.next('TestRequest');
  await tick();
  assert.deepEqual(errors.map(e => (e as Error).message), ['thenable bug']);
});

test('a throwing onHandlerError is recorded too; the other handlers still run and the session keeps working', { timeout: 10_000 }, async () => {
  let thrown = false;
  const errors: unknown[] = [];
  const { client, exchange } = await loggedOn({
    onHandlerError: error => {
      errors.push(error);
      if (!thrown) { thrown = true; throw new Error('onHandlerError itself is broken'); }
    },
  });
  const seen: string[] = [];
  exchange.on('NewOrderSingle', () => { throw new Error('handler A bug'); });
  exchange.on('NewOrderSingle', () => { seen.push('B ran'); });
  await client.send('NewOrderSingle', order('x'));
  await exchange.next('NewOrderSingle');
  await tick();
  assert.deepEqual(seen, ['B ran']);
  assert.ok(errors.some(e => e instanceof Error && e.message === 'handler A bug'), 'onHandlerError must receive the handler\'s own error');
  assert.deepEqual(errorTexts(exchange), ['handler A bug', 'onHandlerError itself is broken']);
  const reply = await exchange.send('TestRequest', { TestReqID: 'still-alive' });
  assert.equal(reply.TestReqID, 'still-alive');
  await exchange.next('Heartbeat', { where: { TestReqID: 'still-alive' } });   // client auto-replies; exchange receives it
});

test('with no onHandlerError, failing handlers are recorded in history and watch, and nothing is thrown', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  const watched: string[] = [];
  exchange.watch(entry => { if (entry.kind === 'error') watched.push(entry.text); });
  exchange.on('NewOrderSingle', () => { throw new Error('handler bug'); });
  exchange.on('NewOrderSingle', async () => { throw new Error('async handler bug'); });
  await client.send('NewOrderSingle', order('o1'));
  await exchange.next('NewOrderSingle');
  await tick();
  const errors = exchange.history.flatMap(entry => (entry.kind === 'error' ? [entry] : []));
  const during = { MsgType: 'NewOrderSingle', MsgSeqNum: 2, ClOrdID: 'o1' };
  assert.deepEqual(errors.map(entry => [entry.text, entry.during]), [['handler bug', during], ['async handler bug', during]]);
  assert.ok(errors.every(entry => entry.stack?.startsWith('Error: ')));
  assert.deepEqual(watched, ['handler bug', 'async handler bug']);
  assert.equal(exchange.state, 'active');
});

test('a link whose end() throws is recorded as an error entry, with no onHandlerError', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  client.attach({ write: async bytes => { setImmediate(() => exchange.receiveBytes(bytes)); }, end: () => { throw new Error('end() blew up'); } });
  client.close();
  await client.closed;
  assert.deepEqual(errorTexts(client), ['end() blew up']);
});

test('a watcher that throws is recorded once per entry, and never loops on its own error entries', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  let calls = 0;
  exchange.watch(() => { calls++; throw new Error('watcher bug'); });
  await client.send('TestRequest', { TestReqID: 'x' });
  await client.next('Heartbeat');
  await tick();
  const errors = exchange.history.flatMap(entry => (entry.kind === 'error' ? [entry] : []));
  assert.deepEqual(errors.map(entry => [entry.text, entry.during?.MsgType]), [['watcher bug', 'TestRequest'], ['watcher bug', 'Heartbeat']]);
  assert.equal(calls, 4);   // TestRequest in, its error entry, Heartbeat out, its error entry
});

test('messages() streams application messages and ends when the session closes', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  const collected: string[] = [];
  const reading = (async () => {
    for await (const message of exchange.messages()) collected.push(String(message.ClOrdID));
  })();
  await client.send('NewOrderSingle', order('a'));
  await client.send('TestRequest', { TestReqID: 'not an app message' });
  await client.send('NewOrderSingle', order('b'));
  await exchange.next('NewOrderSingle');
  await exchange.next('NewOrderSingle');
  await client.logout();
  await reading;
  assert.deepEqual(collected, ['a', 'b']);
});

test('messages() subscribes immediately, not on the first next()', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  const iterator = exchange.messages();
  await client.send('NewOrderSingle', order('early'));
  await tick();   // the message arrives before iterator.next() is ever called
  const { value, done } = await iterator.next();
  assert.equal(done, false);
  assert.equal(value?.ClOrdID, 'early');
  const finished = await iterator.return?.();
  assert.equal(finished?.done, true);
});

test('two concurrent next() calls on messages() both resolve, in order', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  const it = exchange.messages();
  const a = it.next();
  const b = it.next();
  await client.send('NewOrderSingle', order('o1'));
  await client.send('NewOrderSingle', order('o2'));
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.value?.ClOrdID, 'o1');
  assert.equal(rb.value?.ClOrdID, 'o2');
});

test('return() wakes a pending next() on messages()', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  const it = exchange.messages();
  const pending = it.next();
  await it.return!();
  client.close();
  const result = await Promise.race([
    pending.then(x => ({ settled: true, done: x.done })),
    tick().then(() => ({ settled: false })),
  ]);
  assert.deepEqual(result, { settled: true, done: true });
});

test('history records what went in and out, with bytes; watch follows it live', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  const live: string[] = [];
  exchange.watch(entry => live.push(`${entry.kind} ${entry.kind === 'message' ? `${entry.direction} ${String(entry.message.MsgType)}` : entry.kind === 'problem' ? entry.problem.code : entry.text}`));
  await client.send('TestRequest', { TestReqID: 'x' });
  await client.next('Heartbeat');
  assert.deepEqual(live, ['message in TestRequest', 'message out Heartbeat']);
  const logon = exchange.history[0];
  assert.equal(logon?.kind === 'message' && logon.direction, 'in');
  assert.ok(logon?.kind === 'message' && logon.bytes && logon.bytes.length > 0);
});

// ─── Routes ─────────────────────────────────────────────────────────────────

test('an incoming route runs before the engine', { timeout: 10_000 }, async () => {
  const { client, exchange, clock } = await loggedOn();
  exchange.incoming(message => (message.MsgType === 'TestRequest' ? null : message));
  await client.send('TestRequest', { TestReqID: 'ignored' });
  const waiting = client.next('Heartbeat', { timeout: '2s' });
  const check = assert.rejects(waiting, { name: 'TimeoutError' });
  await clock.advance('2s');
  await check;
});

test('a message with no TargetCompID is rejected for that field even when an incoming route returns a copy', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  exchange.incoming(message => ({ ...message }));
  const seen: unknown[] = [];
  exchange.on('NewOrderSingle', message => seen.push(message));
  const dict = dictionaryFor('FIX.4.4');
  const { fields: raw, framing } = fromMessage('NewOrderSingle', {
    SenderCompID: 'CLIENT', TargetCompID: null, MsgSeqNum: 2, SendingTime: T0, ...order('o1'),
  }, dict, { version: 'FIX.4.4' });
  const rejected = client.next('Reject');
  exchange.receiveBytes(buildFrame(raw, framing));
  const reject = await rejected;
  assert.deepEqual({ reason: reject.SessionRejectReason, tag: reject.RefTagID, text: reject.Text }, { reason: 'RequiredTagMissing', tag: 56, text: 'TargetCompID (56) is required' });
  assert.deepEqual(seen, []);
  assert.equal(exchange.state, 'active');
});

test('a problem the session carried on from is not attached to a clean logout later', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  // The exchange sends this order with no TargetCompID, as a peer that gets it wrong would.
  exchange.outgoing(message => (message.ClOrdID === 'o1' ? { ...message, TargetCompID: null } : message));
  const rejected = exchange.next('Reject');
  await exchange.send('NewOrderSingle', order('o1'));
  await rejected;
  assert.deepEqual(client.history.flatMap(entry => (entry.kind === 'problem' ? [entry.problem.action] : [])), ['Rejected']);
  assert.deepEqual(await client.logout(), { by: 'us', text: 'Logout confirmed' });
});

test('a problem that ends the session is the reason it closed with', { timeout: 10_000 }, async () => {
  const { exchange } = await loggedOn();
  const dict = dictionaryFor('FIX.4.4');
  const { fields: raw, framing } = fromMessage('Heartbeat', { SenderCompID: 'OTHER', TargetCompID: 'EXCHANGE', MsgSeqNum: 2, SendingTime: T0 }, dict, { version: 'FIX.4.4' });
  exchange.receiveBytes(buildFrame(raw, framing));
  const reason = await exchange.closed;
  assert.deepEqual([reason.by, reason.problem?.code, reason.problem?.action], ['us', 'CompIDMismatch', 'LoggedOut']);
});

test('an outgoing route that throws is reported; the message goes out unchanged and the session stays open', { timeout: 10_000 }, async () => {
  const errors: unknown[] = [];
  const { client, exchange } = await loggedOn({ onHandlerError: error => errors.push(error) });
  client.outgoing(() => { throw new Error('route bug'); });
  const sent = await client.send('TestRequest', { TestReqID: 'x' });
  assert.equal(sent.TestReqID, 'x');
  const received = await exchange.next('TestRequest');
  assert.equal(received.TestReqID, 'x');
  await tick();
  assert.deepEqual(errors.map(e => (e as Error).message), ['route bug']);
  assert.equal(client.state, 'active');
});

test('an incoming route that rejects is reported; the message is delivered unchanged and the session stays open', { timeout: 10_000 }, async () => {
  const errors: unknown[] = [];
  const { client, exchange } = await loggedOn({ onHandlerError: error => errors.push(error) });
  exchange.incoming(() => Promise.reject(new Error('incoming route bug')));
  await client.send('TestRequest', { TestReqID: 'y' });
  const received = await exchange.next('TestRequest');
  assert.equal(received.TestReqID, 'y');
  await tick();
  assert.deepEqual(errors.map(e => (e as Error).message), ['incoming route bug']);
  assert.equal(exchange.state, 'active');
});

// ─── Resend ─────────────────────────────────────────────────────────────────

test('an outgoing route can lose a message; the resend recovers it', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  client.outgoing(message => (message.ClOrdID === 'lost' && message.PossDupFlag !== true ? null : message));
  await client.send('NewOrderSingle', order('lost'));
  await client.send('NewOrderSingle', order('kept'));
  const first = await exchange.next('NewOrderSingle');
  const second = await exchange.next('NewOrderSingle');
  assert.deepEqual([first.ClOrdID, second.ClOrdID], ['lost', 'kept']);
  assert.equal(first.PossDupFlag, true);
  assert.ok(exchange.history.some(e => e.kind === 'problem' && e.problem.code === 'SeqNumGap'));
  const dropped = client.history.find(e => e.kind === 'message' && e.direction === 'out' && e.message.ClOrdID === 'lost' && e.message.PossDupFlag !== true);
  assert.equal(dropped?.kind === 'message' && dropped.bytes, undefined);
});

test('a ResendRequest for an original that no longer encodes is gap-filled, not fatal', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  // A raw NewOrderSingle sent by hand, missing the required Side, at seq 2.
  const t = '20260930-12:00:00.000';
  const body = `35=D\x0149=CLIENT\x0156=EXCHANGE\x0134=2\x0152=${t}\x0111=r1\x0140=1\x0160=${t}\x01`;
  const head = `8=FIX.4.4\x019=${body.length}\x01`;
  let sum = 0;
  for (const ch of head + body) sum += ch.charCodeAt(0);
  await client.sendBytes(head + body + `10=${String(sum % 256).padStart(3, '0')}\x01`);
  client.setSeqNums({ next: 3 });
  await exchange.send('ResendRequest', { BeginSeqNo: 2, EndSeqNo: 0 });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(client.state, 'active');
  const gapFill = client.history.find(e => e.kind === 'message' && e.direction === 'out' && e.message.MsgType === 'SequenceReset');
  assert.ok(gapFill && gapFill.kind === 'message' && gapFill.message.GapFillFlag === true && gapFill.message.NewSeqNo === 3, 'expected a SequenceReset-GapFill covering seq 2');
});

test('after setSeqNums moves next back, a resend carries what was sent last with each MsgSeqNum', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  const stopDropping = client.outgoing(message => (message.PossDupFlag === true ? message : null));
  await client.send('NewOrderSingle', order('first-2'));   // seq 2, dropped by the route: kept, never written
  await client.send('NewOrderSingle', order('first-3'));   // seq 3, the same
  stopDropping();
  client.setSeqNums({ next: 2 });
  await client.send('NewOrderSingle', order('second-2'));   // seq 2 again, with other content
  await exchange.next('NewOrderSingle', { where: { ClOrdID: 'second-2' } });
  client.setSeqNums({ next: 4 });   // seq 3 is not used again
  await exchange.send('ResendRequest', { BeginSeqNo: 2, EndSeqNo: 3 });
  await waitFor(() => resentTo(exchange).length >= 2, 1000, 'the resend');
  // The same in a live session as after a restart: the store's latest original for each number.
  assert.deepEqual(resentTo(exchange), ['2:second-2', '3:first-3']);
});

for (const [name, make] of STORES) {
  test(`what was sent before a Logon reset the sequences is never resent after it (${name})`, { timeout: 10_000 }, async () => {
    const store = await make();   // shared by both sides and every connection
    const clientId: SessionId = { version: 'FIX.4.4', sender: 'CLIENT', target: 'EXCHANGE' };
    const exchangeId: SessionId = { version: 'FIX.4.4', sender: 'EXCHANGE', target: 'CLIENT' };
    const reconnect = async (reset: boolean) => loggedOn({
      store,
      loaded: { client: await store.load(clientId), exchange: await store.load(exchangeId) },
      ...(reset ? { engine: { logon: { ResetSeqNumFlag: true } } } : {}),
    });
    for (const [day, reset, count] of [['day1', false, 5], ['day2', true, 3]] as const) {
      const { client, exchange } = await reconnect(reset);
      for (let k = 0; k < count; k++) await exchange.send('NewOrderSingle', order(`${day}-${k}`));
      for (let k = 0; k < count; k++) await client.next('NewOrderSingle');
      await client.logout();
      await exchange.closed;
    }
    const { client } = await reconnect(false);
    // Day 1 sent MsgSeqNum 2 to 6 and day 2 only 2 to 4: 5 is day 2's Logout, 6 the Logon of this connection.
    await client.send('ResendRequest', { BeginSeqNo: 2, EndSeqNo: 6 });
    const resent = () => client.history.flatMap(e => (e.kind === 'message' && e.direction === 'in' && e.message.PossDupFlag === true ? [e.message] : []));
    await waitFor(() => resent().length >= 4, 1000, 'the resend');
    assert.deepEqual(resent().map(message => [message.MsgSeqNum, message.ClOrdID ?? message.MsgType]), [[2, 'day2-0'], [3, 'day2-1'], [4, 'day2-2'], [5, 'SequenceReset']]);
  });
}

test('after setSeqNums brings next down to 1, a reload resends what was sent since, not what was sent before', { timeout: 10_000 }, async () => {
  for (const store of [memoryStore(), fileStore(await mkdtemp(join(tmpdir(), 'fixjs-session-')))]) {
    const clientId: SessionId = { version: 'FIX.4.4', sender: 'CLIENT', target: 'EXCHANGE' };
    const before = lone({ store, manual: true });
    await before.send('NewOrderSingle', order('before-1'));   // seq 1
    await before.send('NewOrderSingle', order('before-2'));   // seq 2
    before.setSeqNums({ next: 1 });                            // a new epoch
    await before.send('NewOrderSingle', order('after-1'));    // seq 1 again, with new content
    before.close();
    await before.closed;
    // The client logs on with MsgSeqNum 2; the exchange, expecting 1, asks for 1 again.
    const { exchange } = await loggedOn({ store: { client: store }, loaded: { client: await store.load(clientId) } });
    const resent = () => exchange.history.flatMap(e => (e.kind === 'message' && e.direction === 'in' && e.message.MsgType === 'NewOrderSingle' && e.message.PossDupFlag === true ? [String(e.message.ClOrdID)] : []));
    await waitFor(() => resent().length >= 1, 1000, 'the resend');
    assert.deepEqual(resent(), ['after-1']);
  }
});

for (const [name, make] of STORES) {
  test(`a message sent by hand with a low MsgSeqNum is the latest sent with that number, so a resend gap-fills it; the others go again (${name})`, { timeout: 10_000 }, async () => {
    const store = await storeHolding(make, [
      outEntry('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30 }),
      outEntry('NewOrderSingle', 2, { ...order('a'), TransactTime: T0 }),
      outEntry('NewOrderSingle', 3, { ...order('b'), TransactTime: T0 }),
      outEntry('NewOrderSingle', 4, { ...order('c'), TransactTime: T0 }),
      outEntry('Heartbeat', 2),   // sent by hand with a low MsgSeqNum before the reconnect
    ], 5);
    const { client, exchange } = await loggedOn({
      store: { client: store },
      loaded: { client: { history: [], next: 5, expected: 2 }, exchange: { history: [], next: 2, expected: 5 } },
    });
    await exchange.send('ResendRequest', { BeginSeqNo: 2, EndSeqNo: 4 });
    await waitFor(() => resentTo(exchange).length >= 3, 1000, 'the resend');
    assert.deepEqual(resentTo(exchange), ['gap 2-3', '3:b', '4:c']);
    assert.equal(client.state, 'active');
  });
}

for (const [name, make] of STORES) {
  test(`a message sent by hand with a high MsgSeqNum does not hide the messages sent after it from a resend (${name})`, { timeout: 10_000 }, async () => {
    const store = await storeHolding(make, [
      outEntry('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30 }),
      outEntry('NewOrderSingle', 2, { ...order('a'), TransactTime: T0 }),
      outEntry('Heartbeat', 100),   // sent by hand with a high MsgSeqNum
      outEntry('NewOrderSingle', 3, { ...order('c'), TransactTime: T0 }),
      outEntry('NewOrderSingle', 4, { ...order('d'), TransactTime: T0 }),
    ], 5);
    const { client, exchange } = await loggedOn({
      store: { client: store },
      loaded: { client: { history: [], next: 5, expected: 2 }, exchange: { history: [], next: 2, expected: 5 } },
    });
    await exchange.send('ResendRequest', { BeginSeqNo: 2, EndSeqNo: 4 });
    await waitFor(() => resentTo(exchange).length >= 3, 1000, 'the resend');
    assert.deepEqual(resentTo(exchange), ['2:a', '3:c', '4:d']);
    assert.equal(client.state, 'active');
  });
}

for (const [name, make] of STORES) {
  test(`a message kept with its credentials hidden is gap-filled, not resent (${name})`, { timeout: 10_000 }, async () => {
    const store = await storeHolding(make, [
      outEntry('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30 }),
      outEntry('UserRequest', 2, { UserRequestID: 'u1', UserRequestType: 'ChangePasswordForUser', Username: 'desk7', Password: '*****', NewPassword: '*****' }),
    ], 3);
    const { exchange } = await loggedOn({ store: { client: store }, loaded: { client: { history: [], next: 3, expected: 2 }, exchange: { history: [], next: 2, expected: 3 } } });
    await exchange.send('ResendRequest', { BeginSeqNo: 2, EndSeqNo: 2 });
    await waitFor(() => resentTo(exchange).length >= 1, 1000, 'the resend');
    assert.deepEqual(resentTo(exchange), ['gap 2-3']);
  });
}

test('a message that carries a hidden value is gap-filled in a live session too: it never goes again', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  await client.send('UserRequest', { UserRequestID: 'u1', UserRequestType: 'ChangePasswordForUser', Username: 'desk7', Password: 'old-secret', NewPassword: 'new-secret' });   // 2
  await client.send('NewOrderSingle', order('o1'));   // 3
  await exchange.next('NewOrderSingle');
  await exchange.send('ResendRequest', { BeginSeqNo: 2, EndSeqNo: 3 });
  await waitFor(() => resentTo(exchange).length >= 2, 1000, 'the resend');
  assert.deepEqual(resentTo(exchange), ['gap 2-3', '3:o1']);
  assert.equal(exchange.history.filter(e => e.kind === 'message' && e.direction === 'in' && e.message.MsgType === 'UserRequest').length, 1);
});

test('a resend carries what the store was given: a message an outgoing route rewrote goes again as rewritten', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  client.outgoing(message => (message.MsgType === 'NewOrderSingle' && message.PossDupFlag !== true ? { ...message, Text: 'checked' } : message));
  await client.send('NewOrderSingle', order('o1'));
  assert.equal((await exchange.next('NewOrderSingle')).Text, 'checked');
  await exchange.send('ResendRequest', { BeginSeqNo: 2, EndSeqNo: 2 });
  await waitFor(() => resentTo(exchange).length >= 1, 1000, 'the resend');
  const again = exchange.history.flatMap(e => (e.kind === 'message' && e.direction === 'in' && e.message.PossDupFlag === true ? [e.message] : []));
  assert.deepEqual(again.map(message => [message.MsgSeqNum, message.ClOrdID, message.Text]), [[2, 'o1', 'checked']]);
});

test('a message older than memory.history is resent when the store has it', { timeout: 10_000 }, async () => {
  const store = fileStore(await mkdtemp(join(tmpdir(), 'fixjs-session-')));
  const { client, exchange } = await loggedOn({ store: { client: store }, memory: { client: { history: 3 } } });
  for (let i = 0; i < 10; i++) await client.send('NewOrderSingle', order(`o${i}`));   // 2 to 11
  await exchange.next('NewOrderSingle', { where: { ClOrdID: 'o9' } });
  assert.ok(client.history.length <= 3, `history holds ${client.history.length}`);
  await exchange.send('ResendRequest', { BeginSeqNo: 2, EndSeqNo: 4 });
  await waitFor(() => resentTo(exchange).length >= 3, 1000, 'the resend');
  assert.deepEqual(resentTo(exchange), ['2:o0', '3:o1', '4:o2']);
});

test('a memoryStore resends what it holds and no further back, whatever memory.history is', { timeout: 10_000 }, async () => {
  const store = memoryStore({ history: 8 });
  const { client, exchange } = await loggedOn({ store: { client: store } });
  for (let i = 0; i < 10; i++) await client.send('NewOrderSingle', order(`o${i}`));   // 2 to 11
  await exchange.next('NewOrderSingle', { where: { ClOrdID: 'o9' } });
  await exchange.send('ResendRequest', { BeginSeqNo: 2, EndSeqNo: 0 });
  await waitFor(() => resentTo(exchange).length >= 8, 1000, 'the resend');
  // The store holds eight entries of any kind: the ResendRequest itself and the seven orders before it.
  assert.deepEqual(resentTo(exchange), ['gap 2-5', '5:o3', '6:o4', '7:o5', '8:o6', '9:o7', '10:o8', '11:o9']);
  assert.equal(client.state, 'active');
});

for (const [name, make] of STORES) {
  test(`after a reconnect without a reset, a resend reaches back to what earlier connections sent, past what load() gave (${name})`, { timeout: 10_000 }, async () => {
    const store = await make();
    const clientId: SessionId = { version: 'FIX.4.4', sender: 'CLIENT', target: 'EXCHANGE' };
    const first = await loggedOn({ store: { client: store } });
    for (let i = 0; i < 5; i++) await first.client.send('NewOrderSingle', order(`o${i}`));   // 2 to 6
    await first.exchange.next('NewOrderSingle', { where: { ClOrdID: 'o4' } });
    first.client.close();
    await Promise.all([first.client.closed, first.exchange.closed]);
    // The client comes back with a history of two entries; the exchange has lost everything, and asks for it all again.
    const loaded = await store.load(clientId, { history: { entries: 2, bytes: 1_048_576 } });
    assert.equal(loaded.history.length, 2);
    const { exchange } = await loggedOn({ store: { client: store }, loaded: { client: loaded, exchange: { history: [], next: 2, expected: 1 } }, memory: { client: { history: 2 } } });
    await waitFor(() => resentTo(exchange).length >= 7, 1000, 'the resend');
    assert.deepEqual(resentTo(exchange), ['gap 1-2', '2:o0', '3:o1', '4:o2', '5:o3', '6:o4', 'gap 7-8']);
  });
}

test('a resend of a range larger than every memory limit is read and written one message at a time', { timeout: 30_000 }, async () => {
  const files = fileStore(await mkdtemp(join(tmpdir(), 'fixjs-session-')));
  const dict = dictionaryFor('FIX.4.4');
  const count = 300;
  /** Orders the store has given for the resend that are not yet written, and the most there were at once. */
  let ahead = 0;
  let most = 0;
  const store: Store = {
    ...files,
    sent: (id, range, context) => (async function* () {
      for await (const entry of files.sent(id, range, context)) {
        if (entry.kind === 'message' && entry.message.MsgType === 'NewOrderSingle') most = Math.max(most, ++ahead);
        yield entry;
      }
    })(),
  };
  const { client, exchange } = await loggedOn({
    store: { client: store },
    memory: { client: { history: 5, historyBytes: 2_000, outgoingBytes: 4_000 }, exchange: { history: 2_000, historyBytes: 4_194_304 } },
    onWrite: (side, bytes) => {
      const message = inspectMessage(parseFrame(bytes).fields, dict).message;
      if (side === 'client' && message.PossDupFlag === true && message.MsgType === 'NewOrderSingle') ahead--;
    },
  });
  for (let i = 0; i < count; i++) await client.send('NewOrderSingle', order(`o${i}`));
  await exchange.send('ResendRequest', { BeginSeqNo: 1, EndSeqNo: 0 });
  await waitFor(() => resentTo(exchange).length >= count + 1, 20_000, 'the resend');
  assert.deepEqual(resentTo(exchange), ['gap 1-2', ...Array.from({ length: count }, (_, i) => `${i + 2}:o${i}`)]);
  assert.equal(most, 1);
  assert.equal(client.state, 'active');
});

test('a message sent while a resend is being answered is written after it; the resend is recorded with the sequence numbers as they stood when it was asked for', { timeout: 10_000 }, async () => {
  const records: string[] = [];
  const base = memoryStore();
  const { store, release, reads } = heldStore({
    ...base,
    append(id, list, context) {
      for (const { entry, seqNums } of list) {
        if (entry?.kind === 'message' && entry.direction === 'out') records.push(`${brief(entry.message)} next=${seqNums.next}`);
      }
      return base.append(id, list, context);
    },
  });
  const { client, written } = await loneLoggedOn({ store });
  for (const id of ['a', 'b', 'c']) await client.send('NewOrderSingle', order(id));   // 2 to 4
  written.length = 0;
  records.length = 0;
  client.receiveBytes(fromExchange('ResendRequest', 2, { BeginSeqNo: 2, EndSeqNo: 0 }));
  await waitFor(() => written.length === 1, 1000, 'the first resent order');
  const later = client.send('NewOrderSingle', order('later'));   // 5, numbered while the resend waits for its store
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(written.map(brief), ['NewOrderSingle 2 PossDup']);
  release();
  await later;
  assert.deepEqual(written.map(brief), ['NewOrderSingle 2 PossDup', 'NewOrderSingle 3 PossDup', 'NewOrderSingle 4 PossDup', 'NewOrderSingle 5']);
  assert.deepEqual(records, ['NewOrderSingle 2 PossDup next=5', 'NewOrderSingle 3 PossDup next=5', 'NewOrderSingle 4 PossDup next=5', 'NewOrderSingle 5 next=6']);
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(reads, { begun: 1, closed: 1 });
});

test('a Logon that resets the sequences while a resend is being answered stops it: nothing more of the old sequence is sent', { timeout: 10_000 }, async () => {
  const { store, release, reads } = heldStore();
  const { client, written } = await loneLoggedOn({ store });
  for (const id of ['a', 'b', 'c']) await client.send('NewOrderSingle', order(id));   // 2 to 4
  written.length = 0;
  client.receiveBytes(fromExchange('ResendRequest', 2, { BeginSeqNo: 2, EndSeqNo: 0 }));
  await waitFor(() => written.length === 1, 1000, 'the first resent order');
  client.receiveBytes(fromExchange('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true }));
  for (let i = 0; i < 5; i++) await tick();
  release();
  await waitFor(() => written.some(message => message.MsgType === 'Logon'), 1000, 'the reply to the reset');
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(written.map(brief), ['NewOrderSingle 2 PossDup', 'Logon 1']);
  assert.deepEqual(reads, { begun: 1, closed: 1 });
  assert.deepEqual([client.state, client.seqNums], ['active', { next: 2, expected: 2 }]);
});

test('a ResendRequest taken before the sequences were reset is not answered after it', { timeout: 10_000 }, async () => {
  const { store, release, reads } = heldStore();
  const { client, written } = await loneLoggedOn({ store });
  for (const id of ['a', 'b', 'c']) await client.send('NewOrderSingle', order(id));   // 2 to 4
  written.length = 0;
  client.receiveBytes(fromExchange('ResendRequest', 2, { BeginSeqNo: 2, EndSeqNo: 0 }));
  await waitFor(() => written.length === 1, 1000, 'the first resent order');
  client.receiveBytes(fromExchange('ResendRequest', 3, { BeginSeqNo: 3, EndSeqNo: 0 }));   // waits behind the first
  for (let i = 0; i < 5; i++) await tick();
  client.setSeqNums({ next: 1 });
  release();
  await client.send('NewOrderSingle', order('new'));   // 1 of the new sequence, behind both
  assert.deepEqual(written.map(brief), ['NewOrderSingle 2 PossDup', 'NewOrderSingle 1']);
  assert.deepEqual(reads, { begun: 1, closed: 1 });
});

test('a store that gives a resend entries out of order, twice, out of range or of the wrong kind cannot confuse the session: they are left out', { timeout: 10_000 }, async () => {
  const copy = outEntry('NewOrderSingle', 4, { ...order('copy'), TransactTime: T0, PossDupFlag: true, OrigSendingTime: T0 });
  const received: Entry = { ...outEntry('NewOrderSingle', 4, { ...order('received'), TransactTime: T0 }), direction: 'in' } as Entry;
  const given: unknown[] = [
    outEntry('NewOrderSingle', 3, { ...order('c'), TransactTime: T0 }),
    outEntry('NewOrderSingle', 2, { ...order('late'), TransactTime: T0 }),       // lower than the one before
    outEntry('NewOrderSingle', 3, { ...order('again'), TransactTime: T0 }),      // the same number twice
    outEntry('NewOrderSingle', 19, { ...order('beyond'), TransactTime: T0 }),    // past the range
    copy, received,
    { kind: 'problem', direction: 'in', at: T0, problem: { code: 'Garbled', text: 'x', action: 'Ignored' } },
    null, 7, { kind: 'message', direction: 'out', at: T0 },
    outEntry('NewOrderSingle', 4, { ...order('d'), TransactTime: T0 }),
  ];
  const store = storeSending(async function* () { yield* given as Entry[]; });
  const { client, written } = await loneLoggedOn({ store, next: 13 });   // its Logon took 13
  // A range of eleven numbers: the store may give eleven entries, and gives eleven.
  client.receiveBytes(fromExchange('ResendRequest', 2, { BeginSeqNo: 2, EndSeqNo: 12 }));
  await waitFor(() => written.length >= 4, 1000, 'the resend');
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(written.map(message => `${brief(message)} ${String(message.ClOrdID ?? message.NewSeqNo)}`), ['SequenceReset 2 PossDup 3', 'NewOrderSingle 3 PossDup c', 'NewOrderSingle 4 PossDup d', 'SequenceReset 5 PossDup 13']);
  assert.equal(client.state, 'active');
  assert.deepEqual(errorTexts(client), []);
});

test('a store that stops answering while it is read for a resend closes the session after storeTimeout, as a store write that stops does', { timeout: 10_000 }, async () => {
  const clock = fakeClock(T0);
  let closed = 0;
  const store = storeSending(() => ({
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<Entry>>(() => {}),   // never answers
      return: async () => { closed++; return { done: true as const, value: undefined }; },
    }),
  }));
  const { client, written } = await loneLoggedOn({ store, clock, next: 5 });
  client.receiveBytes(fromExchange('ResendRequest', 2, { BeginSeqNo: 2, EndSeqNo: 4 }));
  for (let i = 0; i < 5; i++) await tick();
  await clock.advance('9s');
  assert.equal(client.state, 'active');
  await clock.advance('2s');
  const reason = await client.closed;
  assert.deepEqual(reason, { by: 'us', text: 'Store read took longer than 10 s' });
  assert.deepEqual(errorTexts(client), ['Store read took longer than 10 s']);
  assert.deepEqual(written, []);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(closed, 1);
});

const FAILING_READS: readonly (readonly [string, Store['sent']])[] = [
  ['part-way through', async function* () { yield outEntry('NewOrderSingle', 2, { ...order('a'), TransactTime: T0 }); throw new Error('disk gone'); }],
  ['when it is asked', () => { throw new Error('disk gone'); }],
  ['by giving something that is not entries', () => 42 as never],
  ['by answering with nothing', () => ({ [Symbol.asyncIterator]: () => ({ next: async () => undefined as never }) })],
  ['by answering with a number', () => ({ [Symbol.asyncIterator]: () => ({ next: async () => 42 as never }) })],
];
for (const [what, sent] of FAILING_READS) {
  test(`a store that fails ${what} while it is read for a resend closes the session, and the rest of the range is not gap-filled`, { timeout: 10_000 }, async () => {
    const reported: unknown[] = [];
    const base = storeSending(sent);
    /** What the store is given once it is being read for the resend. */
    const kept: string[] = [];
    const store: Store = { ...base, append: (id, records, context) => { kept.push(...records.map(described)); return base.append(id, records, context); } };
    const { client, written } = await loneLoggedOn({ store, next: 5, onHandlerError: error => reported.push(error) });
    kept.length = 0;
    client.receiveBytes(fromExchange('ResendRequest', 2, { BeginSeqNo: 2, EndSeqNo: 4 }));
    const reason = await client.closed;
    assert.deepEqual(reason, { by: 'us', text: 'Store could not be read for a resend' });
    // The store that has just failed is not given its own failure to keep.
    assert.deepEqual(kept, what === 'part-way through' ? ['in ResendRequest', 'out NewOrderSingle'] : ['in ResendRequest']);
    assert.deepEqual(written.map(brief), what === 'part-way through' ? ['NewOrderSingle 2 PossDup'] : []);
    assert.equal(errorTexts(client).length, 2);
    assert.equal(errorTexts(client)[1], 'Store could not be read for a resend');
    assert.equal(reported.length, 1);
    if (what.startsWith('by answering')) {
      assert.equal(errorTexts(client)[0], "The store's sent() did not give an iterator result");
    } else if (what !== 'by giving something that is not entries') {
      assert.equal(errorTexts(client)[0], 'disk gone');
      assert.equal((reported[0] as Error).message, 'disk gone');
    }
  });
}

test('one ResendRequest is answered at a time and sixteen may wait: the seventeenth to wait closes the session', { timeout: 10_000 }, async () => {
  const store = storeSending(() => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Entry>>(() => {}) }) }));   // the first answer never gets its first entry
  const { client } = await loneLoggedOn({ store, next: 5 });
  client.receiveBytes(fromExchange('ResendRequest', 2, { BeginSeqNo: 2, EndSeqNo: 4 }));
  for (let i = 0; i < 5; i++) await tick();
  for (let n = 1; n <= 16; n++) client.receiveBytes(fromExchange('ResendRequest', 2 + n, { BeginSeqNo: 2, EndSeqNo: 4 }));
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(client.state, 'active');
  client.receiveBytes(fromExchange('ResendRequest', 19, { BeginSeqNo: 2, EndSeqNo: 4 }));
  const reason = await client.closed;
  assert.deepEqual(reason, { by: 'us', text: 'Too many ResendRequests waiting' });
});

test('the same ResendRequest asked three times of a session on the default memoryStore is answered in full each time: the copies it resends do not push the originals out', { timeout: 30_000 }, async () => {
  const { client, exchange } = await loggedOn();   // each side on a memoryStore of its own, as when no store is given
  const count = 600;   // with their copies, more than the 1,000 entries the store keeps
  for (let i = 0; i < count; i++) await client.send('NewOrderSingle', order(`o${i}`));   // 2 to 601
  await exchange.next('NewOrderSingle', { where: { ClOrdID: `o${count - 1}` } });
  for (const request of [1, 2, 3]) {
    let orders = 0;
    const gaps: string[] = [];
    /** The highest MsgSeqNum the answer has reached. */
    let reached = 1;
    const stop = exchange.watch(entry => {
      if (entry.kind !== 'message' || entry.direction !== 'in' || entry.message.PossDupFlag !== true) return;
      if (entry.message.MsgType === 'SequenceReset') {
        gaps.push(`gap ${String(entry.message.MsgSeqNum)}-${String(entry.message.NewSeqNo)}`);
        reached = Number(entry.message.NewSeqNo) - 1;
      } else {
        orders++;
        reached = Number(entry.message.MsgSeqNum);
      }
    });
    await exchange.send('ResendRequest', { BeginSeqNo: 2, EndSeqNo: count + 1 });
    await waitFor(() => reached >= count + 1, 10_000, `the answer to request ${request}`);
    stop();
    assert.deepEqual({ request, orders, gaps }, { request, orders: count, gaps: [] });
  }
  assert.equal(client.state, 'active');
});

const userRequest = { UserRequestID: 'u1', UserRequestType: 'ChangePasswordForUser', Username: 'desk7', Password: '*****', NewPassword: '*****' };
/** An original kept with a value hidden, and the `redact` of the session now asked to resend it. */
const HIDDEN_UNDER_OTHER_RULES: readonly (readonly [string, readonly number[] | false | undefined, () => Entry])[] = [
  ['a Password hidden by the default, in a session that hides only Account (redact: [1])', [1], () => outEntry('UserRequest', 2, userRequest)],
  ['a Password hidden by the default, in a session that hides nothing (redact: false)', false, () => outEntry('UserRequest', 2, userRequest)],
  ['an Account hidden by redact: [1], in a session with the default', undefined, () => outEntry('NewOrderSingle', 2, { ...order('a'), TransactTime: T0, Account: '*****' })],
  ['a PartyID hidden inside a repeating group, in a session with the default', undefined, () => outEntry('NewOrderSingle', 2, { ...order('a'), TransactTime: T0, Parties: [{ PartyID: 'desk7', PartyRole: 'ClientID' }, { PartyID: '*****', PartyRole: 'EnteringTrader' }] })],
];
for (const [what, redact, kept] of HIDDEN_UNDER_OTHER_RULES) {
  test(`a kept message with a hidden value is gap-filled whatever this session hides, so the mask never goes on the wire: ${what}`, { timeout: 10_000 }, async () => {
    const store = storeSending(async function* () { yield kept(); });
    const { client, written } = await loneLoggedOn({ store, next: 3, ...(redact === undefined ? {} : { redact }) });   // its Logon took 3
    client.receiveBytes(fromExchange('ResendRequest', 2, { BeginSeqNo: 2, EndSeqNo: 2 }));
    await waitFor(() => written.length >= 1, 1000, 'the answer');
    for (let i = 0; i < 5; i++) await tick();
    assert.deepEqual(written.map(message => `${brief(message)} ${String(message.NewSeqNo)}`), ['SequenceReset 2 PossDup 3']);
    assert.doesNotMatch(JSON.stringify(written), /\*{5}/);
    assert.equal(client.state, 'active');
  });
}

test('a message stored with its real values by a session that hides nothing is resent as stored by a session that hides them: redaction never changes the wire', { timeout: 10_000 }, async () => {
  const store = memoryStore();
  const id = { version: 'FIX.4.4', sender: 'CLIENT', target: 'EXCHANGE' } as const;
  const passwords = (message: MessageObject) => [message.Password, message.NewPassword];
  // A session with redact: false sends a UserRequest, MsgSeqNum 2: the store is given its real values.
  const before = await loneLoggedOn({ store, redact: false });
  await before.client.send('UserRequest', { ...userRequest, Password: 'hunter2', NewPassword: 'hunter3' });
  const stored: Entry[] = [];
  for await (const entry of store.sent(id, { from: 2, to: 2 })) stored.push(entry);
  assert.deepEqual(stored.map(entry => entry.kind === 'message' && passwords(entry.message)), [['hunter2', 'hunter3']]);
  // A session on the same store with the default redaction (its Logon took 3) is asked for it again.
  const { client, written } = await loneLoggedOn({ store, next: 3 });
  client.receiveBytes(fromExchange('ResendRequest', 2, { BeginSeqNo: 2, EndSeqNo: 2 }));
  await waitFor(() => written.length >= 1, 1000, 'the answer');
  for (let i = 0; i < 5; i++) await tick();
  // On the wire: the message as stored, its real values in it.
  assert.deepEqual(written.map(brief), ['UserRequest 2 PossDup']);
  assert.deepEqual(passwords(written[0]!), ['hunter2', 'hunter3']);
  assert.equal(written[0]!.Username, 'desk7');
  // What the session shows of the copy it sent hides them, as it hides them in any message.
  const shown = client.history.flatMap(entry => (entry.kind === 'message' && entry.direction === 'out' && entry.message.MsgType === 'UserRequest' ? [entry] : []));
  assert.deepEqual(shown.map(entry => [brief(entry.message), ...passwords(entry.message)]), [['UserRequest 2 PossDup', '*****', '*****']]);
  assert.doesNotMatch(Buffer.from(shown[0]!.bytes!).toString('latin1'), /hunter/);
  assert.equal(client.state, 'active');
});

for (const [name, make] of STORES) {
  test(`${name}: messages numbered before a reset the counterparty asks for are kept after it, at the head of the new epoch, and a resend in the new epoch gives each number's latest message`, { timeout: 10_000 }, async () => {
    const inner = await make();
    const kept: string[] = [];
    const store: Store = { ...inner, append: (id, records, context) => { kept.push(...records.map(record => `${record.newEpoch ? 'new epoch: ' : ''}${described(record)}${record.entry?.kind === 'message' ? ` ${String(record.entry.message.MsgSeqNum)}` : ''}`)); return inner.append(id, records, context); } };
    const { client, written } = await loneLoggedOn({ store });                     // its Logon took 1
    for (const label of ['a', 'b']) await client.send('NewOrderSingle', order(label));   // 2 and 3
    kept.length = 0;
    // Three more are numbered and on their way to the store when the counterparty's Logon resets the sequences.
    const late = ['c', 'd', 'e'].map(label => client.send('NewOrderSingle', order(label)));
    client.receiveBytes(fromExchange('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true }));
    await Promise.allSettled(late);
    for (let i = 0; i < 5; i++) await tick();
    // The first was already with the store; the other two are kept in the new epoch, before the Logon sent in reply.
    assert.deepEqual(kept, ['out NewOrderSingle 4', 'new epoch: in Logon 1', 'out NewOrderSingle 5', 'out NewOrderSingle 6', 'out Logon 1']);
    for (const label of ['f', 'g', 'h', 'i']) await client.send('NewOrderSingle', order(label));   // 2 to 5 of the new sequence
    written.length = 0;
    client.receiveBytes(fromExchange('ResendRequest', 2, { BeginSeqNo: 1, EndSeqNo: 0 }));
    await waitFor(() => written.length >= 5, 1000, 'the answer');
    for (let i = 0; i < 5; i++) await tick();
    // 5 was used in both sequences: the one sent after the reset is the one sent again. 6 is not asked for: the new sequence has not reached it.
    assert.deepEqual(written.map(message => `${brief(message)} ${String(message.ClOrdID ?? message.NewSeqNo)}`),
      ['SequenceReset 1 PossDup 2', 'NewOrderSingle 2 PossDup f', 'NewOrderSingle 3 PossDup g', 'NewOrderSingle 4 PossDup h', 'NewOrderSingle 5 PossDup i']);
    assert.equal(client.state, 'active');
  });
}

/** Resolve once `session` has closed or `deadline` (a time of the real clock) has passed. */
async function closedBy(session: FixSession, deadline: number): Promise<void> {
  while (session.state !== 'closed' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
}

test('a store that gives a resend more entries than its range holds numbers has failed: the session closes, and reads no further', { timeout: 10_000 }, async () => {
  // The store stops by itself after two seconds, so a session that goes on reading it fails this test and does not hang it.
  const deadline = Date.now() + 2_000;
  let given = 0;
  const beyond = outEntry('NewOrderSingle', 9, { ...order('beyond'), TransactTime: T0 });
  const store = storeSending(async function* () {
    while (Date.now() < deadline) {
      given++;
      yield beyond;
    }
  });
  const { client, written } = await loneLoggedOn({ store, next: 5 });   // its Logon took 5
  client.receiveBytes(fromExchange('ResendRequest', 2, { BeginSeqNo: 2, EndSeqNo: 4 }));
  await closedBy(client, deadline + 500);
  assert.equal(client.state, 'closed');
  assert.deepEqual(await client.closed, { by: 'us', text: 'Store could not be read for a resend' });
  assert.equal(given, 4);
  assert.deepEqual(errorTexts(client), ["The store's sent() gave more entries than the 3 MsgSeqNums from 2 to 4", 'Store could not be read for a resend']);
  assert.deepEqual(written, []);
});

test('a store that gives a resend a long run of entries with nothing to wait for between them does not keep timers from running', { timeout: 20_000 }, async () => {
  const deadline = Date.now() + 5_000;   // as above: the store stops by itself
  const count = 100_000;
  let given = 0;
  const beyond = outEntry('NewOrderSingle', count + 9, { ...order('beyond'), TransactTime: T0 });
  const store = storeSending(async function* () {
    while (Date.now() < deadline) {
      given++;
      yield beyond;
    }
  });
  const { client } = await loneLoggedOn({ store, next: count + 2 });
  /** How many entries the store had given when a timer set for a millisecond from now ran. */
  let givenAtTimer: number | undefined;
  const timer = setTimeout(() => { givenAtTimer = given; }, 1);
  client.receiveBytes(fromExchange('ResendRequest', 2, { BeginSeqNo: 2, EndSeqNo: count + 1 }));
  await closedBy(client, deadline + 500);
  clearTimeout(timer);
  assert.ok(givenAtTimer !== undefined && givenAtTimer < count, `the timer ran once the store had given ${String(givenAtTimer)} of ${count} entries`);
  assert.equal(client.state, 'closed');
  assert.deepEqual(await client.closed, { by: 'us', text: 'Store could not be read for a resend' });
  assert.equal(given, count + 1);
});

for (const [name, slow] of [['a memoryStore', false], ['a store that takes a moment to keep each record', true]] as const) {
  test(`a message an outgoing route dropped is resent when the ResendRequest for it comes straight after it, before its record has reached the store (${name})`, { timeout: 10_000 }, async () => {
    const base = memoryStore();
    const store: Store = slow ? { ...base, async append(id, record, context) { await tick(); return base.append(id, record, context); } } : base;
    const { client, written } = await loneLoggedOn({ store });
    client.outgoing(message => (message.ClOrdID === 'lost' && message.PossDupFlag !== true ? null : message));
    const sent = client.send('NewOrderSingle', order('lost'));   // 2: kept, never written
    client.receiveBytes(fromExchange('ResendRequest', 2, { BeginSeqNo: 2, EndSeqNo: 2 }));
    await sent;
    await waitFor(() => written.length >= 1, 1000, 'the answer');
    for (let i = 0; i < 5; i++) await tick();
    assert.deepEqual(written.map(message => `${brief(message)} ${String(message.ClOrdID ?? message.NewSeqNo)}`), ['NewOrderSingle 2 PossDup lost']);
  });
}

test('sequences reset while a resend waits for the store to keep what was queued before it: the store is not read for it', { timeout: 10_000 }, async () => {
  const base = memoryStore();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let hold = false;
  let reads = 0;
  const store: Store = {
    ...base,
    async append(id, record, context) { if (hold) await held; return base.append(id, record, context); },
    sent: (id, range, context) => { reads++; return base.sent(id, range, context); },
  };
  const { client, written } = await loneLoggedOn({ store });
  await client.send('NewOrderSingle', order('a'));   // 2
  written.length = 0;
  hold = true;
  client.receiveBytes(fromExchange('ResendRequest', 2, { BeginSeqNo: 2, EndSeqNo: 0 }));   // its own record is not kept yet
  for (let i = 0; i < 5; i++) await tick();
  client.setSeqNums({ next: 1 });
  release();
  await client.send('NewOrderSingle', order('new'));
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(written.map(brief), ['NewOrderSingle 1']);
  assert.equal(reads, 0);
});

test('a session closed while a long resend lets the event loop turn asks its store for nothing more', { timeout: 10_000 }, async () => {
  let asked = 0;
  let closed = 0;
  let close = () => {};
  const beyond = outEntry('NewOrderSingle', 9_999, { ...order('beyond'), TransactTime: T0 });
  const store = storeSending(() => ({
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        // The 256th entry is the one after which the answer lets the event loop turn: the session closes in that turn.
        if (++asked === 256) setImmediate(close);
        return asked > 2_000 ? { done: true as const, value: undefined } : { done: false as const, value: beyond };
      },
      return: async () => { closed++; return { done: true as const, value: undefined }; },
    }),
  }));
  const { client, written } = await loneLoggedOn({ store, next: 1_002 });
  close = () => client.close();
  client.receiveBytes(fromExchange('ResendRequest', 2, { BeginSeqNo: 2, EndSeqNo: 1_001 }));
  await client.closed;
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual([asked, closed], [256, 1]);
  assert.deepEqual(written, []);
});

test('sequences reset while a gap fill of a resend is on its way: the message that was to follow it is not sent, and the store is not read again', { timeout: 10_000 }, async () => {
  const base = memoryStore();
  let asked = 0;
  const store: Store = {
    ...base,
    sent: (id, range, context) => ({
      [Symbol.asyncIterator]: () => {
        const reader = base.sent(id, range, context)[Symbol.asyncIterator]();
        return { next: () => { asked++; return reader.next(); }, return: async () => ({ done: true as const, value: undefined }) };
      },
    }),
  };
  const { client, written } = await loneLoggedOn({ store });
  await client.send('Heartbeat');                       // 2: covered by a gap fill
  await client.send('NewOrderSingle', order('a'));      // 3: planned together with that gap fill
  await client.send('NewOrderSingle', order('b'));      // 4
  written.length = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  client.outgoing(async message => { if (message.MsgType === 'SequenceReset') await gate; return message; });
  client.receiveBytes(fromExchange('ResendRequest', 2, { BeginSeqNo: 2, EndSeqNo: 0 }));
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(asked, 2);   // the Heartbeat and the first order: the gap fill before the order waits in the route
  client.setSeqNums({ next: 1 });
  release();
  await client.send('NewOrderSingle', order('new'));   // 1 of the new sequence
  for (let i = 0; i < 5; i++) await tick();
  // The gap fill was already with the route when the sequences were reset; nothing else of the old sequence follows it.
  assert.deepEqual(written.map(brief), ['SequenceReset 2 PossDup', 'NewOrderSingle 1']);
  assert.equal(asked, 2);
});

test('sequences reset while a resent message is on its way: the store is not asked for the entry after it', { timeout: 10_000 }, async () => {
  const base = memoryStore();
  let asked = 0;
  const store: Store = {
    ...base,
    sent: (id, range, context) => ({
      [Symbol.asyncIterator]: () => {
        const reader = base.sent(id, range, context)[Symbol.asyncIterator]();
        return { next: () => { asked++; return reader.next(); }, return: async () => ({ done: true as const, value: undefined }) };
      },
    }),
  };
  const { client, written } = await loneLoggedOn({ store });
  for (const id of ['a', 'b']) await client.send('NewOrderSingle', order(id));   // 2 and 3
  written.length = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  client.outgoing(async message => { if (message.PossDupFlag === true) await gate; return message; });
  client.receiveBytes(fromExchange('ResendRequest', 2, { BeginSeqNo: 2, EndSeqNo: 0 }));
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(asked, 1);
  client.setSeqNums({ next: 1 });
  release();
  await client.send('NewOrderSingle', order('new'));
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(written.map(brief), ['NewOrderSingle 2 PossDup', 'NewOrderSingle 1']);
  assert.equal(asked, 1);
});

test('a resend stopped by a reset of the sequences does not judge its store: an entry too many given after the reset closes nothing', { timeout: 10_000 }, async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const store = storeSending(async function* () {
    yield outEntry('NewOrderSingle', 2, { ...order('a'), TransactTime: T0 });
    await held;
    yield outEntry('NewOrderSingle', 2, { ...order('again'), TransactTime: T0 });   // a second entry for a range of one number
  });
  const { client, written } = await loneLoggedOn({ store, next: 3 });   // its Logon took 3
  client.receiveBytes(fromExchange('ResendRequest', 2, { BeginSeqNo: 2, EndSeqNo: 2 }));
  await waitFor(() => written.length === 1, 1000, 'the resent order');
  for (let i = 0; i < 5; i++) await tick();
  client.setSeqNums({ next: 1 });
  release();
  await client.send('NewOrderSingle', order('new'));
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(written.map(brief), ['NewOrderSingle 2 PossDup', 'NewOrderSingle 1']);
  assert.equal(client.state, 'active');
  assert.deepEqual(errorTexts(client), []);
});

test('a resent message counts as sent just then: no Heartbeat is owed until a heartbeat interval after it, and it uses no sequence number', { timeout: 10_000 }, async () => {
  const clock = fakeClock(T0);
  const { client, written } = await loneLoggedOn({ clock });
  await client.send('NewOrderSingle', order('a'));   // 2, at 12:00:00
  written.length = 0;
  await clock.advance('20s');
  client.receiveBytes(fromExchange('ResendRequest', 2, { BeginSeqNo: 2, EndSeqNo: 0 }));   // answered at 12:00:20
  await waitFor(() => written.length === 1, 1000, 'the resent order');
  assert.deepEqual(client.seqNums, { next: 3, expected: 3 });
  await clock.advance('25s');   // 12:00:45: 45 s after the order, 25 s after its copy
  assert.deepEqual(written.map(brief), ['NewOrderSingle 2 PossDup']);
  client.receiveBytes(fromExchange('Heartbeat', 3));
  await clock.advance('10s');   // 12:00:55
  assert.deepEqual(written.map(brief), ['NewOrderSingle 2 PossDup', 'Heartbeat 3']);
});

test('history restored from a store that never redacted (an older build, or redact: false) is shown redacted', { timeout: 10_000 }, async () => {
  const history = [
    outEntry('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30, Username: 'desk7', Password: 'secretPW' }),
  ];
  const { client } = await loggedOn({
    loaded: { client: { history, next: 3, expected: 1 }, exchange: { history: [], next: 1, expected: 3 } },
  });
  const shown = client.history.find(e => e.kind === 'message' && e.message.MsgSeqNum === 1);
  assert.ok(shown?.kind === 'message');
  assert.equal(shown.message.Password, '*****');
  assert.doesNotMatch(Buffer.from(shown.bytes ?? []).toString('latin1'), /secretPW/);
  assert.equal(client.state, 'active');
});

test("an error or problem's own text never echoes a hidden value (a route rewriting a redacted field into something that fails to encode, say)", { timeout: 10_000 }, async () => {
  const { client } = await loggedOn();
  client.outgoing(message => (message.MsgType === 'UserRequest' ? { ...message, Password: 98765432 } : message));
  const sent = client.send('UserRequest', { UserRequestID: 'u2', UserRequestType: 'ChangePasswordForUser', Username: 'd', Password: 'x' }).catch(error => error);
  const reason = await client.closed;
  await sent;
  assert.doesNotMatch(reason.text, /98765432/);
  for (const entry of errorTexts(client)) assert.doesNotMatch(entry, /98765432/);
  assert.ok(errorTexts(client).length > 0, 'expected the encode failure to still be recorded');
});

test('a route or handler error that quotes a hidden value is masked in history', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  exchange.incoming(message => {
    if (message.MsgType === 'UserRequest') throw new Error(`rejecting password '${String(message.Password)}'`);
    return message;
  });
  exchange.on('UserRequest', message => { throw new Error(`handler saw "${String(message.NewPassword)}"`); });
  exchange.on('UserRequest', async message => { throw new Error(`async handler saw '${String(message.Password)}'`); });
  await client.send('UserRequest', { UserRequestID: 'u1', UserRequestType: 'ChangePasswordForUser', Username: 'd', Password: 'oldPW99', NewPassword: 'newPW99' });
  await waitFor(() => errorTexts(exchange).length >= 3, 1000, 'three error entries');
  assert.deepEqual(errorTexts(exchange), ["rejecting password '*****'", 'handler saw "*****"', "async handler saw '*****'"]);
  for (const entry of exchange.history) {
    if (entry.kind === 'error') assert.doesNotMatch(entry.stack ?? '', /oldPW99|newPW99/);
  }
});

test('a masked error keeps its class and properties: a FIXEncodeError is still a FIXEncodeError', { timeout: 10_000 }, async () => {
  const { client } = await loggedOn();
  client.outgoing(message => (message.MsgType === 'UserRequest' ? { ...message, Password: 98765432 } : message));
  const error = await client.send('UserRequest', { UserRequestID: 'u2', UserRequestType: 'ChangePasswordForUser', Username: 'd', Password: 'x' }).catch((e: unknown) => e);
  assert.ok(error instanceof FIXEncodeError, `expected a FIXEncodeError, got ${String(error)}`);
  assert.equal(error.name, 'FIXEncodeError');
  assert.doesNotMatch(error.message, /98765432/);
  assert.doesNotMatch(error.stack ?? '', /98765432/);
});

test('a hidden value that is also an ordinary word (a Password of \'Logon\') does not mangle problem and close texts', { timeout: 10_000 }, async () => {
  const { exchange } = connectedPair();
  const dict = dictionaryFor('FIX.4.4');
  const { fields: raw, framing } = fromMessage('UserRequest', {
    SenderCompID: 'CLIENT', TargetCompID: 'EXCHANGE', MsgSeqNum: 1, SendingTime: T0,
    UserRequestID: 'u', UserRequestType: 'ChangePasswordForUser', Username: 'd', Password: 'Logon',
  }, dict, { version: 'FIX.4.4' });
  exchange.receiveBytes(buildFrame(raw, framing));
  const reason = await exchange.closed;
  assert.equal(reason.text, 'The first message was not a Logon');
  const problems = exchange.history.flatMap(entry => (entry.kind === 'problem' ? [entry.problem.text] : []));
  assert.deepEqual(problems, ['The first message must be a Logon, not UserRequest']);
});

test('a stored message whose data field alone is hidden (redact: [96]) is restored from a fileStore', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-redact-data-'));
  const session = new FixSession({
    config: engineConfig({ version: 'FIX.4.4', sender: 'CLIENT', target: 'EXCHANGE', role: 'initiator', manual: true }),
    dictionary: dictionaryFor('FIX.4.4'), store: fileStore(dir), clock: fakeClock(T0),
    loaded: { history: [], next: 1, expected: 1 }, redact: [96],
  });
  session.attach({ write: async () => {}, end: () => {} });
  await session.send('NewOrderSingle', { ...order('o1'), RawDataLength: 9, RawData: 'abcdefghi' });
  session.close();
  await session.closed;
  const restored = (await fileStore(dir).load(session.id)).history.filter(entry => entry.kind === 'message');
  assert.equal(restored.length, 1);
  assert.ok(restored[0]?.kind === 'message');
  // RawData isn't a NewOrderSingle field, so it's kept under its tag number.
  assert.deepEqual([restored[0].message[95], restored[0].message[96], restored[0].message.ClOrdID], ['5', '*****', 'o1']);
});

test("a decode problem's text never echoes the bad wire value of a hidden Logon field (RawDataLength sent as '12ab')", { timeout: 10_000 }, async () => {
  const acceptor = new FixSession({
    config: engineConfig({ version: 'FIX.4.4', sender: 'EXCHANGE', target: 'CLIENT', role: 'acceptor' }),
    dictionary: dictionaryFor('FIX.4.4'), store: memoryStore(), clock: fakeClock(T0),
    loaded: { history: [], next: 1, expected: 1 },
  });
  acceptor.attach({ write: async () => {}, end: () => {} });
  const body = '35=A\x0149=CLIENT\x0156=EXCHANGE\x0134=1\x0152=20260930-12:00:00.000\x0198=0\x01108=30\x0195=12ab\x01';
  const head = `8=FIX.4.4\x019=${body.length}\x01${body}`;
  const bytes = Buffer.from(`${head}10=${checksum(Buffer.from(head, 'latin1'))}\x01`, 'latin1');
  acceptor.receiveBytes(bytes);
  await tick();
  const problem = acceptor.history.find(e => e.kind === 'problem');
  assert.ok(problem?.kind === 'problem', `expected a problem entry, got ${JSON.stringify(acceptor.history.map(e => e.kind))}`);
  assert.doesNotMatch(problem.problem.text, /12ab/);
  const reason = await acceptor.closed;
  assert.doesNotMatch(reason.text, /12ab/);
});

/** A frame written by hand, as no encoder would write it: `fields` are the tag=value texts that follow BeginString and BodyLength. */
function handFrame(version: string, fields: readonly string[]): Uint8Array {
  const body = `${fields.join('\x01')}\x01`;
  const head = `8=${version}\x019=${body.length}\x01${body}`;
  return Buffer.from(`${head}10=${checksum(Buffer.from(head, 'latin1'))}\x01`, 'latin1');
}

/** An acceptor (EXCHANGE) of `version`, with every frame it writes kept as text. */
function acceptorOf(version: 'FIX.4.4' | 'FIXT.1.1') {
  const written: string[] = [];
  const session = new FixSession({
    config: engineConfig({ version, sender: 'EXCHANGE', target: 'CLIENT', role: 'acceptor' }),
    dictionary: dictionaryFor(version), store: memoryStore(), clock: fakeClock(T0),
    loaded: { history: [], next: 1, expected: 1 },
  });
  session.attach({ write: async bytes => { written.push(Buffer.from(bytes).toString('latin1').replaceAll('\x01', '|')); }, end: () => {} });
  return { session, written };
}

const fromClient = (seq: number, ...fields: string[]) => [`49=CLIENT`, '56=EXCHANGE', `34=${seq}`, '52=20260930-12:00:00.000', ...fields];

for (const version of ['FIX.4.4', 'FIXT.1.1'] as const) {
  const logonFields = ['98=0', '108=30', ...(version === 'FIXT.1.1' ? ['1137=9'] : [])];

  test(`${version}: a Logon that carries MsgType twice is refused, and the session never opens`, { timeout: 10_000 }, async () => {
    const { session, written } = acceptorOf(version);
    session.receiveBytes(handFrame(version, ['35=A', ...fromClient(1, '35=A', ...logonFields)]));
    const reason = await session.closed;
    assert.deepEqual([reason.by, reason.text, reason.problem?.code], ['us', 'Tag 35 appears more than once', 'TagAppearsMoreThanOnce']);
    assert.equal(written.length, 1);
    assert.match(written[0]!, /\|35=5\|.*\|58=Tag 35 appears more than once\|/);
    assert.equal(session.history.some(entry => entry.kind === 'message' && entry.message.MsgType === 'Heartbeat'), false);
  });

  test(`${version}: a message in a session that carries MsgType twice is rejected as a repeated tag, and the session carries on`, { timeout: 10_000 }, async () => {
    const { session, written } = acceptorOf(version);
    const delivered: string[] = [];
    session.on('TestRequest', message => { delivered.push(String(message.TestReqID)); });
    session.receiveBytes(handFrame(version, ['35=A', ...fromClient(1, ...logonFields)]));
    await session.active;
    session.receiveBytes(handFrame(version, ['35=1', ...fromClient(2, '35=1', '112=T1')]));
    await tick();
    const reject = written.find(frame => frame.includes('|35=3|'));
    assert.match(reject ?? '', /\|45=2\|371=35\|.*\|58=Tag 35 appears more than once\|/);
    assert.equal(session.state, 'active');
    assert.deepEqual(delivered, []);
    session.receiveBytes(handFrame(version, ['35=1', ...fromClient(3, '112=T2')]));
    await tick();
    assert.deepEqual(delivered, ['T2']);
  });

  // A raw data field with its length, as the Logon of this version carries one: a negative length is as malformed as a non-numeric one.
  const data = version === 'FIXT.1.1' ? ['1400=0', '1401=-1', '1402=abc'] : ['95=-1', '96=abc'];
  const lengthTag = version === 'FIXT.1.1' ? 1401 : 95;
  for (const length of ['-1', '12ab']) {
    test(`${version}: a Logon whose data length is ${length} is refused as a malformed value, never accepted`, { timeout: 10_000 }, async () => {
      const { session, written } = acceptorOf(version);
      session.receiveBytes(handFrame(version, ['35=A', ...fromClient(1, ...logonFields, ...data.map(field => field.replace('-1', length)))]));
      const reason = await session.closed;
      assert.deepEqual([reason.by, reason.problem?.code, reason.problem?.action], ['us', 'IncorrectDataFormatForValue', 'LoggedOut']);
      assert.match(reason.text, new RegExp(`\\(${lengthTag}\\) has a malformed value`));
      assert.equal(written.length, 1);
      assert.match(written[0]!, /\|35=5\|/);
      assert.equal(session.state, 'closed');
    });
  }

  test(`${version}: a message in a session whose data length is negative is rejected as a malformed value, and the session carries on`, { timeout: 10_000 }, async () => {
    const { session, written } = acceptorOf(version);
    session.receiveBytes(handFrame(version, ['35=A', ...fromClient(1, ...logonFields)]));
    await session.active;
    session.receiveBytes(handFrame(version, ['35=1', ...fromClient(2, '212=-1', '213=abc', '112=T1')]));
    await tick();
    assert.match(written.find(frame => frame.includes('|35=3|')) ?? '', /\|371=212\|.*\|58=XmlDataLen \(212\) has a malformed value '-1'\|/);
    assert.equal(session.state, 'active');
  });
}

// ─── Closing ────────────────────────────────────────────────────────────────

test('a silent peer is disconnected on the clock', { timeout: 10_000 }, async () => {
  const { client, exchange, clock } = await loggedOn();
  client.outgoing(() => null);
  await clock.advance('70s');
  const reason = await exchange.closed;
  assert.deepEqual([reason.by, reason.text, reason.problem?.code], ['us', 'Heartbeat timeout', 'HeartbeatTimeout']);
});

test('logout handshake', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  assert.deepEqual(await client.logout('done'), { by: 'us', text: 'Logout confirmed' });
  assert.deepEqual(await exchange.closed, { by: 'them', text: 'done' });
  assert.equal(client.state, 'closed');
  await assert.rejects(client.send('Heartbeat'), { name: 'FIXStateError' });
});

test('after close(): receiveBytes is ignored, a pending next() rejects, and messages() ends', { timeout: 10_000 }, async () => {
  const { client } = await loggedOn();
  const pending = client.next('ExecutionReport');
  const iterator = client.messages();
  const before = client.history.length;
  client.close();
  await assert.rejects(pending, { name: 'FIXStateError' });
  const { done } = await iterator.next();
  assert.equal(done, true);
  client.receiveBytes(Buffer.from('8=FIX.4.4\x019=5\x0135=0\x0110=000\x01', 'latin1'));
  await tick();
  assert.equal(client.history.length, before);
});

test('close() resolves closed even when an outgoing route never resolves', { timeout: 10_000 }, async () => {
  const { client } = await loggedOn();
  client.outgoing(() => new Promise(() => {}));
  void client.send('TestRequest', { TestReqID: 'held' }).catch(() => {});
  client.close();
  const result = await Promise.race([
    client.closed.then(() => 'closed'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 200)),
  ]);
  assert.equal(result, 'closed');
});

test('a route that resolves after close never reaches the link', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  let release: (() => void) | undefined;
  client.outgoing(message => new Promise(resolve => { release = () => resolve(message); }));
  const writes: Uint8Array[] = [];
  client.attach({
    write: async bytes => { writes.push(bytes); setImmediate(() => exchange.receiveBytes(bytes)); },
    end: () => {},
  });
  void client.send('TestRequest', { TestReqID: 'delayed' }).catch(() => {});
  client.close();
  await client.closed;
  release?.();
  await tick();
  assert.equal(writes.length, 0);
});

test('closed waits for a slow store append to flush before resolving', { timeout: 10_000 }, async () => {
  let releaseAppend: (() => void) | undefined;
  const slowStore: Store = {
    ...memoryStore(),
    async append() { await new Promise<void>(resolve => { releaseAppend = resolve; }); },
  };
  const client = lone({ store: slowStore });
  const sending = client.sendBytes(client.encode('Heartbeat'));   // valid framing, so it's recorded and reaches the store, before it is written
  sending.catch(() => {});
  for (let i = 0; i < 5; i++) await tick();
  client.close();
  let closed = false;
  void client.closed.then(() => { closed = true; });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(closed, false);
  releaseAppend?.();
  const reason = await client.closed;
  assert.equal(reason.by, 'us');
});

test('a store append that rejects records the failure as an error entry, and the close reason says so too', { timeout: 10_000 }, async () => {
  const failingStore: Store = {
    ...memoryStore(),
    async append() { throw new Error('disk gone'); },
  };
  const client = lone({ store: failingStore });
  const sending = client.sendBytes(client.encode('Heartbeat'));   // valid framing, so it's recorded and reaches the store, before it is written
  sending.catch(() => {});
  for (let i = 0; i < 5; i++) await tick();
  const reason = await client.closed;
  assert.match(reason.text, /disk gone/);
  await assert.rejects(sending, /disk gone/, 'a message the store failed to keep is not sent');
  assert.ok(errorTexts(client).includes('disk gone'), `expected an error entry for the store failure, got ${JSON.stringify(errorTexts(client))}`);
});

test('a store error after close is reported via onHandlerError, not thrown', { timeout: 10_000 }, async () => {
  const errors: unknown[] = [];
  let rejectAppend: ((error: unknown) => void) | undefined;
  const flakyStore: Store = {
    ...memoryStore(),
    async append() { await new Promise<void>((_resolve, reject) => { rejectAppend = reject; }); },
  };
  const client = lone({ store: flakyStore, onHandlerError: error => errors.push(error) });
  const sending = client.sendBytes(client.encode('Heartbeat'));   // valid framing, so it's recorded and reaches the store, before it is written
  sending.catch(() => {});
  for (let i = 0; i < 5; i++) await tick();
  client.close();
  rejectAppend?.(new Error('disk full'));
  const reason = await client.closed;
  assert.equal(reason.by, 'us');
  await tick();
  assert.deepEqual(errors.map(e => (e as Error).message), ['disk full']);
});

test('the wait for the store before closed resolves is bounded by logoutTimeout', { timeout: 10_000 }, async () => {
  const clock = fakeClock(T0);
  const errors: unknown[] = [];
  const neverStore: Store = {
    ...memoryStore(),
    async append() { return new Promise(() => {}); },   // never settles
  };
  const client = lone({ store: neverStore, clock, onHandlerError: error => errors.push(error) });
  void client.sendBytes(client.encode('Heartbeat')).catch(() => {});   // queues an append that never settles
  for (let i = 0; i < 5; i++) await tick();
  client.close();
  await clock.advance('10s');   // the default logoutTimeout
  const reason = await client.closed;
  assert.equal(reason.by, 'us');
  const timeout = errors.find(e => e instanceof Error && e.name === 'TimeoutError') as { waitingFor?: unknown } | undefined;
  assert.deepEqual(timeout?.waitingFor, { kind: 'store' });
});

// ─── What the store is given ────────────────────────────────────────────────

test('a sent message is in the store, with the sequence numbers after it, before it reaches the network', { timeout: 10_000 }, async () => {
  const events: string[] = [];
  const store: Store = { ...memoryStore(), async append(_id, records) { for (const record of records) events.push(`store ${described(record)} next=${record.seqNums.next}`); } };
  const wire = (bytes: Uint8Array) => /\x0135=(\w+)\x01/.exec(Buffer.from(bytes).toString('latin1'))?.[1];
  const client = lone({ store, manual: true, link: { write: async bytes => { events.push(`wire ${wire(bytes)}`); }, end: () => {} } });
  await client.send('TestRequest', { TestReqID: 'a' });
  await client.send('Heartbeat');
  assert.deepEqual(events, ['store out TestRequest next=2', 'wire 1', 'store out Heartbeat next=3', 'wire 0']);
});

test('the store is given one record per message, each with the sequence numbers once it is kept', { timeout: 10_000 }, async () => {
  const { store, records } = recordingStore();
  const { client, exchange } = await loggedOn({ store: { exchange: store } });
  await client.send('NewOrderSingle', order('o1'));
  await exchange.next('NewOrderSingle');
  await waitFor(() => records.length >= 3, 1000, 'three records');
  // The Logon reply is numbered while the received Logon is processed, but kept after it: until then, next is still 1.
  assert.deepEqual(records.map(record => [described(record), record.seqNums]), [
    ['in Logon', { next: 1, expected: 2 }],
    ['out Logon', { next: 2, expected: 2 }],
    ['in NewOrderSingle', { next: 2, expected: 3 }],
  ]);
});

test('setSeqNums is kept as a record of its own; bringing next down to 1 begins a new epoch', { timeout: 10_000 }, async () => {
  const { store, records } = recordingStore();
  const client = lone({ store, manual: true });
  await client.send('TestRequest', { TestReqID: 'a' });
  client.setSeqNums({ next: 5 });
  client.setSeqNums({ next: 5 });   // no change: no record
  client.setSeqNums({ next: 1 });
  await waitFor(() => records.length >= 3, 1000, 'three records');
  assert.deepEqual(records.map(record => [described(record), record.seqNums, record.newEpoch === true]), [
    ['out TestRequest', { next: 2, expected: 1 }, false],
    ['seqNums', { next: 5, expected: 1 }, false],
    ['seqNums', { next: 1, expected: 1 }, true],
  ]);
});

test('a Logon with ResetSeqNumFlag=Y begins a new epoch: at the initiator with its own Logon, at the acceptor with the one it received', { timeout: 10_000 }, async () => {
  const client = recordingStore();
  const exchange = recordingStore();
  await loggedOn({
    store: { client: client.store, exchange: exchange.store },
    engine: { logon: { ResetSeqNumFlag: true } },
    loaded: { client: { history: [], next: 7, expected: 9 }, exchange: { history: [], next: 9, expected: 7 } },
  });
  await waitFor(() => client.records.length >= 2 && exchange.records.length >= 2, 1000, 'both Logons on both sides');
  const epochs = (records: StoreRecord[]) => records.map(record => [described(record), record.newEpoch === true]);
  assert.deepEqual(epochs(client.records), [['out Logon', true], ['in Logon', false]]);
  assert.deepEqual(epochs(exchange.records), [['in Logon', true], ['out Logon', false]]);
});

test('a reset Logon starts its new epoch at 2, never carrying over the sequence numbers a session had loaded', { timeout: 10_000 }, async () => {
  const client = recordingStore();
  const exchange = recordingStore();
  await loggedOn({
    store: { client: client.store, exchange: exchange.store },
    engine: { logon: { ResetSeqNumFlag: true } },
    loaded: { client: { history: [], next: 50, expected: 40 }, exchange: { history: [], next: 50, expected: 40 } },
  });
  await waitFor(() => client.records.length >= 1 && exchange.records.length >= 2, 1000, 'the Logons kept');
  const seqNums = (records: StoreRecord[]) => records.map(record => [described(record), record.seqNums, record.newEpoch === true]);
  // The acceptor's own reply is already numbered by the time its received Logon's record is made (see epochStart), so that record shows next 2, not 1.
  assert.deepEqual(seqNums(exchange.records.slice(0, 2)), [
    ['in Logon', { next: 2, expected: 2 }, true],
    ['out Logon', { next: 2, expected: 2 }, false],
  ]);
  assert.deepEqual(seqNums(client.records.slice(0, 1)), [['out Logon', { next: 2, expected: 1 }, true]]);
});

test('a message sent as bytes is in the store before it reaches the network', { timeout: 10_000 }, async () => {
  const events: string[] = [];
  const store: Store = { ...memoryStore(), async append(_id, records) { for (const record of records) events.push(`store ${described(record)}`); } };
  const wire = (bytes: Uint8Array) => /\x0135=(\w+)\x01/.exec(Buffer.from(bytes).toString('latin1'))?.[1];
  const client = lone({ store, manual: true, link: { write: async bytes => { events.push(`wire ${wire(bytes)}`); }, end: () => {} } });
  await client.sendBytes(client.encode('TestRequest', { TestReqID: 'raw' }));
  assert.deepEqual(events, ['store out TestRequest', 'wire 1']);
});

test('setSeqNums is kept after the sends already queued, so a send numbered before it is not kept in the new epoch', { timeout: 10_000 }, async () => {
  const base = memoryStore();
  const records: StoreRecord[] = [];
  let release: (() => void) | undefined;
  const store: Store = {
    ...base,
    async append(id, list, context) {
      const first = records.length === 0;
      records.push(...list);
      if (first) await new Promise<void>(resolve => { release = resolve; });   // holds the first send
      return base.append(id, list, context);
    },
  };
  const client = lone({ store, manual: true });
  const first = client.send('NewOrderSingle', order('A'));    // seq 1, held by the store
  const second = client.send('NewOrderSingle', order('B'));   // seq 2, queued behind it
  for (let i = 0; i < 5; i++) await tick();
  client.setSeqNums({ next: 1 });
  release?.();
  await Promise.all([first, second]);
  await waitFor(() => records.length >= 3, 1000, 'three records');
  assert.deepEqual(records.map(record => [record.entry?.kind === 'message' ? brief(record.entry.message) : described(record), record.newEpoch === true]), [
    ['NewOrderSingle 1', false],
    ['NewOrderSingle 2', false],
    ['seqNums', true],
  ]);
});

test('records kept while setSeqNums({ next: 1 }) waits behind sends an outgoing route is holding keep the next they had, not the one it set, so a restart never reuses a MsgSeqNum', { timeout: 10_000 }, async t => {
  const { store, records } = recordingStore();
  const client = lone({ store, manual: true, next: 48 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  client.outgoing(async message => { await held; return message; });
  const sends = ['A', 'B', 'C'].map(id => client.send('NewOrderSingle', order(id)));   // 48, 49, 50: numbered, and held by the route
  for (let i = 0; i < 5; i++) await tick();
  client.setSeqNums({ next: 1 });                      // its record waits behind theirs
  client.receiveBytes(fromExchange('Heartbeat', 1));   // kept while they all still wait
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(records.map(record => [described(record), record.seqNums]), [['in Heartbeat', { next: 48, expected: 2 }]]);
  release();
  await Promise.all(sends);
  await waitFor(() => records.some(record => record.newEpoch), 1000, 'the setSeqNums record');
  const start = records.findIndex(record => record.newEpoch);
  const before = records.slice(0, start);
  assert.deepEqual(before.map(described), ['in Heartbeat', 'out NewOrderSingle', 'out NewOrderSingle', 'out NewOrderSingle']);
  let highest = 0;
  for (const record of before) {
    const { entry } = record;
    if (entry?.kind === 'message' && entry.direction === 'out') highest = Math.max(highest, Number(entry.message.MsgSeqNum));
    assert.ok(record.seqNums.next > highest, `${described(record)} keeps next ${record.seqNums.next}, not above ${highest}`);
  }
  // A crash just before the setSeqNums record is kept: a restart carries on after 50.
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-setseqnums-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = fileStore(dir);
  await files.append(client.id, before);
  assert.ok((await files.load(client.id)).next >= 51);
  assert.deepEqual(records[start]!.seqNums, { next: 1, expected: 2 });
});

test('setSeqNums({ next: 1 }) while the store holds the first of several sends: their records and its own are handed over in the order they were numbered, and a message received after it is kept in the new epoch', { timeout: 10_000 }, async () => {
  const { store, lists, hold, releaseAll } = listedStore();
  const client = lone({ store, manual: true, next: 48 });
  hold();
  const sends = ['A', 'B', 'C'].map(id => client.send('NewOrderSingle', order(id)));   // 48, 49, 50: the record of 48 held by the store
  for (let i = 0; i < 5; i++) await tick();
  client.setSeqNums({ next: 1 });
  client.receiveBytes(fromExchange('Heartbeat', 1));
  for (let i = 0; i < 5; i++) await tick();
  releaseAll();
  await Promise.all(sends);
  await waitFor(() => lists.flat().length === 5, 1000, 'five records');
  assert.deepEqual(lists.flat().map(record => [described(record), record.seqNums, record.newEpoch === true]), [
    ['out NewOrderSingle', { next: 49, expected: 1 }, false],
    ['out NewOrderSingle', { next: 50, expected: 1 }, false],
    ['out NewOrderSingle', { next: 51, expected: 1 }, false],
    ['seqNums', { next: 1, expected: 1 }, true],
    ['in Heartbeat', { next: 1, expected: 2 }, false],
  ]);
});

test('a message numbered before setSeqNums({ next: 1 }) but written after it is never resent for the MsgSeqNum it had: the resend carries what was sent with it since', { timeout: 10_000 }, async () => {
  const dict = dictionaryFor('FIX.4.4');
  const written: MessageObject[] = [];
  const held: (() => void)[] = [];
  let holding = false;
  const base = memoryStore();
  const store: Store = {
    ...base,
    async append(id, record, context) {
      if (holding) await new Promise<void>(resolve => held.push(resolve));
      return base.append(id, record, context);
    },
  };
  const link: Link = { write: async bytes => { written.push(inspectMessage(parseFrame(bytes).fields, dict).message); }, end: () => {} };
  const client = lone({ store, link });
  client.start();
  client.receiveBytes(fromExchange('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30 }));
  await client.active;
  for (let i = 0; i < 5; i++) await tick();   // both Logons kept
  holding = true;
  const sends = [client.send('NewOrderSingle', order('before'))];   // 2, held by the store
  for (let i = 0; i < 5; i++) await tick();
  client.setSeqNums({ next: 1 });
  for (const id of ['n1', 'n2', 'n3', 'n4']) sends.push(client.send('NewOrderSingle', order(id)));   // 1 to 4
  held.shift()!();   // 'before' is kept, written, and shown
  await waitFor(() => written.some(message => message.ClOrdID === 'before'), 1000, "'before' written");
  client.receiveBytes(fromExchange('ResendRequest', 2, { BeginSeqNo: 2, EndSeqNo: 2 }));
  holding = false;
  while (held.length > 0) held.shift()!();
  await Promise.all(sends);
  await waitFor(() => written.some(message => message.PossDupFlag === true), 1000, 'the answer to the ResendRequest');
  const resent = written.filter(message => message.PossDupFlag === true);
  assert.deepEqual(resent.map(message => [message.MsgType, message.MsgSeqNum, message.ClOrdID]), [['NewOrderSingle', 2, 'n2']]);
});

test('a Heartbeat sent on the tick, and one answering a TestRequest, are in the store before they reach the network', { timeout: 10_000 }, async () => {
  const { client, exchange, clock, journal } = await journaledPair({ engine: { heartbeat: 30 } });
  await clock.advance('31s');
  await waitFor(() => journal.length >= 2, 1000, 'the Heartbeat on the tick');
  await exchange.send('TestRequest', { TestReqID: 'tr1' });
  await exchange.next('Heartbeat', { where: { TestReqID: 'tr1' } });
  assert.deepEqual(journal, ['store Heartbeat 2', 'wire Heartbeat 2', 'store Heartbeat 3', 'wire Heartbeat 3']);
  assert.equal(client.state, 'active');
});

test('a resent message (PossDupFlag) and a SequenceReset gap fill are in the store before they reach the network', { timeout: 10_000 }, async () => {
  const { client, exchange, journal } = await journaledPair();
  await client.send('NewOrderSingle', order('o1'));
  await exchange.next('NewOrderSingle');
  journal.length = 0;
  await exchange.send('ResendRequest', { BeginSeqNo: 1, EndSeqNo: 0 });
  await waitFor(() => journal.length >= 4, 1000, 'the gap fill and the resent order');
  assert.deepEqual(journal, ['store SequenceReset 1 PossDup', 'wire SequenceReset 1 PossDup', 'store NewOrderSingle 2 PossDup', 'wire NewOrderSingle 2 PossDup']);
});

test('a Logout is in the store before it reaches the network', { timeout: 10_000 }, async () => {
  const { client, journal } = await journaledPair();
  await client.logout('done');
  assert.deepEqual(journal, ['store Logout 2', 'wire Logout 2']);
});

// ─── A slow or stopped store ────────────────────────────────────────────────

/** A store whose append never finishes. */
const stoppedStore = (): Store => ({ ...memoryStore(), append: () => new Promise<void>(() => {}) });

/** How a promise has settled after a few turns of the event loop: 'resolved', its error's message, or 'pending'. */
async function outcome(promise: Promise<unknown>): Promise<string> {
  const settled = promise.then(() => 'resolved', (error: unknown) => (error instanceof Error ? error.message : String(error)));
  let pending = true;
  void settled.finally(() => { pending = false; });
  for (let i = 0; i < 10 && pending; i++) await tick();
  return pending ? 'pending' : settled;
}

test('a resend waiting on a store that never keeps what was queued before it is given up once the session closes: a send behind it is rejected', { timeout: 10_000 }, async () => {
  const clock = fakeClock(T0);
  const base = memoryStore();
  let stopped = false;
  let reads = 0;
  const store: Store = {
    ...base,
    append: (id, record, context) => (stopped ? new Promise<void>(() => {}) : base.append(id, record, context)),
    sent: (id, range, context) => { reads++; return base.sent(id, range, context); },
  };
  const { client, written } = await loneLoggedOn({ store, clock });
  await client.send('NewOrderSingle', order('a'));   // 2
  written.length = 0;
  stopped = true;
  client.receiveBytes(fromExchange('ResendRequest', 2, { BeginSeqNo: 2, EndSeqNo: 0 }));   // its own record is never kept
  for (let i = 0; i < 5; i++) await tick();
  const sent = client.send('NewOrderSingle', order('behind'));
  sent.catch(() => {});
  for (let i = 0; i < 5; i++) await tick();
  client.close();
  await clock.advance('10s');   // the bounded wait for the store to flush (logoutTimeout)
  await client.closed;
  assert.equal(await outcome(sent), 'The session closed before NewOrderSingle was sent');
  assert.deepEqual([written, reads], [[], 0]);
});

test('a ResendRequest whose turn comes once the session has closed waits for nothing: a send behind it is rejected though the store has stopped', { timeout: 10_000 }, async () => {
  const clock = fakeClock(T0);
  const base = memoryStore();
  let stopped = false;
  const store: Store = {
    ...base,
    append: (id, record, context) => (stopped ? new Promise<void>(() => {}) : base.append(id, record, context)),
    sent: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Entry>>(() => {}) }) }),   // the first answer never gets its first entry
  };
  const { client, written } = await loneLoggedOn({ store, clock });
  await client.send('NewOrderSingle', order('a'));   // 2
  written.length = 0;
  client.receiveBytes(fromExchange('ResendRequest', 2, { BeginSeqNo: 2, EndSeqNo: 0 }));
  for (let i = 0; i < 5; i++) await tick();
  stopped = true;
  client.receiveBytes(fromExchange('ResendRequest', 3, { BeginSeqNo: 2, EndSeqNo: 0 }));   // waits behind the first; its own record is never kept
  for (let i = 0; i < 5; i++) await tick();
  const sent = client.send('NewOrderSingle', order('behind'));
  sent.catch(() => {});
  for (let i = 0; i < 5; i++) await tick();
  client.close();
  await clock.advance('10s');   // the bounded wait for the store to flush (logoutTimeout)
  await client.closed;
  assert.equal(await outcome(sent), 'The session closed before NewOrderSingle was sent');
  assert.deepEqual(written, []);
});

test('a send waiting on a store that never keeps it is rejected once the session closes', { timeout: 10_000 }, async () => {
  const clock = fakeClock(T0);
  const client = lone({ store: stoppedStore(), clock, manual: true });
  const sent = client.send('NewOrderSingle', order('held'));
  sent.catch(() => {});
  for (let i = 0; i < 5; i++) await tick();
  client.close();
  await clock.advance('10s');   // the bounded wait for the store to flush (logoutTimeout)
  await client.closed;
  assert.equal(await outcome(sent), 'The session closed before NewOrderSingle was sent');
});

test('a store write that takes longer than storeTimeout closes the session, checked on the tick', { timeout: 10_000 }, async () => {
  const clock = fakeClock(T0);
  const client = lone({ store: stoppedStore(), clock, manual: true });   // storeTimeout defaults to 10 s
  const sent = client.send('Heartbeat');
  sent.catch(() => {});
  for (let i = 0; i < 5; i++) await tick();
  await clock.advance('9s');
  assert.equal(client.state, 'active', 'not closed before storeTimeout');
  await clock.advance('2s');   // storeTimeout, and up to one tick more
  assert.equal(client.state, 'closed');
  await clock.advance('10s');   // the bounded wait for the store to flush (logoutTimeout)
  const reason = await client.closed;
  assert.deepEqual([reason.by, reason.text], ['us', 'Store write took longer than 10 s']);
  assert.equal(await outcome(sent), 'The session closed before Heartbeat was sent');
});

test('a slow store whose every write finishes within storeTimeout does not close the session', { timeout: 10_000 }, async () => {
  const clock = fakeClock(T0);
  const base = memoryStore();
  const slowStore: Store = { ...base, async append(id, record, context) { await new Promise<void>(resolve => { clock.setTimeout(resolve, 3_000); }); return base.append(id, record, context); } };
  const writes: Uint8Array[] = [];
  const client = lone({ store: slowStore, clock, manual: true, storeTimeoutMs: 5_000, link: { write: async bytes => { writes.push(bytes); }, end: () => {} } });
  const sends = Array.from({ length: 6 }, (_, i) => client.send('NewOrderSingle', order(`slow${i}`)));
  for (let second = 0; second < 20; second++) {
    await clock.advance('1s');
    for (let i = 0; i < 5; i++) await tick();
  }
  await Promise.all(sends);
  assert.equal(writes.length, 6);
  assert.equal(client.state, 'active');
});

test('a link whose end() throws still lets closed resolve, and the error is reported', { timeout: 10_000 }, async () => {
  const errors: unknown[] = [];
  const { client, exchange } = await loggedOn({ onHandlerError: error => errors.push(error) });
  client.attach({ write: async bytes => { setImmediate(() => exchange.receiveBytes(bytes)); }, end: () => { throw new Error('end() blew up'); } });
  client.close();
  const reason = await client.closed;
  assert.equal(reason.by, 'us');
  await tick();
  assert.ok(errors.some(e => (e as Error).message === 'end() blew up'));
});

test('a graceful disconnect whose Logout can never be written still ends the link within about 2x logoutTimeout', { timeout: 10_000 }, async () => {
  const { client, clock } = await loggedOn();   // default logoutTimeout is 10s
  client.outgoing(() => new Promise(() => {}));   // the Logout (and anything else) can never actually be written
  void client.logout();
  await clock.advance('21s');   // ~1x for the engine's own logout timeout, ~1x more for the bounded wait for queued writes
  const reason = await client.closed;
  assert.equal(reason.by, 'us');
});

test('a synchronous error inside the heartbeat tick closes the session instead of leaving it hung', { timeout: 10_000 }, async () => {
  const base = fakeClock(T0);
  // Throw exactly once, and only once the Logon's own send/record chain has fully settled — otherwise the
  // "next call to now()" lands on that unrelated, already-guarded path instead of the tick we mean to break.
  let failuresLeft = 0;
  const clock: FakeClock = { ...base, now: () => { if (failuresLeft > 0) { failuresLeft--; throw new Error('clock exploded'); } return base.now(); } };
  const client = lone({ clock });
  client.start();
  for (let i = 0; i < 20; i++) await tick();   // let the outgoing Logon fully settle before arming the throw
  failuresLeft = 1;
  await base.advance('1s');   // fires the 1s tick timer, whose body calls clock.now() and throws synchronously
  const reason = await client.closed;
  assert.equal(reason.by, 'us');
  assert.match(reason.text, /clock exploded/);
});

test('a failure while closing on a write error is reported, and the session still closes', { timeout: 10_000 }, async () => {
  let failOnce = false;
  const base = fakeClock(T0);
  const clock: FakeClock = { ...base, now: () => { if (failOnce) { failOnce = false; throw new Error('clock exploded during fail'); } return base.now(); } };
  const errors: unknown[] = [];
  const { client } = await unpausableLoggedOn({ clock, onHandlerError: error => errors.push(error) });
  let armed = true;
  client.attach({
    write: async () => {
      // A message is kept (reading the clock) before it is written, so the throw is armed only here:
      // the first attempt to close (from the first write failure) throws and must not wedge anything.
      if (armed) {
        armed = false;
        failOnce = true;
      }
      throw new Error('boom');   // every write fails
    },
    end: () => {},
  });
  const frames = Array.from({ length: 5 }, () => client.encode('Heartbeat'));   // encode first: encode() also reads the clock
  // One at a time, so nothing but the close reads the clock between a write failing and the close it causes.
  for (const bytes of frames) await client.sendBytes(bytes).catch(() => {});
  const reason = await client.closed;
  assert.equal(reason.by, 'us');
  await tick();
  assert.ok(errors.some(e => e instanceof Error && e.message === 'clock exploded during fail'), 'expected the failed close attempt to be reported, not left to crash uncaught');
});

// ─── Memory budgets ─────────────────────────────────────────────────────────

test('history is evicted by byte budget, not just entry count', { timeout: 10_000 }, async () => {
  const client = lone({ memory: { history: 1000, historyBytes: 300 } });
  // Real, validly framed Heartbeats (a garbled checksum would be refused by sendBytes and never recorded at all).
  for (let i = 0; i < 10; i++) await client.sendBytes(client.encode('Heartbeat'));
  assert.ok(client.history.length > 0, 'sanity: sendBytes must have actually recorded something');
  assert.ok(client.history.length < 10, `expected eviction well before 10 entries, got ${client.history.length}`);
  const bytes = client.history.reduce((total, entry) => total + entrySize(entry), 0);
  assert.ok(bytes <= 300, `history bytes was ${bytes}`);
});

test('the inbox drops the oldest untaken message once it is full', { timeout: 10_000 }, async () => {
  const { client, exchange } = await unpausableLoggedOn({ memory: { inbox: 3 } });
  for (let i = 0; i < 5; i++) await client.send('NewOrderSingle', order(`o${i}`));
  await tick();
  assert.ok(exchange.inboxSizeForTests <= 3, `inbox size was ${exchange.inboxSizeForTests}`);
  const first = await exchange.next('NewOrderSingle');
  assert.equal(first.ClOrdID, 'o2');   // o0 and o1 were dropped once the cap of 3 was exceeded
});

test('the inbox is bounded by bytes too, not just count', { timeout: 10_000 }, async () => {
  const { client, exchange } = await unpausableLoggedOn({ memory: { inbox: 1000, inboxBytes: 300 } });
  for (let i = 0; i < 10; i++) await client.send('NewOrderSingle', order(`o${i}`));
  await tick();
  assert.ok(exchange.inboxSizeForTests > 0, 'sanity: something must have been delivered');
  assert.ok(exchange.inboxSizeForTests < 10, `expected byte-based eviction, got ${exchange.inboxSizeForTests} entries`);
});

test('a slow messages() consumer is dropped once it falls too far behind, and then reports done', { timeout: 10_000 }, async () => {
  const { client, exchange } = await unpausableLoggedOn({ memory: { inbox: 3 } });
  const iterator = exchange.messages();   // never consumed
  for (let i = 0; i < 5; i++) await client.send('NewOrderSingle', order(`o${i}`));
  await tick();
  await assert.rejects(iterator.next(), { name: 'FIXStateError', message: /fell more than 3 messages behind/ });
  const result = await iterator.next();
  assert.equal(result.done, true);
});

test('a messages() consumer is bounded by bytes too', { timeout: 10_000 }, async () => {
  const { client, exchange } = await unpausableLoggedOn({ memory: { inbox: 1000, inboxBytes: 300 } });
  const it = exchange.messages();
  for (let i = 0; i < 10; i++) await client.send('NewOrderSingle', order(`o${i}`));
  await tick();
  await assert.rejects(it.next(), { name: 'FIXStateError', message: /bytes behind/ });
});

test('5,000 messages stay within the default limits', { timeout: 10_000 }, async () => {
  const { client, exchange } = await loggedOn();
  for (let i = 0; i < 4999; i++) void client.send('TestRequest', { TestReqID: `b${i}` }).catch(() => {});
  await client.send('TestRequest', { TestReqID: 'b4999' });
  await exchange.next('TestRequest', { where: { TestReqID: 'b4999' } });
  await tick();
  assert.ok(exchange.history.length <= 1000, `history.length was ${exchange.history.length}`);
  const bytes = exchange.history.reduce((total, entry) => total + entrySize(entry), 0);
  assert.ok(bytes <= 1_048_576, `history bytes was ${bytes}`);
  assert.ok(exchange.inboxSizeForTests <= 1000, `inbox size was ${exchange.inboxSizeForTests}`);
});

test('too many unwritten outgoing bytes closes the session', { timeout: 10_000 }, async () => {
  const { client } = await unpausableLoggedOn({ memory: { outgoingBytes: 800 } });
  client.attach({ write: () => new Promise(() => {}), end: () => {} });   // never resolves; nothing ever drains
  for (let i = 0; i < 8; i++) void client.send('NewOrderSingle', order(`o${i}`)).catch(() => {});
  const reason = await client.closed;
  assert.match(reason.text, /Outgoing queue over \d+ bytes/);
});

test('a counterparty that stops reading stalls a resend on the socket; what the program sends meanwhile waits behind it and closes the session past outgoingBytes', { timeout: 10_000 }, async () => {
  const { client, exchange } = await unpausableLoggedOn({ memory: { outgoingBytes: 800 } });
  for (let i = 0; i < 3; i++) await client.send('NewOrderSingle', order(`o${i}`));
  await exchange.next('NewOrderSingle', { where: { ClOrdID: 'o2' } });
  client.attach({ write: () => new Promise(() => {}), end: () => {} });   // never resolves
  await exchange.send('ResendRequest', { BeginSeqNo: 2, EndSeqNo: 0 });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(client.state, 'active');   // the resend itself, however long, is not counted: it holds one message at a time
  for (let i = 0; i < 8; i++) void client.send('NewOrderSingle', order(`later${i}`)).catch(() => {});
  const reason = await client.closed;
  assert.match(reason.text, /Outgoing queue over \d+ bytes/);
});

test('a burst of received messages against a slow store waits as bytes, not as records: no list passes half of memory.storeBytes by more than a message, and the session is not closed', { timeout: 10_000 }, async () => {
  const clock = fakeClock(T0);
  const lists: number[] = [];
  const slowStore: Store = {
    ...memoryStore(),
    async append(_id, records) {
      lists.push(records.reduce((bytes, record) => bytes + entrySize(record.entry!), 0));
      await new Promise<void>(resolve => { clock.setTimeout(resolve, 2_000); });   // done only once the clock reaches it
    },
  };
  const client = lone({ store: slowStore, clock, manual: true, memory: { storeBytes: 2_000 } });
  const frames = Array.from({ length: 50 }, (_, n) => fromExchange('Heartbeat', n + 1));
  const total = frames.reduce((bytes, frame) => bytes + frame.length, 0);
  assert.ok(total > 2_000, `the burst is ${total} bytes, more than storeBytes`);
  for (const frame of frames) client.receiveBytes(frame);
  for (let waited = 0; waited < 20 && client.seqNums.expected < 51; waited++) await clock.advance('2s');
  await clock.advance('4s');   // the last of them, behind the list before it
  assert.deepEqual([client.state, client.seqNums.expected, client.heldBytesForTests], ['active', 51, 0]);
  assert.ok(Math.max(...lists) <= 1_000 + frames[0]!.length, `a list of ${Math.max(...lists)} bytes`);
  assert.equal(lists.reduce((sum, bytes) => sum + bytes, 0), total, 'every one was kept');
});

test('a store that never keeps a sent message holds it off the network, until the outgoing queue is full and the session closes', { timeout: 10_000 }, async () => {
  const clock = fakeClock(T0);
  const neverStore: Store = { ...memoryStore(), append: () => new Promise(() => {}) };
  const writes: Uint8Array[] = [];
  const client = lone({ store: neverStore, clock, manual: true, memory: { outgoingBytes: 2_000 }, link: { write: async bytes => { writes.push(bytes); }, end: () => {} } });
  void client.send('NewOrderSingle', order('held')).catch(() => {});
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(writes.length, 0, 'nothing is written before the store has kept it');
  for (let i = 0; i < 50; i++) void client.send('NewOrderSingle', order(`s${i}`)).catch(() => {});
  await clock.advance('10s');   // the bounded wait for the store once closed (logoutTimeout)
  const reason = await client.closed;
  assert.match(reason.text, /Outgoing queue over 2000 bytes/);
  assert.equal(writes.length, 0);
});

// ─── Backpressure ───────────────────────────────────────────────────────────

test('a slow incoming route applies read backpressure instead of killing a healthy session', { timeout: 10_000 }, async () => {
  const pauses: boolean[] = [];
  const { client, exchange } = await loggedOn({ onPause: (side, paused) => { if (side === 'exchange') pauses.push(paused); } });
  exchange.incoming(async message => { await tick(); return message; });
  const seen: string[] = [];
  exchange.on('NewOrderSingle', message => seen.push(String(message.ClOrdID)));
  const total = 1500;
  for (let i = 0; i < total; i++) void client.send('NewOrderSingle', order(`m${i}`)).catch(() => {});
  await waitFor(() => seen.length >= total || exchange.state === 'closed', 10_000, 'every order to be delivered');
  assert.equal(exchange.state, 'active');
  assert.deepEqual(seen, Array.from({ length: total }, (_, i) => `m${i}`));
  assert.ok(pauses.includes(true) && pauses.includes(false), 'expected the exchange to pause and resume reads');
});

test('a link without pause/resume closes the session once what it has received and not processed passes memory.inboxBytes', { timeout: 10_000 }, async () => {
  const { client, exchange } = await unpausableLoggedOn({ memory: { inboxBytes: 600 } });
  exchange.incoming(() => new Promise(() => {}));   // never resolves; no incoming frame can finish
  for (let i = 0; i < 20; i++) void client.send('TestRequest', { TestReqID: `i${i}` }).catch(() => {});
  const reason = await exchange.closed;
  assert.match(reason.text, /Too many unprocessed incoming messages/);
});

test('a slow store does not disconnect a healthy fast peer; backpressure keeps up instead', { timeout: 10_000 }, async () => {
  let storeCalls = 0;
  let storeDone = 0;
  const slowStore: Store = {
    ...memoryStore(),
    async append(_id, records) { storeCalls += records.length; await tick(); storeDone += records.length; },   // counted in records
  };
  const pauses: boolean[] = [];
  const { client, exchange } = await loggedOn({
    store: { exchange: slowStore },
    // Small budgets keep the test fast. Reads pause well before the store budget runs out: frames already
    // read when the pause lands still reach the store, each with its sequence numbers.
    memory: { exchange: { storeBytes: 64 * 1024, inboxBytes: 8 * 1024 } },
    onPause: (side, paused) => { if (side === 'exchange') pauses.push(paused); },
  });
  // A healthy, fast peer: each send awaited, like a real sender.
  const total = 1500;
  let sent = 0;
  for (; sent < total; sent++) {
    if (exchange.state === 'closed') break;
    await client.send('NewOrderSingle', order(`o${sent}`));
  }
  await waitFor(() => exchange.state === 'closed' || (storeCalls >= total + 2 && storeDone === storeCalls), 10_000, 'the store to catch up');
  assert.equal(sent, total, 'expected the healthy peer to send everything without being rejected');
  assert.equal(exchange.state, 'active');
  assert.equal(storeDone, storeCalls, 'expected every queued record to have been kept');
  assert.ok(storeCalls >= total, `expected at least ${total} records kept (one per incoming NewOrderSingle), got ${storeCalls}`);
  assert.ok(pauses.includes(true), 'expected the exchange to have paused reads (backpressure) at least once');
  assert.ok(pauses.includes(false), 'expected the exchange to have resumed reads at least once');
});

test('a small storeBytes alone does not disconnect a healthy peer', { timeout: 10_000 }, async () => {
  const slowStore: Store = {
    ...memoryStore(),
    async append() { await tick(); await tick(); },   // half as fast as messages are processed
  };
  const { client, exchange } = await loggedOn({ store: { exchange: slowStore }, memory: { exchange: { storeBytes: 16 * 1024 } } });
  exchange.incoming(async message => { await tick(); return message; });   // received messages pile up while routed
  const seen: string[] = [];
  exchange.on('NewOrderSingle', message => { seen.push(String(message.ClOrdID)); });
  const total = 500;
  for (let i = 0; i < total; i++) void client.send('NewOrderSingle', order(`m${i}`)).catch(() => {});
  await waitFor(() => seen.length >= total || exchange.state === 'closed', 10_000, 'every order to be delivered');
  assert.equal(exchange.state, 'active');
  assert.equal(seen.length, total);
});

// ─── Records go to the store in lists ───────────────────────────────────────

const ticks = async (count = 5) => { for (let i = 0; i < count; i++) await tick(); };

test('records made while an append is in flight go to the store as one list, in the order they were made, each with the sequence numbers as it left them', { timeout: 10_000 }, async () => {
  const { store, lists, hold, release, most } = listedStore();
  const { client } = await loneLoggedOn({ store });
  lists.length = 0;
  hold();
  client.receiveBytes(fromExchange('Heartbeat', 2));
  await ticks();
  for (let seq = 3; seq <= 7; seq++) client.receiveBytes(fromExchange('Heartbeat', seq));
  await ticks();
  client.receiveBytes(fromExchange('Heartbeat', 8));
  await ticks();
  assert.deepEqual(lists.map(list => list.map(described)), [['in Heartbeat']], 'one append in flight, and nothing given meanwhile');
  release();
  await ticks();
  assert.equal(lists.length, 2);
  assert.deepEqual(lists[1]!.map(record => record.entry?.kind === 'message' && record.entry.message.MsgSeqNum), [3, 4, 5, 6, 7, 8]);
  // Not the session's numbers when the list was made (9 for all): each record's own.
  assert.deepEqual(lists[1]!.map(record => record.seqNums), [3, 4, 5, 6, 7, 8].map(seq => ({ next: 2, expected: seq + 1 })));
  assert.deepEqual(lists[0]!.map(record => record.seqNums), [{ next: 2, expected: 3 }]);
  release();
  await ticks();
  assert.equal(most(), 1);
  assert.deepEqual((await store.load(client.id)).expected, 9);
});

test('a session never has two appends in flight, whatever is sent and received meanwhile, and the store is given every record once, in order', { timeout: 10_000 }, async () => {
  const base = memoryStore();
  let inFlight = 0;
  let most = 0;
  const kept: string[] = [];
  const store: Store = {
    ...base,
    async append(id, records, context) {
      most = Math.max(most, ++inFlight);
      await tick();
      await tick();
      for (const record of records) kept.push(record.entry?.kind === 'message' ? `${record.entry.direction} ${String(record.entry.message.MsgSeqNum)}` : described(record));
      inFlight--;
      return base.append(id, records, context);
    },
  };
  const { client } = await loneLoggedOn({ store });
  await ticks(10);
  kept.length = 0;
  const sends: Promise<unknown>[] = [];
  for (let n = 0; n < 40; n++) {
    client.receiveBytes(fromExchange('Heartbeat', n + 2));
    sends.push(client.send('NewOrderSingle', order(`o${n}`)));
    if (n % 7 === 0) await tick();
  }
  await Promise.all(sends);
  await waitFor(() => kept.length === 80, 5000, 'every record to be kept');
  assert.equal(most, 1);
  assert.deepEqual(kept.filter(each => each.startsWith('in ')), Array.from({ length: 40 }, (_unused, n) => `in ${n + 2}`));
  assert.deepEqual(kept.filter(each => each.startsWith('out ')), Array.from({ length: 40 }, (_unused, n) => `out ${n + 2}`));
});

test('a list given to the store holds at most 256 records: the rest wait for the next', { timeout: 10_000 }, async () => {
  const { store, lists, hold, releaseAll } = listedStore();
  // Far more is taken in than the store has kept: the read pause is out of the way.
  const { client } = await loneLoggedOn({ store, memory: { pendingBytes: 1_000_000 } });
  lists.length = 0;
  hold();
  client.receiveBytes(fromExchange('Heartbeat', 2));
  await ticks();
  for (let seq = 3; seq <= 602; seq++) client.receiveBytes(fromExchange('Heartbeat', seq));
  await waitFor(() => client.seqNums.expected === 603, 5000, 'the messages to be processed');
  releaseAll();
  await waitFor(() => lists.flat().length === 601, 5000, 'every record to reach the store');
  assert.deepEqual(lists.map(list => list.length), [1, 256, 256, 88]);
  assert.deepEqual(lists.flat().map(record => record.seqNums.expected), Array.from({ length: 601 }, (_unused, index) => index + 3));
});

test('a list given to the store holds at most 1 MiB of entries, and a record larger than that goes in a list of its own', { timeout: 10_000 }, async () => {
  const { store, lists, hold, releaseAll } = listedStore();
  const { client } = await loneLoggedOn({ store, maxMessageSize: 4 * 1024 * 1024, memory: { inboxBytes: 16 * 1024 * 1024, storeBytes: 32 * 1024 * 1024, pendingBytes: 16 * 1024 * 1024 } });
  lists.length = 0;
  hold();
  const large = (seq: number, bytes: number) => fromExchange('Heartbeat', seq, { TestReqID: 'x'.repeat(bytes) });
  client.receiveBytes(fromExchange('Heartbeat', 2));
  await ticks();
  // Thirty of 100 KiB, then one of 2 MiB, then two small ones.
  for (let seq = 3; seq <= 32; seq++) client.receiveBytes(large(seq, 100 * 1024));
  client.receiveBytes(large(33, 2 * 1024 * 1024));
  client.receiveBytes(fromExchange('Heartbeat', 34));
  client.receiveBytes(fromExchange('Heartbeat', 35));
  await waitFor(() => client.seqNums.expected === 36, 5000, 'the messages to be processed');
  assert.equal(client.state, 'active');
  releaseAll();
  await waitFor(() => lists.flat().length === 34, 5000, 'every record to reach the store');
  const sizes = lists.map(list => list.reduce((bytes, record) => bytes + entrySize(record.entry!), 0));
  assert.deepEqual(lists.map(list => list.length), [1, 10, 10, 10, 1, 2]);
  for (const [index, list] of lists.entries()) assert.ok(list.length === 1 || sizes[index]! <= 1024 * 1024, `list ${index} holds ${sizes[index]} bytes in ${list.length} records`);
  assert.ok(sizes[4]! > 2 * 1024 * 1024);
  assert.deepEqual(lists.flat().map(record => record.entry?.kind === 'message' && record.entry.message.MsgSeqNum), Array.from({ length: 34 }, (_unused, index) => index + 2));
});

test('a list the store fails closes the session once, with the store\'s error, whatever the list held; the records made meanwhile are still given to the store', { timeout: 10_000 }, async () => {
  const reported: unknown[] = [];
  const { store, lists, hold, release, fail, releaseAll } = listedStore();
  const { client } = await loneLoggedOn({ store, onHandlerError: error => reported.push(error) });
  lists.length = 0;
  hold();
  client.receiveBytes(fromExchange('Heartbeat', 2));
  await ticks();
  for (let seq = 3; seq <= 6; seq++) client.receiveBytes(fromExchange('Heartbeat', seq));
  await ticks();
  release();                       // the first list is kept
  await ticks();
  client.receiveBytes(fromExchange('Heartbeat', 7));   // waits behind the list of four
  await ticks();
  assert.deepEqual(lists.map(list => list.length), [1, 4]);
  fail(new Error('disk gone'));    // the list of four is not
  await ticks();
  assert.equal(client.state, 'closed');
  assert.deepEqual(errorTexts(client), ['disk gone']);   // once, not once for each record
  assert.equal(reported.length, 0);
  releaseAll();
  assert.deepEqual(await client.closed, { by: 'us', text: 'disk gone' });
  assert.deepEqual(lists.map(list => list.map(record => record.seqNums.expected)), [[3], [4, 5, 6, 7], [8]]);
});

test('storeTimeout times the append in flight, not how long a record waited for its turn: lists that each take less do not close the session', { timeout: 10_000 }, async () => {
  const clock = fakeClock(T0);
  const base = memoryStore();
  const lists: number[] = [];
  const slow: Store = { ...base, async append(id, records, context) { lists.push(records.length); await new Promise<void>(resolve => { clock.setTimeout(resolve, 4_000); }); return base.append(id, records, context); } };
  const client = lone({ store: slow, clock, manual: true, storeTimeoutMs: 5_000 });
  // One record in flight for 4 s; three more made during it, which then wait 4 s of their own: 8 s in all for them.
  client.receiveBytes(fromExchange('Heartbeat', 1));
  await ticks();
  await clock.advance('1s');
  for (let seq = 2; seq <= 4; seq++) client.receiveBytes(fromExchange('Heartbeat', seq));
  for (let second = 0; second < 9; second++) {
    await clock.advance('1s');
    await ticks(2);
  }
  assert.equal(client.state, 'active');
  assert.deepEqual(lists, [1, 3]);
  assert.deepEqual(await base.load(client.id), { history: (await base.load(client.id)).history, next: 1, expected: 5 });
});

test('a list in flight for storeTimeout closes the session, and the records waiting behind it are never written to the network', { timeout: 10_000 }, async () => {
  const clock = fakeClock(T0);
  const written: Uint8Array[] = [];
  const { store, lists, hold } = listedStore();
  hold();
  const client = lone({ store, clock, manual: true, link: { write: async bytes => { written.push(bytes); }, end: () => {} } });
  const sends = [client.send('Heartbeat'), client.send('Heartbeat')];
  for (const each of sends) each.catch(() => {});
  client.receiveBytes(fromExchange('Heartbeat', 1));
  await ticks();
  await clock.advance('11s');
  assert.equal(client.state, 'closed');
  await clock.advance('10s');   // the bounded wait for the store to flush
  assert.deepEqual(await client.closed, { by: 'us', text: 'Store write took longer than 10 s' });
  assert.equal(lists.length, 1, 'no second list while the first never settles');
  assert.deepEqual(written, []);
  assert.deepEqual(await Promise.all(sends.map(outcome)), ['The session closed before Heartbeat was sent', 'The session closed before Heartbeat was sent']);
});

// ─── Sent messages: records handed over at once, writes in order ────────────

/** The MsgSeqNums of the sent messages among records. */
const outSeqs = (records: readonly StoreRecord[]) => records.flatMap(({ entry }) => (entry?.kind === 'message' && entry.direction === 'out' ? [Number(entry.message.MsgSeqNum)] : []));

/**
 * A logged-on CLIENT whose store and link journal, in order, each list of sent messages the store
 * is given ('given 2,3'), each list it has kept ('kept 2,3') and each message written ('wire 2').
 */
async function journaledLone(options: Parameters<typeof lone>[0] = {}) {
  const dict = dictionaryFor('FIX.4.4');
  const journal: string[] = [];
  const listed = listedStore({
    ...memoryStore(),
    append: async (_id, records) => { if (outSeqs(records).length > 0) journal.push(`kept ${outSeqs(records).join(',')}`); },
  });
  const store: Store = {
    ...listed.store,
    append(id, records, context) {
      if (outSeqs(records).length > 0) journal.push(`given ${outSeqs(records).join(',')}`);
      return listed.store.append(id, records, context);
    },
  };
  const link: Link = { write: async bytes => { journal.push(`wire ${String(inspectMessage(parseFrame(bytes).fields, dict).message.MsgSeqNum)}`); }, end: () => {} };
  const client = lone({ store, link, ...options });
  client.start();
  client.receiveBytes(fromExchange('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30 }));
  await client.active;
  await ticks();
  journal.length = 0;
  listed.lists.length = 0;
  return { client, journal, ...listed };
}

test('messages queued to be sent hand their records to the store without waiting for the one before to be kept or written: while one append is in flight the rest gather, and go as one list', { timeout: 10_000 }, async () => {
  const { client, journal, hold, release } = await journaledLone();
  hold();
  const sends = Array.from({ length: 50 }, (_unused, n) => client.send('NewOrderSingle', order(`o${n}`)));   // 2 to 51
  await ticks(20);
  const rest = Array.from({ length: 49 }, (_unused, n) => n + 3);
  assert.deepEqual(journal, ['given 2'], 'one append in flight; nothing is written');
  release();
  await ticks(20);
  // The other 49 went to the store together, as soon as it was free; 2 is written, and only 2.
  assert.deepEqual([...journal].sort(), ['given 2', 'kept 2', `given ${rest.join(',')}`, 'wire 2'].sort());
  assert.ok(journal.indexOf('kept 2') < journal.indexOf('wire 2'));
  release();
  await Promise.all(sends);
  assert.deepEqual(journal.filter(each => each.startsWith('wire')), ['wire 2', ...rest.map(seq => `wire ${seq}`)]);
  assert.ok(journal.indexOf(`kept ${rest.join(',')}`) < journal.indexOf('wire 3'), 'none of a list is written before the list is kept');
});

test('a message is written only once the append that carried its record has resolved, however late: nothing of a list reaches the network while the store still has it', { timeout: 10_000 }, async () => {
  const { client, journal, hold, release } = await journaledLone();
  hold();
  const sends = [client.send('NewOrderSingle', order('a'))];
  await ticks();
  sends.push(client.send('NewOrderSingle', order('b')), client.send('NewOrderSingle', order('c')));
  await ticks(50);
  assert.deepEqual(journal, ['given 2']);
  release();
  await ticks(50);
  // 2 is kept and written; 3 and 4 are with the store, and stay off the network however long it takes.
  assert.deepEqual([...journal].sort(), ['given 2', 'kept 2', 'given 3,4', 'wire 2'].sort());
  assert.ok(journal.indexOf('kept 2') < journal.indexOf('wire 2'));
  release();
  await Promise.all(sends);
  assert.deepEqual(journal.slice(-3), ['kept 3,4', 'wire 3', 'wire 4']);
  // What history shows is what was written, in that order.
  assert.deepEqual(client.history.flatMap(entry => (entry.kind === 'message' && entry.direction === 'out' ? [entry.message.MsgSeqNum] : [])).slice(-3), [2, 3, 4]);
});

test('a list the store rejects, late: none of its messages is written, nor any numbered after them though their own list is kept; each send is rejected, those of the list with the store\'s error', { timeout: 10_000 }, async () => {
  const { client, journal, lists, hold, release, fail } = await journaledLone();
  hold();
  const sends = [client.send('NewOrderSingle', order('a'))];
  await ticks();
  sends.push(client.send('NewOrderSingle', order('b')), client.send('NewOrderSingle', order('c')));
  await ticks();
  release();                                  // 2 is kept, and written
  await ticks();
  sends.push(client.send('NewOrderSingle', order('d')));   // 5: waits behind the list of 3 and 4
  await ticks(20);
  const outcomes = Promise.all(sends.map(outcome));
  fail(new Error('disk full'));               // 3 and 4 are not kept
  await ticks();
  release();                                  // 5 is
  assert.deepEqual(await client.closed, { by: 'us', text: 'disk full' });
  await ticks();
  assert.deepEqual(journal.filter(each => each.startsWith('wire')), ['wire 2']);
  assert.deepEqual(lists.map(outSeqs).filter(seqs => seqs.length > 0), [[2], [3, 4], [5]]);
  assert.deepEqual(await outcomes, ['resolved', 'disk full', 'disk full', 'The session closed before NewOrderSingle was sent']);
});

test('a store that rejects at once fails every message of the list it was given, and nothing is written', { timeout: 10_000 }, async () => {
  const written: Uint8Array[] = [];
  let calls = 0;
  const store: Store = { ...memoryStore(), append: async () => { calls++; throw new Error('read-only file system'); } };
  const client = lone({ store, manual: true, link: { write: async bytes => { written.push(bytes); }, end: () => {} } });
  const sends = ['a', 'b', 'c'].map(id => client.send('NewOrderSingle', order(id)));
  for (const each of sends) each.catch(() => {});
  assert.deepEqual(await client.closed, { by: 'us', text: 'read-only file system' });
  assert.deepEqual(written, []);
  const outcomes = await Promise.all(sends.map(outcome));
  assert.equal(outcomes[0], 'read-only file system');
  for (const text of outcomes) assert.ok(text === 'read-only file system' || text === 'The session closed before NewOrderSingle was sent', text);
  assert.ok(calls >= 1);
  assert.deepEqual(errorTexts(client).filter(text => text === 'read-only file system').length, calls, 'one error entry for each list that failed');
});

test('a write that fails closes the session: the messages numbered after it are not written, though their records were kept', { timeout: 10_000 }, async () => {
  const dict = dictionaryFor('FIX.4.4');
  const written: number[] = [];
  const { store, records } = recordingStore();
  const link: Link = {
    write: async bytes => {
      const seq = Number(inspectMessage(parseFrame(bytes).fields, dict).message.MsgSeqNum);
      if (seq === 2) throw new Error('EPIPE');
      written.push(seq);
    },
    end: () => {},
  };
  const client = lone({ store, manual: true, link });
  const sends = ['a', 'b', 'c', 'd'].map(id => client.send('NewOrderSingle', order(id)));   // 1 to 4
  const outcomes = await Promise.all(sends.map(outcome));
  assert.deepEqual(await client.closed, { by: 'us', text: 'EPIPE' });
  assert.deepEqual(written, [1]);
  assert.deepEqual(outcomes, ['resolved', 'EPIPE', 'The session closed before NewOrderSingle was sent', 'The session closed before NewOrderSingle was sent']);
  assert.deepEqual(outSeqs(records), [1, 2, 3, 4]);   // a restart finds them, and resends or gap-fills what was not written
});

test('while a write never settles, the messages behind it still reach the store and none of them reaches the network; past outgoingBytes the session closes', { timeout: 10_000 }, async () => {
  const dict = dictionaryFor('FIX.4.4');
  const written: number[] = [];
  const { store, records } = recordingStore();
  const link: Link = {
    write: bytes => {
      written.push(Number(inspectMessage(parseFrame(bytes).fields, dict).message.MsgSeqNum));
      return new Promise<void>(() => {});   // the counterparty has stopped reading
    },
    end: () => {},
  };
  const client = lone({ store, manual: true, link, memory: { outgoingBytes: 4096 } });
  for (let n = 0; n < 10; n++) client.send('NewOrderSingle', order(`o${n}`)).catch(() => {});
  await ticks(20);
  assert.equal(client.state, 'active');
  assert.deepEqual(written, [1]);
  assert.deepEqual(outSeqs(records), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // Each stays counted until it is written, which none of them is: before long they are over the limit.
  for (let n = 10; n < 200 && client.state === 'active'; n++) client.send('NewOrderSingle', order(`o${n}`)).catch(() => {});
  assert.match((await client.closed).text, /^Outgoing queue over 4096 bytes/);
  assert.deepEqual(written, [1]);
  assert.ok(outSeqs(records).length < 60, `${outSeqs(records).length} records for 4096 bytes`);
});

test('an outgoing route that takes a while holds the messages behind it: their records reach the store in the order they were numbered, and so do their writes', { timeout: 10_000 }, async () => {
  const { client, journal } = await journaledLone();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  client.outgoing(async message => { if (message.ClOrdID === 'slow') await held; return message; });
  const sends = ['slow', 'b', 'c'].map(id => client.send('NewOrderSingle', order(id)));   // 2, 3, 4
  await ticks(20);
  assert.equal(journal.length, 0);
  release();
  await Promise.all(sends);
  assert.deepEqual(journal.filter(each => each.startsWith('given')).flatMap(each => each.slice(6).split(',')), ['2', '3', '4']);
  assert.deepEqual(journal.filter(each => each.startsWith('wire')), ['wire 2', 'wire 3', 'wire 4']);
});

test('a route that turns one message into several hands all their records to the store before the first is written, and they are written in order, before the message numbered next', { timeout: 10_000 }, async () => {
  const dict = dictionaryFor('FIX.4.4');
  const journal: string[] = [];
  const { store, lists, hold, release } = listedStore();
  const link: Link = { write: async bytes => { journal.push(`wire ${String(inspectMessage(parseFrame(bytes).fields, dict).message.ClOrdID)}`); }, end: () => {} };
  const client = lone({ store, manual: true, link });
  client.outgoing(message => (message.ClOrdID === 'split' ? [{ ...message, ClOrdID: 'split-1' }, { ...message, ClOrdID: 'split-2' }, { ...message, ClOrdID: 'split-3' }] : message));
  hold();
  const sends = [client.send('NewOrderSingle', order('first')), client.send('NewOrderSingle', order('split')), client.send('NewOrderSingle', order('last'))];
  await ticks(20);
  assert.deepEqual(journal, []);
  release();
  await ticks(20);
  const ids = (records: readonly StoreRecord[]) => records.map(record => (record.entry?.kind === 'message' ? String(record.entry.message.ClOrdID) : described(record)));
  assert.deepEqual(lists.map(ids), [['first'], ['split-1', 'split-2', 'split-3', 'last']]);
  assert.deepEqual(journal, ['wire first']);
  release();
  await Promise.all(sends);
  assert.deepEqual(journal, ['wire first', 'wire split-1', 'wire split-2', 'wire split-3', 'wire last']);
});

test('a message an outgoing route drops is kept and shown in history in its place among the messages sent around it, not ahead of one still waiting to be written', { timeout: 10_000 }, async () => {
  const { store, hold, releaseAll } = listedStore();
  const client = lone({ store, manual: true });
  client.outgoing(message => (message.ClOrdID === 'dropped' ? null : message));
  hold();
  const sends = ['a', 'dropped', 'c'].map(id => client.send('NewOrderSingle', order(id)));
  await ticks(20);
  assert.deepEqual(client.history.map(entry => entry.kind === 'message' && entry.message.ClOrdID), []);   // none before the first is written
  releaseAll();
  await Promise.all(sends);
  assert.deepEqual(client.history.map(entry => entry.kind === 'message' && [entry.message.ClOrdID, entry.bytes !== undefined]), [['a', true], ['dropped', false], ['c', true]]);
});

test('bytes sent as they are keep their place on the wire among the messages sent around them, a frame or not', { timeout: 10_000 }, async () => {
  const wire: string[] = [];
  const { store, lists, hold, releaseAll } = listedStore();
  const link: Link = { write: async bytes => { wire.push(/\x0111=(\w+)\x01/.exec(Buffer.from(bytes).toString('latin1'))?.[1] ?? Buffer.from(bytes).toString('latin1')); }, end: () => {} };
  const client = lone({ store, manual: true, link });
  hold();
  const sends: Promise<unknown>[] = [client.send('NewOrderSingle', order('a'))];
  sends.push(client.sendBytes('not a frame'));
  sends.push(client.sendBytes(client.encode('NewOrderSingle', order('raw'))));
  sends.push(client.send('NewOrderSingle', order('d')));
  await ticks(20);
  assert.deepEqual(wire, []);   // not even the bytes that have no record: they wait their turn
  releaseAll();
  await Promise.all(sends);
  assert.deepEqual(wire, ['a', 'not a frame', 'raw', 'd']);
  assert.deepEqual(lists.flat().map(record => (record.entry?.kind === 'message' ? record.entry.message.ClOrdID : described(record))), ['a', 'raw', 'd']);
});

test('frames sent as bytes hand their records to the store as sent messages do: while one append is in flight the rest gather, with the messages sent among them', { timeout: 10_000 }, async () => {
  const { client, journal, hold, releaseAll } = await journaledLone();
  hold();
  const frames = [2, 3, 4].map(seq => client.encode('NewOrderSingle', { ...order(`raw${seq}`), MsgSeqNum: seq }));
  const sends: Promise<unknown>[] = frames.map(bytes => client.sendBytes(bytes));
  sends.push(client.send('NewOrderSingle', { ...order('d'), MsgSeqNum: 5 }));
  await ticks(20);
  assert.deepEqual(journal, ['given 2']);
  releaseAll();
  await Promise.all(sends);
  assert.deepEqual(journal.filter(each => each.startsWith('given')), ['given 2', 'given 3,4,5']);
  assert.deepEqual(journal.filter(each => each.startsWith('wire')), ['wire 2', 'wire 3', 'wire 4', 'wire 5']);
});

test('a list the store rejects while an earlier message is still being written closes the session with the store\'s error, and nothing is left unhandled', { timeout: 10_000 }, async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const { store, hold, release, fail } = listedStore();
    let finishWrite!: () => void;
    const writes: Promise<void>[] = [];
    const link: Link = { write: () => { const written = new Promise<void>(resolve => { finishWrite = resolve; }); writes.push(written); return written; }, end: () => {} };
    const client = lone({ store, manual: true, link });
    hold();
    const sends = [client.send('NewOrderSingle', order('a'))];
    await ticks();
    sends.push(client.send('NewOrderSingle', order('b')), client.send('NewOrderSingle', order('c')));
    for (const each of sends) each.catch(() => {});
    await ticks();
    release();                       // a is kept; its write begins and does not finish
    await ticks();
    assert.equal(writes.length, 1);
    fail(new Error('disk full'));    // the list of b and c fails while a is still being written: no one is waiting for b or c yet
    await ticks(20);
    assert.deepEqual(await client.closed, { by: 'us', text: 'disk full' });
    finishWrite();
    assert.deepEqual(await Promise.all(sends.map(outcome)), ['resolved', 'disk full', 'disk full']);
    await ticks(20);
    assert.equal(writes.length, 1);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a ResendRequest taken while sent messages wait for a slow store is answered once they are kept and written, from the store, and a message sent after it is written after the answer', { timeout: 10_000 }, async () => {
  const { store, hold, releaseAll } = listedStore();
  const { client, written } = await loneLoggedOn({ store });
  hold();
  const sends = ['a', 'b', 'c'].map(id => client.send('NewOrderSingle', order(id)));   // 2, 3, 4
  await ticks();
  client.receiveBytes(fromExchange('ResendRequest', 2, { BeginSeqNo: 2, EndSeqNo: 3 }));
  await ticks();
  sends.push(client.send('NewOrderSingle', order('d')));                                // 5
  await ticks(20);
  assert.equal(written.length, 0);
  releaseAll();
  await Promise.all(sends);
  assert.deepEqual(written.map(message => `${brief(message)} ${String(message.ClOrdID)}`), [
    'NewOrderSingle 2 a', 'NewOrderSingle 3 b', 'NewOrderSingle 4 c',
    'NewOrderSingle 2 PossDup a', 'NewOrderSingle 3 PossDup b',
    'NewOrderSingle 5 d',
  ]);
});

/** A small generator of whole numbers below `below`, the same for a seed every time (mulberry32). */
function seeded(seed: number): (below: number) => number {
  let state = seed >>> 0;
  return below => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % below);
  };
}

for (const seed of [1, 2, 3]) {
  test(`whatever the store's pace, the same messages are written in the same order and the store is given the same sent records in the same order (seed ${seed})`, { timeout: 20_000 }, async () => {
    /** Runs one script of sends, raw sends, received messages and sequence changes against a store that keeps each list after `pace()` turns. */
    const run = async (pace: () => number) => {
      const dict = dictionaryFor('FIX.4.4');
      const random = seeded(seed);
      const wire: string[] = [];
      const kept: string[] = [];
      let inFlight = 0;
      let most = 0;
      let lists = 0;
      const base = memoryStore();
      const store: Store = {
        ...base,
        async append(id, records, context) {
          most = Math.max(most, ++inFlight);
          lists++;
          for (let turns = pace(); turns > 0; turns--) await tick();
          for (const record of records) {
            if (record.entry?.kind === 'message' && record.entry.direction === 'out') kept.push(`${brief(record.entry.message)} next=${record.seqNums.next}`);
            else if (!record.entry) kept.push(`seqNums next=${record.seqNums.next}${record.newEpoch ? ' new epoch' : ''}`);
          }
          inFlight--;
          return base.append(id, records, context);
        },
      };
      const link: Link = {
        write: async bytes => {
          const text = brief(inspectMessage(parseFrame(bytes).fields, dict).message);
          // Kept before sent: the record of what is being written has been kept.
          assert.ok(kept.some(each => each.startsWith(`${text} next=`)), `${text} was written before its record was kept`);
          wire.push(text);
        },
        end: () => {},
      };
      const client = lone({ store, link });
      client.outgoing(message => (message.ClOrdID === 'twice' ? [message, { ...message, ClOrdID: 'again' }] : message.ClOrdID === 'dropped' ? null : message));
      client.start();
      client.receiveBytes(fromExchange('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30 }));
      await client.active;
      let incoming = 2;
      const sends: Promise<unknown>[] = [];
      for (let step = 0; step < 300; step++) {
        const what = random(20);
        if (what < 9) sends.push(client.send('NewOrderSingle', order(['o', 'twice', 'dropped', 'o', 'o'][random(5)]!)));
        else if (what < 11) sends.push(client.sendBytes(client.encode('Heartbeat')));
        else if (what < 15) client.receiveBytes(fromExchange('TestRequest', incoming++, { TestReqID: `t${step}` }));   // answered with a Heartbeat
        else if (what < 16) client.setSeqNums({ next: client.seqNums.next + 3 });
        else if (what < 17) client.setSeqNums({ next: 1 });
        else for (let turns = random(3); turns > 0; turns--) await tick();
      }
      await Promise.all(sends);
      await waitFor(() => client.seqNums.expected === incoming, 5000, 'every received message to be processed');
      await ticks(30);
      assert.equal(client.state, 'active');
      assert.equal(most, 1);
      return { wire, kept, lists };
    };
    const atOnce = await run(() => 0);
    const paces = seeded(seed * 7919);
    const uneven = await run(() => paces(4));
    const slow = await run(() => 3);
    assert.ok(atOnce.wire.length > 150, `only ${atOnce.wire.length} messages written`);
    assert.deepEqual(uneven.wire, atOnce.wire);
    assert.deepEqual(slow.wire, atOnce.wire);
    assert.deepEqual(uneven.kept, atOnce.kept);
    assert.deepEqual(slow.kept, atOnce.kept);
    assert.ok(slow.lists < atOnce.lists, `a slow store was given ${slow.lists} lists, one that keeps at once ${atOnce.lists}`);
  });
}

// ─── Reads pause early: memory.pendingBytes ─────────────────────────────────

/** A Heartbeat from EXCHANGE of exactly `bytes` bytes: its TestReqID is as long as that takes. */
function sized(seq: number, bytes: number): Uint8Array {
  let frame = fromExchange('Heartbeat', seq, { TestReqID: 'x' });
  // BodyLength grows a digit as the body does, so the second try lands where the first only came near.
  for (let tries = 0; tries < 3 && frame.length !== bytes; tries++) {
    const padding = String(inspectMessage(parseFrame(frame).fields, dictionaryFor('FIX.4.4')).message.TestReqID).length + bytes - frame.length;
    frame = fromExchange('Heartbeat', seq, { TestReqID: 'x'.repeat(padding) });
  }
  assert.equal(frame.length, bytes);
  return frame;
}

/** A link that goes nowhere and notes each pause() and resume(). */
function pausableLink(): { link: Link; pauses: string[] } {
  const pauses: string[] = [];
  return { pauses, link: { write: async () => {}, end: () => {}, pause: () => { pauses.push('pause'); }, resume: () => { pauses.push('resume'); } } };
}

test('reads pause once the received messages a session has not finished processing pass memory.pendingBytes, and resume once they are below a quarter of it', { timeout: 10_000 }, async () => {
  const { link, pauses } = pausableLink();
  const client = lone({ link, manual: true, memory: { pendingBytes: 2100 } });   // ten and a half messages of 200 bytes
  // An incoming route holds each message until it is let through, so each stays not processed.
  const gates: (() => void)[] = [];
  client.incoming(message => new Promise(resolve => { gates.push(() => resolve(message)); }));
  const through = async () => { await waitFor(() => gates.length > 0, 1000, 'a message at the route'); gates.shift()!(); await ticks(); };
  for (let seq = 1; seq <= 10; seq++) client.receiveBytes(sized(seq, 200));
  await ticks();
  assert.deepEqual(pauses, [], '2,000 bytes are not past 2,100');
  client.receiveBytes(sized(11, 200));
  assert.deepEqual(pauses, ['pause'], '2,200 are');
  for (let done = 1; done <= 8; done++) await through();
  assert.deepEqual(pauses, ['pause'], '600 bytes are not below a quarter of 2,100');
  await through();
  assert.deepEqual(pauses, ['pause', 'resume'], '400 are');
  await through();
  await through();
  assert.deepEqual(pauses, ['pause', 'resume']);
  assert.equal(client.state, 'active');
});

test('the records of received messages not yet kept count toward memory.pendingBytes, together with what is not yet processed; the records of sent messages do not', { timeout: 10_000 }, async () => {
  const { link, pauses } = pausableLink();
  const { store, hold, releaseAll } = listedStore();
  const client = lone({ store, link, manual: true, memory: { pendingBytes: 2100 } });
  hold();
  // Five received (1,000 bytes) wait for the store, and fifteen sent after them (3,000 bytes and more).
  for (let seq = 1; seq <= 5; seq++) client.receiveBytes(sized(seq, 200));
  await ticks();
  const sends = Array.from({ length: 15 }, (_, n) => client.sendBytes(client.encode('Heartbeat', { TestReqID: 'y'.repeat(150), MsgSeqNum: n + 1 })));
  await ticks();
  assert.deepEqual(pauses, [], 'what we sent ourselves is not counted');
  // Six more are held by a route: neither they (1,200 bytes) nor the received records are past the limit alone; together they are.
  let through!: () => void;
  const gate = new Promise<void>(resolve => { through = resolve; });
  client.incoming(async message => { await gate; return message; });
  for (let seq = 6; seq <= 10; seq++) client.receiveBytes(sized(seq, 200));
  await ticks();
  assert.deepEqual(pauses, [], '2,000 bytes received and not finished');
  client.receiveBytes(sized(11, 200));
  await ticks();
  assert.deepEqual(pauses, ['pause'], '2,200');
  releaseAll();
  await Promise.all(sends);
  await ticks();
  assert.deepEqual(pauses, ['pause'], 'the six at the route are 1,200 bytes: not below a quarter');
  through();
  await ticks(10);
  assert.deepEqual(pauses, ['pause', 'resume']);
});

test('memory.pendingBytes is 4 KiB unless given: reads pause past that much taken in and not finished, and no sooner', { timeout: 10_000 }, async () => {
  const { link, pauses } = pausableLink();
  const { store, hold, releaseAll } = listedStore();
  const client = lone({ store, link, manual: true });
  hold();
  let seq = 1;
  for (let bytes = 0; bytes < 3 * 1024; bytes += 1024) client.receiveBytes(sized(seq++, 1024));    // 3 KiB
  await waitFor(() => client.seqNums.expected === seq, 5000, 'the messages to be processed');
  await ticks();
  assert.deepEqual(pauses, []);
  for (let more = 0; more < 2; more++) client.receiveBytes(sized(seq++, 1024));                     // 5 KiB
  await waitFor(() => client.seqNums.expected === seq, 5000, 'the messages to be processed');
  await ticks();
  assert.deepEqual(pauses, ['pause']);
  releaseAll();
  await ticks(10);
  assert.deepEqual(pauses, ['pause', 'resume']);
});

/** A CLIENT whose incoming route holds each received message until through() lets the oldest go on. */
function heldAtRoute(memory: NonNullable<Parameters<typeof lone>[0]>['memory'], store?: Store) {
  const { link, pauses } = pausableLink();
  const client = lone({ link, manual: true, ...(memory ? { memory } : {}), ...(store ? { store } : {}) });
  const gates: (() => void)[] = [];
  client.incoming(message => new Promise(resolve => { gates.push(() => resolve(message)); }));
  const through = async (count = 1) => {
    for (let done = 0; done < count; done++) {
      await waitFor(() => gates.length > 0, 1000, 'a message at the route');
      gates.shift()!();
      await ticks();
    }
  };
  return { client, pauses, through };
}

test('exactly memory.pendingBytes taken in does not pause reads and one byte more does; exactly a quarter of it left does not resume them and less does; unless given it is 4,096', { timeout: 10_000 }, async () => {
  for (const pendingBytes of [2000, undefined]) {
    const limit = pendingBytes ?? 4_096;
    const { client, pauses, through } = heldAtRoute(pendingBytes === undefined ? undefined : { pendingBytes });
    let seq = 1;
    // Sixteen messages that are the limit between them.
    for (let n = 0; n < 16; n++) client.receiveBytes(sized(seq++, limit / 16));
    await ticks();
    assert.deepEqual(pauses, [], `${limit} bytes are not past ${limit}`);
    await through(16);
    // Three quarters of the limit and a byte, then two messages that are a quarter of it between them.
    for (let n = 0; n < 11; n++) client.receiveBytes(sized(seq++, limit / 16));
    client.receiveBytes(sized(seq++, limit / 16 + 1));
    client.receiveBytes(sized(seq++, limit / 8));
    assert.deepEqual(pauses, [], `${limit + 1 - limit / 8} bytes`);
    client.receiveBytes(sized(seq++, limit / 8));
    assert.deepEqual(pauses, ['pause'], `${limit + 1} bytes are past ${limit}`);
    await through(12);
    assert.deepEqual(pauses, ['pause'], `${limit / 4} bytes are not below a quarter of ${limit}`);
    await through(1);
    assert.deepEqual(pauses, ['pause', 'resume'], `${limit / 8} bytes are`);
    await through(1);
    assert.equal(client.state, 'active');
  }
});

for (const [what, memory, pauseAt, resumeAt] of [
  ['half of memory.inbox received and not processed', { inbox: 20, pendingBytes: 1_000_000 }, 11, 4],
  ['half of memory.inboxBytes received and not processed', { inboxBytes: 4000, pendingBytes: 1_000_000 }, 11, 4],
  ['half of memory.storeBytes received and not processed', { storeBytes: 4000, pendingBytes: 1_000_000 }, 11, 4],
] as const) {
  test(`reads pause past ${what} though memory.pendingBytes is far off, and resume below a quarter`, { timeout: 10_000 }, async () => {
    const { client, pauses, through } = heldAtRoute(memory);
    for (let seq = 1; seq < pauseAt; seq++) client.receiveBytes(sized(seq, 200));
    await ticks();
    assert.deepEqual(pauses, [], `${pauseAt - 1} messages of 200 bytes`);
    client.receiveBytes(sized(pauseAt, 200));
    assert.deepEqual(pauses, ['pause'], `${pauseAt} messages`);
    await through(pauseAt - resumeAt - 1);
    assert.deepEqual(pauses, ['pause'], `${resumeAt + 1} messages left`);
    await through(1);
    assert.deepEqual(pauses, ['pause', 'resume'], `${resumeAt} messages left`);
    assert.equal(client.state, 'active');
  });
}

test('the records of sent messages the store has not kept pause no reads, however near memory.storeBytes they come; one record past it closes the session', { timeout: 10_000 }, async () => {
  const { link, pauses } = pausableLink();
  const { store, hold } = listedStore();
  const client = lone({ store, link, manual: true, memory: { storeBytes: 4000, pendingBytes: 1_000_000 } });
  hold();
  const own = (n: number) => { void client.sendBytes(sized(n, 200)).catch(() => {}); };
  for (let n = 1; n <= 20; n++) own(n);
  await ticks();
  assert.deepEqual(pauses, [], '4,000 bytes of records of our own, with half of storeBytes at 2,000');
  assert.equal(client.state, 'active');
  // What is received meanwhile is read; its record is one too many.
  client.receiveBytes(sized(1, 200));
  await ticks();
  assert.deepEqual(pauses, []);
  assert.equal(client.history.filter(entry => entry.kind === 'message' && entry.direction === 'in').length, 1);
  assert.equal(client.state, 'closed');
  assert.deepEqual(errorTexts(client), ['Store is not keeping up']);
});

test('the records of received messages the store has not kept pause reads past half of memory.storeBytes and resume them below a quarter, whatever records of sent messages wait beside them', { timeout: 10_000 }, async () => {
  const { link, pauses } = pausableLink();
  const { store, lists, hold, release } = listedStore();
  const client = lone({ store, link, manual: true, memory: { storeBytes: 6000, pendingBytes: 1_000_000 } });
  hold();
  // One list of one record of our own is with the store; nine more of ours gather behind it: 2,000 bytes.
  void client.sendBytes(sized(1, 200));
  await ticks();
  for (let n = 2; n <= 10; n++) void client.sendBytes(sized(n, 200));
  await ticks();
  for (let seq = 1; seq <= 14; seq++) client.receiveBytes(sized(seq, 200));
  await ticks();
  assert.deepEqual(pauses, [], '2,800 bytes received and not kept, beside 2,000 of our own: 4,800 in all, with half of storeBytes at 3,000');
  release();
  await ticks();
  assert.deepEqual(lists.map(list => list.length), [1, 23]);
  client.receiveBytes(sized(15, 200));
  await ticks();
  assert.deepEqual(pauses, [], '3,000 bytes received and not kept are not past half of 6,000');
  client.receiveBytes(sized(16, 200));
  await ticks();
  assert.deepEqual(pauses, ['pause'], '3,200 are');
  // Five more of our own bring the records not kept to 6,000 bytes; then the list of 23 is kept, and 400 bytes received are left with them.
  for (let n = 11; n <= 15; n++) void client.sendBytes(sized(n, 200));
  await ticks();
  assert.deepEqual(pauses, ['pause']);
  release();
  await ticks();
  assert.deepEqual(pauses, ['pause', 'resume'], '400 bytes received and not kept, beside 1,000 of our own');
  release();
  await ticks();
  assert.equal(client.state, 'active');
});

test('the problems found in what was received count toward memory.pendingBytes until the store has kept their records; the errors of the program\'s own routes do not', { timeout: 10_000 }, async () => {
  const { link, pauses } = pausableLink();
  const { store, lists, hold, releaseAll } = listedStore();
  const client = lone({ store, link, manual: true, memory: { pendingBytes: 1000 }, onHandlerError: () => {} });
  hold();
  // Ten sends through a route that throws: an 'error' record and a sent record each, none of them received.
  const remove = client.outgoing(() => { throw new Error('route failed'); });
  for (let n = 1; n <= 10; n++) void client.send('Heartbeat', { TestReqID: `own-${n}` });
  await ticks(20);
  remove();
  assert.equal(errorTexts(client).length, 10);
  assert.deepEqual(pauses, [], 'ten errors of our own, and ten sent messages, wait for the store');
  // Frames whose CheckSum is wrong: nothing is delivered, and each leaves the record of a problem (256 bytes, having no wire bytes).
  const garbled = (seq: number) => { const frame = sized(seq, 100); frame[frame.length - 2] = frame[frame.length - 2] === 0x30 ? 0x31 : 0x30; return frame; };
  for (let seq = 1; seq <= 3; seq++) client.receiveBytes(garbled(seq));
  await ticks();
  assert.equal(client.history.filter(entry => entry.kind === 'problem').length, 3);
  assert.deepEqual(pauses, [], 'three problems: 768 bytes');
  client.receiveBytes(garbled(4));
  await ticks();
  assert.deepEqual(pauses, ['pause'], 'four: 1,024');
  releaseAll();
  await ticks(10);
  assert.deepEqual(pauses, ['pause', 'resume']);
  assert.equal(lists.flat().filter(record => record.entry?.kind === 'problem').length, 4);
});

test('reads paused for what was received resume once that is processed and kept, however much the session sends meanwhile and however far its store is behind with it', { timeout: 10_000 }, async () => {
  const { link, pauses } = pausableLink();
  const { store, lists, hold, release } = listedStore();
  const client = lone({ store, link, manual: true, memory: { pendingBytes: 2000 } });
  hold();
  let sent = 0;
  let unsettled = 0;
  const own = () => { unsettled++; void client.sendBytes(sized(++sent, 200)).finally(() => { unsettled--; }); };
  for (let seq = 1; seq <= 11; seq++) client.receiveBytes(sized(seq, 200));
  await ticks();
  assert.deepEqual(pauses, ['pause']);
  // Ten of our own (2,000 bytes) for every list the store keeps: its backlog only grows.
  const backlog: number[] = [];
  for (let turn = 0; turn < 6 && pauses.length === 1; turn++) {
    for (let n = 0; n < 10; n++) own();
    await ticks();
    release();
    await ticks();
    backlog.push(unsettled);
  }
  assert.deepEqual(pauses, ['pause', 'resume'], `still paused after the store kept ${lists.length - 1} lists`);
  const kept = lists.slice(0, -1).flat().filter(record => record.entry?.kind === 'message' && record.entry.direction === 'in').length;
  assert.equal(kept, 11, 'reads resumed once the eleven received were kept');
  assert.ok(unsettled >= 10, `${unsettled} of our own still wait for the store: more than memory.pendingBytes`);
  assert.deepEqual(backlog, [...backlog].sort((a, b) => a - b), 'the backlog never fell');
  assert.equal(client.state, 'active');
});

test('a slow store against a peer that sends as fast as it is read: what the session has taken in and not finished stays near memory.pendingBytes, whatever storeBytes allows, and the session is not closed', { timeout: 20_000 }, async () => {
  const base = memoryStore();
  let keptBytes = 0;
  const slow: Store = {
    ...base,
    async append(id, records, context) {
      await tick();
      await tick();
      for (const { entry } of records) if (entry?.kind === 'message' && entry.direction === 'in') keptBytes += entrySize(entry);
      return base.append(id, records, context);
    },
  };
  const pauses: boolean[] = [];
  const pendingBytes = 4096;
  const { client, exchange } = await loggedOn({
    store: { exchange: slow },
    memory: { exchange: { pendingBytes } },
    onPause: (side, paused) => { if (side === 'exchange') pauses.push(paused); },
  });
  await ticks(10);
  // What EXCHANGE is given, in bytes, less what its store has kept of it: what it has taken in and not finished.
  let taken = keptBytes;
  let most = 0;
  let largest = 0;
  const receive = exchange.receiveBytes.bind(exchange);
  exchange.receiveBytes = chunk => {
    taken += chunk.length;
    largest = Math.max(largest, chunk.length);
    most = Math.max(most, taken - keptBytes);
    receive(chunk);
  };
  const total = 3000;
  const sends: Promise<unknown>[] = [];
  for (let n = 0; n < total; n++) sends.push(client.send('NewOrderSingle', order(`o${n}`)));   // all at once: only the pause holds them back
  await Promise.all(sends);
  await waitFor(() => exchange.seqNums.expected === total + 2 && taken === keptBytes, 10_000, 'the store to catch up');
  assert.equal(exchange.state, 'active');
  assert.ok(taken > 50 * pendingBytes, `only ${taken} bytes were sent`);
  // One message may arrive after the pause is asked for, and a message counts twice for a moment (received, and as a record).
  assert.ok(most <= pendingBytes + 2 * largest, `${most} bytes taken in and not finished, with pendingBytes ${pendingBytes}`);
  assert.ok(pauses.filter(paused => paused).length >= 10, `paused ${pauses.filter(paused => paused).length} times`);
  assert.equal(pauses.at(-1), false);
});

test('reads paused for the store backlog do not count as no progress while the store keeps what it is given, though nothing is received for longer than processingTimeout', { timeout: 10_000 }, async () => {
  const clock = fakeClock(T0);
  const { link, pauses } = pausableLink();
  const base = memoryStore();
  const lists: number[] = [];
  const slow: Store = { ...base, async append(id, records, context) { lists.push(records.length); await new Promise<void>(resolve => { clock.setTimeout(resolve, 4_000); }); return base.append(id, records, context); } };
  const client = lone({ store: slow, link, clock, manual: true, processingTimeoutMs: 5_000, memory: { pendingBytes: 1000 } });
  for (let seq = 1; seq <= 8; seq++) client.receiveBytes(sized(seq, 200));        // six are 1,200 bytes: paused, and the last two wait as bytes
  await ticks();
  assert.deepEqual(pauses, ['pause']);
  // The first record is kept after 4 s and the other five taken in, in the next list, after 8 s: reads are paused for 8 s.
  for (let second = 1; second <= 7; second++) {
    await clock.advance('1s');
    await ticks(2);
    void client.sendBytes(sized(second, 180));
  }
  assert.deepEqual(pauses, ['pause'], 'paused for 7 s, with processingTimeout 5 s');
  assert.equal(client.state, 'active');
  assert.deepEqual(lists.slice(0, 2), [1, 8], 'the other five taken in, with three of our own sent meanwhile');
  await clock.advance('2s');
  await ticks();
  assert.deepEqual(pauses, ['pause', 'resume'], 'the six are kept and the last two taken in, whatever of our own is not kept');
  assert.equal(client.seqNums.expected, 9);
  assert.equal(client.state, 'active');
});

test('reads paused for the store backlog while the store keeps nothing close the session: no progress for processingTimeout', { timeout: 10_000 }, async () => {
  const clock = fakeClock(T0);
  const { link, pauses } = pausableLink();
  const client = lone({ store: stoppedStore(), link, clock, manual: true, processingTimeoutMs: 5_000, storeTimeoutMs: 60_000, memory: { pendingBytes: 1000 } });
  for (let seq = 1; seq <= 8; seq++) client.receiveBytes(sized(seq, 200));
  await ticks();
  assert.deepEqual(pauses, ['pause']);
  await clock.advance('4s');
  assert.equal(client.state, 'active');
  await clock.advance('3s');
  assert.equal(client.state, 'closed');
  await clock.advance('10s');
  assert.equal((await client.closed).text, 'No progress on received messages for 5 s');
});

/**
 * Two logged-on sessions on a link that holds `room` bytes each way, as a socket's buffers do: a
 * write resolves once its bytes are in the link, and they stay there while the reader has paused.
 */
async function pipedPair(room: number) {
  const clock = fakeClock(T0);
  const dictionary = dictionaryFor('FIX.4.4');
  const make = (sender: string, target: string, role: 'initiator' | 'acceptor') => new FixSession({
    config: engineConfig({ version: 'FIX.4.4', sender, target, role }), dictionary, store: memoryStore(), clock, loaded: { history: [], next: 1, expected: 1 },
  });
  const client = make('CLIENT', 'EXCHANGE', 'initiator');
  const exchange = make('EXCHANGE', 'CLIENT', 'acceptor');
  const pipe = (to: FixSession) => {
    let paused = false;
    let held = 0;
    const writing: { bytes: Uint8Array; done(): void }[] = [];
    const inside: Uint8Array[] = [];
    const move = () => {
      while (writing.length > 0 && (held === 0 || held + writing[0]!.bytes.length <= room)) {
        const next = writing.shift()!;
        held += next.bytes.length;
        inside.push(next.bytes);
        next.done();
      }
      setImmediate(() => {
        let read = false;
        while (!paused && inside.length > 0) {
          const bytes = inside.shift()!;
          held -= bytes.length;
          to.receiveBytes(bytes);
          read = true;
        }
        if (read) move();
      });
    };
    return {
      write: (bytes: Uint8Array) => new Promise<void>(done => { writing.push({ bytes, done }); move(); }),
      pause: () => { paused = true; },
      resume: () => { paused = false; move(); },
    };
  };
  const toExchange = pipe(exchange);
  const toClient = pipe(client);
  client.attach({ write: toExchange.write, end: () => {}, pause: toClient.pause, resume: toClient.resume });
  exchange.attach({ write: toClient.write, end: () => {}, pause: toExchange.pause, resume: toExchange.resume });
  client.start();
  await Promise.all([client.active, exchange.active]);
  return { client, exchange };
}

test('two sessions that each send more than the link between them holds go on reading each other: what one has not yet written never stops it reading', { timeout: 20_000 }, async () => {
  const { client, exchange } = await pipedPair(8192);
  let received = 0;
  client.on('NewOrderSingle', () => { received++; });
  exchange.on('NewOrderSingle', () => { received++; });
  const sends: Promise<unknown>[] = [];
  // 2,000 each way, about 250 bytes each, queued at once: far more than the 8 KiB in transit, and than pendingBytes.
  for (let n = 0; n < 2000; n++) {
    sends.push(client.send('NewOrderSingle', { ...order(`c${n}`), Text: 'x'.repeat(100) }));
    sends.push(exchange.send('NewOrderSingle', { ...order(`e${n}`), Text: 'x'.repeat(100) }));
  }
  await Promise.all(sends);
  await waitFor(() => received === 4000, 10_000, 'every message to be received');
  assert.deepEqual([client.state, exchange.state], ['active', 'active']);
});

// ─── Every send() settles, however the session closes ───────────────────────

for (const [how, sends, close, text] of [
  ['its records pass memory.storeBytes', 30, async () => {}, 'Store is not keeping up'],
  ['close() is called', 6, async (client: FixSession) => { client.close(); }, 'Closed'],
  ['the connection is lost', 6, async (client: FixSession) => { client.linkClosed(); }, 'Connection closed'],
  ['the store write takes longer than storeTimeout', 6, async (_client: FixSession, clock: FakeClock) => { await clock.advance('11s'); }, 'Store write took longer than 10 s'],
  ['it logs out', 6, async (client: FixSession) => { void client.logout(); }, undefined],
] as const) {
  test(`every send() settles when a session whose store has stopped is closed because ${how}`, { timeout: 10_000 }, async () => {
    const clock = fakeClock(T0);
    const base = memoryStore();
    let stopped = false;
    const store: Store = { ...base, append: (id, records, context) => (stopped ? new Promise<void>(() => {}) : base.append(id, records, context)) };
    const { client, written } = await loneLoggedOn({ store, clock, memory: { storeBytes: 2000 } });
    stopped = true;
    const states: string[] = [];
    for (let n = 0; n < sends; n++) {
      states.push('pending');
      // Both ways of sending, in turn.
      const sent: Promise<unknown> = n % 3 === 2 ? client.sendBytes(client.encode('NewOrderSingle', order(`o${n}`))) : client.send('NewOrderSingle', order(`o${n}`));
      sent.then(() => { states[n] = 'sent'; }, (error: Error) => { states[n] = error.message; });
    }
    await ticks(20);
    await close(client, clock);
    await ticks(20);
    // The longest a closing session waits: for its Logout to be written, then for its store.
    await clock.advance('30s');
    const reason = await client.closed;
    await ticks(20);
    if (text !== undefined) assert.equal(reason.text, text);
    assert.deepEqual(states.filter(state => state === 'pending' || state === 'sent'), [], `of ${sends} sends: ${JSON.stringify(states)}`);
    assert.deepEqual(written, [], 'none was kept, so none was written');
  });
}

// ─── What an outgoing route makes of a message ──────────────────────────────

test('of the messages an outgoing route makes of a Logon that resets the sequences, the first alone begins the new epoch', { timeout: 10_000 }, async () => {
  const ours = recordingStore();
  const { client, written } = await loneLoggedOn({ store: ours.store });
  ours.records.length = 0;
  client.outgoing(message => (message.MsgType === 'Logon' ? [message, { ...message, Username: 'second' }, { ...message, Username: 'third' }] : message));
  await client.send('Logon', { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true });
  await ticks();
  assert.deepEqual(written.map(message => [message.MsgType, message.MsgSeqNum, message.Username]), [['Logon', 1, undefined], ['Logon', 1, 'second'], ['Logon', 1, 'third']]);
  const logons = ours.records.filter(record => described(record) === 'out Logon');
  assert.deepEqual(logons.map(record => [record.newEpoch === true, record.seqNums.next]), [[true, 2], [false, 2], [false, 2]]);
  assert.equal(ours.records.filter(record => record.newEpoch).length, 1);
});

test('the messages an outgoing route makes of one count toward memory.outgoingBytes until they are written', { timeout: 10_000 }, async () => {
  for (const [copies, closes] of [[3, false], [40, true]] as const) {
    const client = lone({ manual: true, memory: { outgoingBytes: 5000 }, link: { write: () => new Promise<void>(() => {}), end: () => {} } });
    client.outgoing(message => Array.from({ length: copies }, (_, n) => ({ ...message, ClOrdID: `copy-${n}` })));
    void client.send('NewOrderSingle', order('one')).catch(() => {});
    await ticks(20);
    assert.equal(client.state, closes ? 'closed' : 'active', `${copies} copies of a message of about 150 bytes, with outgoingBytes 5,000`);
    if (closes) assert.match((await client.closed).text, /^Outgoing queue over 5000 bytes/);
    client.close();
  }
});

/** A link whose writes wait until release() lets them, and all later ones, go on; `written` is the bytes of each. */
function heldLink() {
  const written: number[] = [];
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const link: Link = { write: async bytes => { await released; written.push(bytes.length); }, end: () => {} };
  return { link, written, release };
}

test('a message an outgoing route changes counts toward memory.outgoingBytes once, at the size that is written, and nothing is counted once everything is written', { timeout: 10_000 }, async () => {
  const { link, written, release } = heldLink();
  const client = lone({ manual: true, link, memory: { outgoingBytes: 5000 } });
  client.outgoing(message => ({ ...message, Text: 'y'.repeat(20) }));
  // Twenty of about 118 bytes, each made about 144 by the route: 2,900 to be written, where the two sizes together are 5,200.
  const sends = Array.from({ length: 20 }, (_, n) => client.send('NewOrderSingle', order(`o${n}`.padEnd(8, '-'))));
  await ticks(30);
  assert.equal(client.state, 'active');
  const counted = client.outgoingBytesForTests;
  // And as many again, which twice the count would not have room for.
  sends.push(...Array.from({ length: 12 }, (_, n) => client.send('NewOrderSingle', order(`p${n}`.padEnd(8, '-')))));
  await ticks(30);
  assert.equal(client.state, 'active', `32 changed messages, ${client.outgoingBytesForTests} bytes to be written, with outgoingBytes 5,000`);
  release();
  await Promise.all(sends);
  assert.equal(written.length, 32);
  assert.equal(counted, written.slice(0, 20).reduce((sum, bytes) => sum + bytes, 0), 'what was counted for the first twenty is what was written for them');
  assert.equal(client.outgoingBytesForTests, 0);
});

test('each message an outgoing route makes of one counts toward memory.outgoingBytes once, and the one they were made of does not', { timeout: 10_000 }, async () => {
  const { link, written, release } = heldLink();
  const client = lone({ manual: true, link, memory: { outgoingBytes: 5000 } });
  client.outgoing(message => [0, 1, 2].map(n => ({ ...message, Text: `copy-${n}` })));
  // Ten sends, three messages of about 130 bytes for each: 3,900 to be written, and 5,080 if the ten originals counted too.
  const first = Array.from({ length: 10 }, (_, n) => client.send('NewOrderSingle', order(`o${n}`.padEnd(8, '-'))));
  await ticks(40);
  const counted = client.outgoingBytesForTests;
  assert.equal(client.state, 'active');
  // Two more sends are within the limit by what is written alone.
  const more = Array.from({ length: 2 }, (_, n) => client.send('NewOrderSingle', order(`p${n}`.padEnd(8, '-'))));
  await ticks(40);
  assert.equal(client.state, 'active', `${client.outgoingBytesForTests} bytes to be written, with outgoingBytes 5,000`);
  release();
  await Promise.all([...first, ...more]);
  assert.equal(written.length, 36);
  assert.equal(counted, written.slice(0, 30).reduce((sum, bytes) => sum + bytes, 0));
  assert.equal(client.outgoingBytesForTests, 0);
});

test('a message an outgoing route drops stops counting toward memory.outgoingBytes, though the message before it is still to be written', { timeout: 10_000 }, async () => {
  const { link, written, release } = heldLink();
  const client = lone({ manual: true, link, memory: { outgoingBytes: 2000 } });
  client.outgoing(message => (message.MsgType === 'NewOrderSingle' ? null : message));
  const kept = client.send('Heartbeat', { TestReqID: 'written last' });
  await ticks();
  const one = client.outgoingBytesForTests;
  assert.ok(one > 50 && one < 200, `${one} bytes for one Heartbeat`);
  // A hundred orders of about 118 bytes, sent a few at a time: each is dropped by the route while the Heartbeat's write is still held.
  const dropped: Promise<unknown>[] = [];
  for (let n = 0; n < 100; n++) {
    dropped.push(client.send('NewOrderSingle', order(`o${n}`.padEnd(8, '-'))));
    if (n % 10 === 9) await ticks(20);
  }
  assert.equal(client.state, 'active', 'dropped messages were counted');
  assert.equal(client.outgoingBytesForTests, one, 'only the Heartbeat is to be written');
  release();
  await Promise.all([kept, ...dropped]);
  assert.deepEqual(written, [one]);
  assert.equal(client.outgoingBytesForTests, 0);
});

// ─── A closed session and its store ─────────────────────────────────────────

test('a closed session is among those handing over to its store until every record it made has settled, those made while it closed too; after that it gives its store nothing', { timeout: 10_000 }, async () => {
  const { store, lists, hold, release } = listedStore();
  const client = lone({ store, manual: true, onHandlerError: () => {} });
  const settled = () => {
    const waiting = lastSessionSettled(store, client.id);
    let done = waiting === undefined;
    void waiting?.settled.then(() => { done = true; });
    return async () => { await ticks(); return done; };
  };
  assert.equal(lastSessionSettled(store, client.id), undefined, 'a session that is not closing is not waited for');
  // A send waits in an outgoing route, until the route is made to fail.
  const failing: (() => void)[] = [];
  client.outgoing(() => new Promise((_resolve, reject) => { failing.push(() => reject(new Error('route failed'))); }));
  void client.send('Heartbeat', { TestReqID: 'first' }).catch(() => {});
  // And a handler has a received message in hand, until it is made to fail.
  let failLate!: () => void;
  client.on('Heartbeat', () => new Promise<void>((_resolve, reject) => { failLate = () => reject(new Error('handler failed')); }));
  hold();
  client.receiveBytes(sized(1, 200));
  await ticks();
  assert.deepEqual(lists.map(list => list.map(described)), [['in Heartbeat']]);
  client.close();
  const whenClosed = settled();
  assert.equal(await whenClosed(), false, 'the store has not kept the received message');
  // An error recorded while the first list is still with the store goes in a list of its own, after it.
  failing.shift()!();
  await ticks();
  release();
  await ticks();
  assert.deepEqual(lists.map(list => list.map(described)), [['in Heartbeat'], ['error']]);
  assert.equal(await whenClosed(), false, 'the store has not kept the error recorded while the session closed');
  assert.notEqual(lastSessionSettled(store, client.id), undefined);
  assert.equal(lastSessionSettled(store, { ...client.id, target: 'OTHER' }), undefined, 'another id is not waited for');
  assert.equal(lastSessionSettled(memoryStore(), client.id), undefined, 'nor is this id on another store');
  release();
  assert.equal(await whenClosed(), true);
  assert.equal(lastSessionSettled(store, client.id), undefined);
  // Whatever the session records from now on is in its history and not in the store: another session may have it.
  failLate();
  await ticks();
  assert.deepEqual(errorTexts(client), ['route failed', 'handler failed']);
  assert.equal(lists.length, 2, 'the store was given a record by a session that had handed everything over');
});

/** A store whose append() calls each wait until settle(n) lets the n-th of them (from 0) go on. */
function numberedStore() {
  const base = memoryStore();
  const calls: (() => void)[] = [];
  const store: Store = { ...base, async append(id, records, context) { await new Promise<void>(resolve => { calls.push(resolve); }); return base.append(id, records, context); } };
  return { store, calls: () => calls.length, settle: (n: number) => calls[n]!() };
}

test('while two closed sessions for one id both have records with the store, the next waits for both, whichever is settled first', { timeout: 10_000 }, async () => {
  const { store, calls, settle } = numberedStore();
  const earlier = lone({ store, manual: true });
  earlier.receiveBytes(sized(1, 200));
  await ticks();
  earlier.close();
  const later = lone({ store, manual: true });
  later.receiveBytes(sized(1, 200));
  await ticks();
  later.close();
  assert.equal(calls(), 2, 'each session has a list with the store');
  const wait = lastSessionSettled(store, later.id);
  assert.notEqual(wait, undefined);
  let done = false;
  void wait!.settled.then(() => { done = true; });
  // The session that closed last is settled first.
  settle(1);
  await ticks(10);
  assert.equal(done, false, 'the earlier session still has a list with the store');
  assert.notEqual(lastSessionSettled(store, later.id), undefined);
  settle(0);
  await ticks(10);
  assert.equal(done, true);
  assert.equal(lastSessionSettled(store, later.id), undefined);
});

test('a wait for a closed session that is given up is not told when the session settles, and the others are', { timeout: 10_000 }, async () => {
  const { store, settle } = numberedStore();
  const client = lone({ store, manual: true });
  client.receiveBytes(sized(1, 200));
  await ticks();
  client.close();
  const told: string[] = [];
  const givenUp = lastSessionSettled(store, client.id)!;
  const kept = lastSessionSettled(store, client.id)!;
  void givenUp.settled.then(() => { told.push('given up'); });
  void kept.settled.then(() => { told.push('kept'); });
  givenUp.forget();
  givenUp.forget();
  settle(0);
  await ticks(10);
  assert.deepEqual(told, ['kept']);
  kept.forget();
});

// ─── The intake: a session takes in only what it can finish ─────────────────

/**
 * The sessions the tests below leave open are closed when each test ends, passed or not: one that
 * went on asking for turns of the event loop would keep this file from ever ending, and the
 * failure that names the fault from being printed.
 */
const leftOpen: FixSession[] = [];
afterEach(() => { for (const session of leftOpen.splice(0)) session.close(); });
function closedAfterwards<S extends FixSession>(session: S): S {
  leftOpen.push(session);
  return session;
}

/** Microtasks only: all a session can do before the event loop turns. */
const settled = async () => { for (let n = 0; n < 2_000; n++) await null; };

/**
 * From here to the end of the test: how many turns of the event loop were asked for with
 * setImmediate, and how many of those are still to come (asked, and neither run nor given up with
 * clearImmediate). turn() waits one turn of its own, which is not counted.
 */
function watchedTurns(t: TestContext) {
  const ask = globalThis.setImmediate;
  const giveUp = globalThis.clearImmediate;
  let asked = 0;
  let over = 0;
  const live = new Set<unknown>();
  t.mock.method(globalThis, 'setImmediate', ((fn: () => void) => {
    asked++;
    const handle = ask(() => { live.delete(handle); over++; fn(); });
    live.add(handle);
    return handle;
  }) as typeof setImmediate);
  t.mock.method(globalThis, 'clearImmediate', ((handle: NodeJS.Immediate | undefined) => {
    if (live.delete(handle)) over++;
    giveUp(handle);
  }) as typeof clearImmediate);
  return { asked: () => asked, waiting: () => asked - over, turn: () => new Promise<void>(resolve => { ask(resolve); }) };
}

/** `count` Heartbeats from EXCHANGE of `bytes` bytes each, numbered from `from`, as one chunk. */
const chunkOf = (from: number, count: number, bytes: number) => Buffer.concat(Array.from({ length: count }, (_, n) => sized(from + n, bytes)));

/** A manual CLIENT on a link that notes its pauses, and the MsgSeqNums of the Heartbeats it has processed. */
function takingIn(options: Parameters<typeof lone>[0] = {}) {
  const { link, pauses } = pausableLink();
  const client = closedAfterwards(lone({ link, manual: true, memory: { pendingBytes: 1000 }, ...options }));
  const seen: number[] = [];
  client.on('Heartbeat', message => { seen.push(Number(message.MsgSeqNum)); });
  return { client, pauses, seen };
}
const upTo = (last: number) => Array.from({ length: last }, (_, n) => n + 1);

test('a read larger than memory.pendingBytes is taken in a slice at a time: messages up to the pause point, the rest held as bytes, and no more until the event loop has turned, though the store keeps at once', { timeout: 10_000 }, async t => {
  const turns = watchedTurns(t);
  const { client, pauses, seen } = takingIn();
  client.receiveBytes(chunkOf(1, 20, 200));
  assert.deepEqual(pauses, ['pause']);
  await settled();
  // Six are 1,200 bytes, past 1,000. They are processed and kept by now, and nothing waits: still no more is taken.
  assert.deepEqual(seen, upTo(6));
  assert.deepEqual([client.unfinishedBytesForTests, client.heldBytesForTests, turns.asked(), turns.waiting()], [0, 2800, 1, 1]);
  // What the link delivers meanwhile (it was told to pause; it need not have heard yet) waits behind what is held.
  client.receiveBytes(sized(21, 200));
  await settled();
  assert.deepEqual([seen.length, client.heldBytesForTests, turns.asked()], [6, 3000, 1]);
  await turns.turn();
  assert.deepEqual([client.heldBytesForTests, turns.asked(), turns.waiting()], [1800, 2, 1], 'the next six, and a turn asked for before the ones after');
  await settled();
  assert.deepEqual(seen, upTo(12));
  await turns.turn();
  await settled();
  assert.deepEqual([seen.length, client.heldBytesForTests, turns.waiting()], [18, 600, 1]);
  assert.deepEqual(pauses, ['pause'], 'reads stay paused while bytes are held');
  await turns.turn();
  await settled();
  // The last three are 600 bytes: all is taken in, reads resume, and no turn is asked for.
  assert.deepEqual(seen, upTo(21), 'in the order received');
  assert.deepEqual([client.heldBytesForTests, turns.asked(), turns.waiting()], [0, 3, 0]);
  assert.deepEqual(pauses, ['pause', 'resume']);
  await turns.turn();
  assert.deepEqual([client.state, turns.asked()], ['active', 3]);
});

test('reads stay paused from the first slice of a read to its last, though everything taken in is finished between two slices: the link is told to pause once and to resume once, when no bytes are held', { timeout: 10_000 }, async t => {
  const turns = watchedTurns(t);
  const { client, pauses, seen } = takingIn();
  client.receiveBytes(chunkOf(1, 20, 200));
  for (let slice = 1; slice <= 3; slice++) {
    await settled();
    // The store kept at once: nothing taken in is unfinished, and the turn is still to come.
    assert.deepEqual([seen.length, client.unfinishedBytesForTests, turns.waiting()], [6 * slice, 0, 1]);
    assert.deepEqual([pauses, client.readsPausedForTests], [['pause'], true], `after slice ${slice}, with ${client.heldBytesForTests} bytes held`);
    await turns.turn();
  }
  await settled();
  assert.deepEqual([seen.length, client.heldBytesForTests, pauses, client.readsPausedForTests], [20, 0, ['pause', 'resume'], false]);
});

test('a read that the session can finish whole is taken in at once, and no turn of the event loop is asked for', { timeout: 10_000 }, async t => {
  const turns = watchedTurns(t);
  const { client, pauses, seen } = takingIn();
  client.receiveBytes(chunkOf(1, 5, 200));                                    // exactly 1,000 bytes: not past it
  assert.deepEqual([client.heldBytesForTests, turns.asked()], [0, 0]);
  await settled();
  client.receiveBytes(Buffer.concat([chunkOf(6, 4, 200), sized(10, 201)]));   // 1,001: past it with the last byte, and nothing left over
  assert.deepEqual([client.heldBytesForTests, turns.asked()], [0, 0]);
  assert.deepEqual(pauses, ['pause'], 'paused for what is not finished, with nothing held');
  await settled();
  assert.deepEqual(seen, upTo(10));
  assert.deepEqual(pauses, ['pause', 'resume']);
});

test('a message larger than memory.pendingBytes is still taken in when nothing else waits, and the ones behind it one at a time', { timeout: 10_000 }, async t => {
  const turns = watchedTurns(t);
  const { client, pauses, seen } = takingIn();
  client.receiveBytes(chunkOf(1, 3, 3000));
  assert.equal(client.heldBytesForTests, 6000);
  await settled();
  assert.deepEqual(seen, [1], 'one, though it alone is three times the limit');
  await turns.turn();
  await settled();
  assert.deepEqual([seen.length, client.heldBytesForTests], [2, 3000]);
  await turns.turn();
  await settled();
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual([client.heldBytesForTests, turns.waiting()], [0, 0]);
  assert.deepEqual(pauses, ['pause', 'resume']);
});

test('a session whose store has not kept what it took in takes in no more and asks for no turn of the event loop while it waits; once that is below the resume point it takes the next slice at once', { timeout: 10_000 }, async t => {
  const turns = watchedTurns(t);
  const { store, lists, hold, release, releaseAll } = listedStore();
  const { client, pauses, seen } = takingIn({ store });
  hold();
  client.receiveBytes(chunkOf(1, 14, 200));
  assert.deepEqual([client.heldBytesForTests, turns.asked()], [1600, 1]);
  for (let n = 0; n < 5; n++) {
    await turns.turn();
    await settled();
  }
  // The six are processed and their records wait for the store: the turn came, took nothing, and asked for no other.
  assert.deepEqual([seen.length, client.unfinishedBytesForTests, client.heldBytesForTests, turns.asked(), turns.waiting()], [6, 1200, 1600, 1, 0]);
  release();
  await settled();
  assert.deepEqual([client.unfinishedBytesForTests, client.heldBytesForTests], [1000, 1600], 'one kept: 1,000 bytes are not below a quarter of 1,000');
  release();
  await settled();
  // The other five kept: the next six are taken, with no turn of the event loop between.
  assert.deepEqual([seen.length, client.heldBytesForTests, turns.asked(), turns.waiting()], [12, 400, 2, 1]);
  assert.deepEqual(pauses, ['pause']);
  releaseAll();
  await turns.turn();
  await settled();
  assert.deepEqual(seen, upTo(14));
  assert.deepEqual([client.heldBytesForTests, turns.waiting()], [0, 0]);
  assert.deepEqual(pauses, ['pause', 'resume']);
  assert.deepEqual(lists.map(list => list.length).slice(0, 4), [1, 5, 1, 5], 'a slice is what one list and the next carry');
  assert.equal(lists.flat().length, 14);
});

test('the beginning of a message alone holds nothing back: reads are not paused for it, no turn is asked for, and it is taken in when its end arrives', { timeout: 10_000 }, async t => {
  const turns = watchedTurns(t);
  const { client, pauses, seen } = takingIn();
  const first = sized(1, 200);
  client.receiveBytes(first.subarray(0, 120));
  await settled();
  assert.deepEqual([client.heldBytesForTests, turns.asked(), seen.length], [120, 0, 0]);
  assert.deepEqual(pauses, []);
  // Its end, six more (1,400 bytes: past the limit), and the beginning of the ninth.
  client.receiveBytes(Buffer.concat([first.subarray(120), chunkOf(2, 7, 200), sized(9, 200).subarray(0, 80)]));
  assert.deepEqual(pauses, ['pause']);
  await settled();
  assert.deepEqual([seen.length, client.heldBytesForTests, turns.waiting()], [6, 480, 1]);
  await turns.turn();
  await settled();
  // The seventh and eighth are taken; what is left is no whole message, and reads resume for the rest of it.
  assert.deepEqual([seen.length, client.heldBytesForTests, turns.waiting()], [8, 80, 0]);
  assert.deepEqual(pauses, ['pause', 'resume']);
  client.receiveBytes(sized(9, 200).subarray(80));
  await settled();
  assert.deepEqual(seen, upTo(9));
  assert.deepEqual([client.heldBytesForTests, turns.asked()], [0, 1]);
});

test('reads paused with only the beginning of a message held resume once what was taken in is finished, though no turn of the event loop was asked for', { timeout: 10_000 }, async t => {
  const turns = watchedTurns(t);
  const { store, hold, releaseAll } = listedStore();
  const { client, pauses, seen } = takingIn({ store });
  hold();
  client.receiveBytes(chunkOf(1, 6, 200));                 // 1,200 bytes: paused, nothing held
  client.receiveBytes(sized(7, 200).subarray(0, 50));      // arrives after the pause was asked for
  await settled();
  assert.deepEqual([client.heldBytesForTests, turns.asked()], [50, 0]);
  assert.deepEqual(pauses, ['pause']);
  releaseAll();
  await settled();
  assert.deepEqual(pauses, ['pause', 'resume'], 'half a message keeps no read paused');
  assert.deepEqual([seen.length, client.heldBytesForTests, turns.asked()], [6, 50, 0]);
});

for (const [how, close, text] of [
  ['close() is called', (client: FixSession) => { client.close(); }, 'Closed'],
  ['the connection is lost', (client: FixSession) => { client.linkClosed(); }, 'Connection closed'],
] as const) {
  test(`a session that holds bytes when ${how} drops them and gives up the turn it asked for: nothing is taken in or scheduled afterwards, and closed resolves`, { timeout: 10_000 }, async t => {
    const turns = watchedTurns(t);
    const { client, pauses, seen } = takingIn();
    client.receiveBytes(chunkOf(1, 20, 200));
    await settled();
    assert.deepEqual([seen.length, client.heldBytesForTests, turns.waiting()], [6, 2800, 1]);
    close(client);
    assert.deepEqual([client.heldBytesForTests, turns.waiting()], [0, 0]);
    assert.deepEqual(pauses, ['pause', 'resume'], 'what the link still delivers is read, and dropped');
    client.receiveBytes(chunkOf(21, 20, 200));
    for (let n = 0; n < 5; n++) {
      await turns.turn();
      await settled();
    }
    assert.deepEqual([seen.length, client.heldBytesForTests, turns.asked(), turns.waiting()], [6, 0, 1, 0]);
    assert.equal((await client.closed).text, text);
    assert.equal(client.seqNums.expected, 7, 'what was held was not received: the counterparty is asked for it again from here');
  });
}

test('a session that holds bytes behind a store that never keeps anything is closed at storeTimeout, drops them, asks for no turn afterwards, and its closed promise resolves', { timeout: 10_000 }, async t => {
  const turns = watchedTurns(t);
  const clock = fakeClock(T0);
  const { client, seen } = takingIn({ store: stoppedStore(), clock });
  client.receiveBytes(chunkOf(1, 20, 200));
  await turns.turn();
  await settled();
  assert.deepEqual([seen.length, client.heldBytesForTests, turns.waiting()], [6, 2800, 0]);
  await clock.advance('12s');
  assert.deepEqual([client.state, client.heldBytesForTests, turns.asked(), turns.waiting()], ['closed', 0, 1, 0]);
  await clock.advance('30s');
  assert.equal((await client.closed).text, 'Store write took longer than 10 s');
});

test('a link that cannot pause closes the session once the bytes held and the messages not yet processed pass memory.inboxBytes between them, and not at exactly that', { timeout: 10_000 }, async t => {
  const turns = watchedTurns(t);
  const client = closedAfterwards(lone({ manual: true, memory: { pendingBytes: 1000, inboxBytes: 4000 } }));
  client.incoming(() => new Promise(() => {}));   // never resolves: nothing taken in is ever processed
  for (let seq = 1; seq <= 20; seq++) client.receiveBytes(sized(seq, 200));
  await turns.turn();
  await settled();
  assert.deepEqual([client.state, client.heldBytesForTests, client.unfinishedBytesForTests], ['active', 2800, 1200], '4,000 bytes are not past 4,000');
  client.receiveBytes(Uint8Array.of(0x38));
  assert.equal(client.state, 'closed');
  assert.equal((await client.closed).text, 'Too many unprocessed incoming messages');
  assert.deepEqual(errorTexts(client), ['Too many unprocessed incoming messages']);
  assert.deepEqual([client.heldBytesForTests, turns.waiting()], [0, 0]);
});

test('received messages past half of memory.inbox that are not yet processed wait as bytes, and are processed in their order: the count alone closes no session', { timeout: 10_000 }, async () => {
  const { client, pauses, through } = heldAtRoute({ inbox: 4, pendingBytes: 1_000_000 });
  closedAfterwards(client);
  for (let seq = 1; seq <= 12; seq++) client.receiveBytes(sized(seq, 200));
  await ticks();
  assert.deepEqual([client.state, client.heldBytesForTests], ['active', 1800], 'three wait at the route (more than half of four), nine as bytes');
  assert.deepEqual(pauses, ['pause']);
  await through(12);
  await ticks();
  assert.deepEqual([client.state, client.seqNums.expected, client.heldBytesForTests], ['active', 13, 0]);
  assert.equal(pauses.at(-1), 'resume');
});

// ─── Liveness while a session is behind: the engine's own timers, on the clock ──

/**
 * A logged-on CLIENT (HeartBtInt 30, memory.pendingBytes 1,000) on a link that notes its pauses and
 * the MsgType of each message written, with a store that keeps each list `delay.ms` later on the clock.
 */
async function liveClient(clock: FakeClock = fakeClock(T0)) {
  const delay = { ms: 0 };
  const base = memoryStore();
  const store: Store = {
    ...base,
    async append(id, records, context) {
      if (delay.ms > 0) await new Promise<void>(resolve => { clock.setTimeout(resolve, delay.ms); });
      return base.append(id, records, context);
    },
  };
  const dict = dictionaryFor('FIX.4.4');
  const written: string[] = [];
  const pauses: string[] = [];
  const link: Link = {
    write: async bytes => { written.push(String(inspectMessage(parseFrame(bytes).fields, dict).message.MsgType)); },
    end: () => {}, pause: () => { pauses.push('pause'); }, resume: () => { pauses.push('resume'); },
  };
  const client = closedAfterwards(lone({ link, store, clock, storeTimeoutMs: 600_000, memory: { pendingBytes: 1000 } }));
  client.start();
  client.receiveBytes(fromExchange('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30 }));
  await client.active;
  await ticks();
  written.length = 0;
  return { client, clock, delay, written, pauses };
}

for (const [what, count, behindFor] of [
  ['holds bytes it has not taken in, its counterparty\'s Heartbeats among them,', 12, 80],
  ['has stopped reading for what it has not finished, with nothing held,', 6, 40],
] as const) {
  test(`a session that ${what} for longer than the heartbeat interval sends no TestRequest and is not closed, while its own Heartbeats go on; a counterparty silent once it has caught up is asked and given up as ever`, { timeout: 10_000 }, async () => {
    const { client, clock, delay, written, pauses } = await liveClient();
    // The store keeps a list every 20 s: the first record of a slice, then the other five.
    delay.ms = 20_000;
    client.receiveBytes(chunkOf(2, count, 200));
    await ticks();
    assert.deepEqual([pauses, client.heldBytesForTests], [['pause'], (count - 6) * 200]);
    await clock.advance(`${behindFor - 1}s`);
    assert.deepEqual(pauses, ['pause'], `behind for ${behindFor - 1} s`);
    await clock.advance('3s');
    assert.deepEqual([pauses, client.heldBytesForTests, client.seqNums.expected], [['pause', 'resume'], 0, count + 2]);
    // The store keeps at once from here. What was sent while the session was behind is kept and written 20 s on.
    delay.ms = 0;
    await clock.advance('20s');
    assert.equal(client.state, 'active');
    assert.equal(written.includes('TestRequest'), false, `written while ${behindFor} s behind: ${written.join(' ')}`);
    assert.ok(written.includes('Heartbeat'), `its own Heartbeats: ${written.join(' ')}`);
    // Nothing more comes. Silence is counted from when it listened again: 36 s to the TestRequest, 30 s more to the end.
    await clock.advance('12s');
    assert.equal(written.includes('TestRequest'), false, '34 s of silence');
    await clock.advance('4s');
    assert.equal(written.filter(type => type === 'TestRequest').length, 1, `38 s of silence: ${written.join(' ')}`);
    await clock.advance('26s');
    assert.equal(client.state, 'active', '64 s');
    await clock.advance('4s');
    const reason = await client.closed;
    assert.deepEqual([reason.by, reason.text, reason.problem?.code], ['us', 'Heartbeat timeout', 'HeartbeatTimeout']);
  });
}

test('a TestRequest still unanswered when the session falls behind is not held against the counterparty, whose answer is among what the session has not processed: not at the tick its 30 s end, and not later', { timeout: 10_000 }, async () => {
  const { client, clock, written, pauses } = await liveClient();
  await clock.advance('37s');
  assert.deepEqual(written, ['Heartbeat', 'TestRequest']);
  await clock.advance('28500ms');
  // Half a second before the TestRequest of 36 s is 30 s old, its answer arrives with seven more, and an incoming route holds them all for 45 s.
  const gate = new Promise<void>(resolve => { clock.setTimeout(resolve, 45_000); });
  const remove = client.incoming(async message => { await gate; return message; });
  client.receiveBytes(Buffer.concat([fromExchange('Heartbeat', 2, { TestReqID: 'TEST-1' }), chunkOf(3, 7, 200)]));
  await ticks();
  assert.deepEqual(pauses, ['pause']);
  assert.equal(client.seqNums.expected, 2, 'none is processed');
  await clock.advance('1s');
  assert.equal(client.state, 'active', 'at the tick 30 s after the TestRequest');
  await clock.advance('40s');
  assert.equal(client.state, 'active', '71 s after the TestRequest, with the heartbeat interval 30 s');
  assert.deepEqual(written.filter(type => type === 'TestRequest').length, 1);
  await clock.advance('5s');
  remove();
  await ticks();
  assert.deepEqual([client.state, client.seqNums.expected, client.heldBytesForTests], ['active', 10, 0]);
  assert.equal(pauses.at(-1), 'resume');
});

test('a counterparty silent for 35 s whose messages then arrive and wait at an incoming route is not sent a TestRequest at 36 s: it is heard before its silence is judged', { timeout: 10_000 }, async () => {
  const { client, clock, written } = await liveClient();
  await clock.advance('35500ms');
  assert.deepEqual(written, ['Heartbeat']);
  const gate = new Promise<void>(resolve => { clock.setTimeout(resolve, 20_000); });
  client.incoming(async message => { await gate; return message; });
  client.receiveBytes(chunkOf(2, 8, 200));
  await ticks();
  await clock.advance('10s');
  assert.deepEqual([client.state, client.seqNums.expected], ['active', 2]);
  assert.equal(written.includes('TestRequest'), false, written.join(' '));
});

/**
 * From here to the end of the test, a turn of the event loop asked for with setImmediate does not
 * come until release() is called: what a session does between asking for its turn and getting it
 * can be looked at for as long as the test likes.
 */
function turnsHeldBack(t: TestContext) {
  const waiting = new Map<object, () => void>();
  t.mock.method(globalThis, 'setImmediate', ((fn: () => void) => {
    const handle = {};
    waiting.set(handle, fn);
    return handle;
  }) as unknown as typeof setImmediate);
  t.mock.method(globalThis, 'clearImmediate', ((handle: object | undefined) => { if (handle) waiting.delete(handle); }) as unknown as typeof clearImmediate);
  return { waiting: () => waiting.size, release: () => { for (const [handle, fn] of [...waiting]) { waiting.delete(handle); fn(); } } };
}

test('bytes held are proof of life by themselves: a session that has finished all it took in and waits for its turn of the event loop, with messages still held as bytes, sends no TestRequest however long the turn takes', { timeout: 10_000 }, async t => {
  const { client, clock, written, pauses } = await liveClient();
  const turns = turnsHeldBack(t);
  client.receiveBytes(chunkOf(2, 12, 200));
  await clock.advance('1s');
  // The store keeps at once: the first six are processed and kept, nothing waits, and six are held until the turn comes.
  assert.deepEqual([client.seqNums.expected, client.unfinishedBytesForTests, client.heldBytesForTests, turns.waiting()], [8, 0, 1200, 1]);
  assert.deepEqual(pauses, ['pause']);
  await clock.advance('70s');
  assert.equal(client.state, 'active');
  assert.equal(written.includes('TestRequest'), false, written.join(' '));
  assert.ok(written.filter(type => type === 'Heartbeat').length >= 2, written.join(' '));
  turns.release();
  await clock.advance('1s');
  assert.deepEqual([client.seqNums.expected, client.heldBytesForTests, turns.waiting()], [14, 0, 0]);
  assert.equal(pauses.at(-1), 'resume');
});

test('bytes held while a slow store keeps list after list do not count as no progress: every slice that finishes is progress, for far longer than processingTimeout', { timeout: 10_000 }, async t => {
  const turns = watchedTurns(t);
  const clock = fakeClock(T0);
  const base = memoryStore();
  const slow: Store = { ...base, async append(id, records, context) { await new Promise<void>(resolve => { clock.setTimeout(resolve, 4_000); }); return base.append(id, records, context); } };
  const { client, pauses } = takingIn({ store: slow, clock, processingTimeoutMs: 5_000 });
  client.receiveBytes(chunkOf(1, 30, 200));
  // Five slices of six, each kept by two lists 4 s apart: 40 s.
  await clock.advance('39s');
  assert.deepEqual([client.state, pauses], ['active', ['pause']]);
  await clock.advance('2s');
  assert.deepEqual([client.state, client.seqNums.expected, client.heldBytesForTests, pauses, turns.waiting()], ['active', 31, 0, ['pause', 'resume'], 0]);
});

test('bytes held behind an incoming route that lets a message through every 3 s do not count as no progress: each message that finishes is progress, slice after slice', { timeout: 10_000 }, async t => {
  const turns = watchedTurns(t);
  const clock = fakeClock(T0);
  const { client, seen, pauses } = takingIn({ clock, processingTimeoutMs: 5_000 });
  client.incoming(message => new Promise(resolve => { clock.setTimeout(() => { resolve(message); }, 3_000); }));
  client.receiveBytes(chunkOf(1, 12, 200));
  // One message every 3 s for 36 s, more taken in whenever all but one are through: something is always
  // waiting to be processed, and the store, which keeps at once, has nothing to do with it.
  await clock.advance('29s');
  assert.deepEqual([client.state, seen.length, pauses], ['active', 9, ['pause']]);
  await clock.advance('8s');
  assert.deepEqual([client.state, seen, client.heldBytesForTests, pauses, turns.waiting()], ['active', upTo(12), 0, ['pause', 'resume'], 0]);
});

test('bytes held behind messages that an incoming route never lets through close the session at processingTimeout, and are dropped', { timeout: 10_000 }, async t => {
  const turns = watchedTurns(t);
  const clock = fakeClock(T0);
  const { client } = takingIn({ clock, processingTimeoutMs: 5_000 });
  client.incoming(() => new Promise(() => {}));
  client.receiveBytes(chunkOf(1, 20, 200));
  await clock.advance('4s');
  assert.deepEqual([client.state, client.heldBytesForTests], ['active', 2800]);
  await clock.advance('3s');
  assert.deepEqual([client.state, client.heldBytesForTests, turns.waiting()], ['closed', 0, 0]);
  await clock.advance('10s');
  assert.equal((await client.closed).text, 'No progress on received messages for 5 s');
});

test('a session that waits only for its turn of the event loop, everything it took in finished, is not closed for no progress on received messages however long the turn takes, and takes in the rest when it comes', { timeout: 10_000 }, async t => {
  const clock = fakeClock(T0);
  const { client, seen } = takingIn({ clock, processingTimeoutMs: 5_000 });
  const turns = turnsHeldBack(t);
  client.receiveBytes(chunkOf(1, 12, 200));
  await clock.advance('1s');
  assert.deepEqual([seen.length, client.unfinishedBytesForTests, client.heldBytesForTests, turns.waiting()], [6, 0, 1200, 1]);
  await clock.advance('20s');
  assert.deepEqual([client.state, client.heldBytesForTests, errorTexts(client)], ['active', 1200, []]);
  turns.release();
  await clock.advance('1s');
  assert.deepEqual([seen, client.heldBytesForTests, client.state], [upTo(12), 0, 'active']);
});

/** A frame of `bytes` bytes from EXCHANGE whose CheckSum is wrong. */
function garbled(bytes: number): Uint8Array {
  const frame = Buffer.from(sized(1, bytes));
  frame[frame.length - 2] = frame[frame.length - 2] === 0x30 ? 0x31 : 0x30;
  return frame;
}

/** A clock whose timers run within step(), with no turn of the event loop between: what falls due is run at once, in order. */
function steppedClock(start: Date) {
  let now = start.getTime();
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => new Date(now),
    setTimeout(fn: () => void, ms: number): unknown { timers.set(nextId, { at: now + Math.max(0, ms), fn }); return nextId++; },
    clearTimeout(handle: unknown): void { timers.delete(handle as number); },
    advance: async () => { throw new Error('use step()'); },
    step(ms: number): void {
      const target = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
      }
      now = target;
    },
  };
}

test('bytes held are proof of life with no help from the count: at the tick that falls between a slice of garbled frames, all finished, and the turn of the event loop that takes in the Heartbeat held behind them, a counterparty 36 s silent is sent no TestRequest', { timeout: 10_000 }, async () => {
  const clock = steppedClock(T0);
  const { client, written, pauses } = await liveClient(clock);
  for (let second = 1; second <= 35; second++) {
    clock.step(1000);
    await ticks();
  }
  assert.deepEqual(written, ['Heartbeat'], 'its own, at 30 s');
  // Garbled frames are not life. Six of them are 1,200 bytes, past the pause point; the Heartbeat waits behind them as bytes.
  client.receiveBytes(Buffer.concat([...Array.from({ length: 6 }, () => garbled(200)), sized(2, 200)]));
  await settled();
  assert.deepEqual([client.unfinishedBytesForTests, client.heldBytesForTests, client.readsPausedForTests, client.seqNums.expected], [0, 200, true, 2]);
  clock.step(1000);
  clock.step(1000);
  await ticks();
  assert.deepEqual([client.seqNums.expected, client.heldBytesForTests, pauses], [3, 0, ['pause', 'resume']]);
  assert.equal(written.includes('TestRequest'), false, written.join(' '));
  // Had the bytes not been held, the same frames would not have spared it: garbled frames alone are silence.
  // (The Heartbeat was taken in at 37 s: 36 s of silence end at 73 s.)
  for (let second = 38; second <= 75; second++) {
    client.receiveBytes(garbled(200));
    clock.step(1000);
    await ticks();
  }
  assert.equal(written.filter(type => type === 'TestRequest').length, 1, written.join(' '));
});

test('a counterparty that sends nothing but garbled frames, to a session that keeps up, is asked at 36 s and given up at 66 s like one that sends nothing, and nothing of its flood is held', { timeout: 20_000 }, async () => {
  const { client, clock, written, pauses } = await liveClient();
  let most = 0;
  for (let second = 1; second <= 70 && client.state !== 'closed'; second++) {
    client.receiveBytes(Buffer.concat(Array.from({ length: 20 }, () => garbled(200))));   // 4,000 bytes: four times the pause point
    await ticks(10);                                                                      // four slices, each finished before the tick
    await clock.advance('1s');
    most = Math.max(most, client.heldBytesForTests + client.unfinishedBytesForTests);
    if (second === 35) assert.equal(written.includes('TestRequest'), false, written.join(' '));
    if (second === 37) assert.equal(written.filter(type => type === 'TestRequest').length, 1, written.join(' '));
    if (second === 65) assert.equal(client.state, 'active');
  }
  const reason = await client.closed;
  assert.deepEqual([reason.by, reason.text], ['us', 'Heartbeat timeout']);
  assert.equal(most, 0, 'each second\'s flood was finished before the next');
  assert.equal(pauses.at(-1), 'resume');
});

test('a counterparty that floods garbled frames faster than a slow store keeps their records is kept only while the session is behind with them, as one that floods Heartbeats would be; what the session holds stays bounded, and once it has caught up the silence is judged as ever', { timeout: 20_000 }, async () => {
  const { client, clock, delay, written, pauses } = await liveClient();
  delay.ms = 20_000;
  let most = 0;
  // It honours the pause, as a socket does: 1,200 bytes whenever it is read, for 100 s.
  for (let second = 1; second <= 100; second++) {
    if (pauses.at(-1) !== 'pause') client.receiveBytes(Buffer.concat(Array.from({ length: 6 }, () => garbled(200))));
    await clock.advance('1s');
    most = Math.max(most, client.heldBytesForTests + client.unfinishedBytesForTests);
  }
  assert.equal(client.state, 'active');
  assert.equal(written.includes('TestRequest'), false, written.join(' '));
  // Six frames are taken in before reads pause, and each one's record counts as 256 bytes until it is kept.
  assert.ok(most <= 6 * 256, `at most ${most} bytes held or unfinished`);
  // The flood ends. The last records are kept within 40 s; then 36 s to the TestRequest and 30 s more to the end.
  delay.ms = 0;
  await clock.advance('41s');
  assert.deepEqual([client.state, client.unfinishedBytesForTests, pauses.at(-1)], ['active', 0, 'resume']);
  await clock.advance('70s');
  assert.equal(written.filter(type => type === 'TestRequest').length, 1, written.join(' '));
  assert.equal((await client.closed).text, 'Heartbeat timeout');
});

// --- What a session behind does about SendingTime and about a resend it awaits ---

/** `count` Heartbeats from EXCHANGE numbered from `from`, about 200 bytes each, stamped `at`; resent ones when `possDup`. */
const stamped = (from: number, count: number, at: Date, possDup = false) => Buffer.concat(Array.from({ length: count }, (_, n) =>
  fromExchange('Heartbeat', from + n, { SendingTime: at, TestReqID: 'x'.repeat(120), ...(possDup ? { PossDupFlag: true, OrigSendingTime: at } : {}) })));

test('a session behind for longer than maxClockSkew does not log its counterparty out for a stale SendingTime: each message is judged against the time its bytes arrived, whichever chunk brought it, and one that was stale when it arrived is still refused', { timeout: 20_000 }, async () => {
  const { client, clock, delay, written } = await liveClient();
  // The store keeps a list every 20 s, a slice of five messages every 40 s: 42 messages take 360 s.
  delay.ms = 20_000;
  client.receiveBytes(stamped(2, 30, clock.now()));
  await clock.advance('130s');
  assert.deepEqual([client.state, client.heldBytesForTests > 0], ['active', true]);
  // 130 s on, with the first chunk still held in part, twelve more arrive, stamped with their own time.
  client.receiveBytes(stamped(32, 12, clock.now()));
  assert.equal(client.heldBuffersForTests.arrivals, 2);
  await clock.advance('235s');
  assert.deepEqual([client.state, client.seqNums.expected, client.heldBytesForTests], ['active', 44, 0]);
  assert.deepEqual(client.history.flatMap(entry => (entry.kind === 'problem' ? [entry.problem.text] : [])), []);
  assert.equal(written.includes('Logout'), false, written.join(' '));
  assert.ok(client.heldBuffersForTests.arrivals <= 1);
  // A message 121 s old when it arrives is the counterparty's clock, however fast it is processed.
  delay.ms = 0;
  client.receiveBytes(stamped(44, 1, new Date(clock.now().getTime() - 121_000)));
  await ticks();
  assert.equal(client.state, 'closed');
  await clock.advance('25s');
  const reason = await client.closed;
  assert.deepEqual([reason.by, reason.text, reason.problem?.code], ['us', 'SendingTime is 121 s from our clock', 'SendingTimeAccuracy']);
});

test('bytes that arrive within one second of the clock share one time of arrival, that of the last of them: a message is never judged against a time before its own bytes came', { timeout: 20_000 }, async () => {
  const { client, clock, delay, written } = await liveClient();
  delay.ms = 20_000;
  await clock.advance('100ms');
  client.receiveBytes(stamped(2, 12, clock.now()));
  await clock.advance('800ms');
  // Stamped exactly maxClockSkew ahead of the moment it arrives: in, by that moment; out, by the one 800 ms before.
  client.receiveBytes(stamped(14, 1, new Date(clock.now().getTime() + 120_000)));
  assert.equal(client.heldBuffersForTests.arrivals, 1);
  // Thirteen messages, five to a slice of 40 s: taken in within 120 s.
  await clock.advance('125s');
  assert.deepEqual([client.state, client.seqNums.expected, client.heldBytesForTests], ['active', 15, 0]);
  assert.equal(written.includes('Logout'), false, written.join(' '));
});

test('a session that holds the answer to its ResendRequest as bytes, behind a slow store, does not ask for it again and does not give the counterparty up: it asks once, and takes the whole resend in', { timeout: 20_000 }, async () => {
  const { client, clock, delay, written } = await liveClient();
  client.receiveBytes(stamped(60, 1, clock.now()));
  await ticks();
  assert.deepEqual(written, ['ResendRequest']);
  // The counterparty answers at once with 2 to 60. The store keeps a list every 20 s, five messages every 40 s: the 59 take 480 s.
  delay.ms = 20_000;
  client.receiveBytes(stamped(2, 59, clock.now(), true));
  await clock.advance('95s');
  assert.equal(client.state, 'active', '95 s on: asked once, with the answer in hand');
  await clock.advance('390s');
  assert.deepEqual([client.state, client.seqNums.expected, client.heldBytesForTests], ['active', 61, 0]);
  assert.equal(written.filter(type => type === 'ResendRequest').length, 1, written.join(' '));
  assert.equal(written.includes('Logout'), false, written.join(' '));
});

test('a counterparty that never answers a ResendRequest is still given up, counted from when the session caught up: asked again 30 s and 60 s after, and logged out at 90 s', { timeout: 20_000 }, async () => {
  const { client, clock, delay, written, pauses } = await liveClient();
  client.receiveBytes(stamped(60, 1, clock.now()));
  await ticks();
  // It sends on, numbered past the gap, and never what was asked for; the session is two minutes behind with what it sends.
  delay.ms = 20_000;
  client.receiveBytes(stamped(61, 20, clock.now()));
  await clock.advance('95s');
  assert.deepEqual([client.state, written.filter(type => type === 'ResendRequest').length, pauses], ['active', 1, ['pause']]);
  for (let second = 0; second < 90 && pauses.at(-1) === 'pause'; second++) await clock.advance('1s');
  assert.deepEqual([pauses.at(-1), client.heldBytesForTests], ['resume', 0]);
  delay.ms = 0;
  const caughtUp = clock.now().getTime();
  assert.ok(caughtUp - T0.getTime() >= 100_000, 'behind for longer than the three requests would have taken');
  const requests: number[] = [];
  let seq = 81;
  while (client.state !== 'closed' && clock.now().getTime() - caughtUp < 120_000) {
    // Alive all the while: a Heartbeat every 10 s, dropped for the gap before it.
    if ((clock.now().getTime() - caughtUp) % 10_000 === 0) client.receiveBytes(stamped(seq++, 1, clock.now()));
    await clock.advance('1s');
    const asked = written.filter(type => type === 'ResendRequest').length;
    while (requests.length < asked - 1) requests.push(Math.round((clock.now().getTime() - caughtUp) / 1000));
  }
  const reason = await client.closed;
  assert.deepEqual([reason.by, reason.text], ['us', 'Resend from 2 still incomplete after 3 requests']);
  const closedAfter = Math.round((clock.now().getTime() - caughtUp) / 1000);
  assert.ok(requests.length === 2 && Math.abs(requests[0]! - 30) <= 2 && Math.abs(requests[1]! - 60) <= 2 && Math.abs(closedAfter - 90) <= 2, `asked again ${requests.join(' and ')} s after it caught up, closed at ${closedAfter} s`);
});

test('bytes that a link goes on delivering one at a time after it was told to pause are held in a few buffers with room for little more than the bytes, and one time of arrival is kept for each second in which some arrived', { timeout: 20_000 }, async () => {
  const clock = fakeClock(T0);
  const client = closedAfterwards(lone({ manual: true, clock, memory: { pendingBytes: 1000 } }));
  client.incoming(() => new Promise(() => {}));   // nothing taken in is ever processed
  const all = chunkOf(1, 1500, 200);
  for (let n = 0; n < all.length; n++) {
    client.receiveBytes(all.subarray(n, n + 1));
    if (n % 50_000 === 49_999) await clock.advance('1s');
  }
  const { count, capacity, arrivals } = client.heldBuffersForTests;
  assert.deepEqual([client.state, client.heldBytesForTests], ['active', 300_000 - 1200]);
  assert.ok(count <= 24, `${count} buffers`);
  assert.ok(capacity <= client.heldBytesForTests + 65_536, `room for ${capacity} bytes`);
  assert.ok(arrivals >= 5 && arrivals <= 7, `${arrivals} times of arrival`);
  client.close();
  assert.deepEqual(client.heldBuffersForTests, { count: 0, capacity: 0, arrivals: 0 });
});

// --- The times of arrival a session keeps for the bytes it holds ---

/** A clock whose time is moved by `pass` without its timers running: nothing of the session's own falls due meanwhile. */
function passingClock(start: Date): FakeClock & { pass(ms: number): void } {
  const base = fakeClock(start);
  let passed = 0;
  return { ...base, now: () => new Date(base.now().getTime() + passed), pass(ms) { passed += ms; } };
}

const problemTexts = (session: FixSession) => session.history.flatMap(entry => (entry.kind === 'problem' ? [entry.problem.text] : []));

test('a message that trickles in a byte a second leaves the session with no more than 128 times of arrival however long it takes, and the call that completes it drops them all at once: the same work after 300 s as after 6,000 s, and the message is judged by its last byte', { timeout: 20_000 }, async () => {
  const work: string[] = [];
  for (const seconds of [300, 6000]) {
    const clock = passingClock(T0);
    const { client } = await liveClient(clock);
    // Stamped as its last byte is sent: `seconds` ahead of the clock when its first byte arrives.
    const message = Buffer.from(fromExchange('Heartbeat', 2, { SendingTime: new Date(T0.getTime() + seconds * 1000), TestReqID: 'x'.repeat(seconds) }));
    const before = message.length - seconds;
    client.receiveBytes(message.subarray(0, before));
    let most = 0;
    for (let n = before; n < message.length - 1; n++) {
      clock.pass(1000);
      client.receiveBytes(message.subarray(n, n + 1));
      most = Math.max(most, client.heldBuffersForTests.arrivals);
    }
    assert.ok(most <= 128, `${most} times of arrival kept for ${seconds} s`);
    assert.equal(most, Math.min(seconds, 128), 'one a second until there are 128');
    clock.pass(1000);
    const { shifts, splices } = countingDrops(() => client.receiveBytes(message.subarray(message.length - 1)));
    assert.equal(shifts, 0, `${shifts} times of arrival dropped one by one after ${seconds} s`);
    work.push(`${splices} at once`);
    assert.equal(client.heldBuffersForTests.arrivals, 0);
    await ticks();
    assert.deepEqual([client.state, client.seqNums.expected, problemTexts(client)], ['active', 3, []]);
  }
  assert.equal(work[0], work[1]);
});

test('a message whose bytes arrived 130 s apart is judged by the time its last byte arrived, not its first, nor the time it is processed', { timeout: 20_000 }, async () => {
  const { client, clock, delay, written } = await liveClient();
  delay.ms = 20_000;
  const t0 = clock.now().getTime();
  // Stamped t0 + 125 s: within maxClockSkew of when its last byte arrives (t0 + 130 s), outside it by its first (t0) and by when it is processed (after t0 + 250 s).
  const split = stamped(32, 1, new Date(t0 + 125_000));
  client.receiveBytes(Buffer.concat([stamped(2, 30, clock.now()), split.subarray(0, 90)]));
  await clock.advance('130s');
  client.receiveBytes(split.subarray(90));
  assert.equal(client.heldBuffersForTests.arrivals, 2);
  for (let second = 0; second < 300 && client.state === 'active' && client.seqNums.expected < 33; second++) await clock.advance('1s');
  assert.deepEqual([client.state, client.seqNums.expected, client.heldBytesForTests, problemTexts(client)], ['active', 33, 0, []]);
  assert.equal(written.includes('Logout'), false, written.join(' '));
  assert.equal(client.heldBuffersForTests.arrivals, 0);
});

test('a session that holds bytes from more than 128 seconds keeps 128 times of arrival for them, and judges each message no earlier than its own bytes arrived and at most a sixtieth of the time they span later', { timeout: 30_000 }, async () => {
  const { client, clock, delay, written } = await liveClient();
  delay.ms = 500_000;   // the store keeps nothing while they arrive: one slice is taken in, the rest held
  let seq = 2;
  let most = 0;
  // Every 2 s for 400 s, two messages: one that would be stale judged more than 10 s after it arrived, one that would be ahead of the clock judged 2 s before.
  for (let n = 0; n < 200; n++) {
    const at = clock.now().getTime();
    client.receiveBytes(Buffer.concat([stamped(seq++, 1, new Date(at - 110_000)), stamped(seq++, 1, new Date(at + 119_000))]));
    most = Math.max(most, client.heldBuffersForTests.arrivals);
    await clock.advance('2s');
  }
  assert.equal(most, 128);
  assert.equal(client.state, 'active');
  delay.ms = 0;
  // The list it waited for is kept 500 s after it was given, and the rest at once.
  for (let second = 0; second < 200 && client.state === 'active' && client.seqNums.expected < 402; second++) await clock.advance('1s');
  assert.deepEqual([client.state, client.seqNums.expected, client.heldBytesForTests, problemTexts(client)], ['active', 402, 0, []]);
  assert.equal(written.includes('Logout'), false, written.join(' '));
  assert.equal(client.heldBuffersForTests.arrivals, 0);
});
