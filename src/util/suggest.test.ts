import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggest } from './suggest.ts';

test('suggests the closest candidate for a likely typo', () => {
  assert.equal(suggest('Buyy', ['Buy', 'Sell']), 'Buy');
  assert.equal(suggest('Prise', ['Price', 'Side', 'Symbol']), 'Price');
});

test('case differences always match', () => {
  assert.equal(suggest('newordersingle', ['Logon', 'NewOrderSingle']), 'NewOrderSingle');
});

test('no suggestion when nothing is close', () => {
  assert.equal(suggest('Zebra', ['Buy', 'Sell']), undefined);
  assert.equal(suggest('x', []), undefined);
});

test('a huge input is refused cheaply, not compared candidate by candidate', () => {
  const candidates = Array.from({ length: 900 }, (_, i) => `Field${i}`);
  const start = performance.now();
  const result = suggest('x'.repeat(200_000), candidates);
  const elapsed = performance.now() - start;
  assert.equal(result, undefined);
  assert.ok(elapsed < 50, `took ${elapsed}ms`);
});
