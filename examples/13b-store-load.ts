// How much a server answers with each store. One server process and four of
// clients, all on this machine: a server that answers every NewOrderSingle
// with two ExecutionReports, and clients that send it orders and TestRequests.
//
//   node examples/13b-store-load.ts               memoryStore
//   STORE=file node examples/13b-store-load.ts    fileStore, in a temporary folder removed afterwards
//
// RATE=50 changes how many messages each client sends a second (half orders,
// half TestRequests; default 20), CLIENTS how many clients (200), SECONDS how
// long (20). PROFILE=baskets is another load: ten of 300 clients send 500
// orders at one moment, five times over, while the others sit idle.
// PROFILE=overload offers the server more than it can answer: every client
// sends 150 messages a second for 10 s, the server runs with a heap of
// HEAP_MB (768), and once the sending stops the clients wait up to DRAIN
// seconds (60) for the answers still owed. Its line says three things apart:
// whether the server process lived (serverLived), whether every order got
// both its reports (everyOrderAnswered), and how many sessions closed
// (sessionsClosed; server.closed and clientsClosed give the reasons as each
// side saw them). `passed` is true only when the server lived, every order
// was answered, no session closed and each client's reports came in the
// order the server made them (answersOutOfOrder is 0); when it is false the
// program ends with status 1. The line also has the most heap the server
// used and the longest its event loop stood still.
// PENDING_BYTES sets the server's memory.pendingBytes, how much it takes in
// from a client before it stops reading; HISTORY its memory.history (and the
// memoryStore's), how many entries it keeps for each session; OPEN_FILES the
// fileStore's openFiles; PORT the port the server listens on (19901).
// It prints one line of JSON: what was answered, how fast, and what the
// server process needed for it (its largest RSS and heap, and how late its
// event loop ran: loopDelayMs.max is the longest it stood still).
//
// Stopped part-way (Ctrl-C, SIGTERM, a server that cannot start), it ends the
// processes it started and removes the folder; they end by themselves, and
// the server removes the folder, when this process is killed outright.

import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { connect, fileStore, listen, memoryStore, ExecType, MsgType, OrdStatus, OrdType, Side, type Session } from 'fix.js';

const env = process.env;
const ROLE = env.ROLE ?? 'run';                      // run starts the others: one server, four of clients; any other but theirs starts nothing
const PROFILE = env.PROFILE === 'baskets' ? 'baskets' : env.PROFILE === 'overload' ? 'overload' : 'steady';
const STORE = env.STORE === 'file' ? 'file' : 'memory';
const PORT = Number(env.PORT ?? 19901);
const CLIENTS = Number(env.CLIENTS ?? (PROFILE === 'baskets' ? 300 : 200));
const RATE = Number(env.RATE ?? (PROFILE === 'overload' ? 150 : 20));
const SECONDS = Number(env.SECONDS ?? (PROFILE === 'overload' ? 10 : 20));
const HEAP_MB = Number(env.HEAP_MB ?? 768);          // the server's heap under PROFILE=overload
const DRAIN = Number(env.DRAIN ?? 60);               // how long the clients wait for what is still owed, under PROFILE=overload
const FIRST = Number(env.FIRST ?? 0);                // the number of this process's first client
const PROCESSES = 4;
const BASKETS = 10;
const BASKET = 500;
const ROUNDS = 5;

const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });
const rounded = (n: number) => Math.round(n * 10) / 10;
const at = (sorted: readonly number[], p: number) => rounded(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0);

/** The lines the process that started this one has written to its stdin, and who waits for each. */
const heard = new Set<string>();
const awaited = new Map<string, () => void>();

/**
 * Reads what the process that started this one tells it. When that process is gone (its end of
 * stdin closes, however it ended), this one ends too, after `last`.
 */
function listenToParent(last: () => void = () => {}): void {
  createInterface({ input: process.stdin })
    .on('line', text => { heard.add(text); awaited.get(text)?.(); })
    .on('close', () => { last(); process.exit(1); });
}

/** Resolves once `line` has arrived on this process's stdin. */
function told(line: string): Promise<void> {
  return new Promise(resolve => {
    if (heard.has(line)) resolve();
    else awaited.set(line, resolve);
  });
}

// ─── The server ─────────────────────────────────────────────────────────────

async function serve(): Promise<void> {
  // Left alone, nothing else would remove the store's folder: this process is the one that writes it.
  listenToParent(() => { if (env.DIR) rmSync(env.DIR, { recursive: true, force: true, maxRetries: 3 }); });
  const loop = monitorEventLoopDelay({ resolution: 1 });
  loop.enable();
  let rss = 0;
  let heap = 0;
  const mib = (bytes: number) => Math.round(bytes / 1_048_576);
  const sampling = setInterval(() => {
    const now = process.memoryUsage();
    rss = Math.max(rss, now.rss);
    heap = Math.max(heap, now.heapUsed);
  }, 100);
  const closed: Record<string, number> = {};
  let orders = 0;
  let reports = 0;
  const history = env.HISTORY ? { history: Number(env.HISTORY) } : {};
  const server = await listen(PORT, {
    compID: 'EXCHANGE',
    host: '127.0.0.1',
    store: env.DIR ? fileStore(env.DIR, env.OPEN_FILES ? { openFiles: Number(env.OPEN_FILES) } : {}) : memoryStore(history),
    heartbeat: { min: 1, max: 120 },
    limits: { maxSessions: 2_000, connectionsPerAddress: 2_000, pendingLogons: 2_000 },
    memory: { ...history, ...(env.PENDING_BYTES ? { pendingBytes: Number(env.PENDING_BYTES) } : {}) },
  });
  server.on(MsgType.Logon, (_logon, session) => {
    void session.closed.then(reason => {
      const why = `${reason.by}: ${reason.text}`;
      closed[why] = (closed[why] ?? 0) + 1;
    });
  });
  server.on(MsgType.NewOrderSingle, (order, session) => {
    orders++;
    const common = { OrderID: `O${orders}`, ClOrdID: order.ClOrdID, Symbol: order.Symbol, Side: order.Side };
    const price = order.Price ?? 0;
    const failed = () => {};                          // the session closed first: counted in `closed`
    session.send(MsgType.ExecutionReport, { ...common, ExecID: `E${++reports}`, ExecType: ExecType.New, OrdStatus: OrdStatus.New, LeavesQty: order.OrderQty, CumQty: 0, AvgPx: 0 }).catch(failed);
    session.send(MsgType.ExecutionReport, { ...common, ExecID: `E${++reports}`, ExecType: ExecType.Trade, OrdStatus: OrdStatus.Filled, LeavesQty: 0, CumQty: order.OrderQty, AvgPx: price, LastQty: order.OrderQty, LastPx: price }).catch(failed);
  });
  const measured = () => ({
    orders, closed, rssMiB: mib(rss), heapMiB: mib(heap),
    loopDelayMs: { p50: rounded(loop.percentile(50) / 1e6), p99: rounded(loop.percentile(99) / 1e6), max: rounded(loop.max / 1e6) },
  });
  console.log('READY');
  await told('go');
  loop.reset();
  rss = 0;
  heap = 0;
  // A server that dies of the load never reports: what it had measured a second before is what is known of it.
  const reporting = PROFILE === 'overload' ? setInterval(() => { console.log(`SO_FAR ${JSON.stringify(measured())}`); }, 1000) : undefined;
  await told('stop');
  clearInterval(sampling);
  clearInterval(reporting);
  console.log(`RESULT ${JSON.stringify(measured())}`);
  // Sessions still open are closed with the process: close() would wait for each to log out.
  process.exit(0);
}

// ─── The clients ────────────────────────────────────────────────────────────

interface Client { readonly session: Session; readonly index: number; closed: boolean }

async function load(): Promise<void> {
  listenToParent();
  const clients: Client[] = [];
  const closed: Record<string, number> = {};
  const sentAt = new Map<string, number>();
  const fillMs: number[] = [];
  let reports = 0;
  let orders = 0;
  let outOfOrder = 0;
  for (let from = 0; from < CLIENTS; from += 50) {   // log on fifty at a time
    await Promise.all(Array.from({ length: Math.min(50, CLIENTS - from) }, async (_, k) => {
      const index = FIRST + from + k;
      const session = await connect(`127.0.0.1:${PORT}`, { sender: `C${index}`, target: 'EXCHANGE', heartbeat: PROFILE === 'baskets' ? 1 : 30 });
      const client: Client = { session, index, closed: false };
      clients.push(client);
      void session.closed.then(reason => {
        client.closed = true;
        const why = `${reason.by}: ${reason.text}`;
        closed[why] = (closed[why] ?? 0) + 1;
      });
      // The server numbers its reports as it makes them (E1, E2, ...): one client's must come with rising numbers.
      let lastExec = 0;
      session.on(MsgType.ExecutionReport, report => {
        reports++;
        const exec = Number(String(report.ExecID).slice(1));
        if (!(exec > lastExec)) outOfOrder++;
        lastExec = exec;
        if (report.OrdStatus !== OrdStatus.Filled) return;
        const began = sentAt.get(String(report.ClOrdID));
        if (began === undefined) return;
        fillMs.push(performance.now() - began);
        sentAt.delete(String(report.ClOrdID));
      });
    }));
  }
  const sendOrder = (client: Client) => {
    if (client.closed) return;
    const id = `${client.index}-${++orders}`;
    sentAt.set(id, performance.now());
    client.session.send(MsgType.NewOrderSingle, { ClOrdID: id, Symbol: 'MSFT', Side: Side.Buy, OrdType: OrdType.Limit, OrderQty: 100, Price: 25.5, TransactTime: new Date() }).catch(() => {});
  };
  const sendTest = (client: Client) => {
    if (!client.closed) client.session.send(MsgType.TestRequest, { TestReqID: `T${performance.now()}` }).catch(() => {});
  };
  console.log('LOGGED_ON');
  await told('go');
  const result = PROFILE === 'baskets'
    ? await baskets(clients, sendOrder, sendTest, () => reports)
    : await steady(clients, sendOrder, sendTest, () => reports, PROFILE === 'overload' ? () => sentAt.size === 0 || clients.every(client => client.closed) : undefined);
  fillMs.sort((a, b) => a - b);
  console.log(`RESULT ${JSON.stringify({ ...result, orders, reports, outOfOrder, unanswered: sentAt.size, closed, fillMs: { p50: at(fillMs, 0.5), p99: at(fillMs, 0.99) } })}`);
  await told('end');
  process.exit(0);
}

/**
 * Every client sends RATE messages a second for SECONDS, an order and a TestRequest in turn; what is
 * still on its way then has 5 s. With `answered` (the overload), it has until `answered` says nothing
 * is owed any more, or DRAIN seconds, and the time that took is given.
 */
async function steady(clients: readonly Client[], sendOrder: (client: Client) => void, sendTest: (client: Client) => void, reports: () => number, answered?: () => boolean): Promise<Record<string, unknown>> {
  const began = performance.now();
  const due = clients.map(() => 0);
  await new Promise<void>(resolve => {
    const ticker = setInterval(() => {
      const elapsed = Math.min(performance.now() - began, SECONDS * 1000);
      for (const [i, client] of clients.entries()) {
        // Each client's messages are spread over the second, and no two clients send at the same moment.
        const want = Math.floor((elapsed + (i * 1000 / RATE) / clients.length) * RATE / 1000);
        while (due[i]! < want) (due[i]!++ % 2 === 0 ? sendOrder : sendTest)(client);
      }
      if (elapsed < SECONDS * 1000) return;
      clearInterval(ticker);
      resolve();
    }, 5);
  });
  const inTime = reports();
  if (!answered) {
    await pause(5_000);
    return { reportsInTime: inTime };
  }
  const stopped = performance.now();
  while (!answered() && performance.now() - stopped < DRAIN * 1000) await pause(20);
  return { reportsInTime: inTime, drainMs: Math.round(performance.now() - stopped) };
}

/** BASKETS clients send BASKET orders each at one moment, ROUNDS times; of the others, one in ten sends a TestRequest a second. */
async function baskets(clients: readonly Client[], sendOrder: (client: Client) => void, sendTest: (client: Client) => void, reports: () => number): Promise<Record<string, unknown>> {
  const busy = clients.filter(client => client.index < BASKETS);
  const asking = clients.filter(client => client.index >= BASKETS && client.index % 10 === 0);
  const probe = setInterval(() => { for (const client of asking) sendTest(client); }, 1000);
  await pause(3_000);
  const basketMs: number[] = [];
  for (let round = 0; round < ROUNDS && busy.length > 0; round++) {
    const want = reports() + busy.length * BASKET * 2;
    const began = performance.now();
    for (const client of busy) for (let i = 0; i < BASKET; i++) sendOrder(client);
    while (reports() < want && performance.now() - began < 60_000) await pause(2);
    basketMs.push(Math.round(performance.now() - began));
    await pause(2_000);
  }
  if (busy.length === 0) await pause(ROUNDS * 3_000);
  clearInterval(probe);
  return { basketMs };
}

// ─── One run ────────────────────────────────────────────────────────────────

/**
 * Another process of this program in `role`: its RESULT line (when it ends without one: how it ended,
 * with the last SO_FAR line it printed), and a promise for each other line it prints, which rejects
 * when the process ends without printing it. `nodeOptions` are node's own, before the program.
 */
function start(role: string, extra: Record<string, string>, nodeOptions: readonly string[] = []): { child: ChildProcess; result: Promise<Record<string, any>>; said(line: string): Promise<void> } {
  const child = spawn(process.execPath, [...nodeOptions, import.meta.filename], { env: { ...env, ROLE: role, ...extra }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map<string, { resolve(): void; reject(error: Error): void }>();
  let ended: string | undefined;
  let soFar: Record<string, any> = {};
  let give!: (value: Record<string, any>) => void;
  const result = new Promise<Record<string, any>>(resolve => { give = resolve; });
  const gone = (line: string) => new Error(`The ${role} process ended (${ended}) before it said ${line}`);
  createInterface({ input: child.stdout! }).on('line', text => {
    if (text.startsWith('RESULT ')) give(JSON.parse(text.slice(7)));
    else if (text.startsWith('SO_FAR ')) soFar = JSON.parse(text.slice(7));
    else waiting.get(text)?.resolve();
  });
  child.stdin!.on('error', () => {});                 // it ended first: what was written to it is lost with it
  child.on('exit', (code, signal) => {
    ended = signal ?? `exit code ${code}`;
    give({ ...soFar, exited: ended });
    for (const [line, each] of waiting) each.reject(gone(line));
  });
  return {
    child, result,
    said: line => new Promise((resolve, reject) => {
      if (ended !== undefined) reject(gone(line));
      else waiting.set(line, { resolve, reject });
    }),
  };
}

/** What a run under PROFILE=overload found: whether the processes lived, and the sums over all clients. */
export interface OverloadFound {
  readonly serverLived: boolean;
  readonly clientsLived: boolean;
  readonly sessionsClosed: number;
  readonly orders: number;
  readonly reports: number;
  readonly unanswered: number;
  readonly answersOutOfOrder: number;
}

/**
 * Under the overload, things that are each true or not, and one verdict that needs them all:
 * every order was answered when the clients lived to count, none is still owed a report and there
 * are two reports for each; the run passed when also the server lived, no session closed and no
 * client got its reports out of the order the server made them.
 */
export function overloadVerdict(found: OverloadFound): { readonly everyOrderAnswered: boolean; readonly passed: boolean } {
  const everyOrderAnswered = found.clientsLived && found.unanswered === 0 && found.reports === 2 * found.orders;
  const passed = found.serverLived && everyOrderAnswered && found.sessionsClosed === 0 && found.answersOutOfOrder === 0;
  return { everyOrderAnswered, passed };
}

async function run(): Promise<void> {
  const children: ChildProcess[] = [];
  const making = STORE === 'file' ? mkdtemp(join(tmpdir(), 'fixjs-load-')) : undefined;
  /** Ends every process this one started, waits until each is gone, then removes the store's folder: nothing writes to it by then. */
  const cleanUp = async (): Promise<void> => {
    await Promise.all(children.map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return resolve();
      child.once('exit', () => { resolve(); });
      child.kill('SIGKILL');
    })));
    const made = await making;
    if (made) await rm(made, { recursive: true, force: true, maxRetries: 3 });
  };
  // Stopped from outside: the same cleanup, then the exit status a shell gives a process a signal ended.
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const signal of signals) {
    process.once(signal, () => { void cleanUp().finally(() => process.exit(128 + constants.signals[signal])); });
  }
  try {
    const dir = await making;
    const server = start('server', dir ? { DIR: dir } : {}, PROFILE === 'overload' ? [`--max-old-space-size=${HEAP_MB}`] : []);
    children.push(server.child);
    await server.said('READY');
    const each = Math.ceil(CLIENTS / PROCESSES);
    const loads = Array.from({ length: PROCESSES }, (_, p) => start('clients', { CLIENTS: String(Math.max(0, Math.min(each, CLIENTS - p * each))), FIRST: String(p * each) }));
    children.push(...loads.map(each => each.child));
    await Promise.all(loads.map(each => each.said('LOGGED_ON')));
    for (const each of [server, ...loads]) each.child.stdin!.write('go\n');
    const results = await Promise.all(loads.map(each => each.result));
    server.child.stdin!.write('stop\n');
    const served = await server.result;
    for (const each of loads) each.child.stdin!.write('end\n');
    const sum = (key: string) => results.reduce((n, each) => n + (Number(each[key]) || 0), 0);
    const clientsClosed: Record<string, number> = {};
    for (const each of results) for (const [why, n] of Object.entries(each.closed ?? {})) clientsClosed[why] = (clientsClosed[why] ?? 0) + Number(n);
    const count = (closed: Record<string, number> = {}) => Object.values(closed).reduce((n, each) => n + Number(each), 0);
    const serverLived = served.exited === undefined;
    const clientsLived = results.every(each => each.exited === undefined);
    const sessionsClosed = Math.max(count(served.closed), count(clientsClosed));
    const { everyOrderAnswered, passed } = overloadVerdict({
      serverLived, clientsLived, sessionsClosed,
      orders: sum('orders'), reports: sum('reports'), unanswered: sum('unanswered'), answersOutOfOrder: sum('outOfOrder'),
    });
    if (PROFILE === 'overload' && !passed) process.exitCode = 1;
    console.log(JSON.stringify({
      store: STORE, profile: PROFILE, clients: CLIENTS,
      ...(PROFILE === 'baskets'
        ? { basketMs: results.map(each => each.basketMs).find(times => times?.length > 0) }
        : { rate: RATE, seconds: SECONDS, offeredPerSecond: CLIENTS * RATE, answeredPerSecond: Math.round(sum('reportsInTime') / SECONDS) }),
      ...(PROFILE === 'overload'
        ? {
            // Offered against answered while the load lasted, and how long the answers still owed took.
            offeredOverAnswered: rounded(CLIENTS * RATE * SECONDS / Math.max(1, sum('reportsInTime'))),
            passed, serverLived, everyOrderAnswered, sessionsClosed, heapLimitMiB: HEAP_MB,
            drainSeconds: rounded(Math.max(...results.map(each => Number(each.drainMs) || 0)) / 1000),
          }
        : {}),
      orders: sum('orders'), reports: sum('reports'), unanswered: sum('unanswered'), answersOutOfOrder: sum('outOfOrder'),
      ...(clientsLived ? {} : { clientsExited: results.flatMap(each => (each.exited === undefined ? [] : [each.exited])) }),
      fillMs: { p50: Math.max(...results.map(each => each.fillMs?.p50 ?? 0)), p99: Math.max(...results.map(each => each.fillMs?.p99 ?? 0)) },
      server: served, clientsClosed,
    }));
  } finally {
    await cleanUp();
  }
}

if (ROLE === 'server') await serve();
else if (ROLE === 'clients') await load();
else if (ROLE === 'run') {
  await run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
