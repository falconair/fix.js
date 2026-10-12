// What a Store must do, as tests any store can be put through: storeContract(name, make, options)
// defines them with node:test. It is exported from fix.js/test, and the library's own stores run
// it from there (store.test.ts). Nothing here runs or defines a test until storeContract is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictionaryFor } from '../dictionary/index.ts';
import { buildFrame, parseFrame } from '../wire/frame.ts';
import { fromMessage, inspectMessage } from '../wire/message.ts';
import { checkFunction, checkKnownKeys, checkStore, describe, isPlainObject, plainObject } from './options.ts';
import type { Entry, SessionId, Store, StoreRecord } from './types.ts';

const id: SessionId = { version: 'FIX.4.4', sender: 'EXCHANGE', target: 'CLIENT' };
/** A session with another counterparty. */
const other: SessionId = { ...id, target: 'NOBODY' };
/** A session that differs from `id` in its version alone. */
const older: SessionId = { ...id, version: 'FIX.4.2' };
/** Every session the suite uses: a store must keep nothing for any of them when a test begins. */
const SESSIONS: readonly SessionId[] = [id, other, older];
const at = new Date('2026-09-30T12:00:00.000Z');

type MessageEntry = Extract<Entry, { kind: 'message' }>;

/** A message of a session (between EXCHANGE and CLIENT unless `session` says otherwise), as an entry with its wire bytes: decoded from its frame, as a session's entries are. */
function entryOf(direction: 'in' | 'out', msgType: string, fields: Record<string, unknown>, session: SessionId = id): MessageEntry {
  const dict = dictionaryFor(session.version);
  const [sender, target] = direction === 'out' ? [session.sender, session.target] : [session.target, session.sender];
  const encoded = fromMessage(msgType, { SenderCompID: sender, TargetCompID: target, SendingTime: at, ...fields }, dict, { version: session.version });
  const bytes = buildFrame(encoded.fields, encoded.framing);
  return { kind: 'message', direction, at, message: inspectMessage(parseFrame(bytes).fields, dict).message, bytes };
}

/** A TestRequest numbered `seq` whose TestReqID is `label`; `fields` may write PossDupFlag and the rest. */
const message = (direction: 'in' | 'out', seq: number, label: string, fields: Record<string, unknown> = {}): MessageEntry =>
  entryOf(direction, 'TestRequest', { MsgSeqNum: seq, TestReqID: label, ...fields });

/** A message the session sent for the first time, numbered `seq`. */
const original = (seq: number, label = `t${seq}`, session: SessionId = id): MessageEntry =>
  entryOf('out', 'TestRequest', { MsgSeqNum: seq, TestReqID: label }, session);

/** How a test names a message entry: 'MsgSeqNum:TestReqID' (its MsgType where it has no TestReqID). */
const named = (entry: MessageEntry): string => `${String(entry.message.MsgSeqNum)}:${String(entry.message.TestReqID ?? entry.message.MsgType)}`;

/** How long a test has, and how long its cleanup has after it, in ms. */
const LIMIT = 10_000;

/**
 * `value` with each plain object in it, at any depth, as one whose prototype is Object.prototype:
 * a plain object has that prototype or none, and the two kinds are the same to the contract.
 */
const ordinary = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(ordinary)
  : isPlainObject(value) ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, ordinary(inner)]))
  : value;

/**
 * Fails unless `given` is `kept` as it was appended: a plain object with the same kind, direction
 * and time and no property more, the same message (a plain object, every field with the value and
 * the type it had: a number a number, a Date a Date, a boolean a boolean, a group an array of the
 * same), and the same wire bytes, or none where it had none. A copy sent again is encoded from the
 * message a store gives, so nothing less will do.
 */
function assertAsAppended(given: Entry, kept: MessageEntry): void {
  assert.equal(given.kind, 'message');
  if (given.kind !== 'message') return;
  assert.ok(isPlainObject(given), `the entry given for ${named(kept)} is not a plain object`);
  const { bytes, ...rest } = given;
  const { bytes: keptBytes, ...keptRest } = kept;
  assert.deepEqual(ordinary(rest), ordinary(keptRest), `the entry given for ${named(kept)} is not the one appended`);
  assert.ok(given.at instanceof Date, `the entry given for ${named(kept)} has a time that is not a Date`);
  assert.equal('bytes' in given && bytes !== undefined, keptBytes !== undefined, `the entry given for ${named(kept)} ${keptBytes ? 'has lost its' : 'has gained'} wire bytes`);
  if (bytes !== undefined && keptBytes !== undefined) {
    assert.ok(bytes instanceof Uint8Array, `the wire bytes given for ${named(kept)} are not a Uint8Array`);
    assert.deepEqual([...bytes], [...keptBytes], `the wire bytes given for ${named(kept)} are not those appended`);
  }
}

/** What one test uses to give its store entries and to ask for them back; it remembers what the test appended, and no other test's. */
interface Appended {
  /** A record of an entry, and the sequence numbers after it. */
  record(entry: Entry, next: number, extra?: Partial<StoreRecord>): StoreRecord;
  /** What sent() gives for a range, each as 'MsgSeqNum:TestReqID', in the order given; each must be, whole, the entry appended under that name. */
  sent(store: Store, from: number, to: number, session?: SessionId): Promise<string[]>;
  /** What read() gives, named and checked as sent() is: every epoch, or the one asked for. */
  read(store: Store, epoch?: number, session?: SessionId): Promise<string[]>;
  /** What load() gives: its history, named and checked the same way, and its sequence numbers. */
  load(store: Store, session?: SessionId): Promise<{ history: string[]; next: number; expected: number }>;
}

function appending(): Appended {
  /** Every message entry the test has given its store, by its name: what sent() must give back, whole. */
  const appended = new Map<string, MessageEntry>();
  /** The name of an entry `method` gave, which must be, whole, the entry appended under that name; its kind when it is no message. */
  const checked = (entry: Entry, method: string): string => {
    if (entry.kind !== 'message') return entry.kind;
    const name = named(entry);
    const kept = appended.get(name);
    assert.ok(kept, `${method} gave ${name}, which was never appended`);
    assertAsAppended(entry, kept);
    return name;
  };
  return {
    record(entry, next, extra = {}) {
      if (entry.kind === 'message') appended.set(named(entry), entry);
      return { at: entry.at, entry, seqNums: { next, expected: 1 }, ...extra };
    },
    async sent(store, from, to, session = id) {
      const out: string[] = [];
      for await (const entry of store.sent(session, { from, to })) out.push(checked(entry, 'sent()'));
      return out;
    },
    async read(store, epoch, session = id) {
      const out: string[] = [];
      for await (const entry of store.read(session, epoch === undefined ? {} : { epoch })) out.push(checked(entry, 'read()'));
      return out;
    },
    async load(store, session = id) {
      const { history, next, expected } = await store.load(session);
      return { history: history.map(entry => checked(entry, 'load()')), next, expected };
    },
  };
}

/** Calls `cleanup` with what `make` gave, and fails when it has not settled after LIMIT ms: a test waits for its cleanup no longer. */
async function cleanUp<S>(cleanup: (store: S) => unknown, store: S): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(`storeContract() cleanup had not finished after ${LIMIT / 1000} s`)); }, LIMIT);
  });
  try {
    await Promise.race([Promise.resolve(store).then(cleanup), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Defines the tests of a Store's contract, with node:test: call it at the top level of a test file
 * and run the file with `node --test`. It defines them when it is called and not before, and every
 * test's name begins with `name`. The tests use node:test and node:assert and nothing of a store
 * beyond the Store interface. They cover append(), which is given records in lists, and sent(),
 * which answers a ResendRequest.
 *
 * Each test calls `make` once, for a store of its own, and `cleanup` once with what `make` gave
 * when the test is over: passed, failed, out of time, or refused because what `make` gave is not a
 * store. What `cleanup` gives back is awaited when it is a promise, and is not used. A test whose
 * `make` throws fails with what it threw, and has nothing to clean up.
 *
 * A test has 10 s, and fails when it takes longer; its `cleanup` has 10 s after it. A `cleanup`
 * that throws, or has not settled by then, fails its test; when the test had failed already, its
 * own failure is the one reported.
 *
 * The tests use three sessions, all with sender EXCHANGE: FIX.4.4 with target CLIENT, FIX.4.4
 * with target NOBODY, and FIX.4.2 with target CLIENT. What `make` gives must keep nothing for any
 * of them: a store that keeps what it is given between calls needs a new file each time, or
 * reset() of the three sessions in `make`. A test given a store whose load() shows something kept
 * for one of them fails, and says so.
 *
 * Besides what each method gives, they cover what a session of a server asks of a store that a
 * test of one session at a time does not: a SessionId that is a new object for every call, two
 * sessions appended to at the same moment, and two sessions that differ in version alone.
 *
 * RangeError, when it is called, for a name that is not text or is empty, a `make` or a `cleanup`
 * that is not a function, and an option it does not know.
 */
export function storeContract<S extends Store>(
  name: string,
  make: () => S | Promise<S>,
  options: { readonly cleanup?: (store: S) => unknown } = {},
): void {
  if (typeof name !== 'string' || name === '') throw new RangeError(`storeContract() name must be text, not empty, got ${describe(name)}`);
  checkFunction(make, 'storeContract() make');
  checkKnownKeys(plainObject(options, 'storeContract() options', 'an object'), ['cleanup'], 'storeContract() options');
  const { cleanup } = options;
  if (cleanup !== undefined) checkFunction(cleanup, 'storeContract() cleanup');

  /** One test: a store of its own, checked to keep nothing for the suite's sessions, and cleaned up whatever comes of the test. */
  const define = (title: string, body: (store: S, appended: Appended) => Promise<void>): void => {
    test(`${name}: ${title}`, { timeout: LIMIT }, async t => {
      const store = await make();
      // Before anything is asked of what make() gave: node:test runs this however the test ends, and reports the test's own failure when both fail.
      if (cleanup) t.after(() => cleanUp(cleanup, store));
      checkStore(store, 'what make() gave');
      for (const session of SESSIONS) {
        assert.deepEqual(await store.load(session), { history: [], next: 1, expected: 1 },
          `make() gave a store that already keeps something for the session ${session.version} ${session.sender} ${session.target}: each test needs a store with nothing kept for it`);
      }
      await body(store, appending());
    });
  };

  define(`append() keeps the records of a list in the order given, and one list after another`, async (store, { record, sent, read, load }) => {
    await store.append(id, [record(original(1), 2), record(message('in', 1, 'received'), 2), record(original(2), 3)]);
    await store.append(id, [record(original(3), 4)]);   // a list of one
    await store.append(id, [record(original(4), 5), record({ kind: 'error', at, text: 'a handler threw' }, 5), record(original(5), 6)]);
    const order = ['1:t1', '1:received', '2:t2', '3:t3', '4:t4', 'error', '5:t5'];
    assert.deepEqual(await read(store), order);
    assert.deepEqual(await load(store), { history: order, next: 6, expected: 1 });
    assert.deepEqual(await sent(store, 1, 5), ['1:t1', '2:t2', '3:t3', '4:t4', '5:t5']);
  });

  define(`append() of a list of one record keeps it as any other`, async (store, { record, sent, load }) => {
    await store.append(id, [record(original(1), 2)]);
    assert.deepEqual(await load(store), { history: ['1:t1'], next: 2, expected: 1 });
    await store.append(id, [{ at, seqNums: { next: 7, expected: 3 } }]);   // sequence numbers alone
    assert.deepEqual(await load(store), { history: ['1:t1'], next: 7, expected: 3 });
    assert.deepEqual(await sent(store, 1, 9), ['1:t1']);
  });

  define(`append() of a list leaves the sequence numbers of its last record as the session's, whether that record has an entry or not`, async (store, { record, load }) => {
    await store.append(id, [record(original(1), 2, { seqNums: { next: 2, expected: 5 } }), record(original(2), 3, { seqNums: { next: 3, expected: 6 } })]);
    assert.deepEqual(await load(store), { history: ['1:t1', '2:t2'], next: 3, expected: 6 });
    await store.append(id, [record(original(3), 4, { seqNums: { next: 4, expected: 6 } }), { at, seqNums: { next: 40, expected: 60 } }]);
    assert.deepEqual(await load(store), { history: ['1:t1', '2:t2', '3:t3'], next: 40, expected: 60 });
    await store.append(id, [{ at, seqNums: { next: 41, expected: 61 } }, record(original(41), 42, { seqNums: { next: 42, expected: 61 } })]);
    assert.deepEqual(await load(store), { history: ['1:t1', '2:t2', '3:t3', '41:t41'], next: 42, expected: 61 });
  });

  define(`append() begins the next epoch at a record with newEpoch wherever it is in a list: the records before it stay in the epoch before, the records after it are in the new one`, async (store, { record, sent, read, load }) => {
    const began = new Date(at.getTime() + 60_000);
    const first = { ...original(1, 'new1'), at: began };
    await store.append(id, [record(original(1, 'old1'), 2), record(original(2, 'old2'), 3), record(first, 2, { newEpoch: true }), record(original(2, 'new2'), 3)]);
    assert.deepEqual(await sent(store, 1, 3), ['1:new1', '2:new2']);
    assert.deepEqual(await load(store), { history: ['1:new1', '2:new2'], next: 3, expected: 1 });
    assert.deepEqual(await read(store, 1), ['1:old1', '2:old2']);
    assert.deepEqual(await read(store, 2), ['1:new1', '2:new2']);
    assert.deepEqual(await read(store), ['1:old1', '2:old2', '1:new1', '2:new2']);
    const listed = (await store.list()).find(session => session.id.target === id.target);
    assert.deepEqual(listed?.epochs.map(({ epoch, startedAt }) => [epoch, startedAt.toISOString()]), [[1, at.toISOString()], [2, began.toISOString()]]);

    // One list may begin several epochs, and its last record may begin one.
    await store.append(id, [record(original(3, 'new3'), 4), record(original(1, 'third1'), 2, { newEpoch: true }), record(original(2, 'third2'), 3), record(original(1, 'fourth1'), 2, { newEpoch: true })]);
    assert.deepEqual(await read(store, 2), ['1:new1', '2:new2', '3:new3']);
    assert.deepEqual(await read(store, 3), ['1:third1', '2:third2']);
    assert.deepEqual(await read(store, 4), ['1:fourth1']);
    assert.deepEqual(await sent(store, 1, 3), ['1:fourth1']);
    assert.deepEqual(await load(store), { history: ['1:fourth1'], next: 2, expected: 1 });
  });

  define(`append() begins epoch 1 with a session's first record, whether it has newEpoch or not, and not a second one for the list it came in`, async (store, { record, read }) => {
    await store.append(id, [record(original(1), 2, { newEpoch: true }), record(original(2), 3)]);
    assert.deepEqual((await store.list()).find(session => session.id.target === id.target)?.epochs.map(({ epoch }) => epoch), [1]);
    assert.deepEqual(await read(store, 1), ['1:t1', '2:t2']);
  });

  define(`append() keeps a list of 256 records, the most a session gives at once, each in its place`, async (store, { record, sent, load }) => {
    const numbers = Array.from({ length: 256 }, (_unused, index) => index + 1);
    await store.append(id, numbers.map(seq => record(original(seq), seq + 1)));
    assert.deepEqual(await sent(store, 1, 300), numbers.map(seq => `${seq}:t${seq}`));
    assert.deepEqual((await load(store)).history, numbers.map(seq => `${seq}:t${seq}`));
    assert.equal((await store.load(id)).next, 257);
  });

  define(`a session is the three values of its SessionId, whichever object carries them: what is appended with one object is loaded, read, sent() and reset with another`, async (store, { record, sent, read, load }) => {
    // A session of a server hands its store a new object for every connection: each call here is given one of its own.
    const fresh = (): SessionId => ({ ...id });
    await store.append(fresh(), [record(original(1), 2), record(original(2), 3)]);
    await store.append(fresh(), [record(original(3), 4)]);
    assert.deepEqual(await load(store, fresh()), { history: ['1:t1', '2:t2', '3:t3'], next: 4, expected: 1 });
    assert.deepEqual(await read(store, undefined, fresh()), ['1:t1', '2:t2', '3:t3']);
    assert.deepEqual(await sent(store, 1, 9, fresh()), ['1:t1', '2:t2', '3:t3']);
    assert.equal((await store.list()).filter(session => session.id.version === id.version && session.id.sender === id.sender && session.id.target === id.target).length, 1);
    await store.append(fresh(), [record(original(1, 'again'), 2, { newEpoch: true })]);
    assert.deepEqual(await read(store, 2, fresh()), ['1:again']);
    await store.reset(fresh());
    assert.deepEqual(await load(store, fresh()), { history: [], next: 1, expected: 1 });
    assert.deepEqual(await sent(store, 1, 9, fresh()), []);
  });

  define(`append() for two sessions at once keeps the lists of each whole, in order and apart, whichever call settles first`, async (store, { record, sent, read, load }) => {
    /** Four lists of three for a session, numbered on from one list to the next. */
    const lists = (session: SessionId, label: string): StoreRecord[][] =>
      [0, 1, 2, 3].map(list => [1, 2, 3].map(nth => record(original(list * 3 + nth, `${label}${list * 3 + nth}`, session), list * 3 + nth + 1)));
    /** One call for a session at a time, as a session makes them. */
    const oneByOne = async (session: SessionId, all: StoreRecord[][]): Promise<void> => {
      for (const list of all) await store.append(session, list);
    };
    // Neither waits for the other: a call for one session is made while a call for the other has not settled.
    await Promise.all([oneByOne(id, lists(id, 'a')), oneByOne(other, lists(other, 'b'))]);
    const names = (label: string) => Array.from({ length: 12 }, (_unused, index) => `${index + 1}:${label}${index + 1}`);
    assert.deepEqual(await read(store), names('a'));
    assert.deepEqual(await read(store, undefined, other), names('b'));
    assert.deepEqual(await sent(store, 1, 99), names('a'));
    assert.deepEqual(await sent(store, 1, 99, other), names('b'));
    assert.deepEqual(await load(store), { history: names('a'), next: 13, expected: 1 });
    assert.deepEqual(await load(store, other), { history: names('b'), next: 13, expected: 1 });
  });

  define(`sessions that differ only in version are kept apart: what is appended, loaded, read, sent(), listed and reset for one is not for the other`, async (store, { record, sent, read, load }) => {
    await store.append(id, [record(original(1, 'new1'), 2), record(original(2, 'new2'), 3)]);
    assert.deepEqual(await load(store, older), { history: [], next: 1, expected: 1 });
    assert.deepEqual(await sent(store, 1, 9, older), []);
    assert.deepEqual(await read(store, undefined, older), []);
    await store.append(older, [record(original(1, 'old1', older), 2, { seqNums: { next: 2, expected: 8 } })]);
    assert.deepEqual(await load(store), { history: ['1:new1', '2:new2'], next: 3, expected: 1 });
    assert.deepEqual(await load(store, older), { history: ['1:old1'], next: 2, expected: 8 });
    assert.deepEqual(await sent(store, 1, 9), ['1:new1', '2:new2']);
    assert.deepEqual(await sent(store, 1, 9, older), ['1:old1']);
    assert.deepEqual(await read(store, undefined, older), ['1:old1']);
    const versions = (await store.list()).filter(session => session.id.sender === id.sender && session.id.target === id.target).map(session => session.id.version);
    assert.deepEqual(versions.sort(), ['FIX.4.2', 'FIX.4.4']);
    await store.reset(older);
    assert.deepEqual(await load(store, older), { history: [], next: 1, expected: 1 });
    assert.deepEqual(await load(store), { history: ['1:new1', '2:new2'], next: 3, expected: 1 });
    assert.deepEqual(await sent(store, 1, 9), ['1:new1', '2:new2']);
  });

  define(`sent() gives the originals within a range, both ends included, in MsgSeqNum order`, async (store, { record, sent }) => {
    for (let seq = 1; seq <= 6; seq++) await store.append(id, [record(original(seq), seq + 1)]);
    assert.deepEqual(await sent(store, 2, 4), ['2:t2', '3:t3', '4:t4']);
    assert.deepEqual(await sent(store, 1, 1), ['1:t1']);
    assert.deepEqual(await sent(store, 6, 9), ['6:t6']);
    assert.deepEqual(await sent(store, 7, 9), []);
    assert.deepEqual(await sent(store, 1, 6), ['1:t1', '2:t2', '3:t3', '4:t4', '5:t5', '6:t6']);
  });

  define(`sent() gives only messages the session sent: nothing received, no problem, no error, no record of sequence numbers alone`, async (store, { record, sent }) => {
    await store.append(id, [record(original(1), 2)]);
    await store.append(id, [record(message('in', 2, 'received'), 2)]);
    await store.append(id, [record({ kind: 'problem', direction: 'in', at, problem: { code: 'Garbled', text: 'CheckSum is 000 but should be 138', action: 'Ignored' } }, 2)]);
    await store.append(id, [record({ kind: 'error', at, text: 'a handler threw' }, 2)]);
    await store.append(id, [{ at, seqNums: { next: 3, expected: 1 } }]);
    await store.append(id, [record(original(3), 4)]);
    assert.deepEqual(await sent(store, 1, 3), ['1:t1', '3:t3']);
  });

  define(`sent() leaves out what was sent with PossDupFlag: a resent copy never stands for the original`, async (store, { record, sent }) => {
    await store.append(id, [record(original(1), 2)]);
    await store.append(id, [record(original(2), 3)]);
    await store.append(id, [record(message('out', 2, 'copy', { PossDupFlag: true, OrigSendingTime: at }), 3)]);
    await store.append(id, [record(message('out', 3, 'copy-only', { PossDupFlag: true, OrigSendingTime: at }), 3)]);
    assert.deepEqual(await sent(store, 1, 3), ['1:t1', '2:t2']);
  });

  define(`sent() gives the latest of several originals appended with one MsgSeqNum, once, in its place`, async (store, { record, sent }) => {
    await store.append(id, [record(original(1), 2)]);
    await store.append(id, [record(original(2, 'first'), 3)]);
    await store.append(id, [record(original(3), 4)]);
    await store.append(id, [record(original(2, 'second'), 4)]);
    await store.append(id, [record(original(4), 5)]);
    assert.deepEqual(await sent(store, 1, 4), ['1:t1', '2:second', '3:t3', '4:t4']);
    assert.deepEqual(await sent(store, 2, 2), ['2:second']);
  });

  define(`sent() gives originals appended out of MsgSeqNum order in MsgSeqNum order, the latest of each`, async (store, { record, sent }) => {
    await store.append(id, [record(original(5), 6)]);
    await store.append(id, [record(original(2, 'first'), 6)]);
    await store.append(id, [record(original(9), 10)]);
    await store.append(id, [record(original(3), 10)]);
    await store.append(id, [record(original(2, 'second'), 10)]);
    assert.deepEqual(await sent(store, 1, 10), ['2:second', '3:t3', '5:t5', '9:t9']);
    assert.deepEqual(await sent(store, 3, 5), ['3:t3', '5:t5']);
  });

  define(`sent() gives a message that was kept without wire bytes (one an outgoing route dropped)`, async (store, { record, sent }) => {
    const { bytes: _bytes, ...dropped } = original(1);
    await store.append(id, [record(dropped, 2)]);
    await store.append(id, [record(original(2), 3)]);
    assert.deepEqual(await sent(store, 1, 2), ['1:t1', '2:t2']);   // the first still without wire bytes, the second with its own
  });

  define(`sent() gives a message back as it was appended: every field with its type (a time a Date, a number a number, a boolean a boolean), its groups, the entry's time, its wire bytes`, async (store, { record }) => {
    const report = entryOf('out', 'ExecutionReport', {
      MsgSeqNum: 1, OrderID: 'o1', ExecID: 'e1', ExecType: 'Trade', OrdStatus: 'PartiallyFilled', Side: 'Buy', Symbol: 'IBM',
      LeavesQty: 60, CumQty: 40, AvgPx: 101.25, LastQty: 40, LastPx: 101.25, TransactTime: new Date('2026-09-30T11:59:59.123Z'), WorkingIndicator: true,
      Parties: [{ PartyID: 'DESK7', PartyRole: 'ClientID' }, { PartyID: 'ACME', PartyRole: 'ExecutingFirm' }],
    });
    // The message is what a session appends: decoded from its frame, each value of the type its field has.
    assert.ok(report.message.TransactTime instanceof Date && report.message.SendingTime instanceof Date);
    assert.deepEqual([report.message.MsgSeqNum, report.message.AvgPx, report.message.WorkingIndicator], [1, 101.25, true]);
    assert.deepEqual(report.message.Parties, [{ PartyID: 'DESK7', PartyRole: 'ClientID' }, { PartyID: 'ACME', PartyRole: 'ExecutingFirm' }]);
    await store.append(id, [{ at: report.at, entry: report, seqNums: { next: 2, expected: 1 } }]);
    await store.append(id, [record(original(2), 3)]);
    const given: Entry[] = [];
    for await (const entry of store.sent(id, { from: 1, to: 2 })) given.push(entry);
    assert.equal(given.length, 2);
    assertAsAppended(given[0]!, report);
    assertAsAppended(given[1]!, original(2));
  });

  define(`sent() answers a range that ends far above anything kept, and one that begins there, as soon as any other`, async (store, { record, sent }) => {
    for (let seq = 1; seq <= 3; seq++) await store.append(id, [record(original(seq), seq + 1)]);
    // What sent() costs must follow what is kept, not the range: a store that tries each MsgSeqNum of this one never finishes.
    assert.deepEqual(await sent(store, 2, Number.MAX_SAFE_INTEGER), ['2:t2', '3:t3']);
    assert.deepEqual(await sent(store, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER), []);
  });

  define(`sent() never gives anything from before the newest epoch`, async (store, { record, sent }) => {
    for (let seq = 1; seq <= 3; seq++) await store.append(id, [record(original(seq, `old${seq}`), seq + 1)]);
    await store.append(id, [record(original(1, 'new1'), 2, { newEpoch: true })]);
    assert.deepEqual(await sent(store, 1, 3), ['1:new1']);
    // An epoch may begin with a record of sequence numbers alone: then nothing has been sent in it.
    await store.append(id, [{ at, seqNums: { next: 1, expected: 1 }, newEpoch: true }]);
    assert.deepEqual(await sent(store, 1, 3), []);
  });

  define(`sent() gives nothing for a session with nothing kept, and keeps sessions apart`, async (store, { record, sent }) => {
    assert.deepEqual(await sent(store, 1, 10), []);
    await store.append(id, [record(original(1), 2)]);
    assert.deepEqual(await sent(store, 1, 10, other), []);
    await store.reset(id);
    assert.deepEqual(await sent(store, 1, 10), []);
  });

  define(`sent() refuses a range that is not whole numbers with 1 <= from <= to`, async (store, { record }) => {
    await store.append(id, [record(original(1), 2)]);
    const bad: unknown[] = [{ from: 0, to: 1 }, { from: 2, to: 1 }, { from: 1.5, to: 2 }, { from: 1, to: Infinity }, { from: '1', to: 2 }, { from: 1 }, { to: 1 }, {}, undefined, null, 7];
    for (const range of bad) {
      await assert.rejects(async () => { for await (const _entry of store.sent(id, range as never)) { /* nothing to do */ } }, RangeError, `range ${JSON.stringify(range)}`);
    }
  });

  define(`sent() does not hold up an append while its reader pauses`, async (store, { record, sent }) => {
    for (let seq = 1; seq <= 3; seq++) await store.append(id, [record(original(seq), seq + 1)]);
    const reader = store.sent(id, { from: 1, to: 3 })[Symbol.asyncIterator]();
    const first = await reader.next();
    assert.equal(first.done, false);
    // The reader holds its place here; an append that waited for it would never finish.
    await store.append(id, [record(original(4), 5)]);
    const rest: unknown[] = [];
    for (let step = await reader.next(); !step.done; step = await reader.next()) rest.push(step.value.kind === 'message' && step.value.message.MsgSeqNum);
    assert.deepEqual(rest, [2, 3]);
    assert.deepEqual(await sent(store, 4, 4), ['4:t4']);
  });

  define(`sent() gives nothing more once the session is reset while its reader pauses, whatever is appended after`, async (store, { record, sent }) => {
    /** What a paused reader still gives, each as 'MsgSeqNum:TestReqID'. */
    const restOf = async (reader: AsyncIterator<Entry>): Promise<string[]> => {
      const rest: string[] = [];
      for (let step = await reader.next(); !step.done; step = await reader.next()) {
        rest.push(step.value.kind === 'message' ? `${String(step.value.message.MsgSeqNum)}:${String(step.value.message.TestReqID)}` : step.value.kind);
      }
      return rest;
    };
    for (let seq = 1; seq <= 3; seq++) await store.append(id, [record(original(seq, `old${seq}`), seq + 1)]);
    const paused = store.sent(id, { from: 1, to: 3 })[Symbol.asyncIterator]();
    assert.equal((await paused.next()).done, false);
    await store.reset(id);
    assert.deepEqual(await restOf(paused), []);

    // The same when the session is begun again under the same id before the reader goes on.
    for (let seq = 1; seq <= 3; seq++) await store.append(id, [record(original(seq, `old${seq}`), seq + 1)]);
    const again = store.sent(id, { from: 1, to: 3 })[Symbol.asyncIterator]();
    assert.equal((await again.next()).done, false);
    await store.reset(id);
    for (let seq = 1; seq <= 3; seq++) await store.append(id, [record(original(seq, `new${seq}`), seq + 1)]);
    assert.deepEqual(await restOf(again), []);
    assert.deepEqual(await sent(store, 1, 3), ['1:new1', '2:new2', '3:new3']);
  });
}
