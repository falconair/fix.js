import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, chmod, mkdir, mkdtemp, open, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineDictionary } from '../dictionary/define.ts';
import { dictionaryFor } from '../dictionary/index.ts';
import { buildFrame, parseFrame } from '../wire/frame.ts';
import { fromMessage, inspectMessage } from '../wire/message.ts';
import { entryFromJSON, entryToJSON } from './json.ts';
import { entrySize } from './size.ts';
import { recordLine } from './stored-entry.ts';
import { fileStore, fileStoreWith, memoryStore, safeFileName } from './store.ts';
import { storeContract } from '../test.ts';
import type { Entry, SeqNums, SessionId, Store, StoreRecord } from './types.ts';

const dict = dictionaryFor('FIX.4.4');
const id: SessionId = { version: 'FIX.4.4', sender: 'EXCHANGE', target: 'CLIENT' };
const at = new Date('2026-09-30T12:00:00.000Z');

function sentEntry(seq: number, dropped = false): Entry {
  const { fields, framing } = fromMessage('TestRequest', {
    SenderCompID: 'EXCHANGE', TargetCompID: 'CLIENT', MsgSeqNum: seq, SendingTime: at, TestReqID: `t${seq}`,
  }, dict, { version: 'FIX.4.4' });
  const bytes = buildFrame(fields, framing);
  const message = inspectMessage(parseFrame(bytes).fields, dict).message;
  return dropped ? { kind: 'message', direction: 'out', at, message } : { kind: 'message', direction: 'out', at, message, bytes };
}
/** A record of an entry and the sequence numbers after it. */
const record = (entry: Entry, next: number, expected: number, extra: Partial<StoreRecord> = {}): StoreRecord => ({ at: entry.at, entry, seqNums: { next, expected }, ...extra });
/** A record of sequence numbers alone. */
const seqNumsOnly = (seqNums: SeqNums, extra: Partial<StoreRecord> = {}): StoreRecord => ({ at, seqNums, ...extra });
/** Everything read() gives, in order. */
async function readAll(entries: AsyncIterable<Entry>): Promise<Entry[]> {
  const out: Entry[] = [];
  for await (const entry of entries) out.push(entry);
  return out;
}
const seqOf = (entry: Entry) => entry.kind === 'message' && entry.message.MsgSeqNum;
/** Resolve once `condition` holds, polling every 5ms; reject if it takes longer than `ms`. */
async function waitFor(condition: () => Promise<boolean> | boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${ms} ms waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
/** An entry like sentEntry(seq), at another time. */
const sentAt = (seq: number, time: Date): Entry => ({ ...sentEntry(seq), at: time });
const problemEntry: Entry = { kind: 'problem', direction: 'in', at, problem: { code: 'Garbled', text: 'CheckSum is 000 but should be 138', action: 'Ignored' } };

// The contract, as fix.js/test exports it: a memoryStore needs no cleanup, a fileStore's folder is removed with it.
storeContract('memoryStore', () => memoryStore());

/** The folder of each fileStore the contract's tests are given. */
const folders = new Map<Store, string>();
storeContract('fileStore', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  folders.set(store, dir);
  return store;
}, { cleanup: store => rm(folders.get(store)!, { recursive: true, force: true }) });

for (const [name, make] of [['memoryStore', async () => memoryStore()], ['fileStore', async () => fileStore(await mkdtemp(join(tmpdir(), 'fixjs-store-')))]] as const) {
  test(`${name}: a new session starts empty at 1/1`, { timeout: 10_000 }, async () => {
    const store = await make();
    assert.deepEqual(await store.load(id), { history: [], next: 1, expected: 1 });
  });

  test(`${name}: history and sequence numbers survive a reload`, { timeout: 10_000 }, async () => {
    const store = await make();
    await store.append(id, [record(sentEntry(1), 2, 1)]);
    await store.append(id, [record(sentEntry(2, true), 3, 1)]);
    await store.append(id, [record(problemEntry, 3, 2)]);
    await store.append(id, [seqNumsOnly({ next: 10, expected: 20 })]);
    const loaded = await store.load(id);
    assert.deepEqual({ next: loaded.next, expected: loaded.expected }, { next: 10, expected: 20 });
    assert.equal(loaded.history.length, 3);
    const [first, second, third] = loaded.history;
    assert.equal(first?.kind === 'message' && first.message.TestReqID, 't1');
    assert.deepEqual(first?.kind === 'message' && Buffer.from(first.bytes ?? []), Buffer.from((sentEntry(1) as { bytes: Uint8Array }).bytes));
    assert.equal(second?.kind === 'message' && second.bytes, undefined);        // dropped: never reached the wire
    assert.equal(second?.kind === 'message' && second.message.MsgSeqNum, 2);
    assert.deepEqual(third, problemEntry);
    assert.deepEqual(first?.at, at);
  });

  test(`${name}: load() returns only the epoch begun by the last reset`, { timeout: 10_000 }, async () => {
    const store = await make();
    await store.append(id, [record(sentEntry(1), 2, 1)]);
    await store.append(id, [record(sentEntry(2), 3, 1)]);
    await store.append(id, [record(sentEntry(1), 2, 1, { newEpoch: true })]);
    await store.append(id, [record(sentEntry(2), 3, 2)]);
    const loaded = await store.load(id);
    assert.deepEqual(loaded.history.map(e => e.kind === 'message' && e.message.MsgSeqNum), [1, 2]);
    assert.deepEqual({ next: loaded.next, expected: loaded.expected }, { next: 3, expected: 2 });
  });

  test(`${name}: a reset with nothing sent since still begins an epoch, and keeps its sequence numbers`, { timeout: 10_000 }, async () => {
    const store = await make();
    await store.append(id, [record(sentEntry(1), 2, 1)]);
    await store.append(id, [seqNumsOnly({ next: 1, expected: 5 }, { newEpoch: true })]);
    assert.deepEqual(await store.load(id), { history: [], next: 1, expected: 5 });
  });

  test(`${name}: load() returns only the newest entries within the session's history budget`, { timeout: 10_000 }, async () => {
    const store = await make();
    for (let seq = 1; seq <= 10; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
    const byCount = await store.load(id, { history: { entries: 3, bytes: 1_048_576 } });
    assert.deepEqual(byCount.history.map(e => e.kind === 'message' && e.message.MsgSeqNum), [8, 9, 10]);
    assert.deepEqual({ next: byCount.next, expected: byCount.expected }, { next: 11, expected: 1 });
    const byBytes = await store.load(id, { history: { entries: 1_000, bytes: entrySize(sentEntry(9)) + entrySize(sentEntry(10)) } });
    assert.deepEqual(byBytes.history.map(e => e.kind === 'message' && e.message.MsgSeqNum), [9, 10]);
  });

  test(`${name}: read() gives every entry it keeps, across epochs, oldest first; or one epoch, or a time range`, { timeout: 10_000 }, async () => {
    const store = await make();
    const times = [0, 1, 2, 3].map(minute => new Date(at.getTime() + minute * 60_000));
    await store.append(id, [record(sentAt(1, times[0]!), 2, 1)]);
    await store.append(id, [record(sentAt(2, times[1]!), 3, 1)]);
    await store.append(id, [record(sentAt(1, times[2]!), 2, 1, { newEpoch: true })]);
    await store.append(id, [record(sentAt(2, times[3]!), 3, 1)]);
    assert.deepEqual((await readAll(store.read(id))).map(seqOf), [1, 2, 1, 2]);
    assert.deepEqual((await readAll(store.read(id, { epoch: 2 }))).map(e => e.at), [times[2], times[3]]);
    assert.deepEqual((await readAll(store.read(id, { from: times[1], to: times[2] }))).map(e => e.at), [times[1], times[2]]);
    assert.deepEqual(await readAll(store.read({ ...id, target: 'NOBODY' })), []);
  });

  test(`${name}: read() refuses options it does not know, or of the wrong kind`, { timeout: 10_000 }, async () => {
    const store = await make();
    await assert.rejects(readAll(store.read(id, { from: '2026-09-30' } as never)), /read\(\) from must be a Date, got '2026-09-30'/);
    await assert.rejects(readAll(store.read(id, { epoch: 0 })), /read\(\) epoch must be a whole number of at least 1, got 0/);
    await assert.rejects(readAll(store.read(id, { since: at } as never)), /read\(\) options: unknown setting 'since'/);
  });

  test(`${name}: list() gives each session it holds and its epochs, oldest first`, { timeout: 10_000 }, async () => {
    const store = await make();
    assert.deepEqual(await store.list(), []);
    const other: SessionId = { ...id, target: 'ANOTHER' };
    const later = new Date(at.getTime() + 60_000);
    await store.append(id, [record(sentEntry(1), 2, 1)]);
    await store.append(id, [record(sentEntry(2), 3, 1)]);
    await store.append(id, [{ ...record(sentEntry(1), 2, 1), at: later, newEpoch: true }]);
    await store.append(other, [record(sentEntry(1), 2, 1)]);
    const listed = await store.list();
    const withoutCounts = listed.map(session => ({ id: session.id, epochs: session.epochs.map(({ epoch, startedAt }) => ({ epoch, startedAt })) }));
    assert.deepEqual(withoutCounts, [
      { id: other, epochs: [{ epoch: 1, startedAt: at }] },
      { id, epochs: [{ epoch: 1, startedAt: at }, { epoch: 2, startedAt: later }] },
    ]);
    const counts = listed.flatMap(session => session.epochs.map(epoch => epoch.entries));
    assert.deepEqual(counts, name === 'memoryStore' ? [1, 2, 1] : [undefined, undefined, undefined]);
  });

  test(`${name}: reset forgets a session`, { timeout: 10_000 }, async () => {
    const store = await make();
    await store.append(id, [record(sentEntry(1), 2, 1)]);
    await store.reset(id);
    assert.deepEqual(await store.load(id), { history: [], next: 1, expected: 1 });
  });
}

test('memoryStore keeps at most `history` entries per session; sequence numbers are always kept in full', { timeout: 10_000 }, async () => {
  const store = memoryStore({ history: 3 });
  for (let seq = 1; seq <= 10; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  const loaded = await store.load(id);
  assert.equal(loaded.history.length, 3);
  assert.deepEqual(loaded.history.map(e => e.kind === 'message' && e.message.MsgSeqNum), [8, 9, 10]);
  assert.deepEqual({ next: loaded.next, expected: loaded.expected }, { next: 11, expected: 1 });
});

test('memoryStore keeps at most `historyBytes` bytes per session, evicting the oldest first', { timeout: 10_000 }, async () => {
  const store = memoryStore({ history: 1000, historyBytes: 200 });   // count budget generous; byte budget tight
  for (let seq = 1; seq <= 10; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  const loaded = await store.load(id);
  assert.ok(loaded.history.length > 0 && loaded.history.length < 10, `expected byte-based eviction, got ${loaded.history.length} entries`);
  const bytes = loaded.history.reduce((total, e) => total + entrySize(e), 0);
  assert.ok(bytes <= 200, `history bytes was ${bytes}`);
  // The newest entries are the ones kept.
  const seqs = loaded.history.map(e => e.kind === 'message' && e.message.MsgSeqNum);
  assert.deepEqual(seqs, seqs.slice().sort((a, b) => Number(a) - Number(b)));
  assert.equal(seqs.at(-1), 10);
});

test('memoryStore forgets the least recently used session once it holds more than `sessions`', { timeout: 10_000 }, async () => {
  const ids = ['A', 'B', 'C'].map(target => ({ ...id, target }));
  const [a, b, c] = ids as [SessionId, SessionId, SessionId];
  const store = memoryStore({ sessions: 2 });
  for (const each of ids) await store.append(each, [record(sentEntry(1), 2, 1)]);
  assert.deepEqual(await store.load(a), { history: [], next: 1, expected: 1 });
  assert.equal((await store.load(c)).next, 2);

  const lru = memoryStore({ sessions: 2 });
  await lru.append(a, [record(sentEntry(1), 2, 1)]);
  await lru.append(b, [record(sentEntry(1), 2, 1)]);
  await lru.load(a);   // A is now more recently used than B
  await lru.append(c, [record(sentEntry(1), 2, 1)]);
  assert.equal((await lru.load(a)).next, 2);
  assert.deepEqual(await lru.load(b), { history: [], next: 1, expected: 1 });
});

test('fileStore keeps a dropped message it cannot encode without its frame: its sequence numbers count, its entry is left out', { timeout: 10_000 }, async () => {
  const store = fileStore(await mkdtemp(join(tmpdir(), 'fixjs-store-')));
  const unencodable: Entry = { kind: 'message', direction: 'out', at, message: { MsgType: 'TestRequest', MsgSeqNum: 2, TestReqID: 't2', NotAField: 'x' } };
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  await store.append(id, [record(unencodable, 3, 1)]);
  await store.append(id, [record(sentEntry(3), 4, 1)]);
  const loaded = await store.load(id);
  assert.deepEqual(loaded.history.map(e => e.kind === 'message' && e.message.MsgSeqNum), [1, 3]);
  assert.deepEqual({ next: loaded.next, expected: loaded.expected }, { next: 4, expected: 1 });
});

test('fileStore skips a stored frame that no longer decodes, and leaves the line as it is', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  const file = join(dir, safeFileName(id), '1.jsonl');
  const bad = [
    { entry: { kind: 'message', direction: 'out', at: at.toISOString(), frame: Buffer.from('garbage').toString('base64'), onWire: true }, next: 3, expected: 1 },
    { entry: { kind: 'message', direction: 'out', at: at.toISOString(), frame: 42, onWire: true }, next: 4, expected: 1 },
  ];
  await appendFile(file, bad.map(line => `${JSON.stringify(line)}\n`).join(''));
  const before = await readFile(file, 'utf8');
  const loaded = await store.load(id);
  assert.equal(loaded.history.length, 1);
  assert.deepEqual({ next: loaded.next, expected: loaded.expected }, { next: 4, expected: 1 });
  assert.equal(await readFile(file, 'utf8'), before);
});

test('fileStore names files safely, whatever the CompIDs are (H-1)', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  const hostile: SessionId = { version: 'FIX.4.4', sender: 'EXCHANGE', target: '../../../../tmp/pwn' };
  await store.append(hostile, [record(sentEntry(1), 2, 1)]);
  const folders = await readdir(dir);
  assert.equal(folders.length, 1);
  assert.match(folders[0] ?? '', /^session-[0-9a-f]{16}$/);
  assert.deepEqual((await readdir(join(dir, folders[0]!))).sort(), ['1.jsonl', 'session.json']);
  assert.match(safeFileName(id), /^FIX\.4\.4_EXCHANGE_CLIENT-[0-9a-f]{16}$/);
  assert.match(safeFileName({ ...id, target: '.hidden' }), /^session-/);
});

test('safeFileName never collides two different ids, even across delimiters or case', () => {
  const a = safeFileName({ version: 'FIX.4.4', sender: 'B_C', target: 'D' });
  const b = safeFileName({ version: 'FIX.4.4', sender: 'B', target: 'C_D' });
  assert.notEqual(a, b);
  assert.notEqual(a.toLowerCase(), b.toLowerCase());

  const upper = safeFileName({ ...id, target: 'CLIENT' });
  const lower = safeFileName({ ...id, target: 'client' });
  assert.notEqual(upper, lower);
  assert.notEqual(upper.toLowerCase(), lower.toLowerCase());
});

test('fileStore encodes and restores custom fields with the dictionary it is handed', { timeout: 10_000 }, async () => {
  const acme = defineDictionary({ fields: { DeskName: { tag: 9703 } }, messages: { TestRequest: ['DeskName'] } });
  const store = fileStore(await mkdtemp(join(tmpdir(), 'fixjs-store-')));
  const dropped: Entry = {
    kind: 'message', direction: 'out', at,
    message: { MsgType: 'TestRequest', BeginString: 'FIX.4.4', SenderCompID: 'EXCHANGE', TargetCompID: 'CLIENT', MsgSeqNum: 1, SendingTime: at, TestReqID: 't1', DeskName: 'desk1' },
  };
  await store.append(id, [record(dropped, 2, 1)], { dictionary: acme });
  const [entry] = (await store.load(id, { dictionary: acme })).history;
  assert.equal(entry?.kind === 'message' && entry.message.DeskName, 'desk1');
});

test('fileStore keeps error entries', { timeout: 10_000 }, async () => {
  const store = fileStore(await mkdtemp(join(tmpdir(), 'fixjs-store-')));
  const error: Entry = { kind: 'error', at, text: 'handler bug', stack: 'Error: handler bug\n    at handler', during: { MsgType: 'NewOrderSingle', MsgSeqNum: 2, ClOrdID: 'o1' } };
  await store.append(id, [record(error, 1, 3)]);
  assert.deepEqual((await store.load(id)).history, [error]);
});

test('fileStore.load tolerates a torn last line, but not corruption earlier in the file', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  await store.append(id, [record(sentEntry(2), 3, 1)]);
  await appendFile(join(dir, safeFileName(id), '1.jsonl'), '{"entry":{"kind"');

  const loaded = await store.load(id);
  assert.equal(loaded.history.length, 2);
  assert.deepEqual({ next: loaded.next, expected: loaded.expected }, { next: 3, expected: 1 });

  // The torn fragment must have been truncated away: the next append should
  // not glue onto it and corrupt the file mid-way.
  await store.append(id, [record(sentEntry(3), 4, 1)]);
  const reloaded = await store.load(id);
  assert.equal(reloaded.history.length, 3);
  assert.deepEqual({ next: reloaded.next, expected: reloaded.expected }, { next: 4, expected: 1 });
});

test('fileStore restores a redacted message, although its BodyLength and CheckSum no longer match', { timeout: 10_000 }, async () => {
  const store = fileStore(await mkdtemp(join(tmpdir(), 'fixjs-store-')));
  const entry = sentEntry(1) as Extract<Entry, { kind: 'message' }>;
  const bytes = Buffer.from(Buffer.from(entry.bytes!).toString('latin1').replace('112=t1', '112=*****'), 'latin1');
  await store.append(id, [record({ ...entry, bytes }, 2, 1)]);
  const [restored] = (await store.load(id)).history;
  assert.equal(restored?.kind === 'message' && restored.message.TestReqID, '*****');
});

test('fileStore does not restore a corrupted frame that is not a redacted one (one byte flipped, no *****)', { timeout: 10_000 }, async () => {
  const store = fileStore(await mkdtemp(join(tmpdir(), 'fixjs-store-')));
  const entry = sentEntry(1) as Extract<Entry, { kind: 'message' }>;
  // Same length, so BodyLength still agrees; only the CheckSum now disagrees, and there is no '*****'
  // anywhere in the frame — this must read as corruption, not as a frame redaction left behind.
  const text = Buffer.from(entry.bytes!).toString('latin1').replace('112=t1', '112=t9');
  const bytes = Buffer.from(text, 'latin1');
  await store.append(id, [record({ ...entry, bytes }, 2, 1)]);
  const loaded = await store.load(id);
  assert.equal(loaded.history.length, 0, 'a corrupted, non-redacted frame must not be restored');
});

test('fileStore caps a stored error entry\'s stack at 1,000 characters, without touching the in-memory entry', { timeout: 10_000 }, async () => {
  const store = fileStore(await mkdtemp(join(tmpdir(), 'fixjs-store-')));
  const longStack = `Error: boom\n${'    at somewhere\n'.repeat(300)}`;
  assert.ok(longStack.length > 1_000);
  const error: Entry = { kind: 'error', at, text: 'boom', stack: longStack };
  await store.append(id, [record(error, 1, 1)]);
  assert.equal(error.stack, longStack, 'the in-memory entry must be untouched');
  const [restored] = (await store.load(id)).history;
  assert.equal(restored?.kind === 'error' && restored.stack?.length, 1_000);
  assert.ok(restored?.kind === 'error' && longStack.startsWith(restored.stack ?? ''));
});

test('fileStore keeps each epoch in its own file, which begins by saying when it started', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  const later = new Date('2026-09-30T13:00:00.000Z');
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  await store.append(id, [record(sentEntry(2), 3, 1)]);
  await store.append(id, [{ ...record(sentEntry(1), 2, 1), at: later, newEpoch: true }]);
  const folder = join(dir, safeFileName(id));
  assert.deepEqual((await readdir(folder)).sort(), ['1.jsonl', '2.jsonl', 'session.json']);
  const { lifetime, ...sessionJson } = JSON.parse(await readFile(join(folder, 'session.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(typeof lifetime, 'string', 'a random lifetime id, so a reused folder on the same inode can still be told apart');
  assert.deepEqual(sessionJson, { version: 'FIX.4.4', sender: 'EXCHANGE', target: 'CLIENT' });
  const first = (await readFile(join(folder, '1.jsonl'), 'utf8')).split('\n');
  const second = (await readFile(join(folder, '2.jsonl'), 'utf8')).split('\n');
  assert.deepEqual(JSON.parse(first[0]!), { epoch: 1, startedAt: at.toISOString() });
  assert.deepEqual(JSON.parse(second[0]!), { epoch: 2, startedAt: later.toISOString() });
  assert.equal(first.length, 4, 'a header, one line per record, and the final newline');
  assert.deepEqual(Object.keys(JSON.parse(first[1]!)), ['next', 'expected', 'seq', 'entry']);
});

test('fileStore loads a file written before epochs as the first epoch, and moves it into the session folder', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const old = join(dir, `${safeFileName(id)}.jsonl`);
  const frame = Buffer.from((sentEntry(1) as { bytes: Uint8Array }).bytes).toString('base64');
  await appendFile(old, [
    { entry: { kind: 'message', direction: 'out', at: at.toISOString(), frame, onWire: true }, next: 2, expected: 1 },
    { next: 2, expected: 7 },
  ].map(line => `${JSON.stringify(line)}\n`).join(''));
  const store = fileStore(dir);
  const loaded = await store.load(id);
  assert.deepEqual(loaded.history.map(e => e.kind === 'message' && e.message.TestReqID), ['t1']);
  assert.deepEqual({ next: loaded.next, expected: loaded.expected }, { next: 2, expected: 7 });
  assert.deepEqual((await readdir(dir)).sort(), [safeFileName(id)]);
  assert.deepEqual((await readdir(join(dir, safeFileName(id)))).sort(), ['1.jsonl', 'session.json']);
  await store.append(id, [record(sentEntry(1), 2, 1, { newEpoch: true })]);
  assert.deepEqual((await fileStore(dir).load(id)).history.map(e => e.kind === 'message' && e.message.MsgSeqNum), [1]);
  assert.deepEqual((await readdir(join(dir, safeFileName(id)))).sort(), ['1.jsonl', '2.jsonl', 'session.json']);
});

test('fileStore.load reads an epoch from its end, and stops once it has the newest entries', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  await appendFile(join(dir, safeFileName(id), '1.jsonl'), 'not json\n');   // never reached below
  for (let seq = 2; seq <= 6; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  const tail = await store.load(id, { history: { entries: 3, bytes: 1_048_576 } });
  assert.deepEqual(tail.history.map(e => e.kind === 'message' && e.message.MsgSeqNum), [4, 5, 6]);
  await assert.rejects(store.load(id), /the line at byte \d+ is not a JSON object/);
});

test('fileStore keeps a message too large for one line without its frame: its sequence numbers count, its entry is left out', { timeout: 10_000 }, async () => {
  const store = fileStore(await mkdtemp(join(tmpdir(), 'fixjs-store-')));
  const huge: Entry = { kind: 'message', direction: 'in', at, message: { MsgType: 'TestRequest', MsgSeqNum: 1 }, bytes: new Uint8Array(13 * 1024 * 1024) };
  await store.append(id, [record(huge, 1, 2)]);
  await store.append(id, [record(sentEntry(1), 2, 2)]);
  const loaded = await store.load(id);
  assert.deepEqual(loaded.history.map(e => e.kind === 'message' && e.direction), ['out']);
  assert.deepEqual({ next: loaded.next, expected: loaded.expected }, { next: 2, expected: 2 });
});

/** What a fileStore did with the files it appends to, while watchingAppends() ran: the paths it opened and closed, in order, and each text it wrote. */
interface Appends {
  readonly opened: string[];
  readonly closed: string[];
  readonly writes: string[];
  /** The most that were open at once. */
  most: number;
  /** How many are open now. */
  open(): number;
}

/**
 * Runs `work` with every file that is opened to append to (fs/promises' open with flag 'a')
 * watched: its opening, its close, and each text written to it (FileHandle.write, one request to
 * the operating system each). With `write`, that is called in place of each write, and given the
 * real one.
 */
async function watchingAppends<T>(work: (seen: Appends) => Promise<T>, write?: (real: (text: string) => Promise<void>, text: string, path: string) => Promise<void>): Promise<T> {
  const seen: Appends = { opened: [], closed: [], writes: [], most: 0, open: () => seen.opened.length - seen.closed.length };
  return withOpen(async (real, path, flags, mode) => {
    const handle = await real(path, flags, mode);
    if (flags !== 'a') return handle;
    seen.opened.push(String(path));
    seen.most = Math.max(seen.most, seen.open());
    const put = handle.write.bind(handle) as (buffer: Uint8Array, offset: number, length: number) => Promise<{ bytesWritten: number }>;
    const close = handle.close.bind(handle);
    /** Writes all of a text, as the store does: on from where a write stopped short. */
    const all = async (text: string): Promise<void> => {
      const bytes = Buffer.from(text);
      for (let done = 0; done < bytes.length;) done += (await put(bytes, done, bytes.length - done)).bytesWritten;
    };
    handle.write = (async (buffer: Uint8Array, offset = 0, length = buffer.length - offset) => {
      const data = Buffer.from(buffer.buffer, buffer.byteOffset + offset, length).toString('utf8');
      seen.writes.push(data);
      await (write ? write(all, data, String(path)) : all(data));
      return { bytesWritten: length, buffer };
    }) as typeof handle.write;
    handle.close = async () => {
      await close();
      seen.closed.push(String(path));
    };
    return handle;
  }, () => work(seen));
}

/** A write that, while `failing()`, puts what `cut` leaves of the text in the file and then fails as a full disk does. */
const cutShort = (cut: (text: string) => string, failing: () => boolean = () => true) => async (real: (text: string) => Promise<void>, text: string): Promise<void> => {
  if (!failing()) return real(text);
  await real(cut(text));
  throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
};

for (const [what, cut] of [['part of a record', (line: string) => line.slice(0, line.length >> 1)], ['a whole record but its newline', (line: string) => line.slice(0, -1)]] as const) {
  test(`fileStore.append after one that wrote ${what} and failed starts a line of its own, so load() still reads every later record`, { timeout: 10_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
    const store = fileStore(dir);
    await store.append(id, [record(sentEntry(1), 2, 1)]);
    await watchingAppends(() => assert.rejects(store.append(id, [record(sentEntry(2), 3, 1)]), /no space left/), cutShort(cut));
    await store.append(id, [record(sentEntry(3), 4, 1)]);
    await store.append(id, [record(sentEntry(4), 5, 1)]);
    const loaded = await fileStore(dir).load(id);
    const kept = what === 'part of a record' ? [1, 3, 4] : [1, 2, 3, 4];
    assert.deepEqual(loaded.history.map(seqOf), kept);
    assert.equal(loaded.next, 5);
    assert.deepEqual((await readAll(fileStore(dir).read(id))).map(seqOf), kept);
  });
}

test('fileStore runs load() and append() on one session one at a time: a load that cuts off a torn line never cuts into an append', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  const file = join(dir, safeFileName(id), '1.jsonl');
  const large = (seq: number): Entry => ({ kind: 'error', at, text: `${seq}:${'x'.repeat(200_000)}` });
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  await appendFile(file, '{"entry":{"kind"');   // torn by a crash
  // Appends called while a load is still running wait their turn, and a load waits for the appends before it.
  const calls: Promise<unknown>[] = [store.load(id)];
  for (let seq = 2; seq <= 6; seq++) calls.push(store.append(id, [record(large(seq), seq + 1, 1)]));
  const middle = store.load(id);
  for (let seq = 7; seq <= 11; seq++) calls.push(store.append(id, [record(large(seq), seq + 1, 1)]));
  await Promise.all(calls);
  const between = await middle;
  assert.deepEqual({ entries: between.history.length, next: between.next }, { entries: 6, next: 7 }, 'the middle load sees the appends called before it, and none after');
  const lines = (await readFile(file, 'utf8')).split('\n');
  assert.equal(lines.pop(), '', 'the file ends with a newline');
  assert.equal(lines.length, 12, 'a header and eleven records, and nothing else');
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  const loaded = await fileStore(dir).load(id, { history: { entries: 1_000, bytes: 16 * 1_048_576 } });
  assert.equal(loaded.history.length, 11);
  assert.deepEqual({ next: loaded.next, expected: loaded.expected }, { next: 12, expected: 1 });
});

test('fileStore never takes a part-written epoch file as the current one: it removes it and carries on from the epoch before', { timeout: 10_000 }, async () => {
  const header = `${JSON.stringify({ epoch: 2, startedAt: at.toISOString() })}\n`;
  for (const [what, content] of [['empty', ''], ['half a header', header.slice(0, 20)], ['a header and half a record', `${header}{"next":1,"exp`]] as const) {
    const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
    const folder = join(dir, safeFileName(id));
    for (let seq = 1; seq <= 3; seq++) await fileStore(dir).append(id, [record(sentEntry(seq), seq + 1, 50)]);
    await writeFile(join(folder, '2.jsonl'), content);   // a roll-over cut short
    const store = fileStore(dir);
    const loaded = await store.load(id);
    assert.deepEqual(loaded.history.map(e => e.kind === 'message' && e.message.MsgSeqNum), [1, 2, 3], what);
    assert.deepEqual({ next: loaded.next, expected: loaded.expected }, { next: 4, expected: 50 }, what);
    await store.append(id, [seqNumsOnly({ next: 1, expected: 7 }, { newEpoch: true })]);
    const lines = (await readFile(join(folder, '2.jsonl'), 'utf8')).split('\n');
    assert.deepEqual(lines.map(line => line && JSON.parse(line)), [{ epoch: 2, startedAt: at.toISOString() }, { next: 1, expected: 7 }, ''], what);
    assert.deepEqual(await fileStore(dir).load(id), { history: [], next: 1, expected: 7 }, what);
  }
});

test('fileStore removes a .tmp file a write cut short left behind, and never reads it as an epoch', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const folder = join(dir, safeFileName(id));
  await fileStore(dir).append(id, [record(sentEntry(1), 2, 1)]);
  await writeFile(join(folder, '2.jsonl.tmp'), `${JSON.stringify({ epoch: 2, startedAt: at.toISOString() })}\n{"next":9,"expected":9}\n`);
  await writeFile(join(folder, 'session.json.tmp'), '{"vers');
  const loaded = await fileStore(dir).load(id);
  assert.deepEqual({ next: loaded.next, expected: loaded.expected }, { next: 2, expected: 1 });
  assert.deepEqual((await readdir(folder)).sort(), ['1.jsonl', 'session.json']);
});

test('fileStore writes session.json once, and never again at a later epoch', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  const path = join(dir, safeFileName(id), 'session.json');
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  // Already has a lifetime id, so a later roll-over (which only ever adds a missing one) must leave it alone.
  const marked = `${JSON.stringify({ version: 'FIX.4.4', sender: 'EXCHANGE', target: 'CLIENT', written: 'once', lifetime: 'kept' })}\n`;
  await writeFile(path, marked);
  await store.append(id, [record(sentEntry(1), 2, 1, { newEpoch: true })]);
  await fileStore(dir).append(id, [record(sentEntry(1), 2, 1, { newEpoch: true })]);
  assert.equal(await readFile(path, 'utf8'), marked);
  assert.deepEqual((await readdir(join(dir, safeFileName(id)))).sort(), ['1.jsonl', '2.jsonl', '3.jsonl', 'session.json']);
});

test('fileStore.reset removes the file from before epochs first, so a reset cut short never brings it back', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const old = join(dir, `${safeFileName(id)}.jsonl`);
  const store = fileStore(dir);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  await writeFile(old, `${JSON.stringify({ next: 40, expected: 40 })}\n`);   // both layouts: the old file is never read
  assert.equal((await store.load(id)).next, 2);
  // The reset is cut short after its first removal.
  const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
  const realRm = fsp.rm;
  let removals = 0;
  fsp.rm = (async (...args: Parameters<typeof realRm>) => {
    if (++removals === 2) throw Object.assign(new Error('cut short'), { code: 'EIO' });
    return realRm(...args);
  }) as typeof realRm;
  syncBuiltinESMExports();
  try {
    await assert.rejects(store.reset(id), /cut short/);
  } finally {
    fsp.rm = realRm;
    syncBuiltinESMExports();
  }
  assert.ok(!(await readdir(dir)).includes(`${safeFileName(id)}.jsonl`), 'the old file is gone');
  await store.reset(id);
  assert.deepEqual(await fileStore(dir).load(id), { history: [], next: 1, expected: 1 });
});

for (const call of ['list', 'load'] as const) {
  test(`fileStore ignores a session folder a reset cut short, and ${call}() removes it`, { timeout: 10_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
    await fileStore(dir).append(id, [record(sentEntry(1), 40, 40)]);
    // What a reset leaves when it is cut short after renaming the folder.
    const doomed = `${safeFileName(id)}.deleting-0f8fad5b-d9cb-469f-a165-70867728950e`;
    await rename(join(dir, safeFileName(id)), join(dir, doomed));
    const store = fileStore(dir);
    if (call === 'list') {
      assert.deepEqual(await store.list(), []);
      assert.deepEqual(await readdir(dir), []);
    } else {
      assert.deepEqual(await store.load(id), { history: [], next: 1, expected: 1 });
      // load()'s first sweep runs in the background, so the folder's removal may still be in flight.
      await waitFor(async () => (await readdir(dir)).length === 0, 1000, 'the doomed folder swept away');
    }
    assert.deepEqual(await readAll(store.read(id)), []);
  });
}

test('fileStore.load does not wait for its first sweep: a leftover folder a reset cut short stays until the sweep removes it, never delaying load()', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const doomedName = `${safeFileName(id)}.deleting-0f8fad5b-d9cb-469f-a165-70867728950e`;
  const doomed = join(dir, doomedName);
  await mkdir(doomed, { recursive: true });
  await writeFile(join(doomed, 'stray.jsonl'), 'x');
  // A live session, in a folder the sweep must leave alone.
  await fileStore(dir).append(id, [record(sentEntry(1), 2, 1)]);
  const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
  const realRm = fsp.rm;
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  fsp.rm = (async (...args: Parameters<typeof realRm>) => {
    await held;   // the sweep's removal hangs until released, standing in for one slowed by a huge folder
    return realRm(...args);
  }) as typeof realRm;
  syncBuiltinESMExports();
  try {
    const store = fileStore(dir);
    const loaded = await store.load(id);
    assert.deepEqual({ next: loaded.next, expected: loaded.expected }, { next: 2, expected: 1 });   // the live session, unaffected
    // load() returned while the sweep's rm() is still stuck: it never waited for it.
    assert.ok((await readdir(dir)).includes(doomedName), 'the doomed folder is still there');
    release?.();
    await waitFor(async () => !(await readdir(dir)).includes(doomedName), 1000, 'the doomed folder swept away');
    assert.ok((await readdir(dir)).includes(safeFileName(id)), "the live session's folder was left alone");
  } finally {
    fsp.rm = realRm;
    syncBuiltinESMExports();
  }
});

test('fileStore.reset leaves nothing behind, and a session started again after it begins at epoch 1', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  await store.reset(id);
  assert.deepEqual(await readdir(dir), []);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  assert.deepEqual((await store.list()).map(session => session.epochs.map(epoch => epoch.epoch)), [[1]]);
});

test('fileStore.load with no room for history reads only as far as the last record, for the sequence numbers', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  await store.append(id, [seqNumsOnly({ next: 2, expected: 1 })]);
  await appendFile(join(dir, safeFileName(id), '1.jsonl'), 'not json\n');   // never reached below
  for (let next = 3; next <= 8; next++) await store.append(id, [seqNumsOnly({ next, expected: 1 })]);
  assert.deepEqual(await store.load(id, { history: { entries: 0, bytes: 1_048_576 } }), { history: [], next: 8, expected: 1 });
  assert.deepEqual(await store.load(id, { history: { entries: 1_000, bytes: 0 } }), { history: [], next: 8, expected: 1 });
  await assert.rejects(store.load(id), /the line at byte \d+ is not a JSON object/);
});

test('memoryStore forgets every epoch it keeps no entry of, not only the oldest: resets with nothing sent do not pile up', () => {
  // Measured in a child process, where the garbage collector can be run before each reading.
  const storeUrl = new URL('./store.ts', import.meta.url).href;
  const script = `
    import { memoryStore } from '${storeUrl}';
    const id = { version: 'FIX.4.4', sender: 'EXCHANGE', target: 'CLIENT' };
    const at = new Date();
    const store = memoryStore();
    await store.append(id, [{ at, entry: { kind: 'error', at, text: 'kept' }, seqNums: { next: 1, expected: 1 } }]);
    const resets = async count => { for (let i = 0; i < count; i++) await store.append(id, [{ at, seqNums: { next: 1, expected: 1 }, newEpoch: true }]); };
    await resets(1_000);
    globalThis.gc();
    const before = process.memoryUsage().heapUsed;
    await resets(200_000);
    globalThis.gc();
    console.log(process.memoryUsage().heapUsed - before);
  `;
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const grown = Number(result.stdout.trim());
  assert.ok(grown < 2 * 1_048_576, `the heap grew by ${grown} bytes over 200,000 resets`);
});

test('memoryStore forgets an epoch once it keeps none of its entries', { timeout: 10_000 }, async () => {
  const store = memoryStore({ history: 2 });
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  await store.append(id, [record(sentEntry(1), 2, 1, { newEpoch: true })]);
  await store.append(id, [record(sentEntry(2), 3, 1)]);
  assert.deepEqual((await store.list())[0]?.epochs, [{ epoch: 2, startedAt: at, entries: 2 }]);
});

test('fileStore.read() reads only as far as it is asked', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  await appendFile(join(dir, safeFileName(id), '1.jsonl'), 'not json\n');
  for await (const entry of store.read(id)) {
    assert.equal(seqOf(entry), 1);
    break;   // the bad line after it is never read
  }
  await assert.rejects(readAll(store.read(id)), /the line at byte \d+ is not a JSON object/);
});

test('fileStore.read() leaves out a last line cut short by a crash', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  await appendFile(join(dir, safeFileName(id), '1.jsonl'), '{"next":3,"expected":1,"entry":{"kind"');
  assert.deepEqual((await readAll(store.read(id))).map(seqOf), [1]);
});

test('fileStore.list() shows a file from before epochs once its session has been loaded or appended to, starting when its first entry was; read() reads it where it is', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const frame = Buffer.from((sentEntry(1) as { bytes: Uint8Array }).bytes).toString('base64');
  await writeFile(join(dir, `${safeFileName(id)}.jsonl`), `${JSON.stringify({ entry: { kind: 'message', direction: 'out', at: at.toISOString(), frame, onWire: true }, next: 2, expected: 1 })}\n`);
  const store = fileStore(dir);
  assert.deepEqual(await store.list(), []);   // whose it is can't be told until it is used
  assert.deepEqual((await readAll(store.read(id))).map(seqOf), [1]);
  assert.deepEqual(await store.list(), []);   // reading moves nothing
  await store.load(id);
  assert.deepEqual(await store.list(), [{ id, epochs: [{ epoch: 1, startedAt: at }] }]);
});

test('fileStore.list() leaves out folders it did not write', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  await mkdir(join(dir, 'notes'));
  await mkdir(join(dir, 'borrowed'));
  await writeFile(join(dir, 'borrowed', 'session.json'), JSON.stringify(id));   // names a session, but not this folder's
  await writeFile(join(dir, 'stray.txt'), 'hello');
  assert.deepEqual((await store.list()).map(session => session.id), [id]);
});

test('fileStore.list() leaves out a session whose session.json is empty, cut short, not JSON, or not a SessionId, and one with no epoch', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  const bad: [SessionId, string | null][] = [
    [{ ...id, target: 'EMPTY' }, ''],
    [{ ...id, target: 'CUT' }, '{"version":"FIX.4.4","sender":"EXCH'],
    [{ ...id, target: 'GARBAGE' }, '\u0000\u00ff not json at all'],
    [{ ...id, target: 'ARRAY' }, '["FIX.4.4","EXCHANGE","ARRAY"]'],
    [{ ...id, target: 'VERSION' }, '{"version":"FIX.9.9","sender":"EXCHANGE","target":"VERSION"}'],
    [{ ...id, target: 'FOLDER' }, null],   // session.json is a folder
  ];
  for (const [badId, text] of bad) {
    const folder = join(dir, safeFileName(badId));
    await mkdir(folder);
    await writeFile(join(folder, '1.jsonl'), `${JSON.stringify({ epoch: 1, startedAt: at.toISOString() })}\n{"next":1,"expected":1}\n`);
    if (text === null) await mkdir(join(folder, 'session.json'));
    else await writeFile(join(folder, 'session.json'), text);
  }
  const unused: SessionId = { ...id, target: 'UNUSED' };   // a folder and session.json, but no epoch
  await mkdir(join(dir, safeFileName(unused)));
  await writeFile(join(dir, safeFileName(unused), 'session.json'), JSON.stringify(unused));
  assert.deepEqual((await store.list()).map(session => session.id), [id]);
});

test('fileStore.list() shows an epoch whose file has no header: starting when its first entry was, or else when the file last changed', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  const later = new Date(at.getTime() + 60_000);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  const frame = Buffer.from((sentEntry(1) as { bytes: Uint8Array }).bytes).toString('base64');
  await writeFile(join(dir, safeFileName(id), '2.jsonl'), `${JSON.stringify({ next: 2, expected: 1, entry: { kind: 'message', direction: 'out', at: later.toISOString(), frame, onWire: true } })}\n`);
  await writeFile(join(dir, safeFileName(id), '3.jsonl'), 'not json\n');
  const [session] = await store.list();
  assert.deepEqual(session?.epochs.slice(0, 2), [{ epoch: 1, startedAt: at }, { epoch: 2, startedAt: later }]);
  assert.equal(session?.epochs[2]?.epoch, 3);
  assert.ok(session?.epochs[2]?.startedAt instanceof Date && !Number.isNaN(session.epochs[2].startedAt.getTime()));
});

test('fileStore.read() does not hold up appends to the session while its reader pauses; it reads on to the end of the file as it then finds it', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  for (let seq = 1; seq <= 3; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  const reading = store.read(id)[Symbol.asyncIterator]();
  const first = await reading.next();
  assert.equal(!first.done && seqOf(first.value), 1);
  // The reader has stopped part-way; appends and a load still complete.
  for (let seq = 4; seq <= 6; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  assert.equal((await store.load(id)).next, 7);
  const rest: Entry[] = [];
  for (let step = await reading.next(); !step.done; step = await reading.next()) rest.push(step.value);
  assert.deepEqual(rest.map(seqOf), [2, 3, 4, 5, 6]);
});

test('fileStore.read() of a session reset while its reader pauses ends without an error', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  await store.append(id, [record(sentEntry(1), 2, 1, { newEpoch: true })]);
  const reading = store.read(id)[Symbol.asyncIterator]();
  assert.equal(seqOf((await reading.next()).value as Entry), 1);
  await store.reset(id);
  for (let step = await reading.next(); !step.done; step = await reading.next());
  assert.deepEqual(await store.list(), []);
});


test('fileStore.read() gives nothing written after a reset: a reader paused across a reset and a new start of the session stops', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  await store.append(id, [record(sentEntry(2), 3, 1)]);
  await store.append(id, [record(sentEntry(3), 4, 1, { newEpoch: true })]);
  const reading = store.read(id)[Symbol.asyncIterator]();
  assert.equal(seqOf((await reading.next()).value as Entry), 1);
  await store.reset(id);
  await store.append(id, [record(sentEntry(101), 102, 1)]);
  await store.append(id, [record(sentEntry(102), 103, 1, { newEpoch: true })]);   // a new epoch 2
  const rest: Entry[] = [];
  for (let step = await reading.next(); !step.done; step = await reading.next()) rest.push(step.value);
  assert.deepEqual(rest.map(seqOf).filter(seq => Number(seq) > 100), []);
});

test('fileStore.read() changes nothing: a second store reading while a writer begins an epoch leaves the writer\'s .tmp file alone', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  await store.append(id, [record(sentEntry(2), 3, 1)]);
  // The writer is held between writing the new epoch's .tmp file and renaming it into place.
  const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
  const realRename = fsp.rename;
  let reached = () => {};
  const atRename = new Promise<void>(resolve => { reached = resolve; });
  let release = () => {};
  const released = new Promise<void>(resolve => { release = resolve; });
  fsp.rename = (async (from: string, to: string) => {
    if (String(from).endsWith('.jsonl.tmp')) {
      reached();
      await released;
    }
    return realRename(from, to);
  }) as typeof realRename;
  syncBuiltinESMExports();
  try {
    const writing = store.append(id, [record(sentEntry(1), 2, 1, { newEpoch: true })]);
    await atRename;
    assert.deepEqual((await readAll(fileStore(dir).read(id))).map(seqOf), [1, 2]);
    release();
    await writing;
  } finally {
    fsp.rename = realRename;
    syncBuiltinESMExports();
  }
  assert.deepEqual((await fileStore(dir).load(id)).history.map(seqOf), [1]);
});

test('fileStore.read() skips a part-written last epoch file and leaves it where it is', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  await fileStore(dir).append(id, [record(sentEntry(1), 2, 1)]);
  const partial = join(dir, safeFileName(id), '2.jsonl');
  await writeFile(partial, `${JSON.stringify({ epoch: 2, startedAt: at.toISOString() })}\n`);
  assert.deepEqual((await readAll(fileStore(dir).read(id))).map(seqOf), [1]);
  assert.ok((await readdir(join(dir, safeFileName(id)))).includes('2.jsonl'), 'read() removes nothing');
});

test('fileStore.read() stops when the session folder gets a new lifetime id between epochs, even at the same inode', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  await store.append(id, [record(sentEntry(2), 3, 1, { newEpoch: true })]);
  const sessionJsonPath = join(dir, safeFileName(id), 'session.json');
  const original = JSON.parse(await readFile(sessionJsonPath, 'utf8')) as Record<string, unknown>;
  assert.equal(typeof original.lifetime, 'string', 'fileStore writes a lifetime id into session.json');
  const reading = store.read(id)[Symbol.asyncIterator]();
  assert.equal(seqOf((await reading.next()).value as Entry), 1);
  // The folder comes back with the same inode (it is never removed here) but a different lifetime:
  // the way a reused inode on some filesystems could look identical to the one read() began on.
  await writeFile(sessionJsonPath, JSON.stringify({ ...original, lifetime: 'a-different-lifetime' }));
  const next = await reading.next();
  assert.equal(next.done, true, "read() must not open the next epoch once the folder's lifetime has changed");
});

test('fileStore gives a session.json written before lifetime ids one at the next roll-over, atomically', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const folder = join(dir, safeFileName(id));
  await mkdir(folder, { recursive: true });
  // A session.json in the format written before this field existed.
  await writeFile(join(folder, 'session.json'), `${JSON.stringify({ version: id.version, sender: id.sender, target: id.target })}\n`);
  await writeFile(join(folder, '1.jsonl'), `${JSON.stringify({ epoch: 1, startedAt: at.toISOString() })}\n{"next":2,"expected":1}\n`);
  const store = fileStore(dir);
  assert.equal('lifetime' in JSON.parse(await readFile(join(folder, 'session.json'), 'utf8')), false, 'not rewritten merely by being looked up');
  await store.load(id);
  assert.equal('lifetime' in JSON.parse(await readFile(join(folder, 'session.json'), 'utf8')), false, 'not rewritten by load() alone');
  await store.append(id, [record(sentEntry(2), 3, 1, { newEpoch: true })]);   // the next roll-over
  const after = JSON.parse(await readFile(join(folder, 'session.json'), 'utf8'));
  assert.equal(typeof after.lifetime, 'string');
  assert.deepEqual({ ...after, lifetime: undefined }, { version: id.version, sender: id.sender, target: id.target, lifetime: undefined });
  assert.equal((await readdir(folder)).some(name => name.endsWith('.tmp')), false, 'written through tmp+rename, no .tmp left behind');
});

test('fileStore.list() fails when the operating system will not let it read a session.json', { skip: process.getuid?.() === 0 && 'root reads every file', timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  const path = join(dir, safeFileName(id), 'session.json');
  await chmod(path, 0o000);
  try {
    await assert.rejects(store.list(), { code: 'EACCES' });
  } finally {
    await chmod(path, 0o644);
  }
});

test('fileStore.read() with from and to does not read epochs that began too late, or ended too early', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  const minute = (n: number) => new Date(at.getTime() + n * 60_000);
  await store.append(id, [record(sentAt(1, minute(0)), 2, 1)]);
  await store.append(id, [record(sentAt(1, minute(10)), 2, 1, { newEpoch: true })]);
  await store.append(id, [record(sentAt(2, minute(11)), 3, 1)]);
  await store.append(id, [record(sentAt(1, minute(20)), 2, 1, { newEpoch: true })]);
  // Epochs 1 and 3 hold a bad line: read() fails if it reads either.
  await appendFile(join(dir, safeFileName(id), '1.jsonl'), 'not json\n');
  await appendFile(join(dir, safeFileName(id), '3.jsonl'), 'not json\n');
  assert.deepEqual((await readAll(store.read(id, { from: minute(11), to: minute(15) }))).map(e => e.at), [minute(11)]);
  await assert.rejects(readAll(store.read(id)), /not a JSON object/);
});

test('fileStore ignores a folder named like an epoch file: list(), load() and read() carry on without it', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  await mkdir(join(dir, safeFileName(id), '7.jsonl'));
  assert.deepEqual(await store.list(), [{ id, epochs: [{ epoch: 1, startedAt: at }] }]);
  assert.deepEqual((await fileStore(dir).load(id)).history.map(seqOf), [1]);
  assert.deepEqual((await readAll(fileStore(dir).read(id))).map(seqOf), [1]);
});

test('fileStore ignores an epoch file that is a symlink: list() and read() never follow it out of the store', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const outside = await mkdtemp(join(tmpdir(), 'fixjs-outside-'));
  const store = fileStore(dir);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  const elsewhere = join(outside, 'elsewhere.jsonl');
  await writeFile(elsewhere, `${JSON.stringify({ epoch: 2, startedAt: '2001-01-01T00:00:00.000Z' })}\n{"next":1,"expected":1,"entry":{"kind":"error","at":"2001-01-01T00:00:00.000Z","text":"from elsewhere"}}\n`);
  await symlink(elsewhere, join(dir, safeFileName(id), '2.jsonl'));
  assert.deepEqual(await store.list(), [{ id, epochs: [{ epoch: 1, startedAt: at }] }]);
  assert.deepEqual((await readAll(fileStore(dir).read(id))).map(seqOf), [1]);
  assert.deepEqual((await fileStore(dir).load(id)).history.map(seqOf), [1]);
});

// ─── fileStore.sent() ───────────────────────────────────────────────────────

test('fileStore.sent() of a session reset while its reader pauses gives nothing more, and nothing of a session started again', { timeout: 10_000 }, async () => {
  const store = fileStore(await mkdtemp(join(tmpdir(), 'fixjs-store-')));
  for (let seq = 1; seq <= 5; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  const reading = store.sent(id, { from: 1, to: 5 })[Symbol.asyncIterator]();
  assert.equal(seqOf((await reading.next()).value as Entry), 1);
  await store.reset(id);
  for (let seq = 1; seq <= 5; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  assert.deepEqual(await reading.next(), { done: true, value: undefined });
  assert.deepEqual((await readAll(store.sent(id, { from: 1, to: 5 }))).map(seqOf), [1, 2, 3, 4, 5]);
});

test('fileStore.sent() answers from the files alone: another store on the same folder gives the same', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  for (let seq = 1; seq <= 3; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  await store.append(id, [record(sentEntry(1), 2, 1, { newEpoch: true })]);
  await store.append(id, [record(sentEntry(2), 3, 1)]);
  assert.deepEqual((await readAll(fileStore(dir).sent(id, { from: 1, to: 9 }))).map(seqOf), [1, 2]);
  assert.deepEqual((await readdir(join(dir, safeFileName(id)))).sort(), ['1.jsonl', '2.jsonl', 'session.json']);
});

test('fileStore.sent() reads a file written before epochs as the first epoch', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const frame = (seq: number) => Buffer.from((sentEntry(seq) as { bytes: Uint8Array }).bytes).toString('base64');
  await appendFile(join(dir, `${safeFileName(id)}.jsonl`), [1, 2, 3]
    .map(seq => `${JSON.stringify({ entry: { kind: 'message', direction: 'out', at: at.toISOString(), frame: frame(seq), onWire: true }, next: seq + 1, expected: 1 })}\n`).join(''));
  assert.deepEqual((await readAll(fileStore(dir).sent(id, { from: 2, to: 3 }))).map(seqOf), [2, 3]);
});

test('fileStore.sent() gives a range of more MsgSeqNums than it looks for at once, in order, though they were written in another', { timeout: 30_000 }, async () => {
  const store = fileStore(await mkdtemp(join(tmpdir(), 'fixjs-store-')));
  const count = 5_000;   // more than one pass of 4,096 looks for
  // Written highest first, then the first ten again: each of those has two originals, and the later one counts.
  for (let seq = count; seq >= 1; seq--) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  for (let seq = 1; seq <= 10; seq++) await store.append(id, [record({ ...sentEntry(seq), at: new Date(at.getTime() + 1) }, seq + 1, 1)]);
  const given = await readAll(store.sent(id, { from: 1, to: count + 100 }));
  assert.deepEqual(given.map(seqOf), Array.from({ length: count }, (_, index) => index + 1));
  assert.deepEqual(given.slice(0, 11).map(entry => entry.at.getTime() - at.getTime()), [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
  assert.deepEqual((await readAll(store.sent(id, { from: 4_090, to: 4_100 }))).map(seqOf), [4_090, 4_091, 4_092, 4_093, 4_094, 4_095, 4_096, 4_097, 4_098, 4_099, 4_100]);
});

test('fileStore.sent() fails on a line that is not JSON and names no MsgSeqNum, as read() does, and leaves out a frame that no longer decodes', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  await appendFile(join(dir, safeFileName(id), '1.jsonl'), `${JSON.stringify({ next: 3, expected: 1, entry: { kind: 'message', direction: 'out', at: at.toISOString(), frame: 'bm90IGEgZnJhbWU=', onWire: true } })}\n`);
  await store.append(id, [record(sentEntry(3), 4, 1)]);
  assert.deepEqual((await readAll(fileStore(dir).sent(id, { from: 1, to: 3 }))).map(seqOf), [1, 3]);
  await appendFile(join(dir, safeFileName(id), '1.jsonl'), 'not json\n');
  await store.append(id, [record(sentEntry(4), 5, 1)]);
  await assert.rejects(readAll(fileStore(dir).sent(id, { from: 1, to: 4 })), /1\.jsonl: the line at byte \d+ is not a JSON object/);
});

/** The record lines of a session's epoch file: each one's text and where it starts, in bytes. */
async function recordLines(dir: string, epoch = 1): Promise<{ path: string; lines: { text: string; start: number }[] }> {
  const path = join(dir, safeFileName(id), `${epoch}.jsonl`);
  const lines: { text: string; start: number }[] = [];
  let start = 0;
  for (const text of (await readFile(path, 'utf8')).split('\n').slice(0, -1)) {
    lines.push({ text, start });
    start += Buffer.byteLength(text) + 1;
  }
  return { path, lines: lines.slice(1) };   // without the header
}

/** Overwrites a line of a file where it is with text no reader takes for a record; the file keeps its length. */
async function damage(path: string, line: { text: string; start: number }): Promise<void> {
  const file = await open(path, 'r+');
  try {
    await file.write(Buffer.from('x'.repeat(Buffer.byteLength(line.text))), 0, undefined, line.start);
  } finally {
    await file.close();
  }
}

const sentSeqs = async (store: ReturnType<typeof fileStore>, from: number, to: number) => (await readAll(store.sent(id, { from, to }))).map(seqOf);

test('fileStore writes the MsgSeqNum of an original in clear on its line, and of nothing else', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  const copy = sentEntry(1);
  const unencodable: Entry = { kind: 'message', direction: 'out', at, message: { MsgType: 'TestRequest', MsgSeqNum: 5, NoSuchField: 'x' } };
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  await store.append(id, [record(copy.kind === 'message' ? { ...copy, message: { ...copy.message, PossDupFlag: true } } : copy, 2, 1)]);
  await store.append(id, [record({ ...sentEntry(2), direction: 'in' } as Entry, 2, 2)]);
  await store.append(id, [record(sentEntry(3, true), 4, 2)]);
  await store.append(id, [record(unencodable, 6, 2)]);
  await store.append(id, [record(problemEntry, 6, 2)]);
  await store.append(id, [seqNumsOnly({ next: 9, expected: 2 })]);
  const { lines } = await recordLines(dir);
  assert.deepEqual(lines.map(line => (JSON.parse(line.text) as { seq?: number }).seq), [1, undefined, undefined, 3, undefined, undefined, undefined]);
  assert.match(lines[0]!.text, /^\{"next":2,"expected":1,"seq":1,"entry":\{"kind":"message","direction":"out",/);
  assert.deepEqual(await sentSeqs(fileStore(dir), 1, 9), [1, 3]);
});

test('fileStore.sent() reads lines written before lines named their MsgSeqNum, beside lines that do', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  const frame = (seq: number) => Buffer.from((sentEntry(seq) as { bytes: Uint8Array }).bytes).toString('base64');
  const before = (seq: number) => `${JSON.stringify({ next: seq + 1, expected: 1, entry: { kind: 'message', direction: 'out', at: at.toISOString(), frame: frame(seq), onWire: true } })}\n`;
  await appendFile(join(dir, safeFileName(id), '1.jsonl'), before(2) + before(3));
  const later = fileStore(dir);
  await later.append(id, [record(sentEntry(4), 5, 1)]);
  assert.deepEqual(await sentSeqs(later, 1, 9), [1, 2, 3, 4]);
  assert.deepEqual(await sentSeqs(later, 2, 3), [2, 3]);
  await later.append(id, [record(sentEntry(5), 6, 1)]);
  assert.deepEqual(await sentSeqs(later, 3, 5), [3, 4, 5]);
});

test('fileStore.sent() on an epoch written in order begins at the place it remembers and stops once past the range: lines before and after are not read', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  for (let seq = 1; seq <= 50; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  assert.deepEqual(await sentSeqs(store, 1, 1), [1]);                // the first sent(): the file is read through once
  for (let seq = 51; seq <= 100; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);   // each append adds its place
  const { path, lines } = await recordLines(dir);
  await damage(path, lines[1]!);     // MsgSeqNum 2
  await damage(path, lines[94]!);    // MsgSeqNum 95
  assert.deepEqual(await sentSeqs(store, 60, 70), [60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70]);
  assert.deepEqual(await sentSeqs(store, 96, 200), [96, 97, 98, 99, 100]);
  assert.deepEqual(await sentSeqs(store, 101, 200), []);
  await assert.rejects(sentSeqs(store, 1, 5), /is not a JSON object/);      // the damage is there for a read that crosses it
  await assert.rejects(sentSeqs(store, 90, 100), /is not a JSON object/);
});

test('fileStore.sent() after a restart reads the epoch through once, then remembers it', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const writer = fileStore(dir);
  for (let seq = 1; seq <= 100; seq++) await writer.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  const store = fileStore(dir);   // as after a restart: nothing remembered
  assert.deepEqual(await sentSeqs(store, 60, 62), [60, 61, 62]);
  const { path, lines } = await recordLines(dir);
  await damage(path, lines[1]!);
  assert.deepEqual(await sentSeqs(store, 60, 62), [60, 61, 62]);          // not read through again
  await assert.rejects(sentSeqs(fileStore(dir), 60, 62), /is not a JSON object/);   // a store with nothing remembered must
});

test('fileStore.sent() remembers no more than 1,024 places of an epoch, and still begins near what is asked for', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  for (let seq = 1; seq <= 1_000; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  assert.deepEqual(await sentSeqs(store, 1_000, 1_000), [1_000]);
  for (let seq = 1_001; seq <= 2_100; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);   // past 1,024 places twice: one original in four is marked
  const { path, lines } = await recordLines(dir);
  await damage(path, lines[1]!);
  assert.deepEqual(await sentSeqs(store, 2_050, 2_053), [2_050, 2_051, 2_052, 2_053]);
  assert.deepEqual(await sentSeqs(store, 7, 9), [7, 8, 9]);              // begins at MsgSeqNum 5, the place marked before it
  await assert.rejects(sentSeqs(store, 3, 9), /is not a JSON object/);     // begins at MsgSeqNum 1
});

test('fileStore.sent() gives the latest of each MsgSeqNum once an epoch it remembers is no longer in order (setSeqNums moved next back)', { timeout: 10_000 }, async () => {
  const store = fileStore(await mkdtemp(join(tmpdir(), 'fixjs-store-')));
  for (let seq = 1; seq <= 5; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  assert.deepEqual(await sentSeqs(store, 1, 5), [1, 2, 3, 4, 5]);
  await store.append(id, [seqNumsOnly({ next: 3, expected: 1 })]);
  await store.append(id, [record({ ...sentEntry(3), at: new Date(at.getTime() + 1) }, 4, 1)]);
  const given = await readAll(store.sent(id, { from: 1, to: 5 }));
  assert.deepEqual(given.map(seqOf), [1, 2, 3, 4, 5]);
  assert.deepEqual(given.map(entry => entry.at.getTime() - at.getTime()), [0, 0, 1, 0, 0]);
});

test('fileStore.sent() forgets what it remembers of an epoch at a new epoch and at a reset', { timeout: 10_000 }, async () => {
  const store = fileStore(await mkdtemp(join(tmpdir(), 'fixjs-store-')));
  for (let seq = 1; seq <= 5; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  assert.deepEqual(await sentSeqs(store, 1, 9), [1, 2, 3, 4, 5]);
  await store.append(id, [record(sentEntry(1), 2, 1, { newEpoch: true })]);
  assert.deepEqual(await sentSeqs(store, 1, 9), [1]);
  await store.append(id, [record(sentEntry(2), 3, 1)]);
  assert.deepEqual(await sentSeqs(store, 1, 9), [1, 2]);
  await store.reset(id);
  assert.deepEqual(await sentSeqs(store, 1, 9), []);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  assert.deepEqual(await sentSeqs(store, 1, 9), [1]);
});

for (const [what, cut, kept] of [['part of a record', (line: string) => line.slice(0, line.length >> 1), [1, 2, 4]], ['a whole record but its newline', (line: string) => line.slice(0, -1), [1, 2, 3, 4]]] as const) {
  test(`fileStore.sent() after an append that wrote ${what} and failed gives what the file then holds`, { timeout: 10_000 }, async () => {
    const store = fileStore(await mkdtemp(join(tmpdir(), 'fixjs-store-')));
    let failing = false;
    await watchingAppends(async () => {
      await store.append(id, [record(sentEntry(1), 2, 1)]);
      await store.append(id, [record(sentEntry(2), 3, 1)]);   // through the file the store now keeps open
      assert.deepEqual(await sentSeqs(store, 1, 9), [1, 2]);
      failing = true;
      await assert.rejects(store.append(id, [record(sentEntry(3), 4, 1)]), /no space left/);
      failing = false;
      await store.append(id, [record(sentEntry(4), 5, 1)]);
    }, cutShort(cut, () => failing));
    assert.deepEqual(await sentSeqs(store, 1, 9), kept);
    assert.deepEqual(await sentSeqs(store, 4, 4), [4]);
  });
}

// ─── sent(): what it costs, what a line must hold, and its bounds ───────────

/** Rewrites a session's epoch file through `change`, behind the store's back. */
async function rewrite(dir: string, change: (text: string) => string, epoch = 1): Promise<void> {
  const path = join(dir, safeFileName(id), `${epoch}.jsonl`);
  await writeFile(path, change(await readFile(path, 'utf8')));
}
/** The whole numbers from..to. */
const upTo = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
/** An entry like sentEntry(seq), a millisecond later: the later of two originals with one MsgSeqNum. */
const sentLater = (seq: number) => sentAt(seq, new Date(at.getTime() + 1));
const laterThanAt = (entries: readonly Entry[]) => entries.map(entry => entry.at.getTime() - at.getTime());

/** A copy of message `seq` as a resend gives it: its frame says PossDupFlag. */
function resentEntry(seq: number): Entry {
  const { fields, framing } = fromMessage('TestRequest', {
    SenderCompID: 'EXCHANGE', TargetCompID: 'CLIENT', MsgSeqNum: seq, SendingTime: at, PossDupFlag: true, OrigSendingTime: at, TestReqID: `t${seq}`,
  }, dict, { version: 'FIX.4.4' });
  const bytes = buildFrame(fields, framing);
  return { kind: 'message', direction: 'out', at, message: inspectMessage(parseFrame(bytes).fields, dict).message, bytes };
}

/** Runs `work` with fs/promises' open replaced by `fake`, which is given the real one. */
async function withOpen<T>(fake: (real: typeof import('node:fs/promises').open, ...args: Parameters<typeof import('node:fs/promises').open>) => ReturnType<typeof import('node:fs/promises').open>, work: () => Promise<T>): Promise<T> {
  const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
  const real = fsp.open;
  fsp.open = ((...args: Parameters<typeof real>) => fake(real, ...args)) as typeof real;
  syncBuiltinESMExports();
  try {
    return await work();
  } finally {
    fsp.open = real;
    syncBuiltinESMExports();
  }
}

test('fileStore.sent() on an epoch not in order takes no longer for a MsgSeqNum written by hand, however high it is', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  const high = 4_000_000_000_000;
  for (let seq = 1; seq <= 20; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  await store.append(id, [record(sentEntry(high), 21, 1)]);   // one message with a MsgSeqNum written by hand
  for (let seq = 21; seq <= 30; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  for (const each of [store, fileStore(dir)]) {
    assert.deepEqual(await sentSeqs(each, 1, Number.MAX_SAFE_INTEGER), [...upTo(1, 30), high]);
    assert.deepEqual(await sentSeqs(each, 25, high - 1), upTo(25, 30));
    assert.deepEqual(await sentSeqs(each, 31, high), [high]);
    assert.deepEqual(await sentSeqs(each, high + 1, Number.MAX_SAFE_INTEGER), []);
  }
});

test('fileStore.sent() on an epoch not in order gives every original in order, the latest of each, when they are twice what it looks for at once and far apart', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const count = 8_192;                 // twice the 4,096 one pass gives: all it holds places for at once
  const apart = 1_000_003;             // the MsgSeqNums are this far apart
  const store = fileStore(dir);
  await store.append(id, [record(sentEntry(apart), 2, 1)]);
  // Every multiple of `apart` up to 8,192 of them, in an order that is neither rising nor falling, then some again.
  const order = upTo(1, count).map(index => (index * 7_919) % (count + 1));
  const again = [1, 2, 4_096, 4_097, 8_191, count];
  const line = (entry: Entry) => `${recordLine(record(entry, 2, 1), dict)}\n`;
  await appendFile(join(dir, safeFileName(id), '1.jsonl'), order.map(index => line(sentEntry(index * apart))).join('') + again.map(index => line(sentLater(index * apart))).join(''));
  for (const each of [store, fileStore(dir)]) {
    const given = await readAll(each.sent(id, { from: 1, to: Number.MAX_SAFE_INTEGER }));
    assert.deepEqual(given.map(seqOf), upTo(1, count).map(index => index * apart));
    assert.deepEqual(given.flatMap((entry, index) => entry.at.getTime() > at.getTime() ? [index + 1] : []), again);
    assert.deepEqual(await sentSeqs(each, 4_095 * apart + 1, 4_098 * apart), [4_096, 4_097, 4_098].map(index => index * apart));
    assert.deepEqual(await sentSeqs(each, 8_191 * apart, Number.MAX_SAFE_INTEGER), [8_191 * apart, count * apart]);
  }
});

test('fileStore.sent() on an epoch not in order answers a range that ends far past what the file holds', { timeout: 10_000 }, async () => {
  const store = fileStore(await mkdtemp(join(tmpdir(), 'fixjs-store-')));
  for (let seq = 1; seq <= 5; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  await store.append(id, [record(sentLater(3), 4, 1)]);
  const given = await readAll(store.sent(id, { from: 2, to: Number.MAX_SAFE_INTEGER }));
  assert.deepEqual(given.map(seqOf), [2, 3, 4, 5]);
  assert.deepEqual(laterThanAt(given), [0, 1, 0, 0]);
});

test('fileStore.sent() takes a MsgSeqNum a line names that is not a safe whole number as none named, and finds it in the frame', { timeout: 10_000 }, async () => {
  const outOfOrder = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  for (const seq of [1, 3, 2]) await fileStore(outOfOrder).append(id, [record(sentEntry(seq), seq + 1, 1)]);
  await rewrite(outOfOrder, text => text.replace('"seq":3,', '"seq":9999999999999999,'));
  assert.deepEqual(await sentSeqs(fileStore(outOfOrder), 3, Number.MAX_SAFE_INTEGER), [3]);
  assert.deepEqual(await sentSeqs(fileStore(outOfOrder), 1, Number.MAX_SAFE_INTEGER), [1, 2, 3]);

  const inOrder = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  for (const seq of [1, 2, 3]) await fileStore(inOrder).append(id, [record(sentEntry(seq), seq + 1, 1)]);
  await rewrite(inOrder, text => text.replace('"seq":3,', '"seq":9007199254740993,'));
  assert.deepEqual(await sentSeqs(fileStore(inOrder), 1, Number.MAX_SAFE_INTEGER), [1, 2, 3]);
});

for (const [order, extra] of [['in order', []], ['not in order', [2]]] as const) {
  test(`fileStore.sent() on an epoch ${order} leaves out a line that names a MsgSeqNum and does not hold the original with it`, { timeout: 10_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
    const store = fileStore(dir);
    for (const seq of [1, 2, 3, 4, 9]) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
    await store.append(id, [record(resentEntry(6), 10, 1)]);
    for (const seq of [10, 11, 12]) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
    for (const seq of extra) await store.append(id, [record(sentLater(seq), 13, 1)]);
    assert.deepEqual(await sentSeqs(fileStore(dir), 1, 99), [1, 2, 3, 4, 9, 10, 11, 12]);
    const { lines } = await recordLines(dir);
    await rewrite(dir, text => text
      .replace('"seq":9,', '"seq":5,')                                                   // names 5 over a frame numbered 9
      .replace(lines[5]!.text, lines[5]!.text.replace(',"entry":', ',"seq":6,"entry":'))   // names 6 over a frame marked PossDupFlag
      .replace(lines[6]!.text, lines[6]!.text.replace('"onWire":true}', '"onWire":true,"direction":"in"}'))   // names 10, and is a received message
      .replace(lines[7]!.text, lines[7]!.text.replace('"onWire":true}}', '"onWire":true')));   // names 11, and is not JSON
    assert.deepEqual(await sentSeqs(fileStore(dir), 1, 99), [1, 2, 3, 4, 12]);
    assert.deepEqual(await sentSeqs(fileStore(dir), 5, 11), []);
  });
}

test('fileStore.sent() gives nothing that is not the original it went for when another store has put another file there while its reader pauses', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  for (let seq = 1; seq <= 5; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  await store.append(id, [record(sentLater(3), 4, 1)]);   // not in order: each entry is read from the file as it is given
  const reading = store.sent(id, { from: 1, to: 5 })[Symbol.asyncIterator]();
  assert.equal(seqOf((await reading.next()).value as Entry), 1);
  const other = fileStore(dir);
  await other.reset(id);
  for (let seq = 5; seq >= 1; seq--) await other.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  assert.deepEqual(await reading.next(), { done: true, value: undefined });
});

for (const [order, extra] of [['in order', []], ['not in order', [2]]] as const) {
  test(`fileStore.sent() on an epoch ${order} leaves out a last line cut short, as read() does, and gives it once it is whole`, { timeout: 10_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
    const store = fileStore(dir);
    for (const seq of [1, 2, 3]) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
    for (const seq of extra) await store.append(id, [record(sentLater(seq), 4, 1)]);
    // The line of the next original, as another writer on the file would append it.
    const elsewhere = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
    await fileStore(elsewhere).append(id, [record(sentEntry(4), 5, 1)]);
    const whole = (await recordLines(elsewhere)).lines[0]!.text;
    const { path } = await recordLines(dir);
    const read = async () => (await readAll(store.read(id))).map(seqOf);
    assert.deepEqual(await sentSeqs(store, 1, 9), [1, 2, 3]);
    // Cut inside how it begins, after it has named its MsgSeqNum, and before its last character.
    for (const cut of [10, 90, whole.length - 1]) {
      await appendFile(path, whole.slice(0, cut));
      assert.deepEqual(await read(), [1, 2, 3, ...extra], `cut after ${cut} characters`);
      assert.deepEqual(await sentSeqs(store, 1, 9), [1, 2, 3], `cut after ${cut} characters`);
      assert.deepEqual(await sentSeqs(store, 3, 9), [3], `cut after ${cut} characters`);
      assert.deepEqual(await sentSeqs(store, 4, 9), [], `cut after ${cut} characters`);
      await rewrite(dir, text => text.slice(0, -cut));
    }
    // Cut short, it is not counted as an original: the whole one before it with its MsgSeqNum is still given.
    const second = (await recordLines(dir)).lines[1]!.text;
    await appendFile(path, second.slice(0, 90));
    assert.deepEqual(await sentSeqs(store, 1, 9), [1, 2, 3]);
    await rewrite(dir, text => text.slice(0, -90));
    await appendFile(path, whole.slice(0, 90));
    assert.deepEqual(await sentSeqs(store, 1, 9), [1, 2, 3]);
    await appendFile(path, whole.slice(90));            // whole, though no newline ends it yet
    assert.deepEqual(await read(), [1, 2, 3, ...extra, 4]);
    assert.deepEqual(await sentSeqs(store, 1, 9), [1, 2, 3, 4]);
    await appendFile(path, '\n');
    assert.deepEqual(await sentSeqs(store, 1, 9), [1, 2, 3, 4]);
    // A line cut short that is not the last is an error, as it is for read().
    await appendFile(path, `${whole.slice(0, 10)}\n`);
    await assert.rejects(read(), /is not a JSON object/);
    await assert.rejects(sentSeqs(store, 1, 9), /is not a JSON object/);
  });
}

for (const [order, count] of [['in order', 5], ['not in order, of more originals than it looks for at once', 4_100]] as const) {
  test(`fileStore.sent() on an epoch ${order} reads no further than the file went when it began: nothing appended while its reader pauses`, { timeout: 30_000 }, async () => {
    const store = fileStore(await mkdtemp(join(tmpdir(), 'fixjs-store-')));
    const seqs = order === 'in order' ? upTo(1, count) : upTo(1, count).reverse();
    for (const seq of seqs) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
    const reading = store.sent(id, { from: 1, to: Number.MAX_SAFE_INTEGER })[Symbol.asyncIterator]();
    assert.equal(seqOf((await reading.next()).value as Entry), 1);
    await store.append(id, [record(sentLater(count), count + 1, 1)]);
    await store.append(id, [record(sentEntry(count + 1), count + 2, 1)]);
    const rest: Entry[] = [];
    for (let next = await reading.next(); !next.done; next = await reading.next()) rest.push(next.value);
    assert.deepEqual(rest.map(seqOf), upTo(2, count));
    assert.equal(rest.at(-1)!.at.getTime(), at.getTime());
    assert.deepEqual(await sentSeqs(store, count, count + 9), [count, count + 1]);
  });
}

test('fileStore.sent() takes its turn among the calls on a session: it gives everything appended before it was called, though no append had finished', { timeout: 10_000 }, async () => {
  const store = fileStore(await mkdtemp(join(tmpdir(), 'fixjs-store-')));
  const first = upTo(1, 40).map(seq => store.append(id, [record(sentEntry(seq), seq + 1, 1)]));
  const early = sentSeqs(store, 1, 999);
  const second = upTo(41, 80).map(seq => store.append(id, [record(sentEntry(seq), seq + 1, 1)]));
  const later = sentSeqs(store, 1, 999);
  const last = [store.append(id, [record(sentLater(7), 81, 1)]), store.append(id, [record(sentEntry(81), 82, 1)])];
  const latest = readAll(store.sent(id, { from: 1, to: 999 }));
  await Promise.all([...first, ...second, ...last]);
  assert.deepEqual(await early, upTo(1, 40));
  assert.deepEqual(await later, upTo(1, 80));
  assert.deepEqual((await latest).map(seqOf), upTo(1, 81));
  assert.deepEqual(laterThanAt(await latest).slice(5, 8), [0, 1, 0]);
});

test('fileStore.sent() reads an epoch through again when the file is not the length it remembers: another store has appended to it', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  for (let seq = 1; seq <= 5; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  assert.deepEqual(await sentSeqs(store, 1, 9), [1, 2, 3, 4, 5]);
  const other = fileStore(dir);
  await other.append(id, [record(sentEntry(6), 7, 1)]);
  await other.append(id, [record(sentEntry(7), 8, 1)]);
  assert.deepEqual(await sentSeqs(store, 6, 9), [6, 7]);
  assert.deepEqual(await sentSeqs(store, 1, 9), [1, 2, 3, 4, 5, 6, 7]);
});

test('fileStore.sent() counts a line in bytes: after a line with characters of several bytes it still knows where the file ends and where the next original is', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  for (let seq = 1; seq <= 5; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  assert.deepEqual(await sentSeqs(store, 1, 9), [1, 2, 3, 4, 5]);
  await store.append(id, [record({ kind: 'error', at, text: 'Größe überschritten: 12 € — 価格 😀' }, 6, 1)]);
  for (let seq = 6; seq <= 8; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  const { path, lines } = await recordLines(dir);
  await damage(path, lines[1]!);     // MsgSeqNum 2: a read through the whole file would fail on it
  assert.deepEqual(await sentSeqs(store, 6, 9), [6, 7, 8]);
  assert.deepEqual(await sentSeqs(store, 7, 7), [7]);
});

test('fileStore.sent() forgets what it remembers of an epoch once the session is no longer among the 1,000 used most recently', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  for (let seq = 1; seq <= 5; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  assert.deepEqual(await sentSeqs(store, 4, 5), [4, 5]);
  const { path, lines } = await recordLines(dir);
  await damage(path, lines[1]!);
  for (let other = 1; other <= 999; other++) await store.load({ ...id, target: `OTHER${other}` });
  assert.deepEqual(await sentSeqs(store, 4, 5), [4, 5]);          // still remembered: not read through again
  for (let other = 1; other <= 1_000; other++) await store.load({ ...id, target: `OTHER${other}` });
  await assert.rejects(sentSeqs(store, 4, 5), /is not a JSON object/);   // forgotten: read through, and the damage is found
});

test('fileStore.sent() keeps nothing of a session that stopped being among the 1,000 used most recently while its epoch was read through', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  for (let seq = 1; seq <= 5; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  const { path, lines } = await recordLines(dir);
  let opened = () => {};
  const began = new Promise<void>(resolve => { opened = resolve; });
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await withOpen(async (real, ...args) => {
    if (String(args[0]) === path) {
      opened();
      await held;
    }
    return real(...args);
  }, async () => {
    const reading = sentSeqs(store, 4, 5);   // nothing remembered of the epoch yet: it opens the file to read it through
    await began;
    for (let other = 1; other <= 1_000; other++) await store.load({ ...id, target: `OTHER${other}` });
    release();
    assert.deepEqual(await reading, [4, 5]);
  });
  await damage(path, lines[1]!);
  await assert.rejects(sentSeqs(store, 4, 5), /is not a JSON object/);
});

test('memoryStore does not keep a message sent with PossDupFlag (a resent copy, or a gap fill that answers a ResendRequest): the originals stay within its limits, and the record\'s sequence numbers still count', { timeout: 10_000 }, async () => {
  const store = memoryStore({ history: 4 });
  for (let seq = 1; seq <= 3; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  for (let seq = 1; seq <= 3; seq++) await store.append(id, [record(resentEntry(seq), 4, 1)]);
  const gapFill = fromMessage('SequenceReset', { SenderCompID: 'EXCHANGE', TargetCompID: 'CLIENT', MsgSeqNum: 1, SendingTime: at, PossDupFlag: true, OrigSendingTime: at, GapFillFlag: true, NewSeqNo: 4 }, dict, { version: 'FIX.4.4' });
  await store.append(id, [record({ kind: 'message', direction: 'out', at, message: inspectMessage(parseFrame(buildFrame(gapFill.fields, gapFill.framing)).fields, dict).message }, 9, 7)]);
  const kept = await readAll(store.read(id));
  assert.deepEqual(kept.map(entry => entry.kind === 'message' && [entry.direction, entry.message.MsgSeqNum, entry.message.PossDupFlag === true]), [['out', 1, false], ['out', 2, false], ['out', 3, false]]);
  assert.deepEqual((await readAll(store.sent(id, { from: 1, to: 3 }))).map(seqOf), [1, 2, 3]);
  assert.deepEqual(await store.load(id), { history: kept, next: 9, expected: 7 });
  assert.deepEqual((await store.list()).map(session => session.epochs.map(epoch => epoch.entries)), [[3]]);
  // A message received with PossDupFlag is kept like any other entry.
  await store.append(id, [record({ ...resentEntry(5), direction: 'in' } as Entry, 9, 8)]);
  assert.equal((await readAll(store.read(id))).length, 4);
});

test('memoryStore.sent() gives nothing more once its session is forgotten for the limit on sessions while its reader pauses', { timeout: 10_000 }, async () => {
  const store = memoryStore({ sessions: 1 });
  for (let seq = 1; seq <= 3; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  const reading = store.sent(id, { from: 1, to: 3 })[Symbol.asyncIterator]();
  assert.equal(seqOf((await reading.next()).value as Entry), 1);
  await store.append({ ...id, target: 'OTHER' }, [record(sentEntry(1), 2, 1)]);
  assert.deepEqual(await reading.next(), { done: true, value: undefined });
  assert.deepEqual(await readAll(store.sent(id, { from: 1, to: 3 })), []);
});

// ─── fileStore.sent(): the latest run in order, and the part of the file before it ───

test('fileStore.sent() on an epoch that begins with originals numbered above those after them reads only the latest run in order where that holds the range, and the lines before it only for a MsgSeqNum the run has not reached', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  // As when messages of the sequence before a reset are kept after the record that begins the epoch: 605..644, then 1, 2, 3, ...
  for (const seq of [...upTo(605, 644), ...upTo(1, 300)]) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  for (const each of [store, fileStore(dir)]) {
    assert.deepEqual(await sentSeqs(each, 1, Number.MAX_SAFE_INTEGER), [...upTo(1, 300), ...upTo(605, 644)]);
    assert.deepEqual(await sentSeqs(each, 610, 612), [610, 611, 612]);     // only the lines before the run hold them
    assert.deepEqual(await sentSeqs(each, 290, 606), [...upTo(290, 300), 605, 606]);
  }
  const { path, lines } = await recordLines(dir);
  await damage(path, lines[1]!);       // MsgSeqNum 606, before the run
  await damage(path, lines[41]!);      // MsgSeqNum 2, in the run
  assert.deepEqual(await sentSeqs(store, 250, 260), upTo(250, 260));       // neither line is read
  assert.deepEqual(await sentSeqs(store, 3, 300), upTo(3, 300));
  await assert.rejects(sentSeqs(store, 250, 610), /is not a JSON object/);   // the lines before the run are read for 605..610
  await assert.rejects(sentSeqs(store, 1, 5), /is not a JSON object/);       // and the run from its first line for 1
  // Once the run has reached a MsgSeqNum, its own original is the one given, and the lines before it are not read for it.
  for (const seq of upTo(301, 700)) await store.append(id, [record(sentLater(seq), seq + 1, 1)]);
  const given = await readAll(store.sent(id, { from: 604, to: 645 }));
  assert.deepEqual(given.map(seqOf), upTo(604, 645));
  assert.deepEqual(laterThanAt(given), upTo(604, 645).map(() => 1));
  assert.deepEqual(await sentSeqs(store, 3, Number.MAX_SAFE_INTEGER), upTo(3, 700));
});

test('fileStore.sent() gives the latest appended of each MsgSeqNum through several steps backward in one epoch: from the latest run when that holds it, from the lines before it when only they do', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  const store = fileStore(dir);
  // 10 11 12, back to 5 6 and 11 again, back to 3 and 12 again: the nth appended is n milliseconds after `at`.
  const appended = [10, 11, 12, 5, 6, 11, 3, 12];
  for (const [nth, seq] of appended.entries()) {
    await store.append(id, [record(sentAt(seq, new Date(at.getTime() + nth)), seq + 1, 1)]);
    assert.deepEqual((await sentSeqs(store, 1, 99)), [...new Set(appended.slice(0, nth + 1))].sort((a, b) => a - b), `after ${nth + 1} appended`);
  }
  for (const each of [store, fileStore(dir)]) {
    const given = await readAll(each.sent(id, { from: 1, to: 99 }));
    assert.deepEqual(given.map(seqOf), [3, 5, 6, 10, 11, 12]);
    assert.deepEqual(laterThanAt(given), [6, 3, 4, 0, 5, 7]);
    assert.deepEqual(laterThanAt(await readAll(each.sent(id, { from: 11, to: 11 }))), [5]);
    assert.deepEqual(laterThanAt(await readAll(each.sent(id, { from: 12, to: 12 }))), [7]);
    assert.deepEqual(laterThanAt(await readAll(each.sent(id, { from: 4, to: 11 }))), [3, 4, 0, 5]);
    assert.deepEqual(await sentSeqs(each, 7, 9), []);
    assert.deepEqual(await sentSeqs(each, 13, 99), []);
  }
});

test('fileStore.sent() on an epoch not in order gives nothing more once its session is reset while its reader pauses, though the same lines are appended again', { timeout: 10_000 }, async () => {
  // What is still to be given is in the lines before the latest run (1..5 then 3 again), or in the run (5, then 1 2 3).
  for (const seqs of [[1, 2, 3, 4, 5, 3], [5, 1, 2, 3]]) {
    const store = fileStore(await mkdtemp(join(tmpdir(), 'fixjs-store-')));
    for (const seq of seqs) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
    const reading = store.sent(id, { from: 1, to: 5 })[Symbol.asyncIterator]();
    assert.equal(seqOf((await reading.next()).value as Entry), 1);
    await store.reset(id);
    for (const seq of seqs) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
    assert.deepEqual(await reading.next(), { done: true, value: undefined }, `appended ${seqs.join(' ')}`);
    assert.deepEqual(await sentSeqs(store, 1, 5), [...new Set(seqs)].sort((a, b) => a - b));
  }
});

test('memoryStore begins an epoch at a record with newEpoch though it does not keep that record\'s entry (a message sent with PossDupFlag)', { timeout: 10_000 }, async () => {
  const store = memoryStore();
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  await store.append(id, [record(sentEntry(2), 3, 1)]);
  await store.append(id, [record(resentEntry(1), 1, 1, { newEpoch: true })]);
  assert.deepEqual((await readAll(store.sent(id, { from: 1, to: 9 }))).map(seqOf), []);
  assert.deepEqual(await store.load(id), { history: [], next: 1, expected: 1 });
  assert.deepEqual((await store.list())[0]!.epochs.map(({ epoch, entries }) => [epoch, entries]), [[1, 2], [2, 0]]);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  assert.deepEqual((await readAll(store.sent(id, { from: 1, to: 9 }))).map(seqOf), [1]);
  assert.deepEqual((await readAll(store.read(id, { epoch: 2 }))).map(seqOf), [1]);
  assert.deepEqual((await readAll(store.read(id, { epoch: 1 }))).map(seqOf), [1, 2]);
});

test('memoryStore.read() gives nothing more once its session is reset while its reader pauses, and nothing appended after', { timeout: 10_000 }, async () => {
  const store = memoryStore();
  for (let seq = 1; seq <= 3; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  const reading = store.read(id)[Symbol.asyncIterator]();
  assert.equal(seqOf((await reading.next()).value as Entry), 1);
  await store.reset(id);
  for (let seq = 1; seq <= 3; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  assert.deepEqual(await reading.next(), { done: true, value: undefined });
  assert.deepEqual((await readAll(store.read(id))).map(seqOf), [1, 2, 3]);
});

test('append() refuses one record where it takes a list, and a list with nothing in it, and keeps nothing of either (memoryStore and fileStore)', { timeout: 10_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const store of [memoryStore(), fileStore(dir)]) {
    await assert.rejects(store.append(id, record(sentEntry(1), 2, 1) as never), new RangeError('append() takes a list of records, got an object'));
    await assert.rejects(store.append(id, undefined as never), new RangeError('append() takes a list of records, got undefined'));
    await assert.rejects(store.append(id, []), new RangeError('append() takes a list with a record in it, got an empty list'));
    assert.deepEqual(await store.load(id), { history: [], next: 1, expected: 1 });
    assert.deepEqual(await store.list(), []);
  }
});

// ─── A store that keeps its entries as text ─────────────────────────────────

// As a store with a text column would: each entry kept as the JSON text of entryToJSON(), and given back through entryFromJSON().
storeContract('a store that keeps each entry as JSON text, with entryToJSON() and entryFromJSON()', async () => {
  const inner = memoryStore();
  const throughText = (entry: Entry) => entryFromJSON(JSON.parse(JSON.stringify(entryToJSON(entry)))) as Entry;
  return { ...inner, append: (session, records, context) => inner.append(session, records.map(each => (each.entry ? { ...each, entry: throughText(each.entry) } : each)), context) };
});

// ─── fileStore: the files it keeps open, and a list as one write ────────────

/** A folder for one test, removed when the test is over. */
async function folder(t: { after(fn: () => unknown): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
/** The session whose TargetCompID is `target`. */
const sessionOf = (target: string): SessionId => ({ ...id, target });
/** The lines of a session's epoch file, without the newline that ends each. */
async function linesOf(dir: string, epoch = 1, session: SessionId = id): Promise<string[]> {
  return (await readFile(join(dir, safeFileName(session), `${epoch}.jsonl`), 'utf8')).split('\n').slice(0, -1);
}

test('fileStore keeps a session\'s current epoch file open from one append to the next, and writes a list of records with one write', { timeout: 10_000 }, async t => {
  const dir = await folder(t);
  await watchingAppends(async seen => {
    const store = fileStore(dir);
    await store.append(id, [record(sentEntry(1), 2, 1)]);          // the epoch's file, written whole: no file is kept open for that
    assert.deepEqual([seen.opened.length, seen.writes.length], [0, 0]);
    for (let seq = 2; seq <= 6; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
    await store.append(id, [7, 8, 9, 10].map(seq => record(sentEntry(seq), seq + 1, 1)));
    assert.deepEqual([seen.opened.length, seen.closed.length], [1, 0]);
    assert.equal(seen.writes.length, 6);
    assert.equal(seen.writes[5]!.split('\n').length - 1, 4, 'the list of four is one write of four lines');
    assert.equal((await linesOf(dir)).length, 11);                 // the header and ten records
    assert.deepEqual((await fileStore(dir).load(id)).history.map(seqOf), upTo(1, 10));
    await store.reset(id);
  });
});

test('fileStore keeps at most 256 files open at once however many sessions it writes, and every record is kept', { timeout: 60_000 }, async t => {
  const dir = await folder(t);
  const sessions = Array.from({ length: 300 }, (_unused, index) => sessionOf(`C${index}`));
  await watchingAppends(async seen => {
    const store = fileStore(dir);
    for (const session of sessions) await store.append(session, [record(sentEntry(1), 2, 1)]);
    // One after another, then all at once: a session that needs a place waits for one whose call is part-way through.
    for (const session of sessions) await store.append(session, [record(sentEntry(2), 3, 1)]);
    assert.equal(seen.open(), 256);
    await Promise.all(sessions.map(session => store.append(session, [record(sentEntry(3), 4, 1), record(sentEntry(4), 5, 1)])));
    await Promise.all(sessions.flatMap(session => [store.append(session, [record(sentEntry(5), 6, 1)]), store.append(session, [record(sentEntry(6), 7, 1)])]));
    assert.equal(seen.most, 256);
    assert.equal(seen.open(), 256);
    for (const session of sessions) assert.deepEqual((await readAll(store.sent(session, { from: 1, to: 9 }))).map(seqOf), [1, 2, 3, 4, 5, 6]);
    for (const session of sessions) await store.reset(session);
    assert.equal(seen.open(), 0);
  });
});

test('fileStore closes the file appended to least recently when another session needs its place', { timeout: 10_000 }, async t => {
  const dir = await folder(t);
  const [a, b, c] = [sessionOf('A'), sessionOf('B'), sessionOf('C')];
  const fileOfSession = (session: SessionId) => join(dir, safeFileName(session), '1.jsonl');
  await watchingAppends(async seen => {
    const store = fileStoreWith(dir, { openFiles: 2 });
    for (const session of [a, b, c]) await store.append(session, [record(sentEntry(1), 2, 1)]);
    await store.append(a, [record(sentEntry(2), 3, 1)]);
    await store.append(b, [record(sentEntry(2), 3, 1)]);
    await store.append(a, [record(sentEntry(3), 4, 1)]);       // a is now the one used last
    assert.deepEqual(seen.closed, []);
    await store.append(c, [record(sentEntry(2), 3, 1)]);       // b gives up its place
    assert.deepEqual(seen.closed, [fileOfSession(b)]);
    await store.append(b, [record(sentEntry(3), 4, 1)]);       // and takes a's in turn, opening its file again
    assert.deepEqual(seen.closed, [fileOfSession(b), fileOfSession(a)]);
    assert.deepEqual(seen.opened, [a, b, c, b].map(fileOfSession));
    assert.equal(seen.most, 2);
    for (const session of [a, b, c]) await store.reset(session);
  });
});

test('a write that never finishes does not hold up a session that needs a place among the open files: another file is closed for it, or it waits for a call that does finish', { timeout: 10_000 }, async t => {
  const dir = await folder(t);
  const [a, b, c, d] = [sessionOf('A'), sessionOf('B'), sessionOf('C'), sessionOf('D')];
  const fileOfSession = (session: SessionId) => join(dir, safeFileName(session), '1.jsonl');
  const held = new Map<string, () => void>();
  let holding: string[] = [];
  await watchingAppends(async seen => {
    const store = fileStoreWith(dir, { openFiles: 2 });
    for (const session of [a, b, c, d]) await store.append(session, [record(sentEntry(1), 2, 1)]);
    await store.append(a, [record(sentEntry(2), 3, 1)]);
    await store.append(b, [record(sentEntry(2), 3, 1)]);       // a and b have the two places, a the one used least recently
    holding = [fileOfSession(a)];
    const stuck = store.append(a, [record(sentEntry(3), 4, 1)]);   // never finishes: a is now the one used most recently
    await store.append(b, [record(sentEntry(3), 4, 1)]);           // and now the least recently again
    await inTime(store.append(c, [record(sentEntry(2), 3, 1)]), 1000, "c's append, which needs no file that is being written");   // c takes b's place, not a's, and does not wait for a
    assert.deepEqual(seen.closed, [fileOfSession(b)]);
    // Both places are busy: a's for good, c's for a while. d waits for c's call, and takes c's place.
    holding = [fileOfSession(a), fileOfSession(c)];
    const slow = store.append(c, [record(sentEntry(3), 4, 1)]);
    await waitFor(() => held.has(fileOfSession(c)), 1000, "c's write to begin");
    let done = false;
    const waiting = store.append(d, [record(sentEntry(2), 3, 1)]).then(() => { done = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(done, false);
    held.get(fileOfSession(c))!();
    await slow;
    await waiting;
    assert.deepEqual(seen.closed, [fileOfSession(b), fileOfSession(c)]);
    assert.equal(seen.most, 2);
    assert.deepEqual((await store.load(d)).history.map(seqOf), [1, 2]);
    held.get(fileOfSession(a))!();
    await stuck;
    for (const session of [a, b, c, d]) await store.reset(session);
  }, async (real, text, path) => {
    if (holding.includes(path)) await new Promise<void>(resolve => { held.set(path, resolve); });
    await real(text);
  });
});

test('a session that waits for a place among the open files goes on when the file it waits for is closed by a write that failed', { timeout: 10_000 }, async t => {
  const dir = await folder(t);
  const [a, d] = [sessionOf('A'), sessionOf('D')];
  let fail: ((error: Error) => void) | undefined;
  let holding = false;
  await watchingAppends(async seen => {
    const store = fileStoreWith(dir, { openFiles: 1 });
    for (const session of [a, d]) await store.append(session, [record(sentEntry(1), 2, 1)]);
    await store.append(a, [record(sentEntry(2), 3, 1)]);           // a has the one place
    holding = true;
    const failing = assert.rejects(store.append(a, [record(sentEntry(3), 4, 1)]), /no space left/);
    await waitFor(() => fail !== undefined, 1000, "a's write to begin");
    holding = false;
    let done = false;
    const waiting = store.append(d, [record(sentEntry(2), 3, 1)]).then(() => { done = true; });   // no place, and a is busy
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(done, false);
    fail!(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }));
    await failing;
    await waiting;
    assert.equal(seen.most, 1);
    assert.deepEqual((await store.load(d)).history.map(seqOf), [1, 2]);
    for (const session of [a, d]) await store.reset(session);
  }, async (real, text) => {
    if (holding) await new Promise<void>((_resolve, reject) => { fail = reject; });
    await real(text);
  });
});

test('fileStore leaves no file open for a session it has reset, and begins the session again at epoch 1', { timeout: 10_000 }, async t => {
  const dir = await folder(t);
  await watchingAppends(async seen => {
    const store = fileStore(dir);
    for (let seq = 1; seq <= 3; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
    assert.equal(seen.open(), 1);
    await store.reset(id);
    assert.equal(seen.open(), 0);
    assert.deepEqual(await readdir(dir), []);
    await store.append(id, [record(sentEntry(1), 2, 1)]);
    await store.append(id, [record(sentEntry(2), 3, 1)]);
    assert.equal((await linesOf(dir)).length, 3);
    assert.deepEqual((await store.load(id)).history.map(seqOf), [1, 2]);
    await store.reset(id);
    assert.equal(seen.open(), 0);
  });
});

test('fileStore closes the file of an epoch when the next begins, wherever in a list that is', { timeout: 10_000 }, async t => {
  const dir = await folder(t);
  await watchingAppends(async seen => {
    const store = fileStore(dir);
    await store.append(id, [record(sentEntry(1), 2, 1)]);
    await store.append(id, [record(sentEntry(2), 3, 1)]);
    assert.equal(seen.open(), 1);
    await store.append(id, [record(sentEntry(3), 4, 1), record(sentEntry(1), 2, 1, { newEpoch: true }), record(sentEntry(2), 3, 1)]);
    assert.equal(seen.open(), 0, 'the new epoch\'s file was written whole: none is open until something is appended to it');
    await store.append(id, [record(sentEntry(3), 4, 1)]);
    assert.deepEqual(seen.opened.map(path => path.slice(-7)), ['1.jsonl', '2.jsonl']);
    await store.reset(id);
  });
});

test('fileStore closes a file once nothing has been appended to it for a while, and opens it again for the next append', { timeout: 10_000 }, async t => {
  const dir = await folder(t);
  await watchingAppends(async seen => {
    const store = fileStoreWith(dir, { idleMs: 40 });
    await store.append(id, [record(sentEntry(1), 2, 1)]);
    // Appended to every 10 ms, it stays open.
    for (let seq = 2; seq <= 12; seq++) {
      await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual([seen.opened.length, seen.closed.length], [1, 0]);
    await waitFor(() => seen.open() === 0, 2000, 'the idle file to be closed');
    await store.append(id, [record(sentEntry(13), 14, 1)]);
    assert.deepEqual([seen.opened.length, seen.closed.length], [2, 1]);
    assert.deepEqual((await store.load(id)).history.map(seqOf), upTo(1, 13));
    await waitFor(() => seen.open() === 0, 2000, 'the idle file to be closed again');
  });
});

test('a fileStore that is no longer used leaves no file open: each is closed within 4 s of its last append, and the timer that does it does not keep the process alive', { timeout: 30_000 }, async t => {
  const dir = await folder(t);
  // A process of its own: it appends through an open file and returns; it must end by itself, and say what was still open then.
  const program = `
    import { readdirSync } from 'node:fs';
    import { fileStore } from ${JSON.stringify(new URL('./store.ts', import.meta.url).href)};
    const id = { version: 'FIX.4.4', sender: 'EXCHANGE', target: 'CLIENT' };
    const at = new Date();
    const store = fileStore(${JSON.stringify(dir)});
    const open = () => readdirSync('/dev/fd').length;
    const before = open();
    for (let next = 2; next < 6; next++) await store.append(id, [{ at, seqNums: { next, expected: 1 } }]);
    const during = open();
    const began = Date.now();
    process.on('exit', () => console.log(JSON.stringify({ kept: during - before, lasted: Date.now() - began })));
    if (process.argv.includes('--wait')) setTimeout(() => console.log(JSON.stringify({ after: open() - before })), 4500);
  `;
  const run = (args: string[]) => spawnSync(process.execPath, ['--input-type=module', '-e', program, '--', ...args], { encoding: 'utf8', timeout: 20_000 });
  const left = run([]);
  assert.equal(left.status, 0, left.stderr);
  const ended = JSON.parse(left.stdout.trim().split('\n').at(-1)!) as { kept: number; lasted: number };
  assert.equal(ended.kept, 1, 'one file was open when the program had no more to do');
  assert.ok(ended.lasted < 1500, `the process stayed ${ended.lasted} ms for a file it had open`);
  const waited = run(['--wait']);
  assert.equal(waited.status, 0, waited.stderr);
  assert.deepEqual(JSON.parse(waited.stdout.trim().split('\n')[0]!), { after: 0 });
});

test('a process that is killed with a file open has lost nothing its fileStore had resolved', { timeout: 30_000 }, async t => {
  const dir = await folder(t);
  const program = `
    import { fileStore } from ${JSON.stringify(new URL('./store.ts', import.meta.url).href)};
    const id = { version: 'FIX.4.4', sender: 'EXCHANGE', target: 'CLIENT' };
    const at = new Date();
    const store = fileStore(${JSON.stringify(dir)});
    let next = 1;
    for (let list = 0; list < 5; list++) await store.append(id, Array.from({ length: 20 }, () => ({ at, seqNums: { next: ++next, expected: 1 } })));
    process.kill(process.pid, 'SIGKILL');
  `;
  const ran = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(ran.signal, 'SIGKILL', ran.stderr);
  assert.equal((await linesOf(dir)).length, 101);              // the header and five lists of twenty
  assert.deepEqual(await fileStore(dir).load(id), { history: [], next: 101, expected: 1 });
});

test('a session folder removed under a fileStore that has its file open is not noticed until the file is closed: appends resolve meanwhile, the next one fails, and the one after begins the session again', { timeout: 10_000 }, async t => {
  const dir = await folder(t);
  await watchingAppends(async seen => {
    const store = fileStoreWith(dir, { idleMs: 30 });
    await store.append(id, [record(sentEntry(1), 2, 1)]);
    await store.append(id, [record(sentEntry(2), 3, 1)]);
    await rm(join(dir, safeFileName(id)), { recursive: true });
    await store.append(id, [record(sentEntry(3), 4, 1)]);          // to the removed file
    await waitFor(() => seen.open() === 0, 2000, 'the idle file to be closed');
    await assert.rejects(store.append(id, [record(sentEntry(4), 5, 1)]), { code: 'ENOENT' });
    await store.append(id, [record(sentEntry(5), 6, 1)]);
    assert.deepEqual(await store.load(id).then(({ history, next }) => [history.map(seqOf), next]), [[5], 6]);
    await store.reset(id);
  });
});

test('a fileStore that only reads opens no file to append to', { timeout: 10_000 }, async t => {
  const dir = await folder(t);
  const writer = fileStore(dir);
  for (let seq = 1; seq <= 5; seq++) await writer.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  await watchingAppends(async seen => {
    const store = fileStore(dir);
    assert.equal((await store.load(id)).next, 6);
    assert.equal((await readAll(store.read(id))).length, 5);
    assert.equal((await readAll(store.sent(id, { from: 1, to: 9 }))).length, 5);
    assert.equal((await store.list()).length, 1);
    assert.equal(seen.opened.length, 0);
  });
  await writer.reset(id);
});

test('fileStore closes the file of a session once it is no longer among the 1,000 it remembers', { timeout: 30_000 }, async t => {
  const dir = await folder(t);
  await watchingAppends(async seen => {
    const store = fileStore(dir);
    await store.append(id, [record(sentEntry(1), 2, 1)]);
    await store.append(id, [record(sentEntry(2), 3, 1)]);
    assert.equal(seen.open(), 1);
    for (let other = 0; other < 1_000; other++) await store.load(sessionOf(`OTHER${other}`));
    await waitFor(() => seen.open() === 0, 1500, 'the file of the forgotten session to be closed');
    assert.equal(seen.closed.length, 1);
    await store.append(id, [record(sentEntry(3), 4, 1)]);
    assert.deepEqual((await store.load(id)).history.map(seqOf), [1, 2, 3]);
    await store.reset(id);
  });
});

test('fileStore closes the file of an epoch it finds is no longer the current one (another store on the folder began the next), and appends to the new one', { timeout: 30_000 }, async t => {
  const dir = await folder(t);
  const file = (epoch: number) => join(dir, safeFileName(id), `${epoch}.jsonl`);
  let hold = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let waiting!: () => void;
  const reached = new Promise<void>(resolve => { waiting = resolve; });
  const seen: { opened: string[]; closed: string[] } = { opened: [], closed: [] };
  await withOpen(async (real, path, flags, mode) => {
    // A load() of the session is held as it opens the epoch's file to read it.
    if (hold && flags === 'r' && String(path) === file(1)) {
      hold = false;
      waiting();
      await held;
    }
    const handle = await real(path, flags, mode);
    if (flags !== 'a') return handle;
    seen.opened.push(String(path));
    const close = handle.close.bind(handle);
    handle.close = async () => { await close(); seen.closed.push(String(path)); };
    return handle;
  }, async () => {
    const store = fileStore(dir);
    await store.append(id, [record(sentEntry(1), 2, 1)]);
    await store.append(id, [record(sentEntry(2), 3, 1)]);      // 1.jsonl is open
    hold = true;
    const loading = store.load(id);
    await reached;
    const appended = store.append(id, [record(sentEntry(2), 3, 1)]);   // waits its turn behind the load
    // Meanwhile the session is forgotten for 1,000 others, and another store begins its next epoch.
    for (let other = 0; other < 1_000; other++) await store.load(sessionOf(`OTHER${other}`));
    await fileStore(dir).append(id, [record(sentEntry(1), 2, 1, { newEpoch: true })]);
    release();
    await loading;
    await appended;
    assert.deepEqual(seen.opened, [file(1), file(2)]);
    assert.deepEqual(seen.closed, [file(1)]);
    assert.equal((await linesOf(dir, 2)).length, 3);
    assert.deepEqual(await sentSeqs(store, 1, 9), [1, 2]);
    await store.reset(id);
    assert.deepEqual(seen.closed, [file(1), file(2)]);
  });
});

for (const [what, cut, whole] of [
  ['in the middle of its third line', (text: string) => { const lines = text.split('\n'); return `${lines[0]}\n${lines[1]}\n${lines[2]!.slice(0, lines[2]!.length >> 1)}`; }, [2, 3]],
  ['after its second line', (text: string) => { const lines = text.split('\n'); return `${lines[0]}\n${lines[1]}\n`; }, [2, 3]],
  ['just before the newline of its last line', (text: string) => text.slice(0, -1), [2, 3, 4, 5]],
  ['before anything of it was written', () => '', []],
] as const) {
  test(`fileStore.append of a list that failed ${what}: the list is rejected, the file is closed, and the next append starts a line of its own after the whole lines that were written`, { timeout: 10_000 }, async t => {
    const dir = await folder(t);
    let failing = false;
    await watchingAppends(async seen => {
      const store = fileStore(dir);
      await store.append(id, [record(sentEntry(1), 2, 1)]);
      assert.deepEqual(await sentSeqs(store, 1, 9), [1]);        // from here on the store remembers where the originals are
      failing = true;
      await assert.rejects(store.append(id, [2, 3, 4, 5].map(seq => record(sentEntry(seq), seq + 1, 1))), /no space left/);
      failing = false;
      assert.equal(seen.open(), 0, 'no file is left open after a write that failed');
      await store.append(id, [record(sentEntry(6), 7, 1), record(sentEntry(7), 8, 1)]);
      const kept = [1, ...whole, 6, 7];
      for (const each of [store, fileStore(dir)]) {
        assert.deepEqual((await each.load(id)).history.map(seqOf), kept);
        assert.equal((await each.load(id)).next, 8);
        assert.deepEqual((await readAll(each.read(id))).map(seqOf), kept);
        assert.deepEqual(await sentSeqs(each, 1, 9), kept);
        assert.deepEqual(await sentSeqs(each, 6, 6), [6]);
      }
      for (const line of await linesOf(dir)) assert.doesNotThrow(() => JSON.parse(line), `a line that is not whole: ${line.slice(0, 60)}`);
      await store.reset(id);
    }, cutShort(cut, () => failing));
  });
}

test('a fileStore started on a file whose last list was cut short in the middle of a line, as a crash leaves it, keeps the whole lines, cuts off the rest, and appends after them', { timeout: 10_000 }, async t => {
  const dir = await folder(t);
  const first = fileStore(dir);
  await first.append(id, [record(sentEntry(1), 2, 1)]);
  await first.reset(sessionOf('NOBODY'));
  const list = [2, 3, 4, 5].map(seq => `${recordLine(record(sentEntry(seq), seq + 1, 1), dict)}\n`).join('');
  const file = join(dir, safeFileName(id), '1.jsonl');
  await appendFile(file, list.slice(0, list.length - 100));   // the process died part-way through the write
  for (const begin of ['load', 'append', 'sent'] as const) {
    const copy = await folder(t);
    await mkdir(join(copy, safeFileName(id)));
    for (const name of await readdir(join(dir, safeFileName(id)))) await writeFile(join(copy, safeFileName(id), name), await readFile(join(dir, safeFileName(id), name)));
    const store = fileStore(copy);
    if (begin === 'load') assert.deepEqual([(await store.load(id)).history.map(seqOf), (await store.load(id)).next], [[1, 2, 3, 4], 5]);
    if (begin === 'sent') assert.deepEqual(await sentSeqs(store, 1, 9), [1, 2, 3, 4]);
    await store.append(id, [record(sentEntry(6), 7, 1), record(sentEntry(7), 8, 1)]);
    assert.deepEqual((await store.load(id)).history.map(seqOf), [1, 2, 3, 4, 6, 7], `begun with ${begin}()`);
    assert.deepEqual(await sentSeqs(fileStore(copy), 1, 9), [1, 2, 3, 4, 6, 7]);
    for (const line of await linesOf(copy)) assert.doesNotThrow(() => JSON.parse(line));
    await store.reset(id);
  }
  await first.reset(id);
});

test('fileStore.append of a list that crosses into a new epoch writes the records before it to the old epoch\'s file with one write, and the new epoch\'s file whole, with its header and the rest of the list', { timeout: 10_000 }, async t => {
  const dir = await folder(t);
  const began = new Date(at.getTime() + 60_000);
  await watchingAppends(async seen => {
    const store = fileStore(dir);
    await store.append(id, [record(sentEntry(1), 2, 1)]);
    await store.append(id, [record(sentEntry(2), 3, 1), record(sentEntry(3), 4, 1), record(sentAt(1, began), 2, 1, { newEpoch: true }), record(sentEntry(2), 3, 1), record(sentEntry(3), 4, 7)]);
    assert.equal(seen.writes.length, 1);
    assert.equal(seen.writes[0]!.split('\n').length - 1, 2);
    assert.equal((await linesOf(dir, 1)).length, 4);                              // its header and three records
    const second = await linesOf(dir, 2);
    assert.deepEqual(JSON.parse(second[0]!), { epoch: 2, startedAt: began.toISOString() });
    assert.equal(second.length, 4);
    assert.deepEqual((await readdir(join(dir, safeFileName(id)))).sort(), ['1.jsonl', '2.jsonl', 'session.json']);   // no .tmp file left
    assert.deepEqual(await store.load(id).then(({ history, next, expected }) => [history.map(seqOf), next, expected]), [[1, 2, 3], 4, 7]);
    assert.deepEqual((await readAll(store.read(id, { epoch: 1 }))).map(seqOf), [1, 2, 3]);
    assert.deepEqual(await sentSeqs(store, 1, 9), [1, 2, 3]);
    await store.reset(id);
  });
});

test('fileStore.append of a list whose new epoch cannot be written: the list is rejected, the records before the epoch stay in the old one, nothing of the new one is left, and a later list begins it', { timeout: 10_000 }, async t => {
  const dir = await folder(t);
  const store = fileStore(dir);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  await store.append(id, [record(sentEntry(2), 3, 1)]);
  const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
  const realWrite = fsp.writeFile;
  fsp.writeFile = (async (path: Parameters<typeof realWrite>[0], data: Parameters<typeof realWrite>[1]) => {
    await realWrite(path, String(data).slice(0, 40));                 // part of the temporary file, then the disk is full
    throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  }) as typeof realWrite;
  syncBuiltinESMExports();
  try {
    await assert.rejects(store.append(id, [record(sentEntry(3), 4, 1), record(sentEntry(1), 2, 1, { newEpoch: true }), record(sentEntry(2), 3, 1)]), /no space left/);
  } finally {
    fsp.writeFile = realWrite;
    syncBuiltinESMExports();
  }
  assert.deepEqual((await readdir(join(dir, safeFileName(id)))).sort(), ['1.jsonl', 'session.json']);
  for (const each of [store, fileStore(dir)]) {
    assert.deepEqual(await each.load(id).then(({ history, next }) => [history.map(seqOf), next]), [[1, 2, 3], 4]);
    assert.deepEqual(await sentSeqs(each, 1, 9), [1, 2, 3]);
  }
  await store.append(id, [record(sentEntry(1), 2, 1, { newEpoch: true }), record(sentEntry(2), 3, 1)]);
  assert.deepEqual((await store.list())[0]!.epochs.map(({ epoch }) => epoch), [1, 2]);
  assert.deepEqual(await sentSeqs(store, 1, 9), [1, 2]);
  await store.reset(id);
});

test('fileStore.sent() knows where the originals of a list are once it has read an epoch through: each list appended after that is found without reading the file again, whatever else the list holds', { timeout: 10_000 }, async t => {
  const dir = await folder(t);
  const store = fileStore(dir);
  for (let seq = 1; seq <= 3; seq++) await store.append(id, [record(sentEntry(seq), seq + 1, 1)]);
  assert.deepEqual(await sentSeqs(store, 1, 9), [1, 2, 3]);       // reads the epoch through, once
  let fromStart = 0;
  await withOpen(async (real, ...args) => {
    const handle = await real(...args);
    if (args[1] !== 'r') return handle;
    const read = handle.read.bind(handle);
    handle.read = ((...given: unknown[]) => { if (given[3] === 0) fromStart++; return (read as (...all: unknown[]) => unknown)(...given); }) as typeof handle.read;
    return handle;
  }, async () => {
    // Originals among received messages, a record of sequence numbers alone, an error, and a line of several bytes a character.
    await store.append(id, [
      record(sentEntry(4), 5, 1), record({ ...sentEntry(9), direction: 'in' } as Entry, 5, 2), seqNumsOnly({ next: 5, expected: 2 }),
      record(sentEntry(5), 6, 2), record({ kind: 'error', at, text: 'ünïcödé — more bytes than characters' }, 6, 2), record(sentEntry(6), 7, 2),
    ]);
    await store.append(id, upTo(7, 40).map(seq => record(sentEntry(seq), seq + 1, 2)));
    assert.deepEqual(await sentSeqs(store, 5, 6), [5, 6]);
    assert.deepEqual(await sentSeqs(store, 38, 99), [38, 39, 40]);
    assert.deepEqual(await sentSeqs(store, 1, 99), upTo(1, 40));
  });
  assert.equal(fromStart, 0, 'the file was read from its start again');
  assert.deepEqual(await sentSeqs(fileStore(dir), 1, 99), upTo(1, 40));
  await store.reset(id);
});

test('fileStore works out a session\'s folder name once for each call, however many records the call holds', { timeout: 10_000 }, async t => {
  const dir = await folder(t);
  const crypto = createRequire(import.meta.url)('node:crypto') as typeof import('node:crypto');
  const realHash = crypto.createHash;
  let hashes = 0;
  crypto.createHash = ((...args: Parameters<typeof realHash>) => { hashes++; return realHash(...args); }) as typeof realHash;
  syncBuiltinESMExports();
  try {
    const store = fileStore(dir);
    const count = async (call: () => Promise<unknown>) => { hashes = 0; await call(); return hashes; };
    assert.equal(await count(() => store.load(id)), 1);
    assert.equal(await count(() => store.append(id, upTo(1, 50).map(seq => record(sentEntry(seq), seq + 1, 1)))), 1);
    assert.equal(await count(() => store.append(id, [record(sentEntry(51), 52, 1), record(sentEntry(1), 2, 1, { newEpoch: true }), record(sentEntry(2), 3, 1)])), 1);
    assert.equal(await count(() => store.append(id, [record(sentEntry(3), 4, 1)])), 1);
    assert.equal(await count(() => readAll(store.sent(id, { from: 1, to: 9 }))), 1);
    assert.equal(await count(() => readAll(store.read(id))), 1);
    assert.equal(await count(() => store.reset(id)), 1);
  } finally {
    crypto.createHash = realHash;
    syncBuiltinESMExports();
  }
});

test('a write to an open file that never settles holds only its own session: others are appended to, and the session\'s later calls wait behind it', { timeout: 10_000 }, async t => {
  const dir = await folder(t);
  const other = sessionOf('OTHER');
  let stuck = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await watchingAppends(async () => {
    const store = fileStore(dir);
    for (const session of [id, other]) {
      await store.append(session, [record(sentEntry(1), 2, 1)]);
      await store.append(session, [record(sentEntry(2), 3, 1)]);
    }
    stuck = true;
    let settled = false;
    const never = store.append(id, [record(sentEntry(3), 4, 1)]).then(() => { settled = true; });
    const behind = store.load(id).then(loaded => { settled = true; return loaded; });
    await new Promise(resolve => setTimeout(resolve, 50));
    stuck = false;
    await store.append(other, [record(sentEntry(3), 4, 1)]);
    assert.deepEqual((await store.load(other)).history.map(seqOf), [1, 2, 3]);
    assert.equal(settled, false);
    release();
    await never;
    assert.deepEqual((await behind).history.map(seqOf), [1, 2, 3]);
    for (const session of [id, other]) await store.reset(session);
  }, async (real, text) => { if (stuck) await held; await real(text); });
});

// ─── fileStore: sessions that wait for a place among the open files ─────────

/** What `work` gives, or a failure when it has not settled after `ms`: a test of a wait that may never end fails instead of hanging. */
async function inTime<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error(`${what}: not settled after ${ms} ms`)); }, ms); });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `work` with setInterval and clearInterval watched: `ticking()` is how many intervals set meanwhile have not been cleared. */
async function watchingIntervals<T>(work: (ticking: () => number) => Promise<T>): Promise<T> {
  const [realSet, realClear] = [globalThis.setInterval, globalThis.clearInterval];
  const live = new Set<unknown>();
  globalThis.setInterval = ((...args: Parameters<typeof realSet>) => { const timer = realSet(...args); live.add(timer); return timer; }) as typeof realSet;
  globalThis.clearInterval = ((timer: Parameters<typeof realClear>[0]) => { live.delete(timer); realClear(timer); }) as typeof realClear;
  try {
    return await work(() => live.size);
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
}

/** An open() that fails as a process out of descriptors does, for a file to append to, while `failing()`. */
const outOfDescriptors = (failing: () => boolean) => async (real: typeof import('node:fs/promises').open, ...args: Parameters<typeof import('node:fs/promises').open>) => {
  if (failing() && args[1] === 'a') throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
  return real(...args);
};

test('sessions that wait for a place among the open files are not left waiting when the files of those before them cannot be opened: each append is refused with the error, and every session is appended to again once files can be opened', { timeout: 20_000 }, async t => {
  const dir = await folder(t);
  const sessions = upTo(0, 5).map(index => sessionOf(`C${index}`));
  let failing = false;
  await withOpen(outOfDescriptors(() => failing), async () => {
    const store = fileStoreWith(dir, { openFiles: 2 });
    for (const session of sessions) await store.append(session, [record(sentEntry(1), 2, 1)]);
    failing = true;
    const refused = await inTime(Promise.all(sessions.map(session => store.append(session, [record(sentEntry(2), 3, 1)]).then(() => 'kept', (error: NodeJS.ErrnoException) => error.code))), 3000, 'six appends with no file to be opened and two places');
    assert.deepEqual(refused, sessions.map(() => 'EMFILE'));
    // Nothing is left waiting or held: a load of each takes its turn at once.
    for (const session of sessions) assert.equal((await inTime(store.load(session), 3000, 'a load after the refused appends')).next, 2);
    failing = false;
    await inTime(Promise.all(sessions.map(session => store.append(session, [record(sentEntry(3), 4, 1)]))), 3000, 'six appends once files can be opened');
    for (const session of sessions) assert.deepEqual((await store.load(session)).history.map(seqOf), [1, 3]);
    for (const session of sessions) await store.reset(session);
  });
});

test('a place among the open files that a failed open gives back goes to the session that waits for it, while the files that are open stay open', { timeout: 20_000 }, async t => {
  const dir = await folder(t);
  const [a, b, c] = [sessionOf('A'), sessionOf('B'), sessionOf('C')];
  const fileOfSession = (session: SessionId) => join(dir, safeFileName(session), '1.jsonl');
  let failing = '';
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let holding = false;
  await watchingAppends(async seen => {
    await withOpen(async (real, ...args) => {
      if (args[1] === 'a' && String(args[0]) === failing) throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
      return real(...args);
    }, async () => {
      const store = fileStoreWith(dir, { openFiles: 2 });
      for (const session of [a, b, c]) await store.append(session, [record(sentEntry(1), 2, 1)]);
      await store.append(a, [record(sentEntry(2), 3, 1)]);        // a has a place
      holding = true;
      const slow = store.append(a, [record(sentEntry(3), 4, 1)]);  // and a write part-way through
      failing = fileOfSession(b);
      const refused = assert.rejects(store.append(b, [record(sentEntry(2), 3, 1)]), { code: 'EMFILE' });   // b takes the other place, and cannot open its file
      const waiting = store.append(c, [record(sentEntry(2), 3, 1)]);   // c waits for a place
      await refused;
      await inTime(waiting, 3000, "c's append, waiting for the place b gave back");
      assert.deepEqual(seen.closed, [], "a's file was closed for it");
      release();
      await slow;
      for (const session of [a, b, c]) await store.reset(session);
    });
  }, async (real, text) => { if (holding) { holding = false; await held; } await real(text); });
});

test('fileStore stops looking for idle files once none is open, however the last place was given back: a file closed, or one that could not be opened', { timeout: 20_000 }, async t => {
  const dir = await folder(t);
  const [a, b] = [sessionOf('A'), sessionOf('B')];
  let fail: ((error: Error) => void) | undefined;
  let holding = false;
  await watchingIntervals(async ticking => {
    await withOpen(async (real, ...args) => {
      if (holding && args[1] === 'a') {
        holding = false;
        await new Promise<void>((_resolve, reject) => { fail = reject; });
      }
      return real(...args);
    }, async () => {
      const store = fileStoreWith(dir, { openFiles: 2 });
      for (const session of [a, b]) await store.append(session, [record(sentEntry(1), 2, 1)]);
      assert.equal(ticking(), 0, 'no file is open yet');
      await store.append(a, [record(sentEntry(2), 3, 1)]);
      assert.equal(ticking(), 1);
      await store.reset(a);
      assert.equal(ticking(), 0, 'the last file was closed');
      // b's file is being opened while a's, the only one open, is closed: the last place is then given back by the open that fails.
      await store.append(a, [record(sentEntry(1), 2, 1)]);
      await store.append(a, [record(sentEntry(2), 3, 1)]);
      holding = true;
      const refused = assert.rejects(store.append(b, [record(sentEntry(2), 3, 1)]), { code: 'EMFILE' });
      await waitFor(() => fail !== undefined, 1000, "b's file to be asked for");
      await store.reset(a);
      assert.equal(ticking(), 1, "b has a place: its file is being opened");
      fail!(Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }));
      await refused;
      assert.equal(ticking(), 0, 'no file is open and none is being opened');
      await store.reset(b);
    });
  });
});

test('a session that appends again the moment its last append resolves does not keep others from a place among the open files: every session is appended to, about as often as any other', { timeout: 20_000 }, async t => {
  const dir = await folder(t);
  const sessions = upTo(0, 5).map(index => sessionOf(`C${index}`));
  const store = fileStoreWith(dir, { openFiles: 2 });
  for (const session of sessions) await store.append(session, [seqNumsOnly({ next: 2, expected: 1 })]);
  const made = sessions.map(() => 0);
  const WANTED = 600;
  const deadline = Date.now() + 10_000;
  let total = 0;
  await Promise.all(sessions.map(async (session, index) => {
    for (let next = 3; total < WANTED && Date.now() < deadline; next++) {
      await store.append(session, [seqNumsOnly({ next, expected: 1 })]);
      made[index]!++;
      total++;
    }
  }));
  assert.ok(total >= WANTED, `only ${total} appends in 10 s`);
  // Taking turns, each of six makes about 100 of 600. One kept waiting makes one or two.
  assert.ok(Math.min(...made) >= 50, `appends made by each session: ${made.join(' ')}`);
  for (const [index, session] of sessions.entries()) assert.equal((await store.load(session)).next, made[index]! + 2);
  for (const session of sessions) await store.reset(session);
});

for (const places of [1, 2, 4]) {
  test(`sessions that wait for a place among ${places} open file${places === 1 ? '' : 's'} are given one in the order they asked`, { timeout: 20_000 }, async t => {
    const dir = await folder(t);
    const holders = upTo(0, places - 1).map(index => sessionOf(`H${index}`));
    const waiters = upTo(0, 7).map(index => sessionOf(`W${index}`));
    const fileOfSession = (session: SessionId) => join(dir, safeFileName(session), '1.jsonl');
    let holding = false;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    /** The files asked to be opened to append to, in the order they were asked for: the order places were given in. */
    const asked: string[] = [];
    const noting = async (real: typeof import('node:fs/promises').open, ...args: Parameters<typeof import('node:fs/promises').open>) => {
      if (args[1] === 'a') asked.push(String(args[0]));
      return real(...args);
    };
    await watchingAppends(seen => withOpen(noting, async () => {
      const store = fileStoreWith(dir, { openFiles: places });
      for (const session of [...holders, ...waiters]) await store.append(session, [record(sentEntry(1), 2, 1)]);
      for (const session of holders) await store.append(session, [record(sentEntry(2), 3, 1)]);   // each holder has a place
      holding = true;
      const slow = holders.map(session => store.append(session, [record(sentEntry(3), 4, 1)]));    // and a write part-way through
      await waitFor(() => seen.writes.length === places * 2, 1000, "the holders' writes to begin");
      holding = false;
      const waiting = waiters.map(session => store.append(session, [record(sentEntry(2), 3, 1)]));
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(asked.length, places, 'a session was given a place while every file had a write part-way through');
      release();
      await inTime(Promise.all([...slow, ...waiting]), 5000, 'the appends of the holders and of the eight that waited');
      assert.deepEqual(asked.slice(places), waiters.map(fileOfSession), 'the order the files of the sessions that waited were asked for');
      assert.equal(seen.most, places);
      for (const session of waiters) assert.deepEqual((await store.load(session)).history.map(seqOf), [1, 2]);
      for (const session of [...holders, ...waiters]) await store.reset(session);
    }), async (real, text) => { if (holding) await held; await real(text); });
  });
}

test('a session that asks for a place among the open files while others wait for one goes behind them, though a file falls idle before its turn', { timeout: 20_000 }, async t => {
  const dir = await folder(t);
  const [a, b, c, d] = [sessionOf('A'), sessionOf('B'), sessionOf('C'), sessionOf('D')];
  const fileOfSession = (session: SessionId) => join(dir, safeFileName(session), '1.jsonl');
  let holding = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await watchingAppends(async seen => {
    const store = fileStoreWith(dir, { openFiles: 1 });
    for (const session of [a, b, c, d]) await store.append(session, [record(sentEntry(1), 2, 1)]);
    await store.append(a, [record(sentEntry(2), 3, 1)]);
    holding = true;
    const slow = store.append(a, [record(sentEntry(3), 4, 1)]);
    await waitFor(() => seen.writes.length === 2, 1000, "a's write to begin");
    holding = false;
    const order: string[] = [];
    const asked = [b, c].map(session => store.append(session, [record(sentEntry(2), 3, 1)]).then(() => { order.push(session.target); }));
    // d asks as a's call finishes, when the place is about to be free: b and c asked first.
    const last = slow.then(() => store.append(d, [record(sentEntry(2), 3, 1)])).then(() => { order.push(d.target); });
    release();
    await inTime(Promise.all([...asked, last]), 5000, 'the appends of the three that waited');
    assert.deepEqual(order, ['B', 'C', 'D']);
    assert.deepEqual(seen.opened.slice(1), [b, c, d].map(fileOfSession));
    for (const session of [a, b, c, d]) await store.reset(session);
  }, async (real, text) => { if (holding) await held; await real(text); });
});

test('a place given back in the middle of a session\'s calls goes to the session that waits at once, not when that session has no more calls', { timeout: 20_000 }, async t => {
  const dir = await folder(t);
  const [a, d] = [sessionOf('A'), sessionOf('D')];
  const fileOfSession = (session: SessionId) => join(dir, safeFileName(session), '1.jsonl');
  let fail: ((error: Error) => void) | undefined;
  let holding = false;
  let holdRead = false;
  let reading = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await watchingAppends(seen => withOpen(async (real, ...args) => {
    // A call of a's that follows its failed append is held as it opens a's file to read it.
    if (holdRead && args[1] === 'r' && String(args[0]) === fileOfSession(a)) {
      holdRead = false;
      reading = true;
      await held;
    }
    return real(...args);
  }, async () => {
    const store = fileStoreWith(dir, { openFiles: 1 });
    for (const session of [a, d]) await store.append(session, [record(sentEntry(1), 2, 1)]);
    await store.append(a, [record(sentEntry(2), 3, 1)]);           // a has the one place
    holding = true;
    const failing = assert.rejects(store.append(a, [record(sentEntry(3), 4, 1)]), /no space left/);
    await waitFor(() => fail !== undefined, 1000, "a's write to begin");
    holding = false;
    holdRead = true;
    const behind = store.load(a);                                  // a's next call, made already
    const waiting = store.append(d, [record(sentEntry(2), 3, 1)]);
    fail!(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }));
    await failing;
    await inTime(waiting, 3000, "d's append, waiting for the place a's failed write gave back");
    assert.equal(seen.most, 1);
    await waitFor(() => reading, 1000, "a's next call to be held");   // d was appended to though a's calls are not over
    release();
    assert.deepEqual((await behind).history.map(seqOf), [1, 2]);
    for (const session of [a, d]) await store.reset(session);
  }), async (real, text) => {
    if (holding) await new Promise<void>((_resolve, reject) => { fail = reject; });
    await real(text);
  });
});

test('a session with many calls made ahead gives its file up to a session that waits when the first of them ends, not the last', { timeout: 20_000 }, async t => {
  const dir = await folder(t);
  const [a, b, c] = [sessionOf('A'), sessionOf('B'), sessionOf('C')];
  const store = fileStoreWith(dir, { openFiles: 2 });
  for (const session of [a, b, c]) await store.append(session, [seqNumsOnly({ next: 2, expected: 1 })]);
  for (const session of [a, b]) await store.append(session, [seqNumsOnly({ next: 3, expected: 1 })]);   // a and b have the two places
  // 300 calls each, none waiting for the one before: neither session is ever without a call part-way through until its last ends.
  let done = 0;
  const ahead = [a, b].flatMap(session => upTo(4, 303).map(next => store.append(session, [seqNumsOnly({ next, expected: 1 })]).then(() => { done++; })));
  await inTime(store.append(c, [seqNumsOnly({ next: 3, expected: 1 })]), 5000, "c's append");
  const before = done;
  await Promise.all(ahead);
  assert.ok(before < 300, `c was appended to after ${before} of the 600 calls the two others had made ahead`);
  for (const session of [a, b]) assert.equal((await store.load(session)).next, 303);
  for (const session of [a, b, c]) await store.reset(session);
});

// ─── fileStore: one write for a list, idle files, a session forgotten ───────

test('fileStore writes a list of any size with one write: 2 MiB of lines reach the file in one piece, never a part of them first', { timeout: 20_000 }, async t => {
  const dir = await folder(t);
  const store = fileStore(dir);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  const list = upTo(2, 33).map(seq => record({ kind: 'error', at, text: `${seq}:${'x'.repeat(65_536)}` }, seq + 1, 1));
  const path = join(dir, safeFileName(id), '1.jsonl');
  const before = (await readFile(path)).length;
  const writes: number[] = [];
  await withOpen(async (real, ...args) => {
    const handle = await real(...args);
    if (args[1] !== 'a') return handle;
    const write = handle.write.bind(handle) as (...given: unknown[]) => Promise<{ bytesWritten: number }>;
    handle.write = (async (...given: unknown[]) => { const done = await write(...given); writes.push(done.bytesWritten); return done; }) as typeof handle.write;
    return handle;
  }, () => store.append(id, list));
  const after = (await readFile(path)).length;
  assert.ok(after - before > 2 * 1_048_576);
  assert.deepEqual(writes, [after - before], 'the bytes each write to the open file put there');
  assert.equal((await linesOf(dir)).length, 34);
  await store.reset(id);
});

test('fileStore carries on a write the operating system cut short, so every line of the list is whole in the file', { timeout: 20_000 }, async t => {
  const dir = await folder(t);
  const store = fileStore(dir);
  await store.append(id, [record(sentEntry(1), 2, 1)]);
  let calls = 0;
  await withOpen(async (real, ...args) => {
    const handle = await real(...args);
    if (args[1] !== 'a') return handle;
    const write = handle.write.bind(handle) as (buffer: Uint8Array, offset: number, length: number) => Promise<{ bytesWritten: number; buffer: Uint8Array }>;
    // No more than 100 bytes of what is asked for are written at a time.
    handle.write = (async (buffer: Uint8Array, offset = 0, length = buffer.length - offset) => { calls++; return write(buffer, offset, Math.min(length, 100)); }) as typeof handle.write;
    return handle;
  }, () => store.append(id, upTo(2, 9).map(seq => record(sentEntry(seq), seq + 1, 1))));
  assert.ok(calls > 8, `${calls} writes`);
  for (const line of await linesOf(dir)) assert.doesNotThrow(() => JSON.parse(line));
  for (const each of [store, fileStore(dir)]) {
    assert.deepEqual((await each.load(id)).history.map(seqOf), upTo(1, 9));
    assert.deepEqual(await sentSeqs(each, 1, 9), upTo(1, 9));
  }
  await store.reset(id);
});

test('a write that takes longer than a file may stay idle has no close waiting behind it: when it finishes its file stays open, and is closed once nothing has been appended to it for that long after', { timeout: 20_000 }, async t => {
  const dir = await folder(t);
  let holding = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  // The store's clock is set by hand: a file is idle by this clock, while the store looks for idle files every 20 ms of real time.
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  const ticks = (count: number) => new Promise(resolve => setTimeout(resolve, count * 20 + 10));
  await watchingAppends(async seen => {
    const store = fileStoreWith(dir, { idleMs: 20 });
    await store.append(id, [record(sentEntry(1), 2, 1)]);
    await store.append(id, [record(sentEntry(2), 3, 1)]);
    holding = true;
    const slow = store.append(id, [record(sentEntry(3), 4, 1)]);
    await ticks(1);                                                // the write has begun
    assert.equal(seen.writes.length, 2);
    now += 1_000;                                                  // it has taken a second, and idle files are looked for meanwhile
    await ticks(4);
    assert.equal(seen.closed.length, 0);
    release();
    await slow;
    await store.load(id);                                          // whatever waited behind the write has run by now
    assert.deepEqual([seen.opened.length, seen.closed.length], [1, 0], 'the file was closed behind a write that had just finished');
    await ticks(4);
    assert.equal(seen.closed.length, 0, 'the file was closed though it had just been written to');
    now += 19;
    await ticks(4);
    assert.equal(seen.closed.length, 0, 'the file was closed 19 ms after it was written to');
    now += 1;
    await ticks(4);
    assert.equal(seen.closed.length, 1, 'the file is closed once 20 ms have passed with nothing appended');
    await store.append(id, [record(sentEntry(4), 5, 1)]);
    assert.equal(seen.opened.length, 2);
    assert.deepEqual((await store.load(id)).history.map(seqOf), [1, 2, 3, 4]);
    await store.reset(id);
  }, async (real, text) => { if (holding) { holding = false; await held; } await real(text); });
});

test('no more files are closed for sessions that wait for a place than sessions wait: of two calls that finish together one gives its file up for the one session waiting', { timeout: 20_000 }, async t => {
  const dir = await folder(t);
  const [a, b, c] = [sessionOf('A'), sessionOf('B'), sessionOf('C')];
  let holding = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await watchingAppends(async seen => {
    const store = fileStoreWith(dir, { openFiles: 2 });
    for (const session of [a, b, c]) await store.append(session, [record(sentEntry(1), 2, 1)]);
    for (const session of [a, b]) await store.append(session, [record(sentEntry(2), 3, 1)]);
    holding = true;
    const slow = [a, b].map(session => store.append(session, [record(sentEntry(3), 4, 1)]));
    await waitFor(() => seen.writes.length === 4, 1000, 'the writes of both to begin');
    holding = false;
    const waiting = store.append(c, [record(sentEntry(2), 3, 1)]);
    release();
    await inTime(Promise.all([...slow, waiting]), 5000, 'the three appends');
    for (const session of [a, b, c]) await store.load(session);    // whatever was to be closed has been
    assert.equal(seen.closed.length, 1);
    assert.deepEqual([seen.most, seen.open()], [2, 2]);
    for (const session of [a, b, c]) await store.reset(session);
  }, async (real, text) => { if (holding) await held; await real(text); });
});

test('fileStore leaves open the file of a session that was forgotten for 1,000 others and is remembered again before its file would be closed', { timeout: 30_000 }, async t => {
  const dir = await folder(t);
  let holding = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await watchingAppends(async seen => {
    const store = fileStore(dir);
    await store.append(id, [record(sentEntry(1), 2, 1)]);
    await store.append(id, [record(sentEntry(2), 3, 1)]);
    holding = true;
    const slow = store.append(id, [record(sentEntry(3), 4, 1)]);   // part-way through while the session is forgotten
    for (let other = 0; other < 1_000; other++) await store.load(sessionOf(`OTHER${other}`));
    release();
    await slow;                                                    // it remembers the session again as it finishes
    await store.append(id, [record(sentEntry(4), 5, 1)]);
    await store.load(id);
    assert.deepEqual([seen.opened.length, seen.closed.length], [1, 0]);
    assert.deepEqual((await store.load(id)).history.map(seqOf), [1, 2, 3, 4]);
    await store.reset(id);
  }, async (real, text) => { if (holding) { holding = false; await held; } await real(text); });
});

// ─── fileStore: its options ─────────────────────────────────────────────────

test('fileStore(dir, { openFiles }) keeps that many files open to append to, and no more', { timeout: 20_000 }, async t => {
  const dir = await folder(t);
  const sessions = upTo(0, 7).map(index => sessionOf(`C${index}`));
  await watchingAppends(async seen => {
    const store = fileStore(dir, { openFiles: 3 });
    for (const session of sessions) await store.append(session, [record(sentEntry(1), 2, 1)]);
    for (const session of sessions) await store.append(session, [record(sentEntry(2), 3, 1)]);
    assert.equal(seen.open(), 3);
    await Promise.all(sessions.flatMap(session => [store.append(session, [record(sentEntry(3), 4, 1)]), store.append(session, [record(sentEntry(4), 5, 1)])]));
    assert.deepEqual([seen.most, seen.open()], [3, 3]);
    for (const session of sessions) assert.deepEqual((await store.load(session)).history.map(seqOf), [1, 2, 3, 4]);
    for (const session of sessions) await store.reset(session);
    assert.equal(seen.open(), 0);
  });
});

test('fileStore refuses options that are not an object, an option it does not know, and an openFiles that is not a whole number of at least 1', { timeout: 10_000 }, async t => {
  const dir = await folder(t);
  const make = fileStore as (dir: string, options?: unknown) => Store;
  for (const [openFiles, got] of [[0, '0'], [-1, '-1'], [1.5, '1.5'], ['8', "'8'"], [Infinity, 'Infinity'], [null, 'null'], [Number.NaN, 'NaN']] as const) {
    assert.throws(() => make(dir, { openFiles }), new RangeError(`fileStore() openFiles must be a whole number of at least 1, got ${got}`));
  }
  assert.throws(() => make(dir, { openFile: 8 }), new RangeError("fileStore() options: unknown setting 'openFile'"));
  assert.throws(() => make(dir, { idleMs: 10 }), new RangeError("fileStore() options: unknown setting 'idleMs'"));
  for (const [options, got] of [[8, '8'], [null, 'null'], ['8', "'8'"], [[], 'an array']] as const) {
    assert.throws(() => make(dir, options), new RangeError(`fileStore() options must be an object of options, got ${got}`));
  }
  for (const options of [undefined, {}, { openFiles: undefined }, { openFiles: 1 }, { openFiles: 4096 }]) {
    assert.deepEqual(await make(dir, options).load(id), { history: [], next: 1, expected: 1 });
  }
});

// ─── A list given to memoryStore and fileStore ──────────────────────────────

/** Each of the two stores, a fileStore in a folder removed with the test. */
async function bothStores(t: { after(fn: () => unknown): void }): Promise<readonly (readonly [string, Store])[]> {
  return [['memoryStore', memoryStore()], ['fileStore', fileStore(await folder(t))]];
}

test('append() keeps the list as it was when the call was made: a caller that empties or changes its array afterwards changes nothing kept (memoryStore and fileStore)', { timeout: 10_000 }, async t => {
  for (const [name, store] of await bothStores(t)) {
    const list = [record(sentEntry(1), 2, 1), record(sentEntry(2), 3, 1)];
    const first = store.append(id, list);
    list.length = 0;
    await first;
    const more = [record(sentEntry(3), 4, 1), record(sentEntry(4), 5, 1)];
    const second = store.append(id, more);
    more[1] = record(sentEntry(9), 10, 1);
    more.push(record(sentEntry(10), 11, 1));
    await second;
    assert.deepEqual(await store.load(id).then(({ history, next }) => [history.map(seqOf), next]), [[1, 2, 3, 4], 5], name);
    assert.deepEqual(await sentSeqs(store, 1, 99), [1, 2, 3, 4], name);
  }
});

test('append() refuses a list with a hole, something that is no record, or a record without its time or its sequence numbers, saying which record, and keeps nothing of the list (memoryStore and fileStore)', { timeout: 10_000 }, async t => {
  const good = () => record(sentEntry(1), 2, 1);
  const holed = [good(), good(), good()];
  delete holed[1];
  const bad: readonly (readonly [unknown[], string])[] = [
    [[good(), null, good()], 'append() record 2 of 3 must be a record, got null'],
    [holed, 'append() record 2 of 3 must be a record, got undefined'],
    [[good(), good(), 'a record'], "append() record 3 of 3 must be a record, got 'a record'"],
    [[[good()]], 'append() record 1 of 1 must be a record, got an array'],
    [[good(), { at, entry: sentEntry(2) }], 'append() record 2 of 2 must have seqNums, the sequence numbers after it, got undefined'],
    [[{ at, seqNums: { next: 2 } }], 'append() record 1 of 1 seqNums.expected must be a whole number of at least 1, got undefined'],
    [[{ at, seqNums: { next: 1.5, expected: 1 } }], 'append() record 1 of 1 seqNums.next must be a whole number of at least 1, got 1.5'],
    [[good(), { seqNums: { next: 2, expected: 1 } }], 'append() record 2 of 2 must have at, a Date, got undefined'],
    [[{ at: new Date(Number.NaN), seqNums: { next: 2, expected: 1 } }, good()], 'append() record 1 of 2 must have at, a Date, got an instance of Date'],
  ];
  for (const [name, store] of await bothStores(t)) {
    for (const [list, text] of bad) {
      await assert.rejects(store.append(id, list as never), new RangeError(text), name);
      assert.deepEqual(await store.load(id), { history: [], next: 1, expected: 1 }, `${name}: ${text}`);
      assert.deepEqual(await store.list(), [], `${name}: ${text}`);
    }
    await store.append(id, [good()]);
    assert.equal((await store.load(id)).next, 2, name);
  }
});

test('memoryStore leaves out each message sent with PossDupFlag wherever it is in a list, and keeps the records around it', { timeout: 10_000 }, async () => {
  const store = memoryStore();
  await store.append(id, [record(sentEntry(1), 2, 1), record(sentEntry(2), 3, 1), record(resentEntry(1), 3, 1), record(sentEntry(3), 4, 1), record(resentEntry(2), 4, 7)]);
  assert.deepEqual((await readAll(store.read(id))).map(entry => [seqOf(entry), entry.kind === 'message' && entry.message.PossDupFlag === true]), [[1, false], [2, false], [3, false]]);
  assert.deepEqual(await store.load(id).then(({ next, expected }) => [next, expected]), [4, 7]);
  // A list that begins with a copy sent again: the originals after it are kept.
  await store.append(id, [record(resentEntry(3), 4, 7), record(sentEntry(4), 5, 7), record(sentEntry(5), 6, 7)]);
  assert.deepEqual(await sentSeqs(store, 1, 9), [1, 2, 3, 4, 5]);
  assert.deepEqual((await readAll(store.read(id))).length, 5);
});

test('memoryStore keeps to its limits on entries and on bytes after each record of a list, not only after the list', { timeout: 10_000 }, async () => {
  const counted = memoryStore({ history: 3 });
  await counted.append(id, upTo(1, 10).map(seq => record(sentEntry(seq), seq + 1, 1)));
  assert.deepEqual((await readAll(counted.read(id))).map(seqOf), [8, 9, 10]);
  assert.deepEqual(await sentSeqs(counted, 1, 99), [8, 9, 10]);
  assert.equal((await counted.load(id)).next, 11);
  assert.deepEqual((await counted.list())[0]!.epochs.map(({ epoch, entries }) => [epoch, entries]), [[1, 3]]);

  const size = entrySize(sentEntry(1));
  const weighed = memoryStore({ historyBytes: size * 2 + 1 });
  await weighed.append(id, upTo(1, 9).map(seq => record(sentEntry(seq), seq + 1, 1)));
  assert.deepEqual((await readAll(weighed.read(id))).map(seqOf), [8, 9]);
  // An epoch begun in the middle of a list that pushes out everything before it: the epoch before is forgotten.
  const epochs = memoryStore({ history: 2 });
  await epochs.append(id, [record(sentEntry(1), 2, 1), record(sentEntry(2), 3, 1), record(sentEntry(1), 2, 1, { newEpoch: true }), record(sentEntry(2), 3, 1), record(sentEntry(3), 4, 1)]);
  assert.deepEqual((await epochs.list())[0]!.epochs.map(({ epoch, entries }) => [epoch, entries]), [[2, 2]]);
  assert.deepEqual(await sentSeqs(epochs, 1, 9), [2, 3]);
});

test('a list that fails part-way: a memoryStore has kept the records before the one it could not keep, a fileStore none of a list one of whose records cannot be made a line, and each keeps the next list', { timeout: 10_000 }, async t => {
  /** An entry no store can keep: a message entry with no message. */
  const broken = { kind: 'message', direction: 'out', at } as unknown as Entry;
  const kept: Record<string, readonly [number[], number]> = { memoryStore: [[1, 2], 3], fileStore: [[1], 2] };
  for (const [name, store] of await bothStores(t)) {
    await store.append(id, [record(sentEntry(1), 2, 1)]);
    await assert.rejects(store.append(id, [record(sentEntry(2), 3, 1), record(broken, 4, 1), record(sentEntry(4), 5, 1)]), TypeError, name);
    // What a session that starts again finds: the sequence numbers of the last record that was kept.
    assert.deepEqual(await store.load(id).then(({ history, next }) => [history.map(seqOf), next]), kept[name], name);
    assert.deepEqual(await sentSeqs(store, 1, 9), kept[name]![0], name);
    await store.append(id, [record(sentEntry(5), 6, 1), record(sentEntry(6), 7, 1)]);
    assert.deepEqual(await store.load(id).then(({ history, next }) => [history.map(seqOf), next]), [[...kept[name]![0], 5, 6], 7], name);
    assert.deepEqual(await sentSeqs(store, 5, 9), [5, 6], name);
  }
});
