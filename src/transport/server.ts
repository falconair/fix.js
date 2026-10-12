import { randomUUID } from 'node:crypto';
import type { Server as NetServer, Socket } from 'node:net';
import type { TlsOptions } from 'node:tls';
import type { DictionaryDef } from '../dictionary/define.ts';
import { SESSION_DATA_TAGS } from '../dictionary/index.ts';
import { resolveDictionary, resolveSessionLayer } from '../dictionary/resolve.ts';
import { FIXLogonError, FIXStateError, TimeoutError } from '../errors.ts';
import { applVerIDProblem } from '../session/handshake.ts';
import { engineConfig, type Problem } from '../session/types.ts';
import { toMs, type Duration } from '../util/duration.ts';
import { FIXT11, isVersion, type Version } from '../version.ts';
import { parseFrame, type RawField } from '../wire/frame.ts';
import { inspectMessage, type MessageObject } from '../wire/message.ts';
import { FrameSplitter } from '../wire/splitter.ts';
import type { AcceptOptions, Handler, Server, Session } from './api.ts';
import { systemClock, type Clock } from './clock.ts';
import { encodeMessage } from './codec.ts';
import { socketLink } from './net.ts';
import { ConnectionFeed, type ConnectionRef } from './feed.ts';
import { historyLimits } from './log.ts';
import { acceptOptionsProblem, checkListenOptions, heartbeatRange, type ListenSettings } from './options.ts';
import { maskError, maskProblem, redactBytes, redaction, type Redaction } from './redact.ts';
import { FixSession, lastSessionSettled, type HandOverWait, type MemoryOptions } from './session.ts';
import { peerClose, plainServer, tlsServer, type OpenedConnection, type SocketServerFactory } from './sockets.ts';
import { memoryStore } from './store.ts';
import { remover, type ConnectionEntry, type LogonIds, type Peer, type Remove, type Store, type StoreContext } from './types.ts';

/** The first byte of a TLS handshake record: a ClientHello sent to a port that doesn't use TLS. */
const TLS_HANDSHAKE = 0x16;

/** A TLS handshake on a listener that doesn't use TLS is refused with this. */
const TLS_ON_PLAIN_PORT: Problem = { code: 'TLSMismatch', text: 'TLS on the plain port: this port does not use TLS', action: 'Disconnected' };

/** Node's codes for bytes that don't start a TLS handshake, on a listener that uses TLS. */
const NOT_TLS = new Set(['ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_HTTP_REQUEST', 'ERR_SSL_HTTPS_PROXY_REQUEST']);

/** Why a TLS handshake failed, in plain words. `handshakeMs`: how long Node waits for one. */
function handshakeProblem(error: Error, handshakeMs: number): Problem {
  const { code, reason } = error as { code?: unknown; reason?: unknown };
  if (code === 'ERR_TLS_HANDSHAKE_TIMEOUT') return { code: 'LogonTimeout', text: `No TLS handshake within ${handshakeMs / 1000} s`, action: 'Disconnected' };
  if (typeof code === 'string' && NOT_TLS.has(code)) return { code: 'TLSMismatch', text: 'No TLS on the TLS port: this port uses TLS', action: 'Disconnected' };
  return { code: 'TLSMismatch', text: `TLS handshake failed: ${typeof reason === 'string' && reason !== '' ? reason : error.message}`, action: 'Disconnected' };
}

/** DefaultApplVerID: the application version a FIXT.1.1 Logon names. */
const DEFAULT_APPL_VER_ID_TAG = 1137;

/** Data fields in a Logon (RawData, EncryptedPassword) are found by these tags before its version is known. */
const PRE_LOGON_DATA_TAGS = SESSION_DATA_TAGS;

// ─── Server ─────────────────────────────────────────────────────────────────

export interface HeartbeatRange {
  readonly min?: number;
  readonly max?: number;
}

/** What one server takes on. */
export interface ServerLimits {
  /** Live sessions. Default 1,000. */
  readonly maxSessions?: number;
  /**
   * Open connections from one IP address, logged-on sessions included. Default 10. Raise it when
   * many counterparties share an address: a gateway, NAT, or a test harness running many clients.
   * Each exact address counts on its own (one IPv6 /64 network has many); pendingLogons is the
   * backstop across all of them.
   */
  readonly connectionsPerAddress?: number;
  /**
   * Open connections that haven't logged on yet (TLS ones still in their handshake included), from all
   * addresses together. Default 100. Silent connections can hold these places until logonTimeout, so a
   * shorter logonTimeout makes that costlier.
   */
  readonly pendingLogons?: number;
  /** Largest message, in bytes. Default 64 KiB. */
  readonly maxMessageSize?: number;
  /**
   * How long a connection has to log on. Default '10s'. A Logon still being checked then (accept()
   * or the store not done with it) is refused with a Logout, 'Logon timed out'. One that was
   * waiting for the store to settle the last session of its counterparty has an 'error' entry
   * saying so before the refusal in watch(); see storeTimeout. Checked on a
   * once-a-second tick, so it can fire up to 1 s late.
   */
  readonly logonTimeout?: Duration;
  /**
   * How long received messages may wait with none of them processed (a route or the store holding
   * them up) before the session is closed, with a Logout once logged on ('No progress on received
   * messages for N s'). Our own outgoing messages don't count as progress; a handler holding a
   * message doesn't hold anything up. Default '60s'. Checked on a once-a-second tick, so it can
   * fire up to 1 s late.
   */
  readonly processingTimeout?: Duration;
}

/**
 * `D` is the custom dictionary's definition, matching the spec's `ListenOptions<D>`; not used yet.
 * `C` is the type of the `context` accept() gives each session.
 */
export interface ListenOptions<D = {}, C = unknown> {
  /** Our CompID, or several: each session's SenderCompID is the one its counterparty addressed. */
  readonly compID: string | readonly string[];
  readonly host?: string;
  /** Accepted BeginStrings. Default: all supported, FIXT.1.1 included. */
  readonly versions?: readonly Version[];
  /** Check each Logon before any session exists: true to accept, settings for this counterparty (accepted), or the text of the Logout that refuses it. */
  readonly accept?: (logon: MessageObject, peer: Peer) => true | string | AcceptOptions<C> | Promise<true | string | AcceptOptions<C>>;
  /**
   * Allowed HeartBtInt range in seconds; a Logon outside it is refused. Default 1 to 120,
   * so HeartBtInt=0 (heartbeats off) is refused unless `min` is 0.
   */
  readonly heartbeat?: HeartbeatRange;
  readonly manual?: boolean;
  readonly store?: Store;
  readonly clock?: Clock;
  readonly dictionary?: { readonly definition: DictionaryDef };
  /** What one server takes on; see ServerLimits. */
  readonly limits?: ServerLimits;
  /** How long to wait for the Logout reply. Default '10s'. Checked on a once-a-second tick, so it can fire up to 1 s late. */
  readonly logoutTimeout?: Duration;
  /** How long one store write (one append() call, with every record it carries) may take before the session closes ('Store write took longer than N s'), and how long a store read for a resend may take to give each entry ('Store read took longer than N s'). A Logon also waits this long for the last session with its counterparty to have its last records kept, and is then refused ('Store unavailable'); one still waiting when limits.logonTimeout ends is refused then ('Logon timed out'), which comes first at the defaults, where both are '10s' and the logon timeout counts from when the connection opened. Whichever refuses it, watch() has one 'error' entry before the refusal ('The store has not settled the records of the last session with "CLIENT": a Logon has waited N s for it'; onHandlerError is given a TimeoutError, waitingFor { kind: 'store' }). The wait is by store object: an accept() that gives a new store object for each Logon gets none. Default '10s'. Checked on a once-a-second tick, so it can fire up to 1 s late. */
  readonly storeTimeout?: Duration;
  /** Also receives each failure outside any session ('error' entries in watch()); what it throws is recorded, never raised. */
  readonly onHandlerError?: (error: unknown) => void;
  readonly memory?: MemoryOptions;
  /** Values hidden in history, watch(), the store and the connection feed: tag numbers for every message, false for none. Default: credentials. */
  readonly redact?: readonly number[] | false;
  /**
   * Serve over TLS: Node's TLS server options (key, cert, …). A connection counts toward the limits, and
   * is in watch(), from the moment TCP opens. Its handshake must finish within limits.logonTimeout (Node
   * also gives up after handshakeTimeout without progress, by default the same); one that fails or takes
   * too long is rejected and closed. Without tls, a TLS handshake is rejected ('TLSMismatch').
   */
  readonly tls?: TlsOptions;
}

/** A handler registered on the server (FixServer#on), and the per-session removers that attached it so far. */
interface HandlerEntry<C> {
  readonly msgType: string;
  readonly handler: Handler<{}, C>;
  readonly removers: Map<FixSession<C>, Remove>;
}

/** A whenConnected() waiter: check() re-evaluates once a session becomes active; fail() rejects it outright (timeout, or the server closing). */
interface Waiter {
  check(): void;
  fail(error: unknown): void;
}

/** listen()'s options as checked (see options.ts), and the redaction they ask for. */
type ServerSettings = ListenSettings & { readonly redaction: Redaction | undefined };

function serverSettings(options: ListenOptions<{}, unknown>): ServerSettings {
  return { ...checkListenOptions(options), redaction: redaction(options.redact) };
}

/** Sessions are told apart by their CompID pair: a counterparty may log on once to each of our CompIDs. */
const pairKey = (sender: string, target: string) => JSON.stringify([sender, target]);

/** One TCP connection, from accept to close. Small and fixed in size: nothing per session exists before accept() passes. */
interface Connection<C> {
  readonly id: string;
  /** The TCP socket: FIX is read from it, or for TLS, from the TLS socket on top of it. */
  readonly tcp: Socket;
  readonly peer: Peer;
  readonly at: Date;
  /** The Logon's version and CompIDs, once one was read. */
  logon?: LogonIds;
  session?: FixSession<C>;
  /** A connection is rejected (in the feed) at most once, and never once closed. */
  rejected?: boolean;
  closed?: boolean;
  /** When its Logon began to wait for the store to settle the records of the last session with its counterparty (ms on the clock); unset once that wait has ended. */
  waitingForStoreSince?: number;
}

/** What #emit is given: an entry's event and its own fields; `at` defaults to now. */
type EntryDetails<E = Extract<ConnectionEntry, { connectionId: string }>> =
  E extends ConnectionEntry ? Omit<E, 'kind' | 'connectionId' | 'peer' | 'at'> & { readonly at?: Date } : never;

/** A connection whose store failed to load is refused with this. */
const STORE_UNAVAILABLE: Problem = { code: 'LogonRefused', text: 'Store unavailable', action: 'Disconnected' };

/** A value from the wire as a text may show it: in double quotes, in printable ASCII, everything else escaped. */
const quoted = (value: string) => JSON.stringify(value).replace(/[^\x20-\x7e]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * What the feed is given for a Logon refused while it waited for the store to settle the records of
 * the last session with `target`: the refusal alone ('Logon timed out', 'Store unavailable') does not
 * say that a store call which has not returned is what kept the counterparty out.
 */
const storeNotSettled = (target: string, waitedMs: number) =>
  new TimeoutError(`The store has not settled the records of the last session with ${quoted(target)}: a Logon has waited ${Math.max(0, waitedMs) / 1000} s for it`, { kind: 'store' });

/** Hides a Logon's values in an error or problem about it (see #admit). */
interface Mask {
  error(error: unknown): unknown;
  problem(problem: Problem): Problem;
}

const ref = (connection: { readonly id: string; readonly peer: Peer }): ConnectionRef => ({ connectionId: connection.id, peer: connection.peer });

export class FixServer<C = unknown> implements Server<{}, C> {
  readonly #net: NetServer;
  readonly #options: ListenOptions<{}, C>;
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #settings: ServerSettings;
  /** Live sessions, by CompID pair. */
  readonly #sessions = new Map<string, FixSession<C>>();
  /** CompID pairs whose Logon is being admitted. */
  readonly #admitting = new Set<string>();
  readonly #handlerEntries: HandlerEntry<C>[] = [];
  readonly #waiters = new Set<Waiter>();
  readonly #connections = new Map<Socket, Connection<C>>();
  /** Open connections per IP address. */
  readonly #perAddress = new Map<string, number>();
  /** Open connections that have no session yet. */
  #waitingForLogon = 0;
  /** close() was called: Logons are refused and new connections closed. */
  #closing = false;
  readonly #feed: ConnectionFeed;

  constructor(sockets: SocketServerFactory, options: ListenOptions<{}, C>, settings: ServerSettings) {
    this.#options = options;
    this.#store = options.store ?? memoryStore();
    this.#clock = options.clock ?? systemClock;
    this.#settings = settings;
    this.#feed = new ConnectionFeed(this.#clock, options.onHandlerError);
    const net = sockets(tcp => this.#connection(tcp));
    this.#net = net;
    // Once listening, a server socket error (say, running out of file descriptors) is an 'error' entry
    // without a connection, never left without a listener. Before that, listen() itself rejects with it.
    net.on('error', error => { if (net.listening) this.#feed.error(undefined, error); });
  }

  /** Start listening; rejects with the listening socket's error (the port is taken, say). */
  open(port: number, host: string | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#net.once('error', reject);
      this.#net.listen(port, host, () => {
        this.#net.off('error', reject);
        resolve();
      });
    });
  }

  get port(): number {
    const address = this.#net.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  get sessions(): readonly Session<{}, C>[] {
    return [...this.#sessions.values()];
  }

  session(target: string, options: { compID?: string } = {}): Session<{}, C> | undefined {
    return this.#find(target, options.compID);
  }

  /** The live session with this counterparty (on `compID`, when given), the first to be accepted; only a logged-on one when `active`. */
  #find(target: string, compID: string | undefined, active = false): FixSession<C> | undefined {
    for (const session of this.#sessions.values()) {
      if (session.id.target !== target || (compID !== undefined && session.id.sender !== compID)) continue;
      if (!active || session.state === 'active') return session;
    }
    return undefined;
  }

  watch(fn: (entry: ConnectionEntry) => void, options: { replay?: boolean } = {}): Remove {
    const replay: ConnectionEntry[] = [];
    if (options.replay) {
      for (const connection of this.#connections.values()) {
        replay.push({ kind: 'connection', event: 'opened', connectionId: connection.id, peer: connection.peer, at: connection.at });
        const session = connection.session;
        if (session?.loggedOnAt && connection.logon) {
          replay.push({
            kind: 'connection', event: 'loggedOn', connectionId: connection.id, peer: connection.peer, at: session.loggedOnAt,
            logon: connection.logon, sessionKey: session.key,
          });
        }
      }
    }
    return this.#feed.watch(fn, replay);
  }

  whenConnected(target: string, options: { compID?: string; timeout?: Duration } = {}): Promise<Session<{}, C>> {
    return new Promise((resolve, reject) => {
      let ms: number;
      try {
        ms = toMs(options.timeout ?? '5s');
      } catch (error) {
        reject(error);   // an invalid timeout rejects; it doesn't throw out of whenConnected()
        return;
      }
      const { compID } = options;
      const already = this.#find(target, compID, true);
      if (already) {
        resolve(already);
        return;
      }
      let timer: unknown;
      const waiter: Waiter = {
        check: () => {
          const session = this.#find(target, compID, true);
          if (!session) return;
          this.#waiters.delete(waiter);
          this.#clock.clearTimeout(timer);
          resolve(session);
        },
        fail: error => {
          this.#waiters.delete(waiter);
          this.#clock.clearTimeout(timer);
          reject(error);
        },
      };
      this.#waiters.add(waiter);
      timer = this.#clock.setTimeout(() => waiter.fail(new TimeoutError(`${target} did not log on${compID === undefined ? '' : ` to ${compID}`} within ${ms} ms`, { kind: 'logon', target })), ms);
    });
  }

  /** Handle a message type on every session, current and future (a live set of removers, kept up to date as sessions arrive and close). */
  on(msgType: string, handler: Handler<{}, C>): Remove {
    const entry: HandlerEntry<C> = { msgType, handler, removers: new Map() };
    this.#handlerEntries.push(entry);
    for (const session of this.#sessions.values()) entry.removers.set(session, session.on(msgType, handler));
    return remover(() => {
      const index = this.#handlerEntries.indexOf(entry);
      if (index >= 0) this.#handlerEntries.splice(index, 1);
      for (const remove of entry.removers.values()) remove();
      entry.removers.clear();
    });
  }

  /**
   * Stop accepting, log every session out, close. From the moment it's called, a Logon is refused
   * ('Server shutting down') and a new connection is closed at once. Resolves once every connection
   * has closed, so their 'closed' entries come first.
   */
  async close(): Promise<void> {
    this.#closing = true;
    const stopped = new Promise<void>(resolve => this.#net.close(() => resolve()));
    for (const waiter of [...this.#waiters]) waiter.fail(new FIXStateError('Server closed'));
    await Promise.all([...this.#sessions.values()].map(session => session.logout('Server shutting down')));
    // A socket leaves #connections on its 'close' event, so every one still here has yet to close.
    const open = [...this.#connections.keys()];
    const closed = open.map(socket => new Promise<void>(resolve => socket.once('close', () => resolve())));
    for (const socket of open) socket.destroy();
    await Promise.all([stopped, ...closed]);
  }

  /**
   * A TCP connection opened (for TLS, before its handshake). From here it counts toward the limits, is in
   * the feed, and has limits.logonTimeout to log on. Returns what to do once it is ready for FIX (or its
   * TLS handshake failed), or undefined when it was closed at once.
   */
  #connection(tcp: Socket): OpenedConnection | undefined {
    if (this.#closing) {
      tcp.on('error', () => undefined);
      tcp.destroy();
      return undefined;
    }
    const connection: Connection<C> = { id: randomUUID(), tcp, peer: { address: tcp.remoteAddress ?? '', port: tcp.remotePort ?? 0 }, at: this.#clock.now() };
    const { address } = connection.peer;
    const fromAddress = this.#perAddress.get(address) ?? 0;
    const overLimit = fromAddress >= this.#settings.connectionsPerAddress ? `Too many connections from ${address}`
      : this.#waitingForLogon >= this.#settings.pendingLogons ? 'Too many connections waiting to log on'
      : undefined;
    this.#connections.set(tcp, connection);
    this.#perAddress.set(address, fromAddress + 1);
    this.#waitingForLogon++;
    let waiting = true;
    const stopWaiting = () => {
      if (!waiting) return;
      waiting = false;
      this.#waitingForLogon--;
    };
    tcp.on('error', () => undefined);
    const maxMessageSize = this.#settings.maxMessageSize;
    const splitter = new FrameSplitter({ maxMessageSize });
    const received: Uint8Array[] = [];
    let receivedBytes = 0;
    let reported = false;
    /** The bytes read before a session took over, reported once (redacted). */
    const report = () => {
      if (reported || receivedBytes === 0) return;
      reported = true;
      if (!this.#feed.watched) return;
      const bytes = Buffer.concat(received);
      const rules = this.#settings.redaction;
      this.#emit(connection, { event: 'received', bytes: rules ? redactBytes(bytes, rules, PRE_LOGON_DATA_TAGS, { wire: true }) : bytes });
    };
    this.#emit(connection, { event: 'opened', at: connection.at });
    tcp.on('close', () => {
      stopWaiting();
      const left = (this.#perAddress.get(address) ?? 1) - 1;
      if (left > 0) this.#perAddress.set(address, left);
      else this.#perAddress.delete(address);
      this.#connections.delete(tcp);
      report();
      connection.closed = true;
      this.#emit(connection, connection.session ? { event: 'closed', sessionKey: connection.session.key } : { event: 'closed' });
    });
    if (overLimit) {
      // No Logon has been read: just close.
      this.#reject(connection, { code: 'ConnectionLimit', text: overLimit, action: 'Disconnected' });
      tcp.destroy();
      return undefined;
    }
    /** The socket FIX is read from: the TCP socket, or for TLS, the TLS socket once its handshake is done. */
    let fix: Socket | undefined;
    // The backstop against a connection that never completes a Logon (including one refused pre-session,
    // and a TLS handshake that never finishes): it stays armed until a session actually attaches, or the
    // socket closes on its own.
    const logonTimer = this.#clock.setTimeout(() => {
      if (connection.session) return;
      report();
      const seconds = this.#settings.logonTimeoutMs / 1000;
      if (fix === undefined) {
        this.#reject(connection, { code: 'LogonTimeout', text: `No TLS handshake within ${seconds} s`, action: 'Disconnected' });
        tcp.destroy();
        return;
      }
      // The Logon was read (accept() or the store still busy with it): a Logout says why we close.
      if (connection.logon && !connection.rejected) {
        // One that waited for the store to settle the last session of its counterparty: an 'error' entry says so first,
        // with how long it waited (the time its connection had to log on, less what had passed when the wait began).
        const since = connection.waitingForStoreSince;
        if (since !== undefined) {
          this.#feed.error(ref(connection), storeNotSettled(connection.logon.SenderCompID, this.#settings.logonTimeoutMs - (since - connection.at.getTime())));
        }
        this.#refuse(fix, connection, connection.logon, 'Logon timed out', 'LogonTimeout');
        return;
      }
      this.#reject(connection, { code: 'LogonTimeout', text: `No Logon within ${seconds} s`, action: 'Disconnected' });
      fix.destroy();
    }, this.#settings.logonTimeoutMs);
    tcp.on('close', () => this.#clock.clearTimeout(logonTimer));

    const plainPort = this.#options.tls === undefined;
    const serve = (socket: Socket) => {
      const onData = (chunk: Buffer) => {
        const firstChunk = receivedBytes === 0;
        received.push(chunk);
        receivedBytes += chunk.length;
        if (firstChunk && plainPort && chunk[0] === TLS_HANDSHAKE) {
          report();
          this.#reject(connection, TLS_ON_PLAIN_PORT);
          socket.destroy();
          return;
        }
        const first = splitter.push(chunk).find(frame => frame.valid);
        if (!first) {
          // H-2: the pre-Logon buffer is bounded by maxMessageSize, but only up to the Logon frame —
          // once it's found we stop counting (and stop reading altogether, see below).
          if (receivedBytes > maxMessageSize) {
            report();
            this.#reject(connection, { code: 'MessageTooLarge', text: `No Logon within the first ${maxMessageSize} bytes`, action: 'Disconnected' });
            socket.destroy();
          }
          return;
        }
        // Pause reads the instant the Logon is found, so a slow accept() (or store.load) never has to
        // fight an unbounded pile of post-Logon bytes arriving on this same buffer; whatever pipelined bytes
        // already arrived are handed to the session intact once it attaches.
        socket.off('data', onData);
        socket.pause();
        report();
        const buffered = Buffer.concat(received);
        received.length = 0;
        void this.#admit(socket, connection, first.bytes).then(created => {
          if (!created) return;   // refused, or the socket/CompID vanished mid-check; logonTimer remains armed
          this.#clock.clearTimeout(logonTimer);
          connection.session = created;
          stopWaiting();
          if (socket.destroyed) {   // closed in the instant between #admit resolving and here: end the session, or it blocks its CompID
            created.linkClosed();
            return;
          }
          try {
            created.attach(socketLink(socket, created));
            // Resume before feeding what's buffered, so a pause the session asks for while taking it in holds.
            socket.resume();
            created.receiveBytes(buffered);
          } catch (error) {
            this.#failToStart(socket, connection, created, error);
          }
        }, error => {
          // Anything else that failed before a session existed: still refused, with a Logout once a Logon was read.
          this.#feed.error(ref(connection), error);
          if (connection.logon) {
            this.#refuse(socket, connection, connection.logon, 'Logon refused');
            return;
          }
          this.#reject(connection, { code: 'LogonRefused', text: 'Logon refused', action: 'Disconnected' });
          socket.destroy();
        });
      };
      socket.on('data', onData);
    };
    return {
      ready: socket => {
        // Closed, or rejected by the logon timeout, while its TLS handshake finished.
        if (connection.closed || connection.rejected || tcp.destroyed) {
          socket.destroy();
          return;
        }
        if (socket !== tcp) socket.on('error', () => undefined);
        fix = socket;
        serve(socket);
      },
      // The listening socket closes the connection (see tlsServer).
      failed: error => this.#reject(connection, handshakeProblem(error, this.#options.tls?.handshakeTimeout ?? this.#settings.logonTimeoutMs)),
    };
  }

  /**
   * The session was created but couldn't be started on its socket: an 'error' entry, 'rejected' unless
   * it already logged on (a manual session is active at once), and the session and socket are closed,
   * so 'closed' follows. Never throws.
   */
  #failToStart(socket: Socket, connection: Connection<C>, session: FixSession<C>, error: unknown): void {
    try {
      this.#feed.error(ref(connection), error);
      if (session.state !== 'active') this.#reject(connection, { code: 'LogonRefused', text: 'Logon refused', action: 'Disconnected' });
    } catch {
      // Building the entry failed (a clock that throws, say): the connection is still closed below.
    }
    try {
      session.close();
    } catch (closeError) {
      this.#feed.error(ref(connection), closeError);
    }
    socket.destroy();
  }

  /**
   * The pre-session checks. Returns the new session, or undefined after refusing/abandoning the connection.
   * Once the Logon is read, an error or refusal text about it is masked before the feed or onHandlerError
   * sees it, where it quotes a hidden value of the Logon (its Password, say); the Logout keeps the text as written.
   */
  async #admit(socket: Socket, connection: Connection<C>, logonBytes: Uint8Array): Promise<FixSession<C> | undefined> {
    const beginString = /^8=([^\x01]+)\x01/.exec(Buffer.from(logonBytes).toString('latin1'))?.[1] ?? '';
    // A Logon is a session message: its version's session layer reads it, whatever application messages the session will carry.
    // The custom dictionary extends the versions this server serves (listen() checked it against each); a Logon of any other
    // version is read with the standard session layer and refused, which the custom fields may not fit.
    const served = isVersion(beginString) && this.#settings.versions.includes(beginString);
    const listenDict = resolveSessionLayer(beginString, served ? this.#options.dictionary : undefined);
    const { fields } = parseFrame(logonBytes, { dataTags: listenDict.dataTags });
    const logon = inspectMessage(fields, listenDict).message;
    const rules = this.#settings.redaction;
    const mask: Mask = rules
      ? { error: error => maskError(error, logon, rules, listenDict), problem: problem => maskProblem(problem, logon, rules, listenDict) }
      : { error: error => error, problem: problem => problem };
    try {
      return await this.#check(socket, connection, beginString, logon, fields, mask);
    } catch (error) {
      throw mask.error(error);
    }
  }

  /** #admit's checks on a Logon that was read (`fields` are its frame's, as they came); `mask` hides its values in what the feed is given. */
  async #check(socket: Socket, connection: Connection<C>, beginString: string, logon: MessageObject, fields: readonly RawField[], mask: Mask): Promise<FixSession<C> | undefined> {
    if (logon.MsgType !== 'Logon') {
      this.#reject(connection, { code: 'NotLoggedOn', text: `The first message must be a Logon, not ${String(logon.MsgType)}`, action: 'Disconnected' });
      socket.destroy();
      return undefined;
    }
    const target = typeof logon.SenderCompID === 'string' ? logon.SenderCompID : '';
    const addressed = typeof logon.TargetCompID === 'string' ? logon.TargetCompID : '';
    connection.logon = { BeginString: beginString, SenderCompID: target, TargetCompID: addressed };
    if (!target) {
      this.#reject(connection, { code: 'RequiredTagMissing', text: 'The Logon has no SenderCompID', action: 'Disconnected' });
      socket.destroy();
      return undefined;
    }
    const { compIDs } = this.#settings;
    const logonIds = connection.logon;
    const refuse = (text: string, code: Problem['code'] = 'LogonRefused'): undefined => this.#refuse(socket, connection, logonIds, text, code, mask);
    /** The connection closed, or was refused (by the logon timeout), while we waited. */
    const gone = () => socket.destroyed || connection.rejected === true;
    const shuttingDown = () => this.#closing;
    if (shuttingDown()) return refuse('Server shutting down');
    if (!isVersion(beginString) || !this.#settings.versions.includes(beginString)) return refuse(`BeginString ${beginString} is not supported`);
    if (beginString === FIXT11) {
      // Under FIXT.1.1 the Logon says which application messages the session will carry: once, and as FIX writes it.
      const named = fields.filter(field => field.tag === DEFAULT_APPL_VER_ID_TAG).map(field => field.value);
      const version = applVerIDProblem(logon.DefaultApplVerID, named);
      if (version) return refuse(version.text);
    }
    if (!compIDs.includes(addressed)) {
      return refuse(`TargetCompID ${String(logon.TargetCompID)} is not ${compIDs.length === 1 ? compIDs[0] : `one of ${compIDs.join(', ')}`}`);
    }
    const pair = pairKey(addressed, target);
    if (this.#sessions.has(pair) || this.#admitting.has(pair)) return refuse(`${target} is already logged on`);
    if (this.#sessions.size + this.#admitting.size >= this.#settings.maxSessions) {
      return refuse(`Too many sessions (limit ${this.#settings.maxSessions})`, 'ConnectionLimit');
    }
    this.#admitting.add(pair);
    try {
      // accept() must never lock a CompID out forever if it hangs — race it against the socket closing
      // (which the logon timer above will eventually force, if nothing else does). If accept() settles
      // later anyway, its result is simply ignored (we've already moved on).
      const verdict = this.#options.accept ? await this.#raceAgainstClose(socket, this.#safeAccept(connection, logon, mask)) : true;
      if (gone()) return undefined;   // closed, or timed out, while accept() was pending
      if (shuttingDown()) return refuse('Server shutting down');
      if (typeof verdict === 'string') return refuse(verdict);
      if (verdict !== true) {
        // Checked at run time: untyped callers can return anything.
        const problem = acceptOptionsProblem(verdict, this.#settings.heartbeat);
        if (problem !== undefined) {
          this.#feed.error(ref(connection), mask.error(new RangeError(problem)));
          return refuse('Logon refused');
        }
      }
      const settings: AcceptOptions<C> = verdict === true ? {} : verdict as AcceptOptions<C>;
      const range = heartbeatRange(settings.heartbeat, this.#settings.heartbeat, 'accept() heartbeat');
      const heartBtInt = logon.HeartBtInt;
      if (typeof heartBtInt === 'number' && (heartBtInt < range.min || heartBtInt > range.max)) {
        return refuse(`HeartBtInt ${heartBtInt} is outside ${range.min} to ${range.max} s`);
      }
      const store = settings.store ?? this.#store;
      // One local for the dictionary definition, so the session's dictionary and the store context's
      // dictionary (handed to store.load and every append) can never diverge.
      const custom = settings.dictionary ?? this.#options.dictionary;
      const memory = settings.memory ?? this.#options.memory;
      const storeContext: StoreContext = { history: historyLimits(memory), ...(custom ? { dictionary: custom } : {}) };
      // The last session with this counterparty may have closed with records its store has yet to keep:
      // loaded before them, this one would begin from sequence numbers they are about to change.
      const handingOver = lastSessionSettled(store, { version: beginString, sender: addressed, target });
      if (handingOver) {
        // Noted on the connection while the wait lasts, so that the logon timeout can say what its Logon waited for.
        connection.waitingForStoreSince = this.#clock.now().getTime();
        let inTime: boolean | undefined;
        try {
          inTime = await this.#settledInTime(socket, handingOver, this.#settings.storeTimeoutMs);
        } finally {
          delete connection.waitingForStoreSince;
        }
        if (inTime === undefined) return undefined;
        // Refused meanwhile, when the time it had to log on ended: that refusal is the one its counterparty was given,
        // and the feed was told then that it waited for the store.
        if (gone()) return undefined;
        if (!inTime) {
          this.#feed.error(ref(connection), storeNotSettled(target, this.#settings.storeTimeoutMs));
          this.#reject(connection, STORE_UNAVAILABLE);
          socket.destroy();
          return undefined;
        }
        if (shuttingDown()) return refuse('Server shutting down');
      }
      // Raced against the socket closing, like accept(): a load that never settles must not hold this
      // CompID pair (or a maxSessions slot) once the logon timeout has closed the connection.
      const load = Promise.resolve()
        .then(() => store.load({ version: beginString, sender: addressed, target }, storeContext))
        .then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
      const outcome = await this.#raceAgainstClose(socket, load);
      if (outcome === undefined) {
        // Closed, or timed out, during store.load: register nothing, but a store failure that arrives
        // later is still worth an error entry.
        void load.then(late => { if (!late.ok) this.#feed.error(ref(connection), mask.error(late.error)); });
        return undefined;
      }
      if (!outcome.ok) {
        this.#feed.error(ref(connection), mask.error(outcome.error));
        this.#reject(connection, STORE_UNAVAILABLE);
        socket.destroy();
        return undefined;
      }
      if (gone()) return undefined;
      const loaded = outcome.value;
      if (shuttingDown()) return refuse('Server shutting down');
      const manual = settings.manual ?? this.#options.manual;
      const session = new FixSession<C>({
        config: engineConfig({
          version: beginString, sender: addressed, target, role: 'acceptor',
          ...(manual === undefined ? {} : { manual }),
          logonTimeout: this.#settings.logonTimeoutMs / 1000,
          logoutTimeout: this.#settings.logoutTimeoutS,
        }),
        dictionary: resolveDictionary(beginString, custom),
        store,
        storeContext,
        clock: this.#clock,
        loaded,
        maxMessageSize: this.#settings.maxMessageSize,
        processingTimeoutMs: this.#settings.processingTimeoutMs,
        storeTimeoutMs: this.#settings.storeTimeoutMs,
        connection: { id: connection.id, peer: connection.peer, at: connection.at },
        ...(settings.context === undefined ? {} : { context: settings.context }),
        ...(this.#options.onHandlerError === undefined ? {} : { onHandlerError: this.#options.onHandlerError }),
        ...(memory === undefined ? {} : { memory }),
        ...(this.#options.redact === undefined ? {} : { redact: this.#options.redact }),
      });
      this.#register(pair, session, connection);
      return session;
    } finally {
      this.#admitting.delete(pair);
    }
  }

  /** Track a new session: server handlers, the registry, and its loggedOn (or rejected) entry. */
  #register(key: string, session: FixSession<C>, connection: Connection<C>): void {
    for (const entry of this.#handlerEntries) entry.removers.set(session, session.on(entry.msgType, entry.handler));
    this.#sessions.set(key, session);
    session.active.then(() => {
      if (connection.logon) this.#emit(connection, { event: 'loggedOn', at: session.loggedOnAt ?? this.#clock.now(), logon: connection.logon, sessionKey: session.key });
      for (const waiter of [...this.#waiters]) waiter.check();
    }, (error: unknown) => {
      // The session refused the Logon itself (a MsgSeqNum too low, say): the connection never logged on.
      // A connection lost mid-logon wasn't refused: its 'closed' entry says what happened.
      if (error instanceof FIXLogonError && error.reason.by !== 'network') {
        this.#reject(connection, error.reason.problem ?? { code: 'LogonRefused', text: error.reason.text, action: 'Disconnected' });
      }
    });
    void session.closed.then(() => {
      if (this.#sessions.get(key) === session) this.#sessions.delete(key);
      for (const entry of this.#handlerEntries) entry.removers.delete(session);   // stop tracking a closed session
    });
  }

  /**
   * Refuse a connection whose Logon was read: its 'rejected' entry, then a Logout saying why.
   * A refused peer must not hold the socket open forever. Write the Logout without our FIN: a normal
   * engine reads it and closes, which closes ours too. A peer that doesn't (allowHalfOpen, or gone quiet)
   * is reset after peerClose.waitMs, giving the Logout time to arrive first. No FIN before the reset:
   * once our FIN is out, some stacks (macOS) never deliver the later RST to a half-open peer.
   */
  #refuse(socket: Socket, connection: Connection<C>, logon: LogonIds, text: string, code: Problem['code'] = 'LogonRefused', mask?: Mask): undefined {
    const problem: Problem = { code, text, action: 'LoggedOut' };
    this.#reject(connection, mask ? mask.problem(problem) : problem);
    if (socket.destroyed) return undefined;
    let frame: Uint8Array;
    try {
      // Sent as the CompID they addressed, so their engine accepts it.
      frame = this.#logoutFrame(logon.BeginString, logon.TargetCompID || this.#settings.compIDs[0]!, logon.SenderCompID, text);
    } catch (error) {
      this.#feed.error(ref(connection), mask ? mask.error(error) : error);
      socket.destroy();
      return undefined;
    }
    let destroyed = false;
    const destroyOnce = () => {
      if (destroyed) return;
      destroyed = true;
      // The TCP socket: a TLS socket can't be reset itself.
      connection.tcp.resetAndDestroy();
    };
    // A real timer, not the clock: this wait is about the OS socket, not session time.
    const timer = setTimeout(destroyOnce, peerClose.waitMs);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
    socket.write(frame);
    return undefined;
  }

  /** A connection was refused: its 'rejected' entry, once and never after it closed, with the Logon's CompIDs when one was read. */
  #reject(connection: Connection<C>, problem: Problem): void {
    if (connection.rejected || connection.closed) return;
    connection.rejected = true;
    this.#emit(connection, connection.logon ? { event: 'rejected', problem, logon: connection.logon } : { event: 'rejected', problem });
  }

  #emit(connection: Connection<C>, details: EntryDetails): void {
    if (!this.#feed.watched) return;
    const { at, ...rest } = details;
    this.#feed.emit({ kind: 'connection', connectionId: connection.id, peer: connection.peer, at: at ?? this.#clock.now(), ...rest } as ConnectionEntry);
  }

  /**
   * accept() must never throw/reject out of #admit, or crash the process (H-5): a failure refuses the Logon.
   * Its error goes to the connection feed (and onHandlerError).
   */
  async #safeAccept(connection: Connection<C>, logon: MessageObject, mask: Mask): Promise<unknown> {
    try {
      return await this.#options.accept!(logon, connection.peer);
    } catch (error) {
      this.#feed.error(ref(connection), mask.error(error));
      return 'Logon refused';
    }
  }

  /**
   * Wait for the sessions handing over to a store: true once they have settled, false once `ms` have
   * passed on the clock first, undefined once the socket has closed first. Whichever ends the wait,
   * its timer is cleared and nothing is kept for it.
   */
  #settledInTime(socket: Socket, wait: HandOverWait, ms: number): Promise<boolean | undefined> {
    return new Promise(resolve => {
      let timer: unknown;
      const finish = (outcome: boolean | undefined) => {
        this.#clock.clearTimeout(timer);
        socket.off('close', onClose);
        wait.forget();
        resolve(outcome);
      };
      const onClose = () => finish(undefined);
      if (socket.destroyed) {
        finish(undefined);
        return;
      }
      timer = this.#clock.setTimeout(() => finish(false), ms);
      socket.once('close', onClose);
      void wait.settled.then(() => finish(true));
    });
  }

  /** Race a promise against the socket closing: if the socket closed first (socket.destroyed), this resolves undefined and any later settlement of `promise` is simply ignored. */
  #raceAgainstClose<T>(socket: Socket, promise: Promise<T>): Promise<T | undefined> {
    return new Promise(resolve => {
      let settled = false;
      const onClose = () => {
        if (settled) return;
        settled = true;
        resolve(undefined);
      };
      socket.once('close', onClose);
      promise.then(
        value => {
          if (settled) return;
          settled = true;
          socket.off('close', onClose);
          resolve(value);
        },
        () => {
          if (settled) return;
          settled = true;
          socket.off('close', onClose);
          resolve(undefined);
        },
      );
    });
  }

  /** A Logout sent before any session exists, to explain a refusal. Sent as the CompID they addressed, so their engine accepts it. */
  #logoutFrame(beginString: string, sender: string, target: string, text: string): Uint8Array {
    const dict = resolveSessionLayer(beginString);
    return encodeMessage({
      MsgType: 'Logout', BeginString: beginString, SenderCompID: sender, TargetCompID: target,
      MsgSeqNum: 1, SendingTime: this.#clock.now(), Text: text,
    }, dict, { version: beginString });
  }
}

/** Accept FIX connections on a port (0 = any free port). Options are checked first (see options.ts): a mistake is a RangeError. */
export async function listen<D = {}, C = unknown>(port: number, options: ListenOptions<D, C>): Promise<Server<D, C>> {
  const settings = serverSettings(options);
  const sockets = options.tls === undefined ? plainServer : tlsServer(options.tls, settings.logonTimeoutMs);
  const server = new FixServer<C>(sockets, options, settings);
  await server.open(port, options.host);
  return server;
}
