// storeContract() as a program that has installed the package meets it: each test here writes a
// small test file, runs it with node in a process of its own, and reads what that process reported.
import { describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeContract } from '../test.ts';

const root = new URL('../index.ts', import.meta.url).href;
const testEntry = new URL('../test.ts', import.meta.url).href;
/** The environment for a process that reports for itself: without the variable by which node's test runner has a file it runs report to it. */
const { NODE_TEST_CONTEXT: _reportsToRunner, ...env } = process.env;

interface Outcome {
  /** How many tests the file defined, and how many of them passed, failed and ran out of time. */
  readonly tests: number;
  readonly pass: number;
  readonly fail: number;
  readonly cancelled: number;
  /** Whether the process was still running after `deadline` ms and had to be stopped. */
  readonly stopped: boolean;
  /** Everything the process wrote. */
  readonly output: string;
  /** What the file left in `tally`, when it left anything. */
  readonly tally: unknown;
}

/**
 * Runs `source` as a test file in a process of its own, with `args` for node, and stops the process
 * when it is still running after `deadline` ms. The file may write JSON to the path it finds in `tally`.
 */
async function runFile(t: TestContext, source: string, { args = [], deadline = 60_000 }: { args?: readonly string[]; deadline?: number } = {}): Promise<Outcome> {
  const dir = await mkdtemp(join(tmpdir(), 'fixjs-contract-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tallyFile = join(dir, 'tally.json');
  const file = join(dir, 'contract.test.mjs');
  await writeFile(file, `const tally = ${JSON.stringify(tallyFile)};\n${source}`);
  const ran = await new Promise<{ stdout: string; stderr: string; stopped: boolean }>(resolve => {
    execFile(process.execPath, ['--test-reporter=tap', ...args, file], { encoding: 'utf8', timeout: deadline, killSignal: 'SIGKILL', env },
      (error, stdout, stderr) => { resolve({ stdout, stderr, stopped: error?.killed === true }); });
  });
  const output = `${ran.stdout}${ran.stderr}`;
  const count = (what: string) => Number(new RegExp(`^# ${what} (\\d+)$`, 'm').exec(ran.stdout)?.[1] ?? 0);
  const tally: unknown = await readFile(tallyFile, 'utf8').then(text => JSON.parse(text), () => undefined);
  return { tests: count('tests'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), stopped: ran.stopped, output, tally };
}

/**
 * A test file that runs the suite against what `make` gives, and leaves how many stores were made
 * and, for each call of cleanup, which of them it was given (-1: something that was never made).
 */
const counting = (make: string): string => `
import { writeFileSync } from 'node:fs';
import { memoryStore } from ${JSON.stringify(root)};
import { storeContract } from ${JSON.stringify(testEntry)};
const made = [];
const cleaned = [];
let calls = 0;
const keep = store => { made.push(store); return store; };
storeContract('a store', ${make}, { cleanup: store => { cleaned.push(made.indexOf(store)); clearInterval(store?.handle); } });
process.on('exit', () => writeFileSync(tally, JSON.stringify({ made: made.length, calls, cleaned })));
`;

interface Tally { made: number; calls: number; cleaned: number[] }
/** A store that keeps the contract, but for sent(), which gives each entry as `change` makes it. */
const giving = (change: string): string => `
import { memoryStore } from ${JSON.stringify(root)};
import { storeContract } from ${JSON.stringify(testEntry)};
const change = ${change};
storeContract('a store', () => {
  const inner = memoryStore();
  return { ...inner, sent: async function* (...given) { for await (const entry of inner.sent(...given)) yield change(entry); } };
});
`;
/** The one contract test the runs that wait out a time limit keep to, as arguments for node. */
const oneTest = ['--test-name-pattern=both ends included'];
/** 0, 1, … one below `length`. */
const each = (length: number) => Array.from({ length }, (_unused, index) => index);

test('storeContract is a function of a name, a function that gives a store, and options', () => {
  assert.equal(typeof storeContract, 'function');
});

test('importing fix.js/test defines no test, and importing fix.js does not load node:test', async t => {
  const imported = await runFile(t, `import ${JSON.stringify(testEntry)};`);
  assert.equal(imported.tests, 0, imported.output);
  assert.doesNotMatch(imported.output, /^(not )?ok /m);

  // The same file defines tests once it calls storeContract(): the count above is of this kind of run.
  const called = await runFile(t, `import { memoryStore } from ${JSON.stringify(root)};\nimport { storeContract } from ${JSON.stringify(testEntry)};\nstoreContract('a store', () => memoryStore());`);
  assert.ok(called.tests > 0, called.output);

  const loaded = (entry: string) => {
    const ran = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(entry)}); console.log(JSON.stringify(process.moduleLoadList.filter(name => name.includes('test_runner'))));`], { encoding: 'utf8', timeout: 60_000, env });
    assert.equal(ran.status, 0, ran.stderr);
    return JSON.parse(ran.stdout) as string[];
  };
  assert.deepEqual(loaded(root), []);
  assert.notDeepEqual(loaded(testEntry), []);   // what would show there, had the root loaded it
});

test('storeContract passes a store that keeps the contract, with a make that gives the store or a promise of it', async t => {
  for (const make of ['() => keep(memoryStore())', 'async () => keep(memoryStore())']) {
    const outcome = await runFile(t, counting(make));
    assert.ok(outcome.tests > 0, outcome.output);
    assert.deepEqual([outcome.pass, outcome.fail], [outcome.tests, 0], outcome.output);
  }
});

test('storeContract calls cleanup once for each store made, with that store, when every test passes', async t => {
  const outcome = await runFile(t, counting('async () => keep(memoryStore())'));
  const tally = outcome.tally as Tally;
  assert.equal(outcome.fail, 0, outcome.output);
  assert.equal(tally.made, outcome.tests);
  assert.deepEqual(tally.cleaned.toSorted((a, b) => a - b), each(tally.made));
});

test('storeContract calls cleanup once for each store made when its tests fail', async t => {
  // A store whose sent() gives nothing fails every test that expects a message back.
  const outcome = await runFile(t, counting('async () => keep({ ...memoryStore(), sent: async function* () {} })'));
  const tally = outcome.tally as Tally;
  assert.ok(outcome.fail > 0, outcome.output);
  assert.equal(tally.made, outcome.tests);
  assert.deepEqual(tally.cleaned.toSorted((a, b) => a - b), each(tally.made));
});

test('storeContract fails the test whose make throws or rejects, with what it threw, and still calls cleanup once for each store made', async t => {
  for (const make of ['async () => { if (++calls % 2 === 0) throw new Error(\'no store today\'); return keep(memoryStore()); }', '() => { if (++calls % 2 === 0) throw new Error(\'no store today\'); return keep(memoryStore()); }']) {
    const outcome = await runFile(t, counting(make));
    const tally = outcome.tally as Tally;
    assert.equal(tally.calls, outcome.tests);
    assert.equal(outcome.fail, Math.floor(outcome.tests / 2), outcome.output);
    assert.match(outcome.output, /no store today/);
    assert.equal(tally.made, outcome.tests - outcome.fail);
    assert.deepEqual(tally.cleaned.toSorted((a, b) => a - b), each(tally.made));
  }
});

test('storeContract fails a test whose cleanup throws, and keeps the failure of the test itself when both fail', async t => {
  const throwing = (make: string) => `
import { memoryStore } from ${JSON.stringify(root)};
import { storeContract } from ${JSON.stringify(testEntry)};
storeContract('a store', ${make}, { cleanup: async () => { throw new Error('the file would not close'); } });
`;
  const passing = await runFile(t, throwing('() => memoryStore()'));
  assert.deepEqual([passing.pass, passing.fail], [0, passing.tests], passing.output);
  assert.match(passing.output, /the file would not close/);

  const failing = await runFile(t, throwing('() => ({ ...memoryStore(), sent: async function* () {} })'));
  assert.equal(failing.pass, 0, failing.output);
  assert.match(failing.output, /2:t2/);   // what the first test expected of sent(), which is why it failed
});

test('storeContract fails a test that is given a store with something already kept for a session it uses, and says so', async t => {
  const outcome = await runFile(t, counting('(() => { const shared = keep(memoryStore()); return () => shared; })()'));
  assert.ok(outcome.fail > 0, outcome.output);
  assert.match(outcome.output, /make\(\) gave a store that already keeps something for the session FIX\.4\.4 EXCHANGE CLIENT: each test needs a store with nothing kept for it/);
});

test('storeContract fails a store whose sent() gives an entry with a property added, or as something other than a plain object', async t => {
  const unchanged = await runFile(t, giving('entry => ({ ...entry })'));
  assert.deepEqual([unchanged.pass, unchanged.fail], [unchanged.tests, 0], unchanged.output);

  const added = await runFile(t, giving('entry => ({ ...entry, rowId: 7 })'));
  assert.ok(added.fail > 0, added.output);
  assert.match(added.output, /the entry given for 2:t2 is not the one appended/);

  const instance = await runFile(t, giving('entry => Object.assign(new (class Row {})(), entry)'));
  assert.ok(instance.fail > 0, instance.output);
  assert.match(instance.output, /the entry given for 2:t2 is not a plain object/);

  const messageInstance = await runFile(t, giving('entry => ({ ...entry, message: Object.assign(new (class Row {})(), entry.message) })'));
  assert.ok(messageInstance.fail > 0, messageInstance.output);
  assert.match(messageInstance.output, /the entry given for 2:t2 is not the one appended/);
});

test('storeContract passes a store whose sent() gives an entry, its message or a group\'s entry as an object with no prototype', async t => {
  const bare = 'value => Object.assign(Object.create(null), value)';
  for (const change of [
    `entry => (${bare})(entry)`,
    `entry => ({ ...entry, message: (${bare})(entry.message) })`,
    `entry => ({ ...entry, message: { ...entry.message, ...(entry.message.Parties ? { Parties: entry.message.Parties.map(${bare}) } : {}) } })`,
  ]) {
    const outcome = await runFile(t, giving(change));
    assert.ok(outcome.tests > 0, outcome.output);
    assert.deepEqual([outcome.pass, outcome.fail], [outcome.tests, 0], `${change}\n${outcome.output}`);
  }
});

/** The names of the contract tests a run reported as failed, without the name the suite was given. */
const failed = (outcome: Outcome): string[] => [...outcome.output.matchAll(/^not ok \d+ - a store: (.*)$/gm)].map(found => found[1]!);
const asAppended = "sent() gives a message back as it was appended: every field with its type (a time a Date, a number a number, a boolean a boolean), its groups, the entry's time, its wire bytes";

test('storeContract fails a store whose sent() gives a time back as text, in a message field or as the entry\'s time', async t => {
  const field = await runFile(t, giving('entry => ({ ...entry, message: { ...entry.message, SendingTime: entry.message.SendingTime.toISOString() } })'));
  assert.ok(failed(field).includes(asAppended), field.output);
  assert.match(field.output, /the entry given for 2:t2 is not the one appended/);
  // Every test that sent() gives a message back to fails: the four left are given none by it.
  assert.equal(field.pass, 4, field.output);

  // The one field that is a time in the report alone: the tests that append only TestRequests pass.
  const transact = await runFile(t, giving('entry => entry.message.TransactTime ? { ...entry, message: { ...entry.message, TransactTime: entry.message.TransactTime.toISOString() } } : entry'));
  assert.deepEqual(failed(transact), [asAppended], transact.output);

  const entryTime = await runFile(t, giving('entry => ({ ...entry, at: entry.at.toISOString() })'));
  assert.ok(failed(entryTime).includes(asAppended), entryTime.output);
  assert.match(entryTime.output, /the entry given for 2:t2 is not the one appended/);
});

test('storeContract fails a store whose sent() gives a number back as text, a group without one of its entries, or a field less', async t => {
  for (const change of [
    'entry => entry.message.AvgPx === undefined ? entry : { ...entry, message: { ...entry.message, AvgPx: String(entry.message.AvgPx) } }',
    'entry => entry.message.Parties ? { ...entry, message: { ...entry.message, Parties: entry.message.Parties.slice(1) } } : entry',
    'entry => { if (!entry.message.Parties) return entry; const { WorkingIndicator, ...message } = entry.message; return { ...entry, message }; }',
  ]) {
    const outcome = await runFile(t, giving(change));
    assert.deepEqual(failed(outcome), [asAppended], `${change}\n${outcome.output}`);
  }
});

test('storeContract fails a store whose sent() gives an entry with another time than it was appended with', async t => {
  const outcome = await runFile(t, giving('entry => ({ ...entry, at: new Date(entry.at.getTime() + 1) })'));
  assert.ok(failed(outcome).includes(asAppended), outcome.output);
  assert.match(outcome.output, /the entry given for 2:t2 is not the one appended/);

  // The same instant as another Date is the time it was appended with.
  const same = await runFile(t, giving('entry => ({ ...entry, at: new Date(entry.at.getTime()) })'));
  assert.deepEqual([same.pass, same.fail], [same.tests, 0], same.output);
});

test('storeContract fails a store whose sent() gives other wire bytes than were appended, none where there were some, or some where there were none', async t => {
  const other = await runFile(t, giving('entry => entry.bytes ? { ...entry, bytes: entry.bytes.map((byte, index) => index === 20 ? byte ^ 1 : byte) } : entry'));
  assert.ok(failed(other).includes(asAppended), other.output);
  assert.match(other.output, /the wire bytes given for 2:t2 are not those appended/);

  const shorter = await runFile(t, giving('entry => entry.bytes ? { ...entry, bytes: entry.bytes.subarray(0, entry.bytes.length - 1) } : entry'));
  assert.match(shorter.output, /the wire bytes given for 2:t2 are not those appended/);

  const array = await runFile(t, giving('entry => entry.bytes ? { ...entry, bytes: [...entry.bytes] } : entry'));
  assert.match(array.output, /the wire bytes given for 2:t2 are not a Uint8Array/);

  const lost = await runFile(t, giving('({ bytes, ...entry }) => entry'));
  assert.ok(failed(lost).includes(asAppended), lost.output);
  assert.match(lost.output, /the entry given for 2:t2 has lost its wire bytes/);

  const gained = await runFile(t, giving('entry => ({ ...entry, bytes: entry.bytes ?? new Uint8Array([56, 61, 70]) })'));
  assert.deepEqual(failed(gained), ['sent() gives a message that was kept without wire bytes (one an outgoing route dropped)'], gained.output);
  assert.match(gained.output, /the entry given for 1:t1 has gained wire bytes/);

  // The same bytes in another Uint8Array, or in a Buffer, are the bytes appended.
  for (const change of ['entry => entry.bytes ? { ...entry, bytes: new Uint8Array(entry.bytes) } : entry', 'entry => entry.bytes ? { ...entry, bytes: Buffer.from(entry.bytes) } : entry']) {
    const same = await runFile(t, giving(change));
    assert.deepEqual([same.pass, same.fail], [same.tests, 0], `${change}\n${same.output}`);
  }
});

test('storeContract fails a store whose sent() gives one session what another was given', async t => {
  const outcome = await runFile(t, `
import { memoryStore } from ${JSON.stringify(root)};
import { storeContract } from ${JSON.stringify(testEntry)};
storeContract('a store', () => {
  const inner = memoryStore();
  return { ...inner, sent: (id, range, context) => inner.sent({ ...id, target: 'CLIENT' }, range, context) };
});
`);
  assert.deepEqual(failed(outcome), [
    'append() for two sessions at once keeps the lists of each whole, in order and apart, whichever call settles first',
    'sent() gives nothing for a session with nothing kept, and keeps sessions apart',
  ], outcome.output);
});

/** A store that keeps the contract, but for append(), which keeps the list `change` makes of the one it is given. */
const appending = (change: string): string => `
import { memoryStore } from ${JSON.stringify(root)};
import { storeContract } from ${JSON.stringify(testEntry)};
const change = ${change};
storeContract('a store', () => {
  const inner = memoryStore();
  return { ...inner, append: (id, records, context) => inner.append(id, change(records), context) };
});
`;
const LISTS = {
  order: 'append() keeps the records of a list in the order given, and one list after another',
  one: 'append() of a list of one record keeps it as any other',
  last: 'append() of a list leaves the sequence numbers of its last record as the session\'s, whether that record has an entry or not',
  epoch: 'append() begins the next epoch at a record with newEpoch wherever it is in a list: the records before it stay in the epoch before, the records after it are in the new one',
  first: 'append() begins epoch 1 with a session\'s first record, whether it has newEpoch or not, and not a second one for the list it came in',
  most: 'append() keeps a list of 256 records, the most a session gives at once, each in its place',
};

test('storeContract fails a store whose append() keeps a list in another order, or only its first record, or only its last', async t => {
  const reversed = await runFile(t, appending('records => [...records].reverse()'));
  for (const title of [LISTS.order, LISTS.last, LISTS.epoch, LISTS.most]) assert.ok(failed(reversed).includes(title), `${title}\n${reversed.output}`);

  const first = await runFile(t, appending('records => records.slice(0, 1)'));
  for (const title of [LISTS.order, LISTS.last, LISTS.epoch, LISTS.most]) assert.ok(failed(first).includes(title), `${title}\n${first.output}`);

  const last = await runFile(t, appending('records => records.slice(-1)'));
  for (const title of [LISTS.order, LISTS.epoch, LISTS.most]) assert.ok(failed(last).includes(title), `${title}\n${last.output}`);

  // Every test that appends a list of one alone passes with each of them: the list is what is tested.
  for (const outcome of [reversed, first, last]) assert.ok(!failed(outcome).includes(LISTS.one), outcome.output);
});

test('storeContract fails a store whose append() leaves the sequence numbers of a record that is not the last of its list', async t => {
  const outcome = await runFile(t, appending('records => [...records, { at: records[0].at, seqNums: records[0].seqNums }]'));
  assert.ok(failed(outcome).includes(LISTS.last), outcome.output);
  assert.ok(failed(outcome).includes(LISTS.order), outcome.output);
});

test('storeContract fails a store whose append() begins an epoch only at the head of a list, or at the head of a list that has a newEpoch record anywhere', async t => {
  const headOnly = await runFile(t, appending('records => records.map((record, index) => (index === 0 ? record : { ...record, newEpoch: false }))'));
  assert.deepEqual(failed(headOnly), [LISTS.epoch], headOnly.output);

  const moved = await runFile(t, appending('records => records.map((record, index) => ({ ...record, newEpoch: index === 0 && records.some(each => each.newEpoch) }))'));
  assert.ok(failed(moved).includes(LISTS.epoch), moved.output);
});

test('storeContract fails a store whose append() begins a second epoch for a first list whose first record has newEpoch', async t => {
  const outcome = await runFile(t, `
import { memoryStore } from ${JSON.stringify(root)};
import { storeContract } from ${JSON.stringify(testEntry)};
storeContract('a store', () => {
  const inner = memoryStore();
  let begun = false;
  return { ...inner, append: async (id, records, context) => {
    // As a store would that begins an epoch for its first record, and then another for the flag.
    if (!begun && records[0].newEpoch) await inner.append(id, [{ at: records[0].at, seqNums: records[0].seqNums }], context);
    begun = true;
    return inner.append(id, records, context);
  } };
});
`);
  assert.deepEqual(failed(outcome), [LISTS.first], outcome.output);
});

test('storeContract fails a store written to be given one record at a time', async t => {
  const outcome = await runFile(t, `
import { memoryStore } from ${JSON.stringify(root)};
import { storeContract } from ${JSON.stringify(testEntry)};
storeContract('a store', () => {
  const inner = memoryStore();
  return { ...inner, append: (id, record, context) => inner.append(id, [{ at: record.at, entry: record.entry, seqNums: record.seqNums ?? { next: 1, expected: 1 } }], context) };
});
`);
  for (const title of Object.values(LISTS)) assert.ok(failed(outcome).includes(title), `${title}\n${outcome.output}`);
});

const SESSIONS = {
  object: 'a session is the three values of its SessionId, whichever object carries them: what is appended with one object is loaded, read, sent() and reset with another',
  together: 'append() for two sessions at once keeps the lists of each whole, in order and apart, whichever call settles first',
  version: 'sessions that differ only in version are kept apart: what is appended, loaded, read, sent(), listed and reset for one is not for the other',
};

test('storeContract fails a store that knows a session by the object its SessionId came in, not by its version and CompIDs', async t => {
  const outcome = await runFile(t, `
import { memoryStore } from ${JSON.stringify(root)};
import { storeContract } from ${JSON.stringify(testEntry)};
storeContract('a store', () => {
  // One memoryStore for each object it has been given as a SessionId: a session handed a new object is another session here.
  const stores = new Map();
  const of = id => stores.get(id) ?? stores.set(id, memoryStore()).get(id);
  return {
    load: (id, context) => of(id).load(id, context),
    append: (id, records, context) => of(id).append(id, records, context),
    read: (id, options, context) => of(id).read(id, options, context),
    sent: (id, range, context) => of(id).sent(id, range, context),
    list: async () => (await Promise.all([...stores.values()].map(store => store.list()))).flat(),
    reset: id => of(id).reset(id),
  };
});
`);
  assert.deepEqual(failed(outcome), [SESSIONS.object], outcome.output);
});

test('storeContract fails a store that gathers what it is given in one place for every session and writes it after a wait', async t => {
  const outcome = await runFile(t, `
import { memoryStore } from ${JSON.stringify(root)};
import { storeContract } from ${JSON.stringify(testEntry)};
storeContract('a store', () => {
  const inner = memoryStore();
  // As a store would that fills one statement or one buffer for all its sessions.
  let gathered = [];
  return { ...inner, append: async (id, records, context) => {
    gathered.push(...records);
    await new Promise(resolve => setImmediate(resolve));
    const mine = gathered;
    gathered = [];
    if (mine.length > 0) await inner.append(id, mine, context);
  } };
});
`);
  assert.deepEqual(failed(outcome), [SESSIONS.together], outcome.output);
});

test('storeContract fails a store that leaves the version out of what it knows a session by', async t => {
  const outcome = await runFile(t, `
import { memoryStore } from ${JSON.stringify(root)};
import { storeContract } from ${JSON.stringify(testEntry)};
storeContract('a store', () => {
  const inner = memoryStore();
  const any = id => ({ ...id, version: 'FIX.4.4' });
  return {
    load: (id, context) => inner.load(any(id), context),
    append: (id, records, context) => inner.append(any(id), records, context),
    read: (id, options, context) => inner.read(any(id), options, context),
    sent: (id, range, context) => inner.sent(any(id), range, context),
    list: () => inner.list(),
    reset: id => inner.reset(any(id)),
  };
});
`);
  assert.deepEqual(failed(outcome), [SESSIONS.version], outcome.output);
});

test('storeContract fails a test that is given a store with something kept for the session of another version alone, and names that session', async t => {
  const outcome = await runFile(t, `
import { memoryStore } from ${JSON.stringify(root)};
import { storeContract } from ${JSON.stringify(testEntry)};
storeContract('a store', async () => {
  const store = memoryStore();
  await store.append({ version: 'FIX.4.2', sender: 'EXCHANGE', target: 'CLIENT' }, [{ at: new Date(), seqNums: { next: 5, expected: 1 } }]);
  return store;
});
`);
  assert.deepEqual([outcome.pass, outcome.fail], [0, outcome.tests], outcome.output);
  assert.match(outcome.output, /make\(\) gave a store that already keeps something for the session FIX\.4\.2 EXCHANGE CLIENT: each test needs a store with nothing kept for it/);
});

test('storeContract fails a test that is given a store with something kept for the second session alone, and names that session', async t => {
  const outcome = await runFile(t, `
import { memoryStore } from ${JSON.stringify(root)};
import { storeContract } from ${JSON.stringify(testEntry)};
storeContract('a store', async () => {
  const store = memoryStore();
  await store.append({ version: 'FIX.4.4', sender: 'EXCHANGE', target: 'NOBODY' }, [{ at: new Date(), seqNums: { next: 5, expected: 1 } }]);
  return store;
});
`);
  assert.deepEqual([outcome.pass, outcome.fail], [0, outcome.tests], outcome.output);
  assert.match(outcome.output, /make\(\) gave a store that already keeps something for the session FIX\.4\.4 EXCHANGE NOBODY: each test needs a store with nothing kept for it/);
  assert.doesNotMatch(outcome.output, /for the session FIX\.4\.4 EXCHANGE CLIENT/);
});

test('storeContract gives what make gave to cleanup once when it is not a store, and fails the test saying what a store must have', async t => {
  // What make gave holds a timer, as a store half built holds a file: the process ends by itself only when cleanup has been given each.
  const outcome = await runFile(t, counting('() => keep({ load() {}, handle: setInterval(() => {}, 1000) })'), { deadline: 20_000 });
  const tally = outcome.tally as Tally;
  assert.equal(outcome.stopped, false, 'the process was still running after 20 s');
  assert.ok(outcome.tests > 0, outcome.output);
  assert.deepEqual([outcome.pass, outcome.fail], [0, outcome.tests], outcome.output);
  assert.match(outcome.output, /what make\(\) gave must have load, append, read, sent, list and reset functions/);
  assert.equal(tally.made, outcome.tests);
  assert.deepEqual(tally.cleaned.toSorted((a, b) => a - b), each(tally.made));

  // The same for something that is no object at all.
  const nothing = await runFile(t, counting('() => keep(++calls)'));
  assert.deepEqual([nothing.pass, nothing.fail], [0, nothing.tests], nothing.output);
  assert.deepEqual((nothing.tally as Tally).cleaned.toSorted((a, b) => a - b), each(nothing.tests));
});

test('storeContract keeps what each test appended apart from the others when its tests run at once, twice over', async t => {
  const outcome = await runFile(t, `
import { describe } from 'node:test';
import { memoryStore } from ${JSON.stringify(root)};
import { storeContract } from ${JSON.stringify(testEntry)};
describe('at once', { concurrency: true }, () => {
  storeContract('a store', () => memoryStore());
  storeContract('another store', () => memoryStore());
});
`);
  assert.ok(outcome.tests > 0, outcome.output);
  assert.deepEqual([outcome.pass, outcome.fail], [outcome.tests, 0], outcome.output);
});

// Each of these waits out the 10 s a test or a cleanup has, so they run at once.
describe('storeContract and a store or a cleanup that never finishes', { concurrency: true }, () => {
  test('a test whose sent() never settles runs out of time after 10 s, and its store is still given to cleanup, so the process ends', async t => {
    const outcome = await runFile(t, counting(`() => {
      const store = keep({ ...memoryStore(), sent: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) });
      store.handle = setInterval(() => {}, 1000);   // what an open file is to the process: it does not end while this is held
      return store;
    }`), { args: oneTest, deadline: 30_000 });
    assert.equal(outcome.stopped, false, `the process was still running after 30 s\n${outcome.output}`);
    assert.deepEqual([outcome.pass, outcome.fail, outcome.cancelled], [0, 0, 1], outcome.output);
    assert.match(outcome.output, /test timed out after 10000ms/);
    assert.deepEqual(outcome.tally, { made: 1, calls: 0, cleaned: [0] });
  });

  test('a test that fails reports its own failure when its cleanup never settles', async t => {
    const outcome = await runFile(t, `
import { memoryStore } from ${JSON.stringify(root)};
import { storeContract } from ${JSON.stringify(testEntry)};
storeContract('a store', () => ({ ...memoryStore(), sent: async function* () {} }), { cleanup: () => new Promise(() => {}) });
`, { args: oneTest, deadline: 30_000 });
    assert.equal(outcome.stopped, false, `the process was still running after 30 s\n${outcome.output}`);
    assert.deepEqual([outcome.pass, outcome.fail, outcome.cancelled], [0, 1, 0], outcome.output);
    assert.match(outcome.output, /2:t2/);   // what the test expected of sent(), which is why it failed
    assert.doesNotMatch(outcome.output, /timed out|cleanup/);
  });

  test('a test that passes fails, naming cleanup, when its cleanup has not settled after 10 s', async t => {
    const outcome = await runFile(t, `
import { memoryStore } from ${JSON.stringify(root)};
import { storeContract } from ${JSON.stringify(testEntry)};
storeContract('a store', () => memoryStore(), { cleanup: () => new Promise(() => {}) });
`, { args: oneTest, deadline: 30_000 });
    assert.equal(outcome.stopped, false, `the process was still running after 30 s\n${outcome.output}`);
    assert.deepEqual([outcome.pass, outcome.fail, outcome.cancelled], [0, 1, 0], outcome.output);
    assert.match(outcome.output, /storeContract\(\) cleanup had not finished after 10 s/);
    assert.doesNotMatch(outcome.output, /test timed out/);
  });
});

test('storeContract refuses, when it is called, a name, a make or options that are not what it takes', () => {
  const make = () => { throw new Error('never called'); };
  assert.throws(() => storeContract(7 as never, make), new RangeError('storeContract() name must be text, not empty, got 7'));
  assert.throws(() => storeContract('', make), new RangeError("storeContract() name must be text, not empty, got ''"));
  assert.throws(() => storeContract('a store', {} as never), new RangeError('storeContract() make must be a function, got an object'));
  assert.throws(() => storeContract('a store', make, 7 as never), new RangeError('storeContract() options must be an object, got 7'));
  assert.throws(() => storeContract('a store', make, { cleanUp: () => {} } as never), new RangeError("storeContract() options: unknown setting 'cleanUp'"));
  assert.throws(() => storeContract('a store', make, { cleanup: true } as never), new RangeError('storeContract() cleanup must be a function, got true'));
});
