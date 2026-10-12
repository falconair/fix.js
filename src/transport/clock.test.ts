import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock, systemClock } from './clock.ts';

test('the fake clock runs timers in order as time is advanced', async () => {
  const clock = fakeClock(new Date('2026-09-30T00:00:00Z'));
  const fired: string[] = [];
  clock.setTimeout(() => fired.push('b'), 2000);
  clock.setTimeout(() => fired.push('a'), 1000);
  const cancelled = clock.setTimeout(() => fired.push('never'), 1500);
  clock.clearTimeout(cancelled);
  await clock.advance('1s');
  assert.deepEqual(fired, ['a']);
  assert.equal(clock.now().toISOString(), '2026-09-30T00:00:01.000Z');
  await clock.advance(5000);
  assert.deepEqual(fired, ['a', 'b']);
});

test('timers set by timers fire within the same advance', async () => {
  const clock = fakeClock();
  let ticks = 0;
  const tick = () => { ticks++; clock.setTimeout(tick, 1000); };
  clock.setTimeout(tick, 1000);
  await clock.advance('10s');
  assert.equal(ticks, 10);
});

test('the system clock is real time', () => {
  assert.ok(Math.abs(systemClock.now().getTime() - Date.now()) < 1000);
});
