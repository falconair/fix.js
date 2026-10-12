// examples/13b-store-load.ts starts five processes and a folder of its own: however it ends, none is left.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { connect, createServer, type AddressInfo, type Server } from 'node:net';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';

const example = new URL('../examples/13b-store-load.ts', import.meta.url).pathname;
/** The environment for a process that is no test file: without the variable by which node's test runner has a file it runs report to it. */
const { NODE_TEST_CONTEXT: _reportsToRunner, ...env } = process.env;

async function waitFor(condition: () => Promise<boolean> | boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${ms} ms waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
/** A server on a port of the system's choosing. */
const listening = (): Promise<Server> => new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { resolve(server); }); });
const closed = (server: Server): Promise<void> => new Promise(resolve => { server.close(() => { resolve(); }); });
/** A port nothing listens on. */
async function freePort(): Promise<number> {
  const server = await listening();
  const { port } = server.address() as AddressInfo;
  await closed(server);
  return port;
}
/** Whether something accepts connections on a port of this machine. */
const accepts = (port: number): Promise<boolean> => new Promise(resolve => {
  const socket = connect(port, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => { resolve(false); });
});
/** The processes a process started that are still running. */
const childrenOf = (pid: number): number[] => spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number);
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The example with a fileStore under a temporary folder of this test's, on `port`, for a minute unless it is stopped or `settings` say otherwise. */
function start(port: number, temporary: string, settings: Record<string, string> = {}) {
  const child = spawn(process.execPath, [example], {
    env: { ...env, TMPDIR: temporary, STORE: 'file', PORT: String(port), CLIENTS: '8', RATE: '20', SECONDS: '60', ...settings },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (text: Buffer) => { output += String(text); });
  child.stderr.on('data', (text: Buffer) => { output += String(text); });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { child.once('exit', (code, signal) => { resolve({ code, signal }); }); });
  return { child, ended, output: () => output };
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`examples/13b-store-load.ts stopped with ${signal} while it runs ends the processes it started and removes its folder`, { timeout: 60_000 }, async t => {
    const temporary = await mkdtemp(join(tmpdir(), 'fixjs-example-'));
    const port = await freePort();
    const run = start(port, temporary);
    let started: number[] = [];
    t.after(async () => {
      for (const pid of [run.child.pid!, ...started]) if (alive(pid)) process.kill(pid, 'SIGKILL');
      await rm(temporary, { recursive: true, force: true });
    });
    // Under way: its server and four processes of clients run, and each client's session is in the store.
    const sessions = async () => (await Promise.all((await readdir(temporary)).map(name => readdir(join(temporary, name))))).flat().length;
    await waitFor(async () => (started = childrenOf(run.child.pid!)).length === 5 && await sessions() >= 8, 30_000, `the example to be under way\n${run.output()}`);
    run.child.kill(signal);
    const { code } = await run.ended;
    assert.equal(code, 128 + constants.signals[signal], run.output());
    await waitFor(() => !started.some(alive), 5_000, 'the processes it started to end');
    assert.deepEqual(await readdir(temporary), [], 'what it left in the temporary folder');
    assert.equal(await accepts(port), false, 'something still listens on its port');
  });
}

test('examples/13b-store-load.ts whose port is taken says so, ends, and leaves no folder', { timeout: 60_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'fixjs-example-'));
  const taken = await listening();
  const run = start((taken.address() as AddressInfo).port, temporary);
  t.after(async () => {
    if (alive(run.child.pid!)) process.kill(run.child.pid!, 'SIGKILL');
    await closed(taken);
    await rm(temporary, { recursive: true, force: true });
  });
  const { code } = await run.ended;
  assert.equal(code, 1, run.output());
  assert.match(run.output(), /EADDRINUSE/);
  assert.match(run.output(), /The server process ended \(exit code \d+\) before it said READY/);
  assert.deepEqual(await readdir(temporary), [], 'what it left in the temporary folder');
});

test('the processes examples/13b-store-load.ts started end when it is killed outright, and its server removes the folder', { timeout: 60_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'fixjs-example-'));
  const port = await freePort();
  const run = start(port, temporary);
  let started: number[] = [];
  t.after(async () => {
    for (const pid of [run.child.pid!, ...started]) if (alive(pid)) process.kill(pid, 'SIGKILL');
    await rm(temporary, { recursive: true, force: true });
  });
  const sessions = async () => (await Promise.all((await readdir(temporary)).map(name => readdir(join(temporary, name))))).flat().length;
  await waitFor(async () => (started = childrenOf(run.child.pid!)).length === 5 && await sessions() >= 8, 30_000, `the example to be under way\n${run.output()}`);
  run.child.kill('SIGKILL');
  await run.ended;
  await waitFor(() => !started.some(alive), 5_000, 'the processes it started to end');
  await waitFor(async () => (await readdir(temporary)).length === 0, 5_000, 'its folder to be removed');
  assert.equal(await accepts(port), false, 'something still listens on its port');
});

/** The one line of JSON the example prints when it is done. */
const lineOf = (output: string): Record<string, any> => JSON.parse(output.split('\n').findLast(line => line.startsWith('{')) ?? 'null');
/** Of the processes the example started, its server: the one given a heap limit. */
const serverOf = (pids: readonly number[]): number | undefined =>
  pids.find(pid => spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.includes('--max-old-space-size=64'));

test('examples/13b-store-load.ts with PROFILE=overload says that the server lived, that every order was answered, in order, and that no session closed, passes only then, and says the most heap the server used and the longest its event loop stood still; it leaves nothing', { timeout: 60_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'fixjs-example-'));
  const port = await freePort();
  const run = start(port, temporary, { PROFILE: 'overload', RATE: '40', SECONDS: '1', DRAIN: '20', HISTORY: '100', PENDING_BYTES: '2048' });
  t.after(async () => {
    if (alive(run.child.pid!)) process.kill(run.child.pid!, 'SIGKILL');
    await rm(temporary, { recursive: true, force: true });
  });
  const { code } = await run.ended;
  assert.equal(code, 0, run.output());
  const line = lineOf(run.output());
  assert.deepEqual(
    [line.profile, line.store, line.offeredPerSecond, line.heapLimitMiB, line.unanswered],
    ['overload', 'file', 320, 768, 0], run.output());
  assert.deepEqual(
    [line.serverLived, line.everyOrderAnswered, line.sessionsClosed, line.answersOutOfOrder, line.passed],
    [true, true, 0, 0, true], run.output());
  assert.deepEqual([line.orders, line.reports], [160, 320], 'two reports for each of the 160 orders, the ones that came after the sending stopped too');
  assert.ok(line.server.heapMiB > 0 && line.server.rssMiB >= line.server.heapMiB, run.output());
  assert.ok(line.server.loopDelayMs.max > 0 && line.drainSeconds >= 0 && line.offeredOverAnswered >= 1, run.output());
  assert.deepEqual(await readdir(temporary), [], 'what it left in the temporary folder');
  assert.equal(await accepts(port), false, 'something still listens on its port');
});

test('examples/13b-store-load.ts with PROFILE=overload whose server dies under the load says that it did not live and how it ended, does not pass, ends itself with status 1, and leaves nothing', { timeout: 60_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'fixjs-example-'));
  const port = await freePort();
  const run = start(port, temporary, { PROFILE: 'overload', RATE: '40', SECONDS: '3', DRAIN: '20', HEAP_MB: '64' });
  let started: number[] = [];
  t.after(async () => {
    for (const pid of [run.child.pid!, ...started]) if (alive(pid)) process.kill(pid, 'SIGKILL');
    await rm(temporary, { recursive: true, force: true });
  });
  const sessions = async () => (await Promise.all((await readdir(temporary)).map(name => readdir(join(temporary, name))))).flat().length;
  await waitFor(async () => (started = childrenOf(run.child.pid!)).length === 5 && await sessions() >= 8, 30_000, `the example to be under way\n${run.output()}`);
  const server = serverOf(started);
  assert.ok(server !== undefined, 'the server is the process started with the heap limit asked for');
  process.kill(server, 'SIGKILL');
  const { code } = await run.ended;
  assert.equal(code, 1, run.output());
  const line = lineOf(run.output());
  assert.deepEqual([line.profile, line.serverLived, line.passed, line.server.exited, line.heapLimitMiB], ['overload', false, false, 'SIGKILL', 64], run.output());
  assert.equal(line.sessionsClosed, 8, 'every client lost its session');
  await waitFor(() => !started.some(alive), 5_000, 'the processes it started to end');
  assert.deepEqual(await readdir(temporary), [], 'what it left in the temporary folder');
  assert.equal(await accepts(port), false, 'something still listens on its port');
});

test('examples/13b-store-load.ts with PROFILE=overload does not pass, and ends with status 1, when sessions closed though the server lived: it says how many and with what reasons', { timeout: 60_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'fixjs-example-'));
  const port = await freePort();
  const run = start(port, temporary, { PROFILE: 'overload', RATE: '40', SECONDS: '3', DRAIN: '20', HEAP_MB: '64' });
  let started: number[] = [];
  t.after(async () => {
    for (const pid of [run.child.pid!, ...started]) if (alive(pid)) process.kill(pid, 'SIGKILL');
    await rm(temporary, { recursive: true, force: true });
  });
  const sessions = async () => (await Promise.all((await readdir(temporary)).map(name => readdir(join(temporary, name))))).flat().length;
  await waitFor(async () => (started = childrenOf(run.child.pid!)).length === 5 && await sessions() >= 8, 30_000, `the example to be under way\n${run.output()}`);
  // One of its four processes of clients is killed: the two sessions it held are closed, and the server goes on.
  const server = serverOf(started);
  const clients = started.find(pid => pid !== server);
  assert.ok(server !== undefined && clients !== undefined);
  process.kill(clients, 'SIGKILL');
  const { code } = await run.ended;
  assert.equal(code, 1, run.output());
  const line = lineOf(run.output());
  assert.deepEqual([line.serverLived, line.sessionsClosed, line.passed], [true, 2, false], run.output());
  // Closed by the network, as the server saw it: 'Connection closed' or the error of the read that failed.
  assert.ok(Object.keys(line.server.closed).every(why => why.startsWith('network: ')), run.output());
  assert.equal(Object.values(line.server.closed as Record<string, number>).reduce((n, each) => n + each, 0), 2, run.output());
  assert.deepEqual(await readdir(temporary), [], 'what it left in the temporary folder');
});

test('examples/13b-store-load.ts with PROFILE=overload does not pass, and ends with status 1, when orders were left unanswered though the server lived and no session closed', { timeout: 60_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'fixjs-example-'));
  const port = await freePort();
  // 1,000 messages a second from each client, and no time for the answers once the sending stops.
  const run = start(port, temporary, { PROFILE: 'overload', RATE: '1000', SECONDS: '1', DRAIN: '0', HISTORY: '100' });
  t.after(async () => {
    if (alive(run.child.pid!)) process.kill(run.child.pid!, 'SIGKILL');
    await rm(temporary, { recursive: true, force: true });
  });
  const { code } = await run.ended;
  assert.equal(code, 1, run.output());
  const line = lineOf(run.output());
  assert.deepEqual([line.serverLived, line.sessionsClosed, line.everyOrderAnswered, line.passed], [true, 0, false, false], run.output());
  assert.ok(line.unanswered > 0 && line.orders === 4000 && line.reports < 8000, run.output());
  assert.deepEqual(await readdir(temporary), [], 'what it left in the temporary folder');
});

// --- The verdict of an overload run, by itself ---

type OverloadFound = { serverLived: boolean; clientsLived: boolean; sessionsClosed: number; orders: number; reports: number; unanswered: number; answersOutOfOrder: number };
type OverloadVerdict = (found: OverloadFound) => { everyOrderAnswered: boolean; passed: boolean };

/** The example's own verdict: read with a ROLE that starts nothing, so only its functions are had. */
async function verdictOfExample(): Promise<OverloadVerdict> {
  const role = process.env.ROLE;
  process.env.ROLE = 'none';
  try {
    return ((await import(example)) as { overloadVerdict: OverloadVerdict }).overloadVerdict;
  } finally {
    if (role === undefined) delete process.env.ROLE;
    else process.env.ROLE = role;
  }
}

test('an overload run passes only when the server lived, every order was answered, no session closed and no answer came out of order: each of the sixteen combinations, and each way an order can be unanswered', { timeout: 20_000 }, async () => {
  const verdict = await verdictOfExample();
  const good: OverloadFound = { serverLived: true, clientsLived: true, sessionsClosed: 0, orders: 150, reports: 300, unanswered: 0, answersOutOfOrder: 0 };
  assert.deepEqual(verdict(good), { everyOrderAnswered: true, passed: true });
  // What makes each of the four untrue, by itself.
  const flaws: readonly [string, Partial<OverloadFound>][] = [
    ['the server did not live', { serverLived: false }],
    ['an order was left unanswered', { unanswered: 1, reports: 298 }],
    ['sessions closed', { sessionsClosed: 2 }],
    ['an answer came out of order', { answersOutOfOrder: 1 }],
  ];
  const rows: [string, boolean, boolean][] = [];
  for (let mask = 0; mask < 16; mask++) {
    const chosen = flaws.filter((_, n) => (mask & (1 << n)) !== 0);
    const found = Object.assign({}, good, ...chosen.map(([, flaw]) => flaw)) as OverloadFound;
    const { everyOrderAnswered, passed } = verdict(found);
    rows.push([chosen.map(([what]) => what).join(', ') || 'nothing wrong', everyOrderAnswered, passed]);
  }
  assert.deepEqual(rows, Array.from({ length: 16 }, (_, mask) => [
    flaws.filter((__, n) => (mask & (1 << n)) !== 0).map(([what]) => what).join(', ') || 'nothing wrong',
    (mask & 2) === 0,
    mask === 0,
  ]));
  // Every order answered needs the clients alive to have counted, none still owed, and two reports for each order.
  const answered: readonly [Partial<OverloadFound>, boolean][] = [
    [{}, true],
    [{ clientsLived: false }, false],
    [{ unanswered: 3 }, false],
    [{ reports: 299 }, false],
    [{ reports: 301 }, false],
    [{ reports: 150 }, false],
    [{ orders: 0, reports: 0 }, true],
    [{ clientsLived: false, unanswered: 3, reports: 294 }, false],
  ];
  for (const [change, expected] of answered) {
    assert.deepEqual(verdict({ ...good, ...change }), { everyOrderAnswered: expected, passed: expected }, JSON.stringify(change));
  }
  // One session closed is enough, and one answer out of order.
  assert.equal(verdict({ ...good, sessionsClosed: 1 }).passed, false);
  assert.equal(verdict({ ...good, answersOutOfOrder: 7 }).passed, false);
});
