import type { DictionaryDef } from '../dictionary/define.ts';
import type { Duration } from '../util/duration.ts';
import type { MessageObject } from '../wire/message.ts';
import type { MemoryOptions } from './session.ts';
import type { CloseReason, ConnectionEntry, Entry, Peer, Remove, RouteFn, SeqNums, SessionId, Store } from './types.ts';

/** Called for each message of a type; `session` is the session it arrived on. */
export type Handler<D = {}, C = unknown> = (message: MessageObject, session: Session<D, C>) => unknown;

/**
 * A FIX session, from connect() or a server. `D` is the custom dictionary's
 * definition (what defineDictionary() was given), matching the spec's
 * `Session<D>`; messages aren't typed by it yet. `C` is the type of `context`.
 */
export interface Session<D = {}, C = unknown> {
  readonly id: SessionId;
  /**
   * `${version}:${sender}:${target}`: a label for logs and metrics. Not guaranteed
   * unique when a CompID contains ':'; look sessions up by `id`.
   */
  readonly key: string;
  /**
   * This connection's id. For a server session, the id the server's connection
   * feed uses for this connection; a client session's id is local.
   */
  readonly connectionId: string;
  /** The other end of the TCP connection. */
  readonly peer: Peer | undefined;
  readonly connectedAt: Date;
  /** When the Logon handshake completed; undefined until then. In manual mode, when the session was created. */
  readonly loggedOnAt: Date | undefined;
  /** What accept() returned as `context` for this counterparty; undefined when it gave none, and for connect(). */
  readonly context: C | undefined;
  readonly state: 'loggingOn' | 'active' | 'loggingOut' | 'closed';
  /** Negotiated heartbeat interval, in seconds. */
  readonly heartbeat: number;
  readonly seqNums: SeqNums;
  /** Everything sent, received, noticed and failed, oldest first; bounded by `memory`. */
  readonly history: readonly Entry[];
  readonly closed: Promise<CloseReason>;
  on(msgType: string, handler: Handler<D, C>): Remove;
  messages(msgType?: string): AsyncIterableIterator<MessageObject>;
  next(msgType: string, options?: { where?: Readonly<Record<string, unknown>>; timeout?: Duration }): Promise<MessageObject>;
  send(msgType: string, fields?: Readonly<Record<string, unknown>>): Promise<MessageObject>;
  encode(msgType: string, fields?: Readonly<Record<string, unknown>>): Uint8Array;
  sendBytes(bytes: Uint8Array | string): Promise<void>;
  setSeqNums(seqNums: { next?: number; expected?: number }): void;
  outgoing(fn: RouteFn): Remove;
  incoming(fn: RouteFn): Remove;
  watch(fn: (entry: Entry) => void): Remove;
  logout(text?: string): Promise<CloseReason>;
  close(): void;
}

/** A listening FIX server. `D` and `C` as for Session. */
export interface Server<D = {}, C = unknown> {
  readonly port: number;
  readonly sessions: readonly Session<D, C>[];
  /**
   * The live session with this counterparty. compID: the one of our CompIDs it
   * logged on to; without it, the first of its sessions to be accepted.
   */
  session(target: string, options?: { compID?: string }): Session<D, C> | undefined;
  /** Wait for this counterparty to be logged on (to `compID`, when given). Default timeout 5s. */
  whenConnected(target: string, options?: { compID?: string; timeout?: Duration }): Promise<Session<D, C>>;
  /** Handle a message type on every session, current and future. */
  on(msgType: string, handler: Handler<D, C>): Remove;
  /** Follow every connection, including ones that never become a session. replay: first report the connections already open. */
  watch(fn: (entry: ConnectionEntry) => void, options?: { replay?: boolean }): Remove;
  /**
   * Log everyone out and stop listening. From the moment it's called, a Logon is refused ('Server
   * shutting down') and a new connection is closed. Resolves once every connection has closed.
   */
  close(): Promise<void>;
}

/** Settings for one counterparty, returned by accept(). Anything left out uses the listen() options. */
export interface AcceptOptions<C = unknown> {
  /** Allowed HeartBtInt range, in seconds; a missing end comes from listen(). */
  readonly heartbeat?: { readonly min?: number; readonly max?: number };
  readonly manual?: boolean;
  readonly store?: Store;
  readonly memory?: MemoryOptions;
  /** Custom fields for this counterparty's session. */
  readonly dictionary?: { readonly definition: DictionaryDef };
  /** Any value, kept as session.context. */
  readonly context?: C;
}
