import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import type { DictionaryDef } from '../dictionary/define.ts';
import { TimeoutError } from '../errors.ts';
import type { Duration } from '../util/duration.ts';
import type { Version } from '../version.ts';
import type { Session } from './api.ts';
import { systemClock, type Clock } from './clock.ts';
import { historyLimits } from './log.ts';
import { checkConnectOptions } from './options.ts';
import { FixSession, lastSessionSettled, type MemoryOptions } from './session.ts';
import { peerClose } from './sockets.ts';
import { memoryStore } from './store.ts';
import type { Link, Store, StoreContext } from './types.ts';

/** 'host:port', '[ipv6]:port', or { host, port }. */
export function parseAddress(address: string | { host: string; port: number }): { host: string; port: number } {
  if (typeof address !== 'string') return address;
  const match = /^\[([^\]]+)\]:(\d+)$/.exec(address) ?? /^([^:]+):(\d+)$/.exec(address);
  if (!match) throw new RangeError(`'${address}' is not an address; use host:port`);
  return { host: match[1]!, port: Number(match[2]) };
}

/**
 * Connect a socket and a session: writes go to the socket, socket data and closing go to the session.
 * end() sends our FIN, then destroys the socket if the peer hasn't closed its end within peerClose.waitMs,
 * so a peer that keeps its side open can't hold our file descriptor. This wait is on a real timer: it's
 * about the OS, not session time.
 */
export function socketLink(socket: Socket, session: Pick<FixSession, 'receiveBytes' | 'linkClosed'>): Link {
  let destroyTimer: ReturnType<typeof setTimeout> | undefined;
  socket.on('data', (chunk: Buffer) => session.receiveBytes(chunk));
  socket.on('close', () => {
    clearTimeout(destroyTimer);
    session.linkClosed();
  });
  socket.on('error', error => session.linkClosed(error));
  return {
    write: bytes => new Promise((resolve, reject) => {
      socket.write(bytes, error => (error ? reject(error) : resolve()));
    }),
    end: () => {
      socket.end();
      if (socket.destroyed || destroyTimer) return;
      destroyTimer = setTimeout(() => socket.destroy(), peerClose.waitMs);
      destroyTimer.unref();
    },
    pause: () => { socket.pause(); },
    resume: () => { socket.resume(); },
  };
}

// ─── Client ─────────────────────────────────────────────────────────────────

/** `D` is the custom dictionary's definition, matching the spec's `ConnectOptions<D>`; not used yet. */
export interface ConnectOptions<D = {}> {
  /** Our CompID. */
  readonly sender: string;
  /** Their CompID. */
  readonly target: string;
  /** Default 'FIX.4.4'. 'FIXT.1.1' carries FIX 5.0 SP2, unless `logon` names another application version. */
  readonly version?: Version;
  /** HeartBtInt in seconds. Default 30. */
  readonly heartbeat?: number;
  /** Extra Logon fields (Username, Password, ResetSeqNumFlag; under FIXT.1.1, DefaultApplVerID). */
  readonly logon?: Readonly<Record<string, unknown>>;
  /** Nothing automatic; resolves as soon as TCP connects. */
  readonly manual?: boolean;
  readonly store?: Store;
  readonly clock?: Clock;
  readonly dictionary?: { readonly definition: DictionaryDef };
  readonly onHandlerError?: (error: unknown) => void;
  readonly memory?: MemoryOptions;
  /** How long to wait for the Logon reply. Default '10s'. Checked on a once-a-second tick, so it can fire up to 1 s late. */
  readonly logonTimeout?: Duration;
  /** How long to wait for the Logout reply. Default '10s'. Checked on a once-a-second tick, so it can fire up to 1 s late. */
  readonly logoutTimeout?: Duration;
  /** How long to wait for the TCP connection itself. Default '10s'. */
  readonly connectTimeout?: Duration;
  /** How long one store write (one append() call, with every record it carries) may take before the session closes ('Store write took longer than N s'), and how long connect() waits for store.load() (past it, a TimeoutError), which includes waiting for a session with the same store and CompIDs that was closed a moment ago to have its last records kept. Default '10s'. A write's limit is checked on a once-a-second tick, so it can fire up to 1 s late. A store read for a resend has the same limit for each entry it gives ('Store read took longer than N s'). */
  readonly storeTimeout?: Duration;
  /** Values hidden in history, watch() and the store: tag numbers for every message, false for none. Default: credentials. */
  readonly redact?: readonly number[] | false;
  /**
   * Connect over TLS: true for Node's defaults (the server's certificate is checked against the system's
   * CAs), or Node's TLS connection options (ca for a private CA, …). connectTimeout covers the handshake too.
   */
  readonly tls?: boolean | ConnectionOptions;
}

/** Connect and log on. Resolves with an active session; with manual, as soon as TCP connects. Options are checked first (see options.ts): a mistake is a RangeError. */
export async function connect<D = {}>(address: string | { host: string; port: number }, options: ConnectOptions<D>): Promise<Session<D>> {
  const { host, port } = parseAddress(address);
  const { version, config, dictionary, connectTimeout, storeTimeoutMs } = checkConnectOptions(options);
  const clock = options.clock ?? systemClock;
  const store = options.store ?? memoryStore();
  const storeContext: StoreContext = { history: historyLimits(options.memory), ...(options.dictionary ? { dictionary: options.dictionary } : {}) };
  const id = { version, sender: options.sender, target: options.target };
  // Loaded before the socket is opened, so a load that takes too long leaves no socket to close; and only
  // once a session for this id that was closed a moment ago has had its last records settled by the store.
  const lastSession = lastSessionSettled(store, id);
  let loaded: Awaited<ReturnType<Store['load']>>;
  try {
    loaded = await storeLoad(async () => {
      await lastSession?.settled;
      return store.load(id, storeContext);
    }, storeTimeoutMs, clock);
  } finally {
    lastSession?.forget();
  }
  const tls = options.tls === true ? {} : options.tls || undefined;
  const socket = tls === undefined
    ? await openSocket(host, port, connectTimeout, clock)
    : await openSocket(host, port, connectTimeout, clock, address => tlsConnect({ ...tls, ...address }), 'secureConnect');
  const session = new FixSession({
    config, dictionary, store, storeContext, clock, loaded, storeTimeoutMs,
    connection: { id: randomUUID(), peer: { address: socket.remoteAddress ?? host, port: socket.remotePort ?? port }, at: clock.now() },
    ...(options.onHandlerError === undefined ? {} : { onHandlerError: options.onHandlerError }),
    ...(options.memory === undefined ? {} : { memory: options.memory }),
    ...(options.redact === undefined ? {} : { redact: options.redact }),
  });
  session.attach(socketLink(socket, session));
  if (options.manual) return session;
  session.start();
  await session.active;
  return session;
}

/** What `load` gives, or a TimeoutError once `ms` pass on the clock first; a load that settles after that is ignored. */
function storeLoad<T>(load: () => Promise<T>, ms: number, clock: Clock): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = clock.setTimeout(() => reject(new TimeoutError(`Store load took longer than ${ms / 1000} s`, { kind: 'store' })), ms);
    Promise.resolve().then(load).then(
      value => { clock.clearTimeout(timer); resolve(value); },
      (error: unknown) => { clock.clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * Open a connection, bounded by `ms` on the clock: past it, the socket is destroyed and we reject with a
 * TimeoutError. It is open on `ready`: 'connect' for TCP, 'secureConnect' once a TLS handshake is done
 * (and the server's certificate checked). `create` is replaceable for tests.
 */
export function openSocket(
  host: string, port: number, ms: number, clock: Clock,
  create: (options: { host: string; port: number }) => Socket = createConnection, ready: 'connect' | 'secureConnect' = 'connect',
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = create({ host, port });
    let settled = false;
    const timer = clock.setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new TimeoutError(`Could not connect to ${host}:${port} within ${ms} ms`, { kind: 'connect', address: `${host}:${port}` }));
    }, ms);
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      reject(error);
    };
    // Kept until it opens: a socket that fails may report more than one error, and none may go unheard.
    socket.on('error', onError);
    socket.once(ready, () => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      socket.off('error', onError);
      resolve(socket);
    });
  });
}
