import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARRIVAL_MARKS, Arrivals } from './arrivals.ts';
import { countingDrops } from './fixtures.ts';

const T = Date.parse('2026-09-30T12:00:00.000Z');

test('the times of arrival kept are 128 at most', () => {
  assert.equal(ARRIVAL_MARKS, 128);
});

test('bytes are judged by the time noted for the chunk that brought the last of them: a message across two chunks by the second, and one that ends where a chunk ends by that chunk', () => {
  const arrivals = new Arrivals();
  arrivals.note(10, T);
  arrivals.note(10, T + 5000);
  arrivals.note(10, T + 9000);
  assert.equal(arrivals.marks, 3);
  assert.equal(arrivals.take(4), T);
  assert.equal(arrivals.take(6), T, 'its last byte is the first chunk\'s last');
  assert.equal(arrivals.marks, 2, 'the time of bytes all taken is dropped');
  assert.equal(arrivals.take(1), T + 5000);
  assert.equal(arrivals.take(12), T + 9000, 'begun in the second chunk, ended in the third');
  assert.equal(arrivals.marks, 1);
  assert.equal(arrivals.take(7), T + 9000);
  assert.equal(arrivals.marks, 0);
});

test('one take that passes several times of arrival drops them together and is judged by the last it reaches', () => {
  const arrivals = new Arrivals();
  for (let n = 0; n < 50; n++) arrivals.note(10, T + n * 1000);
  let got: number | undefined;
  const { shifts, splices } = countingDrops(() => { got = arrivals.take(395); });
  assert.deepEqual([got, arrivals.marks, shifts, splices], [T + 39_000, 11, 0, 1]);
  assert.equal(arrivals.take(5), T + 39_000);
  assert.equal(arrivals.take(1), T + 40_000);
  assert.equal(arrivals.marks, 10);
});

test('bytes that arrive within one second of the clock share one time, that of the last of them', () => {
  const arrivals = new Arrivals();
  arrivals.note(10, T + 100);
  arrivals.note(10, T + 900);
  arrivals.note(10, T + 1000);
  assert.equal(arrivals.marks, 2);
  assert.equal(arrivals.take(10), T + 900);
  assert.equal(arrivals.take(10), T + 900);
  assert.equal(arrivals.take(10), T + 1000);
});

test('bytes noted without a time are judged by the next time noted after them, and by none when there is none', () => {
  const arrivals = new Arrivals();
  arrivals.note(10);
  assert.equal(arrivals.take(10), undefined);
  arrivals.note(10);
  arrivals.note(10, T + 3000);
  assert.equal(arrivals.take(10), T + 3000);
  assert.equal(arrivals.take(10), T + 3000);
  assert.equal(arrivals.marks, 0);
});

test('however many seconds the bytes held arrived in, no more than 128 times are kept, and taking them all drops them at once: the same work after 1,000 seconds as after 100,000', () => {
  const work: number[] = [];
  for (const seconds of [1000, 100_000]) {
    const arrivals = new Arrivals();
    let most = 0;
    for (let n = 0; n < seconds; n++) {
      arrivals.note(1, T + n * 1000);
      most = Math.max(most, arrivals.marks);
    }
    assert.equal(most, 128);
    let got: number | undefined;
    const { shifts, splices } = countingDrops(() => { got = arrivals.take(seconds); });
    assert.deepEqual([got, arrivals.marks, shifts], [T + (seconds - 1) * 1000, 0, 0]);
    work.push(splices);
  }
  assert.deepEqual(work, [1, 1]);
});

test('while the bytes held arrived in 128 different seconds or fewer, each is judged to the second', () => {
  const arrivals = new Arrivals();
  for (let n = 0; n < 128; n++) arrivals.note(3, T + n * 7000 + 500);
  assert.equal(arrivals.marks, 128);
  for (let n = 0; n < 128; n++) assert.equal(arrivals.take(3), T + n * 7000 + 500);
});

test('past 128, the two neighbours that arrived closest together share the later one\'s time: bytes that came in a burst lose seconds, and those that came minutes apart lose nothing', () => {
  const arrivals = new Arrivals();
  // 100 chunks a minute apart, then a burst of 60 a second apart, then 20 more a minute apart.
  const at: number[] = [];
  for (let n = 0; n < 100; n++) at.push(T + n * 60_000);
  for (let n = 0; n < 60; n++) at.push(at.at(-1)! + 1000);
  for (let n = 0; n < 20; n++) at.push(at.at(-1)! + 60_000);
  for (const time of at) arrivals.note(1, time);
  assert.equal(arrivals.marks, 128);
  const late = at.map(time => arrivals.take(1)! - time);
  assert.ok(late.every(ms => ms >= 0), 'none judged before it arrived');
  assert.deepEqual(late.slice(0, 99), Array.from({ length: 99 }, () => 0));
  assert.deepEqual(late.slice(160), Array.from({ length: 20 }, () => 0));
  // The 128 were full 29 seconds into the burst, and its seconds were joined as they came: the early ones more than once.
  assert.ok(Math.max(...late) <= 8000, `at most ${Math.max(...late)} ms late`);
  assert.ok(late.filter(ms => ms > 0).length >= 52);
});

test('whatever arrives and is taken, in any order: bytes are never judged before the last of them arrived, never after the newest time noted, and later than they arrived by no more than a second or a sixtieth of the longest time the bytes held have arrived across', () => {
  let seed = 12345;
  const random = (below: number) => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % below; };
  for (let round = 0; round < 40; round++) {
    const arrivals = new Arrivals();
    const held: number[] = [];   // for each byte held, when it arrived
    let from = 0;                // the first byte of `held` not yet taken
    let now = T + random(1000);
    let widest = 0;              // the longest time the bytes held have arrived across
    let merged = false;
    for (let step = 0; step < 4000; step++) {
      const quiet = round % 4 === 0 ? 1 : random(3);
      if (quiet !== 0 || held.length === from) {
        // Mostly a second or so apart; sometimes minutes; sometimes within the same second.
        now += [0, 300, 1000, 1000, 1000, 2500, 90_000][round % 2 === 0 ? 2 + random(2) : random(7)]!;
        const bytes = 1 + random(40);
        for (let n = 0; n < bytes; n++) held.push(now);
        arrivals.note(bytes, now);
        widest = Math.max(widest, now - held[from]!);
        assert.ok(arrivals.marks <= 128);
        if (arrivals.marks === 128) merged = true;
      } else {
        const bytes = Math.min(held.length - from, 1 + random(round % 3 === 0 ? 30 : 400));
        from += bytes;
        const truth = held[from - 1]!;
        const got = arrivals.take(bytes)!;
        assert.ok(got >= truth, `judged ${truth - got} ms before its last byte arrived`);
        assert.ok(got <= now, 'judged after the newest time noted');
        assert.ok(got - truth <= Math.max(999, widest / 60), `judged ${got - truth} ms late, with ${widest} ms held at most`);
        if (from === held.length) assert.equal(arrivals.marks, 0);
      }
    }
    if (round % 4 === 0) assert.ok(merged, 'this round fills the 128');
  }
});

test('clear forgets the times and the bytes they were for: what arrives next is judged by its own', () => {
  const arrivals = new Arrivals();
  for (let n = 0; n < 300; n++) arrivals.note(10, T + n * 1000);
  arrivals.take(15);
  arrivals.clear();
  assert.equal(arrivals.marks, 0);
  assert.equal(arrivals.take(0), undefined);
  arrivals.note(10, T + 900_000);
  arrivals.note(10, T + 905_000);
  assert.equal(arrivals.marks, 2);
  assert.equal(arrivals.take(10), T + 900_000);
  assert.equal(arrivals.take(10), T + 905_000);
});
