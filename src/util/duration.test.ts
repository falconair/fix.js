import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeoutMs, toMs } from './duration.ts';

test('durations in milliseconds or with a unit', () => {
  assert.equal(toMs(250), 250);
  assert.equal(toMs('5s'), 5000);
  assert.equal(toMs('1.5s'), 1500);
  assert.equal(toMs('500ms'), 500);
  assert.throws(() => toMs('5 minutes' as never), RangeError);
  assert.throws(() => toMs(-1), RangeError);
});

test('timeout options must be durations greater than 0, and errors name the option', () => {
  assert.equal(timeoutMs('10s', 'logonTimeout'), 10_000);
  assert.equal(timeoutMs(250, 'logonTimeout'), 250);
  assert.throws(() => timeoutMs(0, 'logonTimeout'), { name: 'RangeError', message: /^logonTimeout must be a duration greater than 0/ });
  assert.throws(() => timeoutMs(Number.NaN, 'limits.logonTimeout'), { name: 'RangeError', message: /^limits\.logonTimeout/ });
  assert.throws(() => timeoutMs('soon' as never, 'connectTimeout'), RangeError);
});

test('timeout options must not overflow Node\'s 32-bit timer, or they would fire after 1 ms instead', () => {
  assert.equal(timeoutMs(2_147_483_647, 'logonTimeout'), 2_147_483_647);
  assert.throws(() => timeoutMs(2_147_483_648, 'logonTimeout'), { name: 'RangeError', message: /^logonTimeout must be a duration greater than 0 and at most 2147483647 ms/ });
  assert.throws(() => timeoutMs('2147484s', 'logoutTimeout'), { name: 'RangeError', message: /^logoutTimeout/ });
});
