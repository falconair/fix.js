import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFrame } from './frame.ts';
import { FrameSplitter, frames } from './splitter.ts';

const frame = (seq: number) => Buffer.from(buildFrame([
  { tag: 8, value: 'FIX.4.4' }, { tag: 35, value: '0' }, { tag: 49, value: 'ME' },
  { tag: 56, value: 'EXCHANGE' }, { tag: 34, value: String(seq) },
]));
const stream = Buffer.concat([frame(1), frame(2), frame(3)]);

test('finds every frame, wherever the bytes are split', () => {
  for (let cut = 1; cut < stream.length; cut++) {
    const splitter = new FrameSplitter();
    const got = [...splitter.push(stream.subarray(0, cut)), ...splitter.push(stream.subarray(cut))];
    assert.deepEqual(got.map(f => f.valid), [true, true, true], `split at byte ${cut}`);
    assert.deepEqual(Buffer.concat(got.map(f => f.bytes)), stream);
  }
});

test('one byte at a time', () => {
  const splitter = new FrameSplitter();
  const got = [...stream].flatMap(byte => splitter.push(Uint8Array.of(byte)));
  assert.equal(got.length, 3);
  assert.ok(got.every(f => f.valid));
});

test('bytes before a frame are reported and skipped', () => {
  const got = new FrameSplitter().push(Buffer.concat([Buffer.from('hello\n'), frame(1)]));
  assert.equal(got[0]?.valid, false);
  assert.equal(got[0]?.error, 'Bytes before BeginString (8=FIX)');
  assert.deepEqual(got.at(-1), { bytes: frame(1), valid: true });
});

test('a bad checksum marks that frame invalid; the next one is fine', () => {
  const bad = frame(2);
  bad.write('000', bad.length - 4, 'latin1');
  const got = new FrameSplitter().push(Buffer.concat([frame(1), bad, frame(3)]));
  assert.deepEqual(got.map(f => f.valid), [true, false, true]);
  assert.match(got[1]?.error ?? '', /^CheckSum is 000 but should be \d{3}$/);
});

test('an absurd BodyLength is refused at once, not buffered', () => {
  const got = new FrameSplitter({ maxMessageSize: 1024 }).push(Buffer.concat([Buffer.from('8=FIX.4.4\x019=99999999\x01'), frame(1)]));
  assert.equal(got[0]?.valid, false);
  assert.match(got[0]?.error ?? '', /exceeds the 1024-byte limit/);
  assert.equal(got.at(-1)?.valid, true);
});

test('a BodyLength that points at the wrong place is refused; the stream recovers', () => {
  const lying = Buffer.from(Buffer.from(frame(1)).toString('latin1').replace(/9=\d+/, '9=5'), 'latin1');
  const got = new FrameSplitter().push(Buffer.concat([lying, frame(2)]));
  assert.equal(got[0]?.valid, false);
  assert.deepEqual(got.at(-1), { bytes: frame(2), valid: true });
});

test('works over an async stream of chunks', async () => {
  async function* chunks() { yield stream.subarray(0, 10); yield stream.subarray(10); }
  const got = [];
  for await (const f of frames(chunks())) got.push(f);
  assert.equal(got.length, 3);
});

test('a large frame pushed one byte at a time takes time in proportion to its length', () => {
  const big = Buffer.from(buildFrame([
    { tag: 8, value: 'FIX.4.4' }, { tag: 35, value: '0' }, { tag: 49, value: 'ME' },
    { tag: 56, value: 'EXCHANGE' }, { tag: 34, value: '1' }, { tag: 58, value: 'x'.repeat(60_000) },
  ]));
  assert.ok(big.length >= 60_000, `frame is only ${big.length} bytes`);
  const split = () => {
    const splitter = new FrameSplitter({ maxMessageSize: big.length + 1024 });
    const start = performance.now();
    const got = [...big].flatMap(byte => splitter.push(Uint8Array.of(byte)));
    const elapsed = performance.now() - start;
    assert.equal(got.length, 1);
    assert.equal(got[0]?.valid, true);
    assert.deepEqual(got[0]?.bytes, big);
    return elapsed;
  };
  // The same bytes, one at a time, only kept: linear by construction, and slowed by the same load as the splitter.
  const keep = () => {
    const kept: Buffer[] = [];
    const start = performance.now();
    for (const byte of big) kept.push(Buffer.from(Uint8Array.of(byte)));
    return performance.now() - start;
  };
  const fastest = (run: () => number) => Math.min(run(), run(), run());
  fastest(keep);
  fastest(split);
  const [baseline, elapsed] = [fastest(keep), fastest(split)];
  // About 2× the baseline when linear; a splitter that copies everything buffered on every push takes about 20×.
  assert.ok(elapsed < 6 * baseline, `took ${elapsed.toFixed(1)} ms, ${(elapsed / baseline).toFixed(1)}× the ${baseline.toFixed(1)} ms baseline`);
});

test('maxMessageSize must be a finite integer of at least 64', () => {
  assert.throws(() => new FrameSplitter({ maxMessageSize: NaN }), RangeError);
  assert.throws(() => new FrameSplitter({ maxMessageSize: 0 }), RangeError);
  assert.throws(() => new FrameSplitter({ maxMessageSize: -1 }), RangeError);
  assert.throws(() => new FrameSplitter({ maxMessageSize: 1.5 }), RangeError);
  assert.doesNotThrow(() => new FrameSplitter({ maxMessageSize: 64 }));
});

test('a BodyLength with a leading zero is refused, like parseFrame would refuse it', () => {
  const withLeadingZero = Buffer.from('8=FIX.4.4\x019=05\x0135=0\x0110=000\x01');
  const got = new FrameSplitter().push(withLeadingZero);
  assert.equal(got[0]?.valid, false);
  assert.equal(got[0]?.error, "BodyLength '05' has a leading zero");
});

test('any BeginString, including FIXT.1.1', () => {
  const fixt = Buffer.from(buildFrame([{ tag: 8, value: 'FIXT.1.1' }, { tag: 35, value: '0' }]));
  assert.deepEqual(new FrameSplitter().push(fixt), [{ bytes: fixt, valid: true }]);
});

// ─── Bytes added and taken a frame at a time ────────────────────────────────

test('bytes added are split only when they are taken: take() gives their frames one at a time, in order, and undefined once only the beginning of a frame is left', () => {
  const splitter = new FrameSplitter();
  splitter.add(Buffer.concat([frame(1), frame(2), frame(3).subarray(0, 20)]));
  assert.equal(splitter.length, frame(1).length + frame(2).length + 20, 'nothing is split by adding');
  assert.deepEqual(splitter.take(), { bytes: frame(1), valid: true });
  assert.equal(splitter.length, frame(2).length + 20);
  assert.deepEqual(splitter.take(), { bytes: frame(2), valid: true });
  assert.equal(splitter.take(), undefined);
  assert.equal(splitter.take(), undefined);
  assert.equal(splitter.length, 20, 'the beginning of the third stays');
  splitter.add(frame(3).subarray(20));
  splitter.add(frame(4));
  assert.deepEqual([splitter.take(), splitter.take(), splitter.take()], [{ bytes: frame(3), valid: true }, { bytes: frame(4), valid: true }, undefined]);
  assert.equal(splitter.length, 0);
});

test('what was added and not taken comes first when more is pushed, and bytes that are no frame count toward length until they are taken as one', () => {
  const splitter = new FrameSplitter();
  splitter.add(new Uint8Array(0));
  assert.equal(splitter.length, 0);
  splitter.add(Buffer.from('hello\n'));
  splitter.add(frame(1));
  assert.equal(splitter.length, 6 + frame(1).length);
  const got = splitter.push(frame(2));
  assert.deepEqual(got.map(each => each.valid), [false, true, true]);
  assert.deepEqual(Buffer.concat(got.map(each => each.bytes)), Buffer.concat([Buffer.from('hello\n'), frame(1), frame(2)]));
  assert.equal(splitter.length, 0);
});

test('clear() drops what was added and not taken, the beginning of a frame included: what is added next is read from its own first byte', () => {
  const long = Buffer.from(buildFrame([{ tag: 8, value: 'FIX.4.4' }, { tag: 35, value: '0' }, { tag: 112, value: 'x'.repeat(500) }]));
  const splitter = new FrameSplitter();
  splitter.add(frame(1));
  splitter.add(long.subarray(0, 40));
  assert.deepEqual(splitter.take(), { bytes: frame(1), valid: true });
  assert.equal(splitter.take(), undefined, 'the long frame is not whole yet');
  splitter.clear();
  assert.equal(splitter.length, 0);
  assert.equal(splitter.take(), undefined);
  // Shorter than what the dropped frame still waited for.
  splitter.add(frame(2));
  assert.deepEqual(splitter.take(), { bytes: frame(2), valid: true });
  assert.equal(splitter.length, 0);
  // Dropped while its last buffer still had room: nothing of that buffer is left either.
  splitter.add(long.subarray(0, 300));
  splitter.add(long.subarray(300, 310));
  assert.equal(splitter.buffers.count, 2);
  splitter.clear();
  assert.deepEqual([splitter.length, splitter.buffers], [0, { count: 0, capacity: 0 }]);
  splitter.add(frame(3));
  splitter.add(frame(4).subarray(0, 5));
  splitter.add(frame(4).subarray(5));
  assert.deepEqual([splitter.take(), splitter.take(), splitter.take()], [{ bytes: frame(3), valid: true }, { bytes: frame(4), valid: true }, undefined]);
});

// --- What the bytes held cost: buffers, not chunks ---

/** A Heartbeat whose TestReqID makes it about `bytes` long. */
const long = (seq: number, bytes: number) => Buffer.from(buildFrame([
  { tag: 8, value: 'FIX.4.4' }, { tag: 35, value: '0' }, { tag: 34, value: String(seq) }, { tag: 112, value: 'x'.repeat(bytes) },
]));

test('bytes added one at a time and not taken are held in a few buffers with room for no more than twice the bytes, and 64 KiB past them at most: not in a buffer for each chunk', () => {
  const splitter = new FrameSplitter();
  const all = Buffer.concat(Array.from({ length: 2_000 }, (_, n) => long(n + 1, 500)));
  assert.ok(all.length > 1_000_000);
  for (let n = 0; n < all.length; n++) {
    splitter.add(all.subarray(n, n + 1));
    if (n === 999 || n === 99_999) {
      const { count, capacity } = splitter.buffers;
      assert.ok(count <= 16 && capacity <= 2 * splitter.length + 64, `${splitter.length} bytes held in ${count} buffers with room for ${capacity}`);
    }
  }
  const { count, capacity } = splitter.buffers;
  assert.equal(splitter.length, all.length);
  assert.ok(count <= 40, `${all.length} bytes held in ${count} buffers`);
  assert.ok(capacity <= all.length + 65_536, `${all.length} bytes held with room for ${capacity}`);
  // No buffer was made larger than 64 KiB, so none was ever copied into a larger one as bytes came.
  assert.ok(count >= all.length / 65_536, `${count} buffers`);
  const got: Buffer[] = [];
  for (let next = splitter.take(); next; next = splitter.take()) {
    assert.equal(next.valid, true);
    got.push(Buffer.from(next.bytes));
  }
  assert.equal(got.length, 2_000);
  assert.ok(Buffer.concat(got).equals(all));
  assert.deepEqual([splitter.length, splitter.buffers], [0, { count: 0, capacity: 0 }]);
});

test('one large frame that arrives a byte at a time, looked for after every byte, is held in a few buffers with room for no more than twice its bytes, and comes out whole', () => {
  const splitter = new FrameSplitter();
  const big = long(1, 65_000);
  let most = { count: 0, capacity: 0, length: 0 };
  for (let n = 0; n < big.length - 1; n++) {
    splitter.add(big.subarray(n, n + 1));
    assert.equal(splitter.take(), undefined);
    const { count, capacity } = splitter.buffers;
    if (count > most.count) most = { count, capacity, length: splitter.length };
    if (capacity > 2 * splitter.length + 64) assert.fail(`${splitter.length} bytes held with room for ${capacity}`);
  }
  assert.ok(most.count <= 16, `at most ${most.count} buffers (with ${most.length} bytes held)`);
  splitter.add(big.subarray(big.length - 1));
  const frame = splitter.take();
  assert.equal(frame?.valid, true);
  assert.ok(Buffer.from(frame!.bytes).equals(big));
  assert.deepEqual(splitter.buffers, { count: 0, capacity: 0 });
});

test('a chunk added to an empty splitter, or one as large as all it holds, is kept as it is, with no room to spare; a smaller one begins a buffer with room for as much as is held', () => {
  const splitter = new FrameSplitter();
  const one = long(1, 300);
  splitter.add(one.subarray(0, 100));
  assert.deepEqual(splitter.buffers, { count: 1, capacity: 100 });
  splitter.add(one.subarray(100, 200));
  assert.deepEqual(splitter.buffers, { count: 2, capacity: 200 });
  splitter.add(one.subarray(200, 210));
  assert.deepEqual(splitter.buffers, { count: 3, capacity: 400 }, 'ten bytes in a buffer with room for 200');
  splitter.add(one.subarray(210));
  assert.deepEqual(splitter.buffers, { count: 3, capacity: 400 }, 'the rest fits beside them');
  assert.deepEqual(splitter.take(), { bytes: one, valid: true });
  assert.deepEqual(splitter.buffers, { count: 0, capacity: 0 });
});

test('a frame taken is not changed by what is added afterwards, and the bytes given to add() may be reused by the caller', () => {
  const splitter = new FrameSplitter();
  const big = long(1, 3_000);
  const scratch = Buffer.alloc(7);
  const taken: Buffer[] = [];
  const stream = Buffer.concat([big, long(2, 40), long(3, 3_000), long(4, 10)]);
  for (let at = 0; at < stream.length; at += scratch.length) {
    const n = stream.copy(scratch, 0, at, at + scratch.length);
    splitter.add(scratch.subarray(0, n));
    scratch.fill(0x2a, 0, n);
    if (at % 3 === 0) for (let next = splitter.take(); next; next = splitter.take()) taken.push(next.bytes as Buffer);
  }
  for (let next = splitter.take(); next; next = splitter.take()) taken.push(next.bytes as Buffer);
  assert.equal(taken.length, 4);
  assert.ok(Buffer.concat(taken).equals(stream));
});

test('however the bytes are cut into chunks and whenever frames are taken, the frames are those of the bytes given whole', () => {
  let seed = 12345;
  const random = (below: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % below; };
  for (let round = 0; round < 60; round++) {
    const stream = Buffer.concat(Array.from({ length: 30 }, (_, n) => (random(5) === 0 ? Buffer.from('junk') : long(n + 1, random(4) === 0 ? 2_000 + random(3_000) : random(120)))));
    const whole = new FrameSplitter().push(stream);
    const splitter = new FrameSplitter();
    const got: { bytes: Buffer; valid: boolean }[] = [];
    const most = [1, 3, 50, 700, 5_000][round % 5]!;
    for (let at = 0; at < stream.length;) {
      const n = 1 + random(most);
      splitter.add(stream.subarray(at, at + n));
      at += n;
      for (let next = random(3) > 0 ? splitter.take() : undefined; next; next = random(6) > 0 ? splitter.take() : undefined) got.push({ bytes: Buffer.from(next.bytes), valid: next.valid });
      if (splitter.buffers.capacity > 2 * splitter.length + 64) assert.fail(`round ${round}: ${splitter.length} bytes held with room for ${splitter.buffers.capacity}`);
    }
    for (let next = splitter.take(); next; next = splitter.take()) got.push({ bytes: Buffer.from(next.bytes), valid: next.valid });
    assert.ok(Buffer.concat(got.map(each => each.bytes)).equals(Buffer.concat(whole.map(each => Buffer.from(each.bytes)))), `round ${round}: every byte, in order`);
    assert.deepEqual(got.filter(each => each.valid).map(each => each.bytes.toString('latin1')), whole.filter(each => each.valid).map(each => Buffer.from(each.bytes).toString('latin1')), `round ${round}: the same frames`);
  }
});
