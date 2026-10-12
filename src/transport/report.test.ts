import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorEntry } from './report.ts';

const at = new Date('2026-09-30T12:00:00.000Z');

test('an error entry keeps the text, a capped stack, and what was being handled', () => {
  const error = new Error('x'.repeat(2_000));
  const entry = errorEntry(error, at, { MsgType: 'NewOrderSingle', MsgSeqNum: 7, ClOrdID: 'o1', Side: 'Buy' });
  assert.equal(entry.kind, 'error');
  assert.equal(entry.at, at);
  assert.equal(entry.text.length, 1_000);
  assert.ok(entry.stack !== undefined && entry.stack.length <= 4_000);
  assert.deepEqual(entry.during, { MsgType: 'NewOrderSingle', MsgSeqNum: 7, ClOrdID: 'o1' });
});

test('anything thrown becomes an entry, even a value that cannot be printed', () => {
  assert.deepEqual(errorEntry('just text', at), { kind: 'error', at, text: 'just text' });
  const unprintable = { toString() { throw new Error('no'); } };
  assert.deepEqual(errorEntry(unprintable, at), { kind: 'error', at, text: 'An error that could not be described' });
  assert.equal(errorEntry(new Error('e'), at, { Text: 'no ids' }).during, undefined);
});
