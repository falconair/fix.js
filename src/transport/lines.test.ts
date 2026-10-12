import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstLineStart, linesBackward, linesForward, type Line } from './lines.ts';

const CHUNK = 64 * 1024;

async function file(text: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'fixjs-lines-')), 'file.jsonl');
  await writeFile(path, text);
  return path;
}

async function all(lines: AsyncIterable<Line>): Promise<Line[]> {
  const out: Line[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

test('lines are read last first, with where each starts and whether a newline ends it', async () => {
  const path = await file('one\ntwo\n\nthree');
  assert.deepEqual(await all(linesBackward(path, 100)), [
    { text: 'three', start: 9, ended: false },
    { text: 'two', start: 4, ended: true },
    { text: 'one', start: 0, ended: true },
  ]);
});

test('lines are read first first, the same way', async () => {
  const path = await file('one\ntwo\n\nthree\n');
  assert.deepEqual(await all(linesForward(path, 100)), [
    { text: 'one', start: 0, ended: true },
    { text: 'two', start: 4, ended: true },
    { text: 'three', start: 9, ended: true },
  ]);
});

test('lines longer than a chunk are read whole, in both directions', async () => {
  const long = 'x'.repeat(150_000);
  const path = await file(`a\n${long}\nb\n`);
  assert.deepEqual((await all(linesBackward(path, 200_000))).map(line => [line.text.length, line.start]), [[1, 150_003], [150_000, 2], [1, 0]]);
  assert.deepEqual((await all(linesForward(path, 200_000))).map(line => [line.text.length, line.start]), [[1, 0], [150_000, 2], [1, 150_003]]);
});

test('a line longer than the limit is an error, in both directions', async () => {
  const path = await file(`a\n${'x'.repeat(100_000)}\nb\n`);
  await assert.rejects(all(linesBackward(path, 50_000)), /a line is longer than 50000 bytes/);
  await assert.rejects(all(linesForward(path, 50_000)), /a line is longer than 50000 bytes/);
});

test('reading backward can stop early', async () => {
  const path = await file(Array.from({ length: 10_000 }, (_, i) => `line ${i}`).join('\n'));
  const seen: string[] = [];
  for await (const line of linesBackward(path, 100)) {
    seen.push(line.text);
    if (seen.length === 2) break;
  }
  assert.deepEqual(seen, ['line 9999', 'line 9998']);
});

test('text other than ASCII is read as UTF-8', async () => {
  const path = await file('café\nnaïve\n');
  assert.deepEqual((await all(linesBackward(path, 100))).map(line => line.text), ['naïve', 'café']);
});

test('the start of a first line is read up to its newline, or up to the limit', async () => {
  assert.equal(await firstLineStart(await file('{"epoch":2}\n{"next":1}\n'), 100), '{"epoch":2}');
  assert.equal(await firstLineStart(await file('abcdefgh'), 4), 'abcd');
  assert.equal(await firstLineStart(join(tmpdir(), 'fixjs-no-such-file.jsonl'), 4), undefined);
});

test('a line longer than the limit is rejected even when it fits in one chunk, in both directions', async () => {
  const path = await file(`a\n${'x'.repeat(20)}\nb\n`);
  await assert.rejects(all(linesForward(path, 10)), /a line is longer than 10 bytes/);
  await assert.rejects(all(linesBackward(path, 10)), /a line is longer than 10 bytes/);
});

test('a long line holds only about one chunk and one line in memory, not a growing copy of everything read so far', async () => {
  // Measured as peak resident set size in a child process: an in-process
  // sample of process.memoryUsage() is too noisy, since V8 reclaims a
  // generator's discarded chunk buffers on its own schedule, not the test's.
  // What is checked is how much more a line twice as long costs. When memory
  // grows with the line, the extra 8 MiB is held about three times over (the
  // chunks, the joined bytes, the string): about 24 MiB, measured 19–29 MiB
  // with 16 readers running at once. When every chunk copies everything read
  // so far it is about 550 MiB. Peak RSS varies with when the garbage
  // collector runs, so a bound on the difference holds where one on a single
  // reading does not.
  const small = 8 * (1 << 20);
  const paths = new Map([[small, await file('x'.repeat(small) + '\n')], [2 * small, await file('x'.repeat(2 * small) + '\n')]]);
  const linesUrl = new URL('./lines.ts', import.meta.url).href;
  function maxRssGrowthKiB(direction: 'linesForward' | 'linesBackward', size: number): number {
    const script = `
      import { ${direction} } from '${linesUrl}';
      const before = process.resourceUsage().maxRSS;
      for await (const _line of ${direction}(${JSON.stringify(paths.get(size))}, ${2 * size}));
      console.log(process.resourceUsage().maxRSS - before);
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return Number(result.stdout.trim());
  }
  const limitKiB = (5 * small) / 1024;
  for (const direction of ['linesForward', 'linesBackward'] as const) {
    const extra = maxRssGrowthKiB(direction, 2 * small) - maxRssGrowthKiB(direction, small);
    assert.ok(extra < limitKiB, `${direction}: a 16 MiB line grew maxRSS by ${extra} KiB more than an 8 MiB line, expected under ${limitKiB} KiB`);
  }
});

test('a multi-byte UTF-8 character split across a chunk boundary is read whole, in both directions', async () => {
  const forwardPath = await file('a'.repeat(CHUNK - 1) + '€€\n');
  assert.deepEqual((await all(linesForward(forwardPath, CHUNK + 100))).map(line => line.text.slice(-2)), ['€€']);
  const backwardPath = await file('€€' + 'a'.repeat(CHUNK - 1) + '\n');
  assert.deepEqual((await all(linesBackward(backwardPath, CHUNK + 100))).map(line => line.text.slice(0, 2)), ['€€']);
});

test('stopping a forward read early closes the file', async () => {
  const path = await file(Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join('\n') + '\n');
  const before = readdirSync('/dev/fd').length;
  for await (const _ of linesForward(path, 100)) break;
  assert.equal(readdirSync('/dev/fd').length, before);
});

test('a missing file rejects with ENOENT, in both directions', async () => {
  const missing = join(tmpdir(), 'fixjs-no-such-file-lines.jsonl');
  await assert.rejects(all(linesForward(missing, 100)), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  await assert.rejects(all(linesBackward(missing, 100)), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
});

test('an empty file has no lines, in either direction', async () => {
  const path = await file('');
  assert.deepEqual(await all(linesForward(path, 100)), []);
  assert.deepEqual(await all(linesBackward(path, 100)), []);
});

test('a file of only newlines has no non-empty lines, in either direction', async () => {
  const path = await file('\n\n\n\n');
  assert.deepEqual(await all(linesForward(path, 100)), []);
  assert.deepEqual(await all(linesBackward(path, 100)), []);
});

test('a forward read can begin at a line start and stop at a byte: nothing at or past it is read', async () => {
  const path = await file('one\ntwo\nthree\nfour\n');
  assert.deepEqual(await all(linesForward(path, 100, { from: 4 })), [
    { text: 'two', start: 4, ended: true },
    { text: 'three', start: 8, ended: true },
    { text: 'four', start: 14, ended: true },
  ]);
  assert.deepEqual(await all(linesForward(path, 100, { to: 8 })), [
    { text: 'one', start: 0, ended: true },
    { text: 'two', start: 4, ended: true },
  ]);
  assert.deepEqual(await all(linesForward(path, 100, { from: 8, to: 14 })), [{ text: 'three', start: 8, ended: true }]);
  // A range that ends inside a line gives what it has of it, as a line no newline ends.
  assert.deepEqual(await all(linesForward(path, 100, { from: 8, to: 11 })), [{ text: 'thr', start: 8, ended: false }]);
  assert.deepEqual(await all(linesForward(path, 100, { from: 8, to: 8 })), []);
  assert.deepEqual(await all(linesForward(path, 100, { from: 19 })), []);
  assert.deepEqual(await all(linesForward(path, 100, { to: 1_000 })), await all(linesForward(path, 100)));
});

test('a forward read of a range longer than a chunk keeps each line whole and where it starts', async () => {
  const long = 'x'.repeat(150_000);
  const path = await file(`a\n${long}\nb\nc\n`);
  assert.deepEqual((await all(linesForward(path, 200_000, { from: 2, to: 150_005 }))).map(line => [line.text.length, line.start, line.ended]), [[150_000, 2, true], [1, 150_003, true]]);
});

test('a forward read of a range keeps a multi-byte UTF-8 character whole across a chunk boundary, and counts where the next line starts in bytes', async () => {
  // The read begins at byte 3, so its first chunk ends one byte into the first euro sign (three bytes each).
  const path = await file(`ab\n${'a'.repeat(CHUNK - 1)}€€\nz\n`);
  const next = 3 + (CHUNK - 1) + 6 + 1;
  const whole = [{ length: CHUNK + 1, tail: '€€', start: 3, ended: true }, { length: 1, tail: 'z', start: next, ended: true }];
  const brief = (lines: Line[]) => lines.map(line => ({ length: line.text.length, tail: line.text.slice(-2), start: line.start, ended: line.ended }));
  assert.deepEqual(brief(await all(linesForward(path, CHUNK + 100, { from: 3 }))), whole);
  assert.deepEqual(brief(await all(linesForward(path, CHUNK + 100, { from: 3, to: next }))), whole.slice(0, 1));
  assert.deepEqual(brief(await all(linesForward(path, CHUNK + 100, { from: 3, to: next + 2 }))), whole);
});

test('a forward read of a range that ends before it begins reads nothing', async () => {
  const path = await file('one\ntwo\nthree\n');
  assert.deepEqual(await all(linesForward(path, 100, { from: 8, to: 4 })), []);
  assert.deepEqual(await all(linesForward(path, 100, { from: 4, to: 0 })), []);
});
