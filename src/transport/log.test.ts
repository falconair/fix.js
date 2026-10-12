import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionLog } from './log.ts';
import type { Entry } from './types.ts';

const at = new Date('2026-09-30T12:00:00.000Z');
/** An outgoing entry with `size` wire bytes. */
const out = (seq: number, fields: Record<string, unknown> = {}, size = 100): Entry =>
  ({ kind: 'message', direction: 'out', at, message: { MsgType: 'NewOrderSingle', MsgSeqNum: seq, ...fields }, bytes: new Uint8Array(size) });
const seqs = (log: SessionLog) => log.history.map(entry => entry.kind === 'message' && entry.message.MsgSeqNum);

test('history keeps the newest entries within its count and byte limits', () => {
  const byCount = new SessionLog({ entries: 3, bytes: 10_000 });
  for (let seq = 1; seq <= 5; seq++) byCount.add(out(seq));
  assert.deepEqual(seqs(byCount), [3, 4, 5]);
  const byBytes = new SessionLog({ entries: 1_000, bytes: 250 });
  for (let seq = 1; seq <= 5; seq++) byBytes.add(out(seq));
  assert.deepEqual(seqs(byBytes), [4, 5]);
});

test('restoring takes in what the store held, oldest first, and keeps the newest within the limits', () => {
  const log = new SessionLog({ entries: 3, bytes: 10_000 });
  log.restore([out(1), out(2), out(3), out(4)]);
  assert.deepEqual(seqs(log), [2, 3, 4]);
  log.add(out(5));
  assert.deepEqual(seqs(log), [3, 4, 5]);
  const byBytes = new SessionLog({ entries: 1_000, bytes: 250 });
  byBytes.restore([out(1), out(2), out(3)]);
  assert.deepEqual(seqs(byBytes), [2, 3]);
});

test('a log holds a history and nothing else: a sequence reset, a resent copy and a low MsgSeqNum are entries like any other', () => {
  const log = new SessionLog({ entries: 100, bytes: 100_000 });
  log.restore([out(1, { MsgType: 'Logon' }), out(2), out(1, { MsgType: 'Logon', ResetSeqNumFlag: true })]);
  log.add(out(2, { PossDupFlag: true }));
  log.add(out(1, { MsgType: 'Heartbeat' }));
  assert.deepEqual(seqs(log), [1, 2, 1, 2, 1]);
  assert.deepEqual(Object.getOwnPropertyNames(SessionLog.prototype).sort(), ['add', 'constructor', 'history', 'restore']);
});
