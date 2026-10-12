// A seeded model test of how a session hands what it sends to its store and to the network.
// Each seed drives one session with random steps against a store and a link that are slow, and
// in most seeds fail in one way, and checks at every write and every list kept that:
//   1. no message reaches the link before the append() that carried its record has resolved,
//      and none of a list the store rejected ever does;
//   2. messages are written in the order their records were given to the store;
//   3. what a restart would load, after any list kept, never lets a MsgSeqNum already written be used again.
// And at the end: every send() has settled, `closed` has resolved with the reason the failure
// calls for, no timer is left, and nothing was rejected with no one to hear it.
// What the session receives arrives as a socket gives it: several messages in one chunk, and
// chunks that end in the middle of a message; in half the seeds the session stops taking in
// after a few messages it has not finished (a small memory.pendingBytes). Whatever the chunks,
// 4. the store is given each message received once, in the order received, and every one of
//    them when nothing failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictionaryFor } from '../dictionary/index.ts';
import { engineConfig } from '../session/types.ts';
import { buildFrame, parseFrame } from '../wire/frame.ts';
import { fromMessage, inspectMessage } from '../wire/message.ts';
import { fakeClock, type Clock } from './clock.ts';
import { T0 } from './fixtures.ts';
import { FixSession } from './session.ts';
import { memoryStore } from './store.ts';
import type { CloseReason, Link, Store, StoreRecord } from './types.ts';

const SEEDS = 400;
const STEPS = 150;
/** In a seed with little room for records, memory.storeBytes: a burst of sends against a slow store passes it. */
const LITTLE_ROOM = 2500;
/** In a seed that takes in little at a time, memory.pendingBytes: three or four of the messages received here. */
const LITTLE_AT_A_TIME = 300;

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const turns = async (count: number) => { for (let n = 0; n < count; n++) await tick(); };
const dict = dictionaryFor('FIX.4.4');
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

function fromExchange(msgType: string, seq: number, fields: Record<string, unknown> = {}): Uint8Array {
  const { fields: raw, framing } = fromMessage(msgType, { SenderCompID: 'EXCHANGE', TargetCompID: 'CLIENT', MsgSeqNum: seq, SendingTime: T0, ...fields }, dict, { version: 'FIX.4.4' });
  return buildFrame(raw, framing);
}

function seeded(seed: number): (below: number) => number {
  let state = seed >>> 0;
  return below => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % below;
  };
}

/**
 * What goes wrong in a seed, at the list or the write numbered `failAt`:
 * the store rejects that list after a while, throws as it is given it, or never settles it;
 * the link fails that write, or never finishes it nor any after it.
 */
const FAILURES = ['none', 'none', 'storeRejects', 'storeThrows', 'storeNeverSettles', 'writeFails', 'writesStall', 'none'] as const;

const unhandled: unknown[] = [];
process.on('unhandledRejection', reason => { unhandled.push(reason); });

/** A record as the store was given it, and what became of it. */
interface Given {
  readonly record: StoreRecord;
  readonly list: number;
  /** Epochs begun up to and with this record. */
  readonly epoch: number;
  kept: boolean;
  rejected: boolean;
  /** Times its bytes were written to the link. */
  written: number;
}

async function run(seed: number) {
  const random = seeded(seed);
  const failure = FAILURES[seed % FAILURES.length]!;
  const littleRoom = random(3) === 0;
  const littleAtATime = random(2) === 0;
  const failAt = 2 + random(25);
  const faults: string[] = [];
  const fault = (what: string) => { if (faults.length < 10) faults.push(what); };

  // ── The store: keeps a list after 0 to 3 turns, and is the model of what a restart would load ──
  const given: Given[] = [];
  let lists = 0;
  let inFlight = 0;
  let mostInFlight = 0;
  let listOutOfBounds = false;
  let epochsGiven = 0;
  /** What load() would give now: the epoch and `next` of the last record of the last list kept. */
  let restart = { epoch: 0, next: 1 };
  /** Originals written so far: MsgSeqNum and epoch. */
  const originalsWritten: { seq: number; epoch: number }[] = [];
  let storeFailed = false;
  let linkEnded = false;
  const base = memoryStore();
  const checkRestart = (when: string) => {
    for (const { seq, epoch } of originalsWritten) {
      if (epoch === restart.epoch && seq >= restart.next) fault(`${when}: a restart would load next ${restart.next} in epoch ${restart.epoch}, and MsgSeqNum ${seq} of that epoch was already written`);
    }
  };
  const store: Store = {
    ...base,
    append(id, records, context) {
      const list = lists++;
      mostInFlight = Math.max(mostInFlight, ++inFlight);
      if (records.length === 0 || records.length > 256) listOutOfBounds = true;
      const mine: Given[] = [];
      for (const record of records) {
        if (record.newEpoch) epochsGiven++;
        mine.push({ record, list, epoch: epochsGiven, kept: false, rejected: false, written: 0 });
      }
      given.push(...mine);
      const failing = list === failAt;
      const reject = (): never => {
        inFlight--;
        storeFailed = true;
        for (const each of mine) each.rejected = true;
        throw new Error('store failed');
      };
      if (failing && failure === 'storeThrows') reject();
      return (async () => {
        await turns(random(4));
        if (failing && failure === 'storeNeverSettles') {
          storeFailed = true;
          await new Promise(() => {});
        }
        if (failing && failure === 'storeRejects') reject();
        await base.append(id, records, context);
        for (const each of mine) each.kept = true;
        const last = mine.at(-1)!;
        restart = { epoch: last.epoch, next: last.record.seqNums.next };
        checkRestart(`list ${list} kept`);
        inFlight--;
      })();
    },
  };

  // ── The link: a write takes 0 to 2 turns, and is checked against the store as it begins ──
  let writes = 0;
  let writeFailed = false;
  let lastWritten = -1;
  let written = 0;
  const link: Link = {
    async write(bytes) {
      const mine = writes++;
      if (linkEnded) fault(`write ${mine} began after the link was ended`);
      const wire = text(bytes);
      if (!wire.startsWith('NOT A FRAME')) {
        written++;
        const message = inspectMessage(parseFrame(bytes, { dataTags: dict.dataTags }).fields, dict).message;
        const label = `${String(message.MsgType)} ${String(message.MsgSeqNum)}${message.PossDupFlag ? ' PossDup' : ''} ${String(message.ClOrdID ?? message.TestReqID ?? '')}`;
        // Its record: the first with these bytes that has not been written yet.
        const index = given.findIndex(({ record: { entry }, written: times }) => times === 0 && entry?.kind === 'message' && entry.direction === 'out' && entry.bytes !== undefined && text(entry.bytes) === wire);
        if (index < 0) {
          fault(`${label} was written and the store was never given its record`);
        } else {
          const record = given[index]!;
          record.written++;
          if (!record.kept) fault(`${label} was written before list ${record.list}, which carried its record, resolved${record.rejected ? ' (the store rejected it)' : ''}`);
          if (index < lastWritten) fault(`${label} was written out of order: its record is number ${index}, after number ${lastWritten} was written`);
          lastWritten = Math.max(lastWritten, index);
          if (!message.PossDupFlag && message.TestReqID !== 'by hand') {
            originalsWritten.push({ seq: Number(message.MsgSeqNum), epoch: record.epoch });
            checkRestart(`${label} written`);
          }
        }
      }
      if (mine === failAt && failure === 'writeFails') {
        writeFailed = true;
        await turns(random(3));
        throw new Error('link failed');
      }
      if (mine >= failAt && failure === 'writesStall') {
        writeFailed = true;
        await new Promise(() => {});
      }
      await turns(random(3));
    },
    end() { linkEnded = true; },
  };

  // ── The session, on a clock that knows which of its timers are still set ──
  const fake = fakeClock(T0);
  const timers = new Set<unknown>();
  const clock: Clock = {
    now: () => fake.now(),
    setTimeout: (fn, ms) => {
      const handle: unknown = fake.setTimeout(() => { timers.delete(handle); fn(); }, ms);
      timers.add(handle);
      return handle;
    },
    clearTimeout: handle => { timers.delete(handle); fake.clearTimeout(handle); },
  };
  const client = new FixSession({
    config: engineConfig({ version: 'FIX.4.4', sender: 'CLIENT', target: 'EXCHANGE', role: 'initiator' }),
    dictionary: dict, store, clock, loaded: { history: [], next: 1, expected: 1 },
    memory: { ...(littleRoom ? { storeBytes: LITTLE_ROOM } : {}), ...(littleAtATime ? { pendingBytes: LITTLE_AT_A_TIME } : {}) },
  });
  client.attach(link);
  client.outgoing(async message => {
    switch (message.ClOrdID) {
      case 'slow': await turns(1 + random(6)); return message;
      case 'twice': return [message, { ...message, ClOrdID: 'again' }];
      case 'dropped': return null;
      case 'rewritten': return { ...message, Text: 'rewritten' };
      default: return message;
    }
  });
  client.start();
  client.receiveBytes(fromExchange('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30 }));
  await client.active;
  let reason: CloseReason | undefined;
  void client.closed.then(closed => { reason = closed; });

  // ── Arrival: a message waits for the next, or goes with those that waited, whole or cut short ──
  let arriving: Buffer = Buffer.alloc(0);
  let chunks = 0;
  let cutShort = 0;
  let severalAtOnce = 0;
  const deliver = (bytes: number) => {
    if (bytes === 0) return;
    chunks++;
    client.receiveBytes(arriving.subarray(0, bytes));
    arriving = arriving.subarray(bytes);
  };
  const receive = (frame: Uint8Array) => {
    const waited = arriving.length;
    arriving = Buffer.concat([arriving, frame]);
    const how = random(4);
    if (how === 0) return;
    if (waited > frame.length / 2) severalAtOnce++;
    if (how > 1) return deliver(arriving.length);
    // All but the last bytes of the newest message, which go with the next chunk.
    cutShort++;
    deliver(arriving.length - 1 - random(frame.length - 1));
  };

  // ── Random steps ──
  let incoming = 2;
  const sends: Promise<unknown>[] = [];
  const sending = (sent: Promise<unknown>) => { sent.catch(() => {}); sends.push(sent); };
  /** A call that a closed session refuses by throwing. */
  const unlessClosed = (call: () => void) => { try { call(); } catch { /* closed meanwhile */ } };
  for (let step = 0; step < STEPS; step++) {
    const what = random(24);
    if (what < 9) sending(client.send('NewOrderSingle', { ClOrdID: ['plain', 'twice', 'dropped', 'slow', 'rewritten', 'plain'][random(6)]!, Side: 'Buy', OrdType: 'Market' }));
    else if (what < 11) unlessClosed(() => sending(client.sendBytes(client.encode('Heartbeat', { TestReqID: 'by hand' }))));
    else if (what < 12) sending(client.sendBytes(`NOT A FRAME ${step}`));
    else if (what < 16) receive(fromExchange('TestRequest', incoming++, { TestReqID: `t${step}` }));
    else if (what < 17) {
      const next = client.seqNums.next;
      if (random(2) === 0 && next > 1) receive(fromExchange('ResendRequest', incoming++, { BeginSeqNo: 1 + random(next - 1), EndSeqNo: 0 }));
    } else if (what < 19) unlessClosed(() => client.setSeqNums({ next: client.seqNums.next + 3 }));
    else if (what < 20) { if (random(3) === 0) unlessClosed(() => client.setSeqNums({ next: 1 })); }
    else await turns(random(4));
  }
  deliver(arriving.length);

  // ── Let it come to rest ──
  /** Wait until the session has closed, or nothing more has been given to the store or the link for a while. */
  const atRest = async () => {
    for (let same = 0, seen = -1, n = 0; n < 30_000 && same < 60 && !reason; n++) {
      await tick();
      const now = writes * 100_000 + given.length;
      same = now === seen ? same + 1 : 0;
      seen = now;
    }
  };
  await atRest();
  if (!reason && failure === 'storeNeverSettles' && storeFailed) await fake.advance('12s');   // storeTimeout, on the tick
  // A write that never finishes holds the sends behind it for good, as it holds its own: closing is all that is left.
  const stuck = failure === 'writesStall' && writeFailed;
  if (!reason && stuck) client.close();
  if (client.state === 'closed') {
    await turns(50);
    if (!reason) await fake.advance('30s');                                                     // the bounded waits of a closing session
    await turns(50);
    if (!reason) fault(`closed never resolved (${failure}, state ${client.state})`);
  }
  if (!stuck) {
    let settled = false;
    void Promise.allSettled(sends).then(() => { settled = true; });
    for (let n = 0; n < 2_000 && !settled; n++) await tick();
    if (!settled) fault(`a send() never settled (${failure}, state ${client.state}, closed: ${reason?.text})`);
  }
  await atRest();
  await turns(20);

  // ── What the store was given, as a whole ──
  if (mostInFlight > 1) fault(`${mostInFlight} appends were in flight at once`);
  if (listOutOfBounds) fault('a list was empty, or held more than 256 records');
  // A message whose record was one too many for memory.storeBytes was recorded and never processed: it is still expected.
  const outOfRoom = littleRoom && reason?.text === 'Store is not keeping up';
  let before = { next: 1, expected: 1 };
  given.forEach(({ record }, index) => {
    const { entry, seqNums } = record;
    if (record.newEpoch) {
      if (entry || seqNums.next !== 1) fault(`record ${index} begins a new epoch and is not the record of setSeqNums({ next: 1 }) (next ${seqNums.next})`);
    } else if (seqNums.next < before.next) {
      fault(`record ${index}: next went back from ${before.next} to ${seqNums.next} with no new epoch`);
    }
    if (seqNums.expected < before.expected) fault(`record ${index}: expected went back from ${before.expected} to ${seqNums.expected}`);
    if (entry?.kind === 'message') {
      const { message } = entry;
      const seq = Number(message.MsgSeqNum);
      const original = entry.direction === 'out' && !message.PossDupFlag && message.TestReqID !== 'by hand' && message.MsgType !== 'SequenceReset';
      if (original && seqNums.next !== seq + 1) fault(`record ${index}: MsgSeqNum ${seq} was kept with next ${seqNums.next}`);
      if (entry.direction === 'in' && !outOfRoom && seqNums.expected < seq + 1) fault(`record ${index}: received MsgSeqNum ${seq} was kept with expected ${seqNums.expected}`);
    }
    before = seqNums;
  });
  for (const each of given) if (each.rejected && each.written > 0) fault('a message of a list the store rejected was written');
  const receivedGiven = given.flatMap(({ record: { entry } }) => (entry?.kind === 'message' && entry.direction === 'in' ? [Number(entry.message.MsgSeqNum)] : []));
  if (receivedGiven.some((seq, index) => seq !== index + 1)) fault(`the store was given the messages received as ${receivedGiven.join(' ')}: not each once, in the order received`);

  // ── How it ended ──
  if (failure === 'none' && !outOfRoom) {
    if (reason) fault(`closed with nothing having failed: ${reason.text}`);
    if (receivedGiven.length !== incoming - 1) fault(`${incoming - 1} messages were received and the store was given ${receivedGiven.length} of them`);
    given.forEach(({ record: { entry }, written: times, list }, index) => {
      if (entry?.kind === 'message' && entry.direction === 'out' && entry.bytes && times !== 1) fault(`record ${index} (${String(entry.message.MsgType)} ${String(entry.message.MsgSeqNum)}, list ${list}) was kept and written ${times} times`);
    });
  }
  if (reason && !outOfRoom) {
    if ((failure === 'storeRejects' || failure === 'storeThrows') && storeFailed && reason.text !== 'store failed') fault(`closed with '${reason.text}', not the store's error`);
    if (failure === 'storeNeverSettles' && storeFailed && !/^Store write took longer/.test(reason.text)) fault(`closed with '${reason.text}', not for the store's silence`);
    if (failure === 'writeFails' && writeFailed && reason.text !== 'link failed') fault(`closed with '${reason.text}', not the link's error`);
  }
  if (reason && timers.size > 0) fault(`${timers.size} timers were left set after closed resolved`);
  return { failure: `${failure}${storeFailed || writeFailed ? ', met' : ''}${outOfRoom ? ', out of room' : ''}`, faults, written, lists, records: given.length, closed: reason?.text, chunks, cutShort, severalAtOnce, littleAtATime };
}

test(`a session driven at random for ${SEEDS} seeds, against a store and a link that are slow and fail in every way: nothing is written before its record is kept, the wire keeps the order of the records, and a restart never reuses a MsgSeqNum`, { timeout: 60_000 }, async () => {
  const failed: string[] = [];
  const met: Record<string, number> = {};
  const totals = { written: 0, lists: 0, records: 0, chunks: 0, cutShort: 0, severalAtOnce: 0, littleAtATime: 0 };
  for (let seed = 1; seed <= SEEDS; seed++) {
    const result = await run(seed);
    met[result.failure] = (met[result.failure] ?? 0) + 1;
    totals.written += result.written;
    totals.lists += result.lists;
    totals.records += result.records;
    totals.chunks += result.chunks;
    totals.cutShort += result.cutShort;
    totals.severalAtOnce += result.severalAtOnce;
    totals.littleAtATime += result.littleAtATime ? 1 : 0;
    if (result.faults.length > 0) failed.push(`seed ${seed} (${result.failure}; closed: ${result.closed}):\n    ${result.faults.join('\n    ')}`);
  }
  if (unhandled.length > 0) failed.push(`rejected with no one to hear it: ${unhandled.slice(0, 3).map(String).join('; ')}`);
  assert.equal(failed.length, 0, `\n${failed.slice(0, 8).join('\n')}\n(${failed.length} seeds)`);
  // The seeds did meet what they are for: each failure, a session out of room, and plenty of traffic.
  for (const failure of ['storeRejects', 'storeThrows', 'storeNeverSettles', 'writeFails', 'writesStall']) {
    assert.ok((met[`${failure}, met`] ?? 0) + (met[`${failure}, met, out of room`] ?? 0) >= 5, `${failure} was met in too few seeds: ${JSON.stringify(met)}`);
  }
  assert.ok(Object.entries(met).some(([name, count]) => name.endsWith('out of room') && count >= 5), `too few seeds ran out of room: ${JSON.stringify(met)}`);
  assert.ok(totals.written > 10_000 && totals.lists > 5_000, JSON.stringify(totals));
  // And what was received came as a socket gives it, to sessions of both kinds.
  assert.ok(totals.chunks > 5_000 && totals.cutShort > 2_000 && totals.severalAtOnce > 2_000, JSON.stringify(totals));
  assert.ok(totals.littleAtATime > SEEDS / 4 && totals.littleAtATime < SEEDS * 3 / 4, JSON.stringify(totals));
});
