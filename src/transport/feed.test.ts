import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from './clock.ts';
import { ConnectionFeed } from './feed.ts';
import type { ConnectionEntry } from './types.ts';

const T0 = new Date('2026-09-30T12:00:00.000Z');
const peer = { address: '203.0.113.24', port: 50000 };
const opened: ConnectionEntry = { kind: 'connection', event: 'opened', connectionId: 'c1', peer, at: T0 };

test('watchers get every entry; a replay goes first, and only to the new watcher', () => {
  const feed = new ConnectionFeed(fakeClock(T0));
  const first: string[] = [];
  const second: string[] = [];
  assert.equal(feed.watched, false);
  feed.watch(entry => first.push(entry.event));
  feed.emit(opened);
  feed.watch(entry => second.push(entry.event), [opened]);
  feed.emit({ ...opened, event: 'closed' });
  assert.deepEqual(first, ['opened', 'closed']);
  assert.deepEqual(second, ['opened', 'closed']);
  assert.equal(feed.watched, true);
});

test('a watcher that throws becomes one error entry for that connection, and onHandlerError gets it', () => {
  const handled: unknown[] = [];
  const feed = new ConnectionFeed(fakeClock(T0), error => handled.push(error));
  const seen: ConnectionEntry[] = [];
  feed.watch(entry => { seen.push(entry); });
  feed.watch(() => { throw new Error('watcher bug'); });
  feed.emit(opened);
  assert.deepEqual(seen.map(entry => [entry.event, entry.connectionId, entry.error?.text]), [['opened', 'c1', undefined], ['error', 'c1', 'watcher bug']]);
  // The throwing watcher also failed on the error entry; that went to onHandlerError only.
  assert.deepEqual(handled.map(error => (error as Error).message), ['watcher bug', 'watcher bug']);
});

test('an error with no connection is the listening socket\'s; a throwing onHandlerError is recorded too', () => {
  const feed = new ConnectionFeed(fakeClock(T0), () => { throw new Error('handler bug'); });
  const seen: ConnectionEntry[] = [];
  feed.watch(entry => { seen.push(entry); });
  assert.doesNotThrow(() => feed.error(undefined, Object.assign(new Error('accept failed'), { code: 'EMFILE' })));
  assert.deepEqual(seen.map(entry => [entry.event, entry.connectionId, entry.error?.text]), [['error', undefined, 'accept failed'], ['error', undefined, 'handler bug']]);
  assert.match(seen[0]?.error?.stack ?? '', /^Error: accept failed/);
});

test('a watcher that throws during its replay gets the error entry itself; the other watchers do not', () => {
  const handled: unknown[] = [];
  const feed = new ConnectionFeed(fakeClock(T0), error => handled.push(error));
  const earlier: ConnectionEntry[] = [];
  feed.watch(entry => { earlier.push(entry); });
  const replayed: ConnectionEntry[] = [];
  feed.watch(entry => { replayed.push(entry); if (entry.event === 'opened') throw new Error('replay bug'); }, [opened]);
  assert.deepEqual(earlier, []);
  assert.deepEqual(replayed.map(entry => [entry.event, entry.connectionId, entry.error?.text]), [['opened', 'c1', undefined], ['error', 'c1', 'replay bug']]);
  assert.deepEqual(handled.map(error => (error as Error).message), ['replay bug']);
  // Once replayed, the watcher follows the feed like any other.
  feed.emit({ ...opened, event: 'closed' });
  assert.deepEqual([earlier.length, replayed.length], [1, 3]);
});

test('each event carries its own fields, so a narrowed entry needs no optional checks', () => {
  const describe = (entry: ConnectionEntry): string => {
    switch (entry.event) {
      case 'received': return `${entry.bytes.length} bytes`;
      case 'rejected': return `${entry.problem.code}: ${entry.problem.text}`;
      case 'loggedOn': return `${entry.sessionKey} as ${entry.logon.TargetCompID}`;
      case 'error': return entry.error.text;
      default: return entry.event;
    }
  };
  assert.deepEqual([
    describe(opened),
    describe({ ...opened, event: 'received', bytes: new Uint8Array(3) }),
    describe({ ...opened, event: 'rejected', problem: { code: 'LogonRefused', text: 'no', action: 'LoggedOut' } }),
    describe({ ...opened, event: 'loggedOn', logon: { BeginString: 'FIX.4.4', SenderCompID: 'CLIENT', TargetCompID: 'EXCHANGE' }, sessionKey: 'FIX.4.4:EXCHANGE:CLIENT' }),
    describe({ kind: 'connection', event: 'error', at: T0, error: { text: 'EMFILE' } }),
  ], ['opened', '3 bytes', 'LogonRefused: no', 'FIX.4.4:EXCHANGE:CLIENT as EXCHANGE', 'EMFILE']);
});
