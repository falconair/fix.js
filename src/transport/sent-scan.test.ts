import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LowestOriginals, SENT_BATCH, type OriginalLine } from './sent-scan.ts';

/** The line of the `nth` original noted, 100 bytes long. */
const line = (seq: number, nth: number): OriginalLine => ({ seq, start: nth * 100, length: 100 });

test('looking for the lowest originals of a range never holds more than 8,192 places, however many originals the range holds', () => {
  const count = 50_000;
  const lowest = new LowestOriginals(1, Number.MAX_SAFE_INTEGER);
  let most = 0;
  // Every MsgSeqNum from 1 to 50,000 once, in an order that is neither rising nor falling.
  for (let nth = 0; nth < count; nth++) {
    lowest.note(line(1 + (nth * 7_919) % count, nth));
    most = Math.max(most, lowest.places);
  }
  assert.equal(2 * SENT_BATCH, 8_192);
  assert.ok(most <= 8_192 && most > SENT_BATCH, `held ${most} places at most`);
  const { lines, more } = lowest.found();
  assert.deepEqual(lines.map(each => each.seq), Array.from({ length: SENT_BATCH }, (_, index) => index + 1));
  assert.equal(more, true);
});

test('the lowest originals of a range are the latest noted of each MsgSeqNum, in MsgSeqNum order, without those of the range left out', () => {
  const lowest = new LowestOriginals(3, 20, { from: 10, to: 12 });
  [9, 2, 3, 10, 12, 21, 13, 9, 11, 20, 3].forEach((seq, nth) => lowest.note(line(seq, nth)));
  assert.deepEqual(lowest.found(), { lines: [line(3, 10), line(9, 7), line(13, 6), line(20, 9)], more: false });
  assert.deepEqual(new LowestOriginals(1, 9).found(), { lines: [], more: false });
});

test('the lowest originals found are one batch of 4,096, and say when the range may hold more above them', () => {
  const some = new LowestOriginals(1, 10_000);
  for (let seq = SENT_BATCH; seq >= 1; seq--) some.note(line(seq, SENT_BATCH - seq));
  assert.deepEqual([some.found().lines.length, some.found().more], [SENT_BATCH, false]);
  some.note(line(SENT_BATCH + 1, SENT_BATCH));
  assert.deepEqual([some.found().lines.length, some.found().lines.at(-1)!.seq, some.found().more], [SENT_BATCH, SENT_BATCH, true]);
});
