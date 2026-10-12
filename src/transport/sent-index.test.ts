import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CHECKPOINTS, SentIndex } from './sent-index.ts';

/** An index of originals 1..count, each line 100 bytes long, the first at byte 50. */
function indexOf(count: number): SentIndex {
  const index = new SentIndex();
  for (let seq = 1; seq <= count; seq++) index.note(seq, 50 + (seq - 1) * 100);
  return index;
}

test('a sent index marks every original until it holds 1,024 places', () => {
  const index = indexOf(MAX_CHECKPOINTS);
  assert.deepEqual([index.places, index.stride, index.highest, index.regular], [1_024, 1, 1_024, true]);
  assert.equal(index.startFor(1), 50);
  assert.equal(index.startFor(700), 50 + 699 * 100);
  assert.equal(index.startFor(5_000), 50 + 1_023 * 100);
});

test('a full sent index drops every other place and marks half as often, so it never holds more than 1,024', () => {
  const index = indexOf(1_025);
  assert.deepEqual([index.places, index.stride], [513, 2]);
  for (let seq = 1_026; seq <= 100_000; seq++) {
    index.note(seq, 50 + (seq - 1) * 100);
    assert.ok(index.places <= MAX_CHECKPOINTS, `${index.places} places after ${seq} originals`);
  }
  assert.deepEqual([index.places, index.stride, index.highest, index.regular], [782, 128, 100_000, true]);
  // The place to begin reading for a MsgSeqNum is the last one marked at or below it: never past it, and less than one stride before.
  for (const from of [1, 2, 128, 129, 130, 77_777, 99_999, 100_000, 100_001]) {
    const start = index.startFor(from);
    const marked = (start - 50) / 100 + 1;
    assert.ok(marked <= Math.max(from, 1) && Math.min(from, 100_000) - marked < 128, `from ${from} begins at original ${marked}`);
    assert.equal((marked - 1) % 128, 0);
  }
});

test('a sent index with nothing in it begins at the start of the file, and so does a MsgSeqNum below its first original', () => {
  assert.equal(new SentIndex().startFor(7), 0);
  const index = new SentIndex();
  index.note(10, 300);
  index.note(11, 400);
  assert.equal(index.startFor(3), 0);
  assert.equal(index.startFor(10), 300);
});

test('a sent index stops being regular at an original whose MsgSeqNum is not higher than the one before, and stays so', () => {
  const index = indexOf(5);
  index.note(5, 550);
  assert.deepEqual([index.regular, index.highest], [false, 5]);
  index.note(6, 650);
  index.note(100, 750);
  index.note(7, 850);
  assert.deepEqual([index.regular, index.highest], [false, 100]);
});

test('a sent index follows the latest run in MsgSeqNum order: at a MsgSeqNum not higher than the one before, it begins again from that line', () => {
  const index = indexOf(2_000);                        // 1..2,000: past 1,024 places, so one in two is marked
  assert.deepEqual([index.places, index.stride], [1_000, 2]);
  index.note(500, 900_000);                            // a step backward
  assert.deepEqual([index.places, index.stride, index.highest, index.regular], [1, 1, 2_000, false]);
  for (let seq = 501; seq <= 600; seq++) index.note(seq, 900_000 + (seq - 500) * 100);
  assert.deepEqual([index.places, index.stride], [101, 1]);
  // Reading for any MsgSeqNum begins in the latest run: at its first line for one below it, at the place marked for one in it.
  assert.equal(index.startFor(1), 900_000);
  assert.equal(index.startFor(499), 900_000);
  assert.equal(index.startFor(550), 900_000 + 50 * 100);
  assert.equal(index.startFor(9_999), 900_000 + 100 * 100);
});

test('a sent index plans the part before the latest run only for MsgSeqNums that part could hold and the run is not known to hold', () => {
  const index = new SentIndex();
  assert.deepEqual(index.plan(1, 9), { start: 0, first: 0 });
  for (let seq = 605; seq <= 644; seq++) index.note(seq, 100 * (seq - 604));          // 605..644, then 1..700
  assert.deepEqual(index.plan(1, 999), { start: 0, first: 605 });                         // no step backward yet: the run is the whole file
  for (let seq = 1; seq <= 100; seq++) index.note(seq, 5_000 + 100 * seq);
  const except = { from: 1, to: 100 };
  assert.deepEqual(index.plan(1, 100), { start: 5_100, first: 1 });                       // the run holds every one
  assert.deepEqual(index.plan(50, 60), { start: 10_000, first: 1 });
  assert.deepEqual(index.plan(101, 604), { start: 15_000, first: 1 });                    // neither part could hold one
  assert.deepEqual(index.plan(645, 9_999), { start: 15_000, first: 1 });
  assert.deepEqual(index.plan(1, 9_999), { start: 5_100, first: 1, earlier: { end: 5_100, from: 605, to: 644, except } });
  assert.deepEqual(index.plan(610, 610), { start: 15_000, first: 1, earlier: { end: 5_100, from: 610, to: 610, except } });
  for (let seq = 101; seq <= 700; seq++) index.note(seq, 5_000 + 100 * seq);
  assert.deepEqual(index.plan(610, 610), { start: 5_000 + 61_000, first: 1 });            // the run has reached it
  assert.deepEqual(index.plan(1, 9_999), { start: 5_100, first: 1 });
  assert.equal(index.regular, false);
});

test('a sent index knows the latest run holds every MsgSeqNum only from the last one that did not follow the one before by 1', () => {
  const index = indexOf(1_000);
  index.note(5, 200_000);              // written by hand, low: the run begins again at it
  index.note(1_001, 200_100);          // and goes on from 1,001: 5 and 1,001 are not neighbours
  index.note(1_002, 200_200);
  const except = { from: 1_001, to: 1_002 };
  assert.deepEqual(index.plan(1_001, 1_002), { start: 200_100, first: 5 });
  assert.deepEqual(index.plan(1, 2_000), { start: 200_000, first: 5, earlier: { end: 200_000, from: 1, to: 1_000, except } });
  assert.deepEqual(index.plan(5, 5), { start: 200_000, first: 5, earlier: { end: 200_000, from: 5, to: 5, except } });   // the earlier part is read, and the run's own wins
  assert.deepEqual(index.plan(900, 1_001), { start: 200_000, first: 5, earlier: { end: 200_000, from: 900, to: 1_000, except } });
});

test('a sent index keeps the lowest and highest MsgSeqNum of everything before the latest run through several steps backward, at a fixed size', () => {
  const index = new SentIndex();
  let offset = 0;
  const note = (seq: number) => { index.note(seq, offset); offset += 100; };
  for (const seq of [50, 51, 52]) note(seq);
  for (const seq of [10, 11]) note(seq);               // a step backward
  for (const seq of [900, 30]) note(seq);              // a high one by hand, and another step backward
  for (const seq of [31, 32]) note(seq);
  assert.deepEqual([index.highest, index.regular, index.places], [900, false, 3]);
  assert.deepEqual(index.plan(1, 9_999), { start: 600, first: 30, earlier: { end: 600, from: 10, to: 900, except: { from: 30, to: 32 } } });
  assert.deepEqual(index.plan(1, 9), { start: 600, first: 30 });
  assert.deepEqual(index.plan(31, 32), { start: 700, first: 30 });
  // Every original a step backward: the run is one line each time, and nothing grows.
  note(5_000);
  for (let seq = 4_999; seq >= 1; seq--) {
    note(seq);
    assert.equal(index.places, 1);
  }
  assert.deepEqual(index.plan(2, 3), { start: offset - 100, first: 1, earlier: { end: offset - 100, from: 2, to: 3, except: { from: 1, to: 1 } } });
});
