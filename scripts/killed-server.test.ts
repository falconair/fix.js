// A server process killed outright while it answers orders, and started again on the same folder:
// what its fileStore holds is what its counterparties were sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { connect, fileStore, memoryStore, type Session, type Store } from '../src/index.ts';

const serverProgram = new URL('./killed-server.ts', import.meta.url).pathname;
/** The environment for a process that is no test file: without the variable by which node's test runner has a file it runs report to it. */
const { NODE_TEST_CONTEXT: _reportsToRunner, ...env } = process.env;
const CLIENTS = 12;
const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

async function waitFor(condition: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${ms} ms waiting for ${what}`);
    await sleep(10);
  }
}

/** Start the server on `folder`; resolves with its process and its port once it listens, rejects when it ends first or says nothing for 10 s. */
function startServer(folder: string, started: ChildProcess[]): Promise<{ child: ChildProcess; port: number; ended: Promise<void> }> {
  const child = spawn(process.execPath, [serverProgram], { env: { ...env, DIR: folder }, stdio: ['pipe', 'pipe', 'pipe'] });
  started.push(child);
  let errors = '';
  child.stderr!.on('data', (text: Buffer) => { errors += String(text); });
  child.stdin!.on('error', () => {});                       // written to nothing; it closes when the process is killed
  const ended = new Promise<void>(resolve => { child.once('exit', () => { resolve(); }); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`The server process said nothing for 10 s: ${errors}`)); }, 10_000);
    void ended.then(() => { clearTimeout(timer); reject(new Error(`The server process ended before it listened: ${errors}`)); });
    createInterface({ input: child.stdout! }).on('line', line => {
      const port = /^PORT (\d+)$/.exec(line)?.[1];
      if (port === undefined) return;
      clearTimeout(timer);
      resolve({ child, port: Number(port), ended });
    });
  });
}

/** One counterparty, and what it has received: by MsgSeqNum, the ExecID of a report (or the MsgType of anything else). */
interface Client {
  readonly name: string;
  readonly store: Store;
  session: Session | undefined;
  open: boolean;
  /** Received from the server that was killed, not as possible duplicates. */
  readonly before: Map<number, string>;
  /** Received from the server started again, not as possible duplicates. */
  readonly after: Map<number, string>;
  /** Received as possible duplicates from the server started again. */
  readonly again: Map<number, string>;
  restarted: boolean;
  readonly faults: string[];
}

async function logOn(client: Client, port: number): Promise<void> {
  const session = await connect({ host: '127.0.0.1', port }, { sender: client.name, target: 'EXCHANGE', store: client.store });
  client.session = session;
  client.open = true;
  void session.closed.then(() => { client.open = false; });
  session.watch(entry => {
    if (entry.kind !== 'message' || entry.direction !== 'in') return;
    const { message } = entry;
    const seq = Number(message.MsgSeqNum);
    const what = String(message.ExecID ?? message.MsgType);
    if (message.PossDupFlag === true) {
      if (message.MsgType === 'ExecutionReport') client.again.set(seq, what);
      return;
    }
    const received = client.restarted ? client.after : client.before;
    const had = received.get(seq);
    if (had !== undefined) client.faults.push(`MsgSeqNum ${seq} came twice, neither a possible duplicate: ${had}, then ${what}`);
    received.set(seq, what);
    const old = client.restarted ? client.before.get(seq) : undefined;
    if (old !== undefined) client.faults.push(`MsgSeqNum ${seq} was used again after the restart: ${old} before it, ${what} after`);
  });
}

test('a server killed while it answers orders and started again on the same folder: every session loads, its fileStore is ahead of every MsgSeqNum a counterparty received, a resend of everything gives each of them again as it was, and no MsgSeqNum is used twice', { timeout: 60_000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'fixjs-killed-'));
  const started: ChildProcess[] = [];
  const clients: Client[] = Array.from({ length: CLIENTS }, (_, index) => ({
    name: `C${index}`, store: memoryStore(), session: undefined, open: false, before: new Map(), after: new Map(), again: new Map(), restarted: false, faults: [],
  }));
  let sending: ReturnType<typeof setInterval> | undefined;
  t.after(async () => {
    clearInterval(sending);
    for (const client of clients) client.session?.close();
    await Promise.all(started.map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      child.once('exit', () => { resolve(); });
      child.kill('SIGKILL');
    })));
    await rm(folder, { recursive: true, force: true });
    await rm(`${folder}-read`, { recursive: true, force: true });
  });

  let orders = 0;
  const order = (client: Client) => {
    if (!client.open) return;
    client.session!.send('NewOrderSingle', { ClOrdID: `${client.name}-${++orders}`, Symbol: 'MSFT', Side: 'Buy', OrdType: 'Limit', OrderQty: 100, Price: 25.5, TransactTime: new Date() }).catch(() => {});
  };
  const reportsBefore = () => clients.reduce((sum, client) => sum + client.before.size, 0);

  // ── Load, and the kill in the middle of it ──
  const first = await startServer(folder, started);
  await Promise.all(clients.map(client => logOn(client, first.port)));
  let turn = 0;
  sending = setInterval(() => {
    // Two orders from each every 5 ms, and a burst of 150 from every fourth each 100 ms, so the server's lists are long.
    for (const client of clients) { order(client); order(client); }
    if (++turn % 20 === 0) for (const [index, client] of clients.entries()) if (index % 4 === 0) for (let n = 0; n < 150; n++) order(client);
  }, 5);
  await waitFor(() => reportsBefore() >= 4000 && turn >= 100, 20_000, 'the server to answer 4,000 times');
  first.child.kill('SIGKILL');
  await first.ended;
  await waitFor(() => clients.every(client => !client.open), 10_000, 'every session to see the server gone');
  clearInterval(sending);
  for (const client of clients) client.restarted = true;
  const received = reportsBefore();
  assert.ok(clients.every(client => client.before.size > 100), 'every counterparty had answers before the kill');

  // ── What the folder holds, read from a copy so that the folder stays as the kill left it ──
  await cp(folder, `${folder}-read`, { recursive: true });
  const disk = fileStore(`${folder}-read`);
  const faults: string[] = [];
  for (const client of clients) {
    const id = { version: 'FIX.4.4', sender: 'EXCHANGE', target: client.name } as const;
    const last = Math.max(...client.before.keys());
    const loaded = await disk.load(id);
    if (loaded.next <= last) faults.push(`${client.name}: the store would begin again at MsgSeqNum ${loaded.next}, and ${last} was received`);
    const kept = new Map<number, string>();
    for await (const entry of disk.sent(id, { from: 1, to: last })) {
      if (entry.kind === 'message') kept.set(Number(entry.message.MsgSeqNum), String(entry.message.ExecID ?? entry.message.MsgType));
    }
    for (const [seq, what] of client.before) {
      if (kept.get(seq) !== what) faults.push(`${client.name}: MsgSeqNum ${seq} was received as ${what} and the store holds ${String(kept.get(seq))}`);
    }
  }
  assert.deepEqual(faults.slice(0, 10), [], `${faults.length} faults in what the store holds`);

  // ── Started again on the same folder ──
  const second = await startServer(folder, started);
  await Promise.all(clients.map(client => logOn(client, second.port)));
  for (let n = 0; n < 20; n++) for (const client of clients) order(client);
  await waitFor(() => clients.every(client => client.after.size >= 40), 10_000, 'the server started again to answer new orders');
  assert.deepEqual(clients.filter(client => !client.open).map(client => client.name), [], 'sessions closed after the restart');
  for (const client of clients) client.session!.send('ResendRequest', { BeginSeqNo: 1, EndSeqNo: 0 }).catch(() => {});
  const reports = (client: Client) => [...client.before].filter(([, what]) => what.startsWith('E'));
  await waitFor(() => clients.every(client => reports(client).every(([seq]) => client.again.has(seq))), 20_000, 'every report received before the kill to be sent again');
  for (const client of clients) {
    for (const [seq, what] of reports(client)) {
      if (client.again.get(seq) !== what) faults.push(`${client.name}: MsgSeqNum ${seq} was ${what} and was sent again as ${String(client.again.get(seq))}`);
    }
    faults.push(...client.faults.map(fault => `${client.name}: ${fault}`));
  }
  assert.deepEqual(faults.slice(0, 10), [], `${faults.length} faults after the restart`);
  assert.ok(received >= 4000, `${received} messages were received before the kill`);
});
