// A fileStore's sent() against a memoryStore's, over random sequences of records given in lists of
// random length. A memoryStore with room for everything keeps the entries in a list and picks the
// latest of each MsgSeqNum from it, so it says what a fileStore must give however it writes and
// reads its file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dictionaryFor } from '../dictionary/index.ts';
import { buildFrame, parseFrame } from '../wire/frame.ts';
import { fromMessage, inspectMessage } from '../wire/message.ts';
import { recordLine } from './stored-entry.ts';
import { fileStore, memoryStore, safeFileName } from './store.ts';
import type { Entry, SessionId, Store, StoreRecord } from './types.ts';

const dict = dictionaryFor('FIX.4.4');
const id: SessionId = { version: 'FIX.4.4', sender: 'EXCHANGE', target: 'CLIENT' };
const at = new Date('2026-09-30T12:00:00.000Z');

/** Whole numbers from a seed, the same every run (mulberry32): `below(n)` is one of 0..n-1. */
function seeded(seed: number): { below(n: number): number } {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return { below: n => Math.floor(next() * n) };
}

/** A TestRequest numbered `seq` whose TestReqID is `label`: sent or received, with or without wire bytes, marked PossDupFlag or not. */
function message(direction: 'in' | 'out', seq: number, label: string, how: { possDup?: boolean; dropped?: boolean } = {}): Entry {
  const [sender, target] = direction === 'out' ? ['EXCHANGE', 'CLIENT'] : ['CLIENT', 'EXCHANGE'];
  const { fields, framing } = fromMessage('TestRequest', {
    SenderCompID: sender, TargetCompID: target, MsgSeqNum: seq, SendingTime: at, TestReqID: label, ...(how.possDup ? { PossDupFlag: true, OrigSendingTime: at } : {}),
  }, dict, { version: 'FIX.4.4' });
  const bytes = buildFrame(fields, framing);
  const decoded = inspectMessage(parseFrame(bytes).fields, dict).message;
  return how.dropped ? { kind: 'message', direction, at, message: decoded } : { kind: 'message', direction, at, message: decoded, bytes };
}

/** What sent() gives for a range, each as 'MsgSeqNum:TestReqID': the label tells which of several originals with one MsgSeqNum it is. */
async function sent(store: Store, from: number, to: number): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of store.sent(id, { from, to })) out.push(entry.kind === 'message' ? `${String(entry.message.MsgSeqNum)}:${String(entry.message.TestReqID)}` : entry.kind);
  return out;
}

interface Tally { records: number; backward: number; epochs: number; unnamed: number; asked: number; given: number; lists: number; crossing: number }

/**
 * One random session's records, appended to a fileStore and a memoryStore alike in lists of 1 to 40
 * (a record that begins an epoch anywhere in one), with sent() and the sequence numbers asked
 * of both along the way and of a fileStore that starts on the folder afterward. `unnamed` writes
 * some originals on lines that do not name their MsgSeqNum, behind the store's back. With `rarely`
 * above 1, only one in that many of the steps backward and new epochs it draws is made (the rest are
 * originals in order), so the runs in order between them are long, and sent() is asked less often.
 */
async function run(seed: number, length: number, unnamed: boolean, rarely: number, tally: Tally): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-differential-'));
  try {
    await runIn(dir, seed, length, unnamed, rarely, tally);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The session of run(), kept by a fileStore on the folder `dir`. */
async function runIn(dir: string, seed: number, length: number, unnamed: boolean, rarely: number, tally: Tally): Promise<void> {
  const random = seeded(seed);
  const files = fileStore(dir);
  const memory = memoryStore({ history: 1_000_000, historyBytes: 1_000_000_000 });
  let next = 1;
  let highest = 1;
  let epoch = 0;
  let labels = 0;
  const label = () => `u${++labels}`;
  /** The records of the list being gathered, and how many it will hold. */
  const pending: StoreRecord[] = [];
  let room = 1;
  const flush = async () => {
    if (pending.length === 0) return;
    const list = pending.splice(0);
    await files.append(id, list);
    await memory.append(id, list);
    tally.lists++;
    if (list.slice(1).some(record => record.newEpoch)) tally.crossing++;
    room = [1, 1, 2, 3, 5, 8, 40][random.below(7)]!;
  };
  const both = async (record: StoreRecord) => {
    if (epoch === 0 || record.newEpoch) epoch++;
    pending.push(record);
    tally.records++;
    if (pending.length >= room) await flush();
  };
  const original = (seq: number, extra: Partial<StoreRecord> = {}, how: { dropped?: boolean } = {}) => {
    highest = Math.max(highest, seq);
    return both({ at, entry: message('out', seq, label(), how), seqNums: { next, expected: 1 }, ...extra });
  };
  const compare = async (store: Store, what: string) => {
    await flush();
    const { next: keptNext, expected: keptExpected } = await store.load(id);
    assert.deepEqual({ next: keptNext, expected: keptExpected }, await memory.load(id).then(({ next: n, expected: e }) => ({ next: n, expected: e })), `seed ${seed}, ${what}, after ${tally.records} records in all: the sequence numbers`);
    const ranges: [number, number][] = [[1, Number.MAX_SAFE_INTEGER]];
    for (let each = 0; each < 6; each++) {
      const from = 1 + random.below(highest + 3);
      ranges.push([from, from + [0, 0, 1, 5, 40, highest][random.below(6)]!]);
    }
    for (const [from, to] of ranges) {
      const expected = await sent(memory, from, to);
      assert.deepEqual(await sent(store, from, to), expected, `seed ${seed}, ${what}, after ${tally.records} records in all: sent ${from}..${to}`);
      tally.asked++;
      tally.given += expected.length;
    }
  };
  for (let step = 0; step < length; step++) {
    let roll = random.below(100);
    if (rarely > 1 && (roll < 63 || roll >= 96) && random.below(rarely) > 0) roll = 0;
    if (roll < 50) {
      await original(next++);
    } else if (roll < 55) {
      // A step backward, as setSeqNums makes one: a record of sequence numbers alone, then the numbers are used again.
      next = 1 + random.below(next);
      await both({ at, seqNums: { next, expected: 1 } });
      tally.backward++;
    } else if (roll < 59) {
      await original(next + 1 + random.below(500));          // a MsgSeqNum written by hand, high
    } else if (roll < 63) {
      await original(1 + random.below(next));                // and low
      tally.backward++;
    } else if (roll < 66) {
      next += 1 + random.below(5);                           // numbers no message carries
      await both({ at, seqNums: { next, expected: 1 } });
    } else if (roll < 73) {
      await both({ at, entry: message('out', 1 + random.below(highest), label(), { possDup: true }), seqNums: { next, expected: 1 } });
    } else if (roll < 82) {
      await both({ at, entry: message('in', 1 + random.below(highest + 5), label()), seqNums: { next, expected: 1 } });
    } else if (roll < 85) {
      await both({ at, seqNums: { next, expected: 1 } });
    } else if (roll < 87) {
      await both({ at, entry: { kind: 'error', at, text: 'a handler threw' }, seqNums: { next, expected: 1 } });
    } else if (roll < 90) {
      await original(next++, {}, { dropped: true });         // kept without wire bytes
    } else if (roll < 96) {
      if (unnamed && epoch > 0) {
        // A line as it was written before lines named their MsgSeqNum, put in the file behind the store's back.
        const seq = next++;
        highest = Math.max(highest, seq);
        const record: StoreRecord = { at, entry: message('out', seq, label()), seqNums: { next, expected: 1 } };
        const line = recordLine(record, dict);
        assert.match(line, /"seq":\d+,/);
        await flush();
        await appendFile(join(dir, safeFileName(id), `${epoch}.jsonl`), `${line.replace(/"seq":\d+,/, '')}\n`);
        await memory.append(id, [record]);
        // The store did not write that line: it finds the file longer than it remembers, as when another store appends to it.
        tally.records++;
        tally.unnamed++;
      } else {
        await original(next++);
      }
    } else if (roll < 99) {
      await original(next++);
    } else if (random.below(2) === 0) {
      // A reset the other side asked for: its Logon begins the epoch, messages numbered in the sequence before it are kept after it, then the numbers begin at 1.
      await both({ at, entry: message('in', 1, label()), seqNums: { next: 1, expected: 2 }, newEpoch: true });
      highest = 1;
      for (let late = random.below(6); late > 0; late--) await original(next++);
      next = 1;
      tally.epochs++;
    } else {
      next = 1;                                              // a reset of our own: its first message begins the epoch
      highest = 1;
      await original(next++, { newEpoch: true });
      tally.epochs++;
    }
    if (random.below(rarely > 1 ? 400 : 8) === 0) await compare(files, 'the store that appended');
  }
  await compare(files, 'the store that appended');
  await compare(fileStore(dir), 'a store started on the folder');
}

test('fileStore.sent() gives what memoryStore.sent() gives, entry for entry, and load() the same sequence numbers, over random lists of records: steps backward, MsgSeqNums written by hand, lines that name no MsgSeqNum, copies, received messages, records with no entry, new epochs', { timeout: 120_000 }, async () => {
  const tally: Tally = { records: 0, backward: 0, epochs: 0, unnamed: 0, asked: 0, given: 0, lists: 0, crossing: 0 };
  for (let seed = 1; seed <= 60; seed++) await run(seed, 250, seed % 3 === 0, 1, tally);
  // Long enough for the places remembered to pass 1,024 and be halved, with steps backward among them.
  for (let seed = 101; seed <= 102; seed++) await run(seed, 6_000, false, 150, tally);
  // The sequences did hold what the test is for.
  assert.ok(tally.backward > 1_000 && tally.epochs > 100 && tally.unnamed > 200 && tally.given > 150_000, JSON.stringify(tally));
  // And they were given in lists, some of which began an epoch part-way through.
  assert.ok(tally.lists > 2_000 && tally.lists < tally.records / 2 && tally.crossing > 40, JSON.stringify(tally));
});
