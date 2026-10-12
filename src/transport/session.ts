import { randomUUID } from 'node:crypto';
import type { IndexedDictionary } from '../dictionary/index.ts';
import { FIXLogonError, FIXStateError, TimeoutError } from '../errors.ts';
import { fillHeader, fillMessage } from '../session/context.ts';
import { initialState, step } from '../session/engine.ts';
import { resendPlan, type PlannedSend } from '../session/resend.ts';
import type { Action, EngineConfig, EngineEvent, EngineState, Problem } from '../session/types.ts';
import type { Duration } from '../util/duration.ts';
import type { Version } from '../version.ts';
import { buildFrame, parseFrame } from '../wire/frame.ts';
import { fromMessage, inspectMessage, type DecodeProblem, type MessageObject } from '../wire/message.ts';
import { FrameSplitter, type SplitFrame } from '../wire/splitter.ts';
import type { Handler, Session } from './api.ts';
import { Arrivals } from './arrivals.ts';
import { ListQueue, TwoStepChain, type SecondStep } from './chain.ts';
import type { Clock } from './clock.ts';
import { encodeMessage, tryEncodeMessage } from './codec.ts';
import { Inbox } from './inbox.ts';
import { historyLimits, SessionLog } from './log.ts';
import { hasRedactedValue, maskError, maskProblem, redactEntry, redaction, redactText, type Redaction } from './redact.ts';
import { errorEntry } from './report.ts';
import { entrySize, UNSIZED_ENTRY_BYTES } from './size.ts';
import { originalSeq } from './store-common.ts';
import { remover, type CloseReason, type Entry, type Link, type Peer, type Remove, type RouteFn, type SeqNums, type SessionId, type Store, type StoreContext, type StoreRecord } from './types.ts';

/**
 * Memory bounds for one session, counted in wire bytes. Counts default to 1,000;
 * bytes default to 1 MiB (4 MiB for outgoingBytes and storeBytes, 4 KiB for pendingBytes). The heap holds
 * about 5–15× the wire bytes per history entry, more inside a live session; the
 * default memoryStore keeps its own copy of up to 1,000 entries per session.
 */
export interface MemoryOptions {
  /** History entries kept; the oldest are dropped. It sizes `session.history` and what the store's load() returns; a resend is read from the store, as far back as the store reaches. */
  readonly history?: number;
  /** History bytes kept (an entry without wire bytes counts as 256). */
  readonly historyBytes?: number;
  /**
   * Undelivered messages kept for next()/messages(); the oldest are dropped. Past half as many
   * received and not yet processed, the session takes in no more and reads pause, as at
   * `pendingBytes`: what arrives meanwhile waits as bytes, bounded by `inboxBytes`. Also how
   * many messages a messages() iterator may fall behind (past that it throws once, then ends).
   */
  readonly inbox?: number;
  /**
   * The same limits as `inbox`, in bytes. It is also the most a session may have received and
   * not processed: the bytes it holds and has not yet taken in as messages, and the messages
   * taken in and not yet processed, together. Past it the session closes ('Too many unprocessed
   * incoming messages'). A socket is paused as soon as bytes are held, so a session on one
   * holds one read of it (up to 64 KiB) beside what it has taken in (`pendingBytes` and one
   * message): keep this above the three together, as the default is, or one full read closes
   * the session. A link that goes on delivering after it was told to pause reaches it whatever
   * it is.
   */
  readonly inboxBytes?: number;
  /**
   * Bytes of messages sent and not yet written; past this the session closes ('Outgoing queue over
   * N bytes': the counterparty is not reading, or messages are sent faster than they can be written).
   * A message counts from when it is sent until it is written, and waits here until the store has
   * kept it, so a slow store fills this too. Each message to be written counts once, at the size
   * it has on the wire: one an outgoing route changes counts as the route left it, the messages a
   * route makes of one count each (the one they were made of does not), and one a route drops
   * stops counting. The messages a route makes of a copy sent again for a resend are not counted:
   * each is written before the next is read. This is also what a session can hold for a
   * counterparty that sends requests and does not read the answers: nothing closes a session that
   * stays just under it. A burst of sends in one turn counts here and, as records, toward
   * `storeBytes`: a program that sends more than 4 MiB at once raises both. Default 4 MiB.
   */
  readonly outgoingBytes?: number;
  /**
   * Bytes of records handed to the store and not yet kept, of received and of sent messages
   * alike; past this the session closes ('Store is not keeping up'). A sent message's record is
   * handed over as soon as its outgoing routes have run, so a burst of sends in one turn counts
   * here whole, as well as toward `outgoingBytes`: against a store that waits, a burst larger
   * than this closes the session whatever `outgoingBytes` allows. For a large burst raise this
   * together with `outgoingBytes`. The records of sent messages pause no reads, however many
   * wait: only what was received does (see `pendingBytes`), past `pendingBytes` or past half of
   * this, whichever is less. Default 4 MiB.
   */
  readonly storeBytes?: number;
  /**
   * How much a session takes in from its counterparty at a time: the bytes of received messages
   * not yet processed, plus the records of what was received that the store has not yet kept
   * (an entry counts as its wire bytes, or 256 without any). Past this many bytes the session
   * takes in no more and reads pause; below a quarter of it the session takes in again, and
   * reads resume once it holds no bytes it has not looked at. (When half of `storeBytes` is
   * less than this, that is the pause point instead, and a quarter of `storeBytes` the resume
   * point.) Only what was received counts, because only that falls while reads are paused. The
   * records of what the session sends pause nothing: they are bounded by `storeBytes`, past
   * which the session closes, and by `outgoingBytes`. So a session whose own messages wait for
   * a slow store goes on reading, and goes on hearing its counterparty's Heartbeats. Nor does
   * what waits to be written to the network count, so a session never stops reading because its
   * counterparty has.
   *
   * What is read from the socket (up to 64 KiB at a time) is held as bytes, and messages are
   * taken from them only up to this amount: the rest waits, in the order received, until what
   * was taken is processed and kept. One message is always taken when nothing waits, so a
   * message larger than this is still processed, by itself. Between two such slices of one read
   * the event loop turns, whatever the store. A store that keeps at once (a memoryStore) makes
   * no session wait; with one, this is how much of one counterparty's burst a server works
   * through before its other sessions, its timers and its store get their turn.
   *
   * While a session holds bytes it has not taken in, or has paused reads, its counterparty's
   * silence is its own doing: it sends no TestRequest and closes no one for a heartbeat timeout
   * (the counterparty's Heartbeat may be among what is unread), does not ask again for a resend
   * it awaits (the answer may be there too; the requests already made still count), and goes on
   * sending its own Heartbeats. Silence, and the wait for the resend, count again from when it
   * reads again. A message's SendingTime is judged against the time the session read its last
   * byte from the link, not the time it is processed: the wait in the session is not the
   * message's age. The wait before the session read it is: with reads paused a session holds
   * about one read of a socket, the rest of what was sent waits in the socket's buffers, and a
   * session more than 120 s behind a counterparty that goes on sending logs it out ('SendingTime
   * is N s from our clock'). Below the pause point none of this applies: messages
   * that wait at an incoming route while reads are not paused are not heard until they are
   * processed, and their sender is asked and given up as a silent one is.
   *
   * What this bounds, and what it does not:
   * - for what it has received, a session holds at most about this much taken in, one message
   *   past it, and one read of the socket as bytes. So a server holds, for received work, about
   *   sessions x (this + 64 KiB + one message), and `limits.maxSessions` bounds the sessions:
   *   there is no other limit across sessions. What Node and the operating system keep for a
   *   paused socket is beside that;
   * - what a program sends in answer waits as records up to `storeBytes` and as messages up to
   *   `outgoingBytes`, for each session: a counterparty that sends requests and does not read
   *   the answers has them queued up to `outgoingBytes` (4 MiB), and is closed only past it;
   * - messages a program's own handlers are still working on are not counted: handlers are not
   *   waited for.
   * Bytes held when a session closes are dropped, as received messages not yet processed are:
   * none was recorded, so the counterparty is asked for them again by their MsgSeqNums.
   * Default 4 KiB.
   */
  readonly pendingBytes?: number;
}

export interface SessionOptions<C = unknown> {
  readonly config: EngineConfig;
  readonly dictionary: IndexedDictionary;
  readonly store: Store;
  readonly clock: Clock;
  /** What the store held for this session. */
  readonly loaded: { readonly history: readonly Entry[]; readonly next: number; readonly expected: number };
  readonly maxMessageSize?: number;
  readonly memory?: MemoryOptions;
  /** Also given every error recorded as an 'error' entry (handlers, routes, watchers, internal failures). Default: recorded only. */
  readonly onHandlerError?: (error: unknown) => void;
  /** Handed to the store with every append. */
  readonly storeContext?: StoreContext;
  /** Values hidden in history, watch() and the store: tag numbers for every message, false for none. Default: credentials (see redact.ts). */
  readonly redact?: readonly number[] | false;
  /** The connection this session runs on. Default: a new id, no peer, connected now. */
  readonly connection?: { readonly id: string; readonly peer?: Peer; readonly at: Date };
  /** What accept() gave as context for this counterparty. */
  readonly context?: C;
  /** Close the session once received messages have waited this long with no progress (an incoming route or the store holding them up). Default: never. */
  readonly processingTimeoutMs?: number;
  /** Close the session once one store write (one append() call), or the store's next entry for a resend, has taken this long. Checked on the once-a-second tick, so it can fire up to 1 s late. Default 10 s. */
  readonly storeTimeoutMs?: number;
}

const TICK_MS = 1000;
const DEFAULT_INBOX_ENTRIES = 1_000;
const DEFAULT_INBOX_BYTES = 1_048_576;
const DEFAULT_OUTGOING_BYTES = 4 * 1024 * 1024;
const DEFAULT_STORE_BYTES = 4 * 1024 * 1024;
const DEFAULT_PENDING_BYTES = 4 * 1024;
const DEFAULT_STORE_TIMEOUT_MS = 10_000;
/** ResendRequests that may wait for their turn to be answered, beside the one being answered; one more closes the session. */
const MAX_RESENDS_WAITING = 16;
/**
 * Entries read from the store for one resend before the answer lets the event loop turn. A store
 * that answers from memory would otherwise keep timers and every other session waiting for a whole
 * range. An entry takes a few microseconds when it is left out and about ten when it is checked for
 * a resend, so 256 of them hold the loop for a millisecond or two, and a turn every 256 adds
 * nothing that can be measured to an answer of 100,000 entries.
 */
const RESEND_ENTRIES_PER_TURN = 256;
/** The most records, and the most bytes of entries, one append() is given: a record larger than that goes alone. */
const STORE_LIST_RECORDS = 256;
const STORE_LIST_BYTES = 1024 * 1024;
/** Read backpressure: pause once pending incoming work passes half the inbox budget, or what was received and is not finished passes half of storeBytes; resume once it falls below a quarter (of pendingBytes too, which is passed whole). */
const PAUSE_AT = 0.5;
const RESUME_BELOW = 0.25;

/**
 * Sessions that are closing or closed and whose store has not yet settled every record they made:
 * for each store object, by session id, how many there are, and who waits for the last of them. A
 * session that begins while one is here would load sequence numbers the records still to come are
 * about to change, and its own records would reach the store among theirs. Kept by store object:
 * two store objects over the same files know nothing of each other's sessions.
 */
interface HandingOver { sessions: number; readonly waiters: Set<() => void> }
const handingOver = new WeakMap<Store, Map<string, HandingOver>>();
const idKey = (id: SessionId): string => JSON.stringify([id.version, id.sender, id.target]);

/** A wait for the sessions handing over to a store: see lastSessionSettled. */
export interface HandOverWait {
  /** Settles (it never rejects) once every one of them has had every record it made settled by the store. */
  readonly settled: Promise<void>;
  /** Give the wait up: nothing is kept for it from then on, though the sessions may never settle. */
  forget(): void;
}

/**
 * A wait for every session for `id` that has closed, or is closing, to have every record it made
 * settled by `store`; undefined when there is none to wait for. Whoever begins a session waits for
 * it before load(), for no longer than storeTimeout, and calls forget() when it stops waiting for
 * any other reason: a store call that never returns must not hold something for every Logon that
 * came meanwhile.
 */
export function lastSessionSettled(store: Store, id: SessionId): HandOverWait | undefined {
  const waiters = handingOver.get(store)?.get(idKey(id))?.waiters;
  if (!waiters) return undefined;
  let wake!: () => void;
  const settled = new Promise<void>(resolve => { wake = resolve; });
  waiters.add(wake);
  return { settled, forget: () => { waiters.delete(wake); } };
}

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * A record on its way to the store, and how it moves the sequence numbers the store holds. Its own
 * sequence numbers are worked out when the store is given it, in store order, from the ones the record
 * before it left (see #seqNumsFor). Until then, the step that made it may still fill these in.
 */
interface PendingRecord {
  readonly at: Date;
  readonly entry?: Entry;
  newEpoch?: boolean;
  /**
   * For a record that begins a new epoch at a reset (a Logon with ResetSeqNumFlag=Y): the sequence
   * numbers already in force when the reset action ran. By then #adopt has applied the engine's whole
   * new state, including any reply that same step sends — so at an acceptor replying to a reset Logon,
   * this is next 2 (the reply already numbered), not next 1. A crash between the received Logon's
   * record and the sent reply's record only leaves MsgSeqNum 1 unsent; it is gap-filled on resend and
   * never reused.
   */
  epochStart?: SeqNums;
  /** `next` as it stood when this record took its place on the outgoing queue (a message sent, or setSeqNums). */
  next?: number;
  /** `expected` as a received message's step, or setSeqNums, left it. */
  expected?: number;
  /** When `expected` was set, counted in setSeqNums calls (see #seqNumsFor). */
  expectedStamp?: number;
  /** For the record of something received: the bytes it counts toward the read pause until the store has settled it. */
  received?: number;
}

/** A message transmitted by #transmit: the message itself and a promise that rejects if routing or writing it failed. */
interface Sent {
  readonly message: MessageObject;
  readonly done: Promise<void>;
}

/**
 * A FIX session at runtime: the shell around the pure engine. Bytes come in
 * through receiveBytes(); the engine's actions are carried out here (encode,
 * route, write, record, deliver). The network is reached only through a Link.
 */
export class FixSession<C = unknown> implements Session<{}, C> {
  readonly id: SessionId;
  readonly key: string;
  readonly connectionId: string;
  readonly peer: Peer | undefined;
  readonly connectedAt: Date;
  readonly context: C | undefined;
  readonly active: Promise<void>;
  readonly closed: Promise<CloseReason>;

  readonly #config: EngineConfig;
  readonly #dict: IndexedDictionary;
  readonly #store: Store;
  readonly #storeContext: StoreContext;
  readonly #clock: Clock;
  readonly #onHandlerError: ((error: unknown) => void) | undefined;
  readonly #redaction: Redaction | undefined;
  readonly #splitter: FrameSplitter;
  readonly #active = deferred<void>();
  readonly #closed = deferred<CloseReason>();
  readonly #inboxLimit: number;
  readonly #inboxByteLimit: number;
  /** Reads pause once what was received and is not finished passes this many bytes (memory.pendingBytes, or half of memory.storeBytes when that is less), and resume below #resumeBelow (a quarter of pendingBytes, or of storeBytes then). */
  readonly #pauseAbove: number;
  readonly #resumeBelow: number;
  #state: EngineState;
  #link: Link | undefined;
  #tickTimer: unknown;
  #closeReason: CloseReason | undefined;
  /** Set once the link has actually been ended (immediately for an abrupt close, or after the bounded wait for a graceful one). #route/#write refuse to do anything once this is true. */
  #linkEnded = false;
  /** What was received and is not finished is past the pause point, and has not yet fallen below the resume point (see #updateBackpressure). */
  #incomingPaused = false;
  /** The intake stopped before it had looked at every byte received: more frames may wait among them (see #takeIn). */
  #heldBack = false;
  /** Whether the link has been told to pause; avoids calling pause()/resume() redundantly. */
  #readsPaused = false;
  /** The turn of the event loop the intake waits for before it takes in more; undefined while it waits for none. */
  #turn: NodeJS.Immediate | undefined;
  /**
   * When the bytes held arrived (session clock, ms): a message waits as bytes for as long as the
   * session is behind, and its SendingTime is judged against when its last byte arrived, to the
   * second for bytes held from 128 different seconds or fewer (see Arrivals for what is kept).
   */
  readonly #arrivals = new Arrivals();
  #lastProblem: Problem | undefined;
  /** The sequence numbers were reset by a Logon of ours, not yet transmitted: its record begins a new epoch, with these. */
  #newEpoch: SeqNums | undefined;
  /** The sequence numbers the last record given to the store holds, and when its `expected` was set (see #seqNumsFor). */
  #recorded: SeqNums & { readonly expectedStamp: number };
  /** setSeqNums calls that changed something, so far. */
  #setCalls = 0;
  /** Sequence resets that brought `next` down, so far: the answer to a ResendRequest taken before the last of them stops. */
  #resets = 0;
  #isActive = false;
  #loggedOnAt: Date | undefined;

  readonly #log: SessionLog;
  readonly #handlers = new Map<string, Set<Handler<{}, C>>>();
  readonly #watchers = new Set<(entry: Entry) => void>();
  readonly #outgoing: RouteFn[] = [];
  readonly #incoming: RouteFn[] = [];
  readonly #inbox: Inbox;
  /** The size to credit to the next #deliver call, set just before dispatching the 'received' event that will trigger it. */
  #pendingInboundSize: number | undefined;
  #inChain: Promise<void> = Promise.resolve();
  /**
   * What is sent, in the order it was numbered, each in two steps: first its routes, and its record
   * handed to the store, without waiting for the message before it to be written; then, once its
   * record is kept and every message before it has been written, its write. A stuck route holds up
   * the first steps, a stuck link or store the second.
   */
  readonly #out: TwoStepChain;
  /** Records on their way to the store, in order: those that wait while one append() is in flight go in the next, as one list. */
  readonly #storeQueue: ListQueue<PendingRecord>;
  /** Frames pushed onto #inChain but not yet fully processed (a stuck incoming route holds these up). */
  #pendingIncoming = 0;
  #pendingIncomingBytes = 0;
  /** Of #pendingIncomingBytes, the frame being processed once its own record is made: from then it counts toward the read pause as that record. */
  #recordedIncomingBytes = 0;
  /** Bytes of the records of what was received (messages, and the problems found in them) that the store has not yet settled. */
  #receivedUnkeptBytes = 0;
  readonly #processingTimeoutMs: number | undefined;
  readonly #storeTimeoutMs: number;
  /** When the append() now in flight began (session clock, ms); undefined while none is. */
  #storeSince: number | undefined;
  /** Settles once the session has closed and its store has settled every record it made (see #finish). */
  readonly #storeSettled = deferred<void>();
  /** The session has closed and its store has settled every record it made: it is given no more. */
  #storeOver = false;
  /** Sent messages waiting for the store to keep them, and a resend waiting for the store to keep what was queued before it or to give its next entry: each one's call gives it up, once the link has ended. */
  readonly #storeWaits = new Set<() => void>();
  /** ResendRequests queued to be answered and not yet begun. */
  #resendsWaiting = 0;
  /** When the store was last asked for the next entry of a resend and has not yet answered (session clock, ms); undefined while it is not being waited for. */
  #resendReadSince: number | undefined;
  /** Received frames processed, and store writes completed, so far; what the tick last saw of each, and when it last saw progress (or nothing waiting). */
  #incomingDone = 0;
  #storeDone = 0;
  #incomingSeen = 0;
  #storeSeen = 0;
  #progressAt: number;

  /** Handlers, next()/messages() listeners and watchers run only once a whole step's actions have been carried out, so a handler that sends doesn't cut ahead of that step's own replies. */
  #dispatchDepth = 0;
  #flushing = false;
  readonly #deferredQueue: (() => void)[] = [];

  constructor(options: SessionOptions<C>) {
    const { config } = options;
    // connect() and listen() only build sessions for supported versions.
    this.id = { version: config.version as Version, sender: config.sender, target: config.target };
    this.key = `${config.version}:${config.sender}:${config.target}`;
    this.connectionId = options.connection?.id ?? randomUUID();
    this.peer = options.connection?.peer;
    this.connectedAt = options.connection?.at ?? options.clock.now();
    this.context = options.context;
    this.#config = config;
    this.#dict = options.dictionary;
    this.#store = options.store;
    this.#storeContext = options.storeContext ?? {};
    this.#clock = options.clock;
    this.#processingTimeoutMs = options.processingTimeoutMs;
    this.#storeTimeoutMs = options.storeTimeoutMs ?? DEFAULT_STORE_TIMEOUT_MS;
    this.#progressAt = this.#now();
    this.#onHandlerError = options.onHandlerError;
    this.#redaction = redaction(options.redact);
    const memory = options.memory ?? {};
    this.#inboxLimit = memory.inbox ?? DEFAULT_INBOX_ENTRIES;
    this.#inboxByteLimit = memory.inboxBytes ?? DEFAULT_INBOX_BYTES;
    const pendingLimit = memory.pendingBytes ?? DEFAULT_PENDING_BYTES;
    const storeLimit = memory.storeBytes ?? DEFAULT_STORE_BYTES;
    const byStore = storeLimit * PAUSE_AT < pendingLimit;
    this.#pauseAbove = byStore ? storeLimit * PAUSE_AT : pendingLimit;
    this.#resumeBelow = (byStore ? storeLimit : pendingLimit) * RESUME_BELOW;
    this.#log = new SessionLog(historyLimits(memory));
    this.#inbox = new Inbox({ entries: this.#inboxLimit, bytes: this.#inboxByteLimit }, {
      clock: this.#clock,
      isApplication: message => this.#isApplication(message),
      onError: error => this.#reportError(error),
    });
    const outgoingLimit = memory.outgoingBytes ?? DEFAULT_OUTGOING_BYTES;
    this.#out = new TwoStepChain({
      limit: outgoingLimit,
      onOverLimit: () => this.#failSafely(new Error(`Outgoing queue over ${outgoingLimit} bytes: the counterparty is not reading, or messages are being sent faster than they can be written`)),
      onError: error => this.#failSafely(error),
      report: error => this.#reportError(error),
    });
    this.#storeQueue = new ListQueue<PendingRecord>({
      limit: storeLimit,
      maxItems: STORE_LIST_RECORDS,
      maxBytes: STORE_LIST_BYTES,
      keep: records => this.#keep(records),
      onOverLimit: () => this.#failSafely(new Error('Store is not keeping up')),
      // Once closed there's no one left to call #fail for; record it (but not in the store that just failed).
      onError: error => (this.#closeReason ? this.#reportError(error, undefined, false) : this.#failSafely(error)),
      onQueued: () => this.#updateBackpressure(),
      onSettled: () => {
        this.#storeDone++;
        this.#updateBackpressure();
      },
      report: error => this.#reportError(error),
    });
    this.#splitter = new FrameSplitter(options.maxMessageSize === undefined ? {} : { maxMessageSize: options.maxMessageSize });
    this.#state = initialState(config, this.#now(), { next: options.loaded.next, expected: options.loaded.expected });
    this.#recorded = { next: options.loaded.next, expected: options.loaded.expected, expectedStamp: 0 };
    // Shown redacted: an old store, or one written with redact:false, may hold real values.
    this.#log.restore(options.loaded.history.map(entry => this.#redacted(entry)));
    // Manual mode starts in phase 'active' without the engine ever emitting an 'active' action.
    if (this.#state.phase === 'active') {
      this.#isActive = true;
      this.#loggedOnAt = this.#clock.now();
      this.#active.resolve();
    }
    this.active = this.#active.promise;
    this.closed = this.#closed.promise;
    this.active.catch(() => undefined);   // callers that never await active must not see an unhandled rejection
  }

  // ─── Reading state ────────────────────────────────────────────────────────

  get state(): 'loggingOn' | 'active' | 'loggingOut' | 'closed' {
    const phase = this.#state.phase;
    return phase === 'connected' ? 'loggingOn' : phase;
  }
  get heartbeat(): number { return this.#state.heartbeat; }
  get seqNums(): SeqNums { return { next: this.#state.next, expected: this.#state.expected }; }
  get history(): readonly Entry[] { return this.#log.history; }
  get loggedOnAt(): Date | undefined { return this.#loggedOnAt; }
  /** Test-only: the bytes of messages sent and not yet written, as counted toward memory.outgoingBytes. */
  get outgoingBytesForTests(): number { return this.#out.pendingBytes; }
  /** Test-only: how many undelivered messages are waiting in the inbox for next(). */
  get inboxSizeForTests(): number { return this.#inbox.size; }
  /** Test-only: bytes received and not yet split into messages. */
  get heldBytesForTests(): number { return this.#splitter.length; }
  /** Test-only: the buffers that hold those bytes (how many, and the bytes they have room for), and how many times of arrival are kept for them. */
  get heldBuffersForTests(): { readonly count: number; readonly capacity: number; readonly arrivals: number } { return { ...this.#splitter.buffers, arrivals: this.#arrivals.marks }; }
  /** Test-only: whether the link has been told to pause. */
  get readsPausedForTests(): boolean { return this.#readsPaused; }
  /** Test-only: what was received and is not finished, as counted toward memory.pendingBytes. */
  get unfinishedBytesForTests(): number { return this.#pendingIncomingBytes - this.#recordedIncomingBytes + this.#receivedUnkeptBytes; }

  // ─── Wiring (used by the transport) ──────────────────────────────────────

  attach(link: Link): void {
    this.#link = link;
    this.#scheduleTick();
  }

  start(): void {
    this.#dispatch({ type: 'start' });
  }

  /**
   * Bytes from the link. They are held as bytes, and the intake takes messages from them only as
   * far as the session can finish them (see #takeIn). Held bytes and received messages not yet
   * processed together may not pass memory.inboxBytes: a link that goes on delivering after
   * pause(), or has none, closes the session there.
   */
  receiveBytes(chunk: Uint8Array): void {
    if (this.#closeReason) return;
    this.#splitter.add(chunk);
    this.#noteArrival(chunk.length);
    if (this.#splitter.length + this.#pendingIncomingBytes > this.#inboxByteLimit) {
      this.#failSafely(new Error('Too many unprocessed incoming messages'));
      return;
    }
    this.#takeIn();
  }

  /** Note when `bytes` more arrived. A clock that fails notes no time: those bytes are judged by the next that arrive, or when they are processed. */
  #noteArrival(bytes: number): void {
    let at: number | undefined;
    try {
      at = this.#now();
    } catch {
      // Judged as said above.
    }
    this.#arrivals.note(bytes, at);
  }

  /**
   * The intake: split messages off the bytes held and put each on the processing chain, in the
   * order received, until reads are to pause (what was received and is not finished is past the
   * pause point). The rest stays as bytes. When nothing is waiting one message is always taken,
   * whatever its size, so a message larger than the pause point is still processed.
   *
   * Once a call has taken messages and left bytes it has not looked at, no call takes more until
   * the event loop has turned, though the count may fall to the resume point at once (a store that
   * keeps in the same turn): store completions, timers and the other sessions get their turn
   * between two slices of one read. The turn is setImmediate, not the session's clock: this is
   * scheduling, not time. It is not unref'd: the event loop runs an unref'd immediate only when
   * something else wakes it, a heartbeat later on a quiet server. So a turn holds the process, for
   * no longer than the bytes held last: none is asked for when every byte has been looked at, a
   * call that finds reads paused takes nothing and asks for none (it runs again when the count
   * falls to the resume point, see #updateBackpressure), and a session that closes drops its own.
   * A call that comes while the turn is awaited takes nothing, and reads stay paused for the bytes
   * held back, whatever the count has fallen to.
   */
  #takeIn(): void {
    if (this.#turn !== undefined) {
      this.#syncReads();
      return;
    }
    let taken = false;
    for (;;) {
      if (this.#incomingPaused) {
        this.#heldBack = this.#splitter.length > 0;
        break;
      }
      const frame = this.#splitter.take();
      if (!frame) {
        this.#heldBack = false;
        break;
      }
      taken = true;
      this.#pendingIncoming++;
      this.#pendingIncomingBytes += frame.bytes.length;
      // Past the pause point this pauses the link, and the next round of the loop stops.
      this.#updateBackpressure();
      const size = frame.bytes.length;
      const arrived = this.#arrivals.take(size);
      this.#inChain = this.#inChain
        .then(() => this.#receiveFrame(frame, arrived))
        .catch(error => this.#failSafely(error))
        .finally(() => {
          this.#incomingDone++;
          this.#pendingIncoming--;
          this.#pendingIncomingBytes -= size;
          this.#recordedIncomingBytes = 0;
          this.#updateBackpressure();
        });
    }
    if (this.#heldBack && taken) {
      this.#turn = setImmediate(() => {
        this.#turn = undefined;
        this.#takeIn();
      });
    }
    this.#syncReads();
  }

  /**
   * Have the link pause while the session is not taking in what it delivers, and resume when it is:
   * while what it has not finished is past the pause point, and while the intake holds bytes it has
   * not looked at, which outlasts the first once the count has fallen and the turn is still to come.
   */
  #syncReads(): void {
    const hold = this.#incomingPaused || this.#heldBack;
    if (hold === this.#readsPaused) return;
    this.#readsPaused = hold;
    try {
      if (hold) this.#link?.pause?.();
      else this.#link?.resume?.();
    } catch (error) {
      // Not persisted: a link whose pause()/resume() always throws must not feed its own store
      // entries back into the backlog that trips pause/resume in the first place.
      this.#reportError(error, undefined, false);
    }
  }

  /**
   * Read backpressure: a slow incoming route or a slow store (ours) must not
   * kill a healthy session just because processing lags behind arrival, and
   * a server must not hold megabytes for each of many sessions it cannot keep
   * up with. One count pauses the link: what was received and is not finished,
   * that is, the bytes of received messages not yet processed plus the
   * records of what was received that the store has not yet kept. Reads pause
   * once it passes pendingBytes, or half of storeBytes when that is less, and
   * resume below a quarter of pendingBytes, or of storeBytes then.
   *
   * Only a count that drains while reads are paused may pause reads. With
   * reads paused nothing more is received, so what is counted can only be
   * processed and kept (the store keeps records in the order they were made,
   * so ours queued later do not hold a received one back), and reads resume.
   * The records of what we send ourselves are therefore not counted, at
   * either point: a program that keeps sending while its store is behind
   * would hold such a count up for as long as it sends, the session would not
   * read its counterparty's Heartbeats, and it would take a live counterparty
   * for dead. Our own records are bounded by storeBytes, past which the
   * session closes, and by outgoingBytes.
   *
   * What waits to be written to the network is not counted either: two
   * sessions that each stopped reading until the other had read would both
   * wait for ever.
   *
   * Unprocessed received messages past half the inbox (in number or in
   * bytes) pause reads as well, and then reads resume only once those are
   * below a quarter too.
   *
   * While reads are to pause the intake takes in nothing more (see #takeIn),
   * and the link stays paused for as long as the intake holds bytes it has
   * not looked at. Those drain while reads are paused too: the intake runs
   * again when the count falls below the resume point, and after the turn of
   * the event loop it asked for. The beginning of a message, with its end
   * still to come, pauses nothing: it would wait for bytes the pause keeps
   * away. The hard limits still apply to a link with no pause/resume, or to
   * bytes that arrive after pause was asked for: memory.inboxBytes in
   * receiveBytes, and the store queue's.
   */
  #updateBackpressure(): void {
    const received = this.#pendingIncomingBytes - this.#recordedIncomingBytes + this.#receivedUnkeptBytes;
    const overHalf = received > this.#pauseAbove
      || this.#pendingIncoming > this.#inboxLimit * PAUSE_AT
      || this.#pendingIncomingBytes > this.#inboxByteLimit * PAUSE_AT;
    const underQuarter = received < this.#resumeBelow
      && this.#pendingIncoming < this.#inboxLimit * RESUME_BELOW
      && this.#pendingIncomingBytes < this.#inboxByteLimit * RESUME_BELOW;
    if (!this.#incomingPaused && overHalf) this.#incomingPaused = true;
    else if (this.#incomingPaused && underQuarter) this.#incomingPaused = false;
    else return;
    // Below the resume point with bytes held: they come before anything the link has still to deliver.
    if (!this.#incomingPaused && this.#heldBack) this.#takeIn();
    else this.#syncReads();
  }

  linkClosed(error?: Error): void {
    if (this.#closeReason) return;
    this.#dispatch({ type: 'disconnected' });
    this.#finish({ by: 'network', text: error?.message ?? 'Connection closed' });
  }

  // ─── Sending ─────────────────────────────────────────────────────────────

  async send(msgType: string, fields: Readonly<Record<string, unknown>> = {}): Promise<MessageObject> {
    if (this.#closeReason) throw new FIXStateError(`Can't send ${msgType}: the session is closed`);
    this.encode(msgType, fields);                       // any mistake throws here, before a sequence number is used
    const sent = this.#dispatch({ type: 'send', msgType, fields });
    const last = sent.at(-1);
    if (!last) throw new FIXStateError(`${msgType} was not sent`);
    await last.done;
    return last.message;
  }

  encode(msgType: string, fields: Readonly<Record<string, unknown>> = {}): Uint8Array {
    const filled = fillMessage(this.#state, this.#config, msgType, fields, this.#now()).fields;
    const { fields: raw, framing } = fromMessage(msgType, filled, this.#dict, this.#encodeContext());
    return buildFrame(raw, framing);
  }

  async sendBytes(bytes: Uint8Array | string): Promise<void> {
    if (this.#closeReason) throw new FIXStateError("Can't send bytes: the session is closed");
    const data = typeof bytes === 'string' ? Buffer.from(bytes, 'latin1') : bytes;
    const next = this.#state.next;
    const done = this.#out.push(data.length, async () => {
      if (this.#linkEnded) throw new FIXStateError('The session is closed');
      const parsed = parseFrame(data, { dataTags: this.#dict.dataTags });
      if (parsed.errors.length > 0) return () => this.#write(data);   // not a frame: written as it is, in its turn, and not recorded
      const message = inspectMessage(parsed.fields, this.#dict).message;
      const entry = this.#redacted({ kind: 'message', direction: 'out', at: this.#clock.now(), message, bytes: data });
      const kept = this.#keptBeforeSending(this.#queueRecord({ at: entry.at, entry, next }), message);
      return async () => {
        await kept;
        await this.#write(data);
        this.#show(entry);
      };
    });
    await done;
  }

  /**
   * Kept in the store as a record of its own, after the messages already queued to be sent (they
   * were numbered before it); bringing `next` down to 1 begins a new epoch there.
   */
  setSeqNums(seqNums: { next?: number; expected?: number }): void {
    const before = this.seqNums;
    this.#dispatch({ type: 'setSeqNums', ...seqNums });
    const after = this.seqNums;
    if (after.next === before.next && after.expected === before.expected) return;
    this.#setCalls++;
    const record: PendingRecord = {
      at: this.#clock.now(), next: after.next, expected: after.expected, expectedStamp: 2 * this.#setCalls,
      ...(before.next > 1 && after.next === 1 ? { newEpoch: true } : {}),
    };
    void this.#out.push(0, async () => { void this.#queueRecord(record); });
  }

  logout(text?: string): Promise<CloseReason> {
    if (!this.#closeReason) this.#dispatch(text === undefined ? { type: 'logout' } : { type: 'logout', text });
    return this.closed;
  }

  close(): void {
    if (this.#closeReason) return;
    this.#dispatch({ type: 'disconnected' });
    this.#finish({ by: 'us', text: 'Closed' });
  }

  // ─── Receiving ───────────────────────────────────────────────────────────

  on(msgType: string, handler: Handler<{}, C>): Remove {
    let set = this.#handlers.get(msgType);
    if (!set) this.#handlers.set(msgType, (set = new Set()));
    set.add(handler);
    return remover(() => set.delete(handler));
  }

  /**
   * Subscribes immediately (not on the first next()). Its own queue is bounded (count and bytes); past
   * that it ends by throwing once, then reports done. return() unsubscribes. Not redacted: like next()
   * and every handler registered with on(), it delivers messages as received/sent; redact only hides
   * values in what's recorded (history, the store) or shown (this session's own watch()).
   */
  messages(msgType?: string): AsyncIterableIterator<MessageObject> {
    return this.#inbox.messages(msgType);
  }

  /** Not redacted: see messages(). */
  next(msgType: string, options: { where?: Readonly<Record<string, unknown>>; timeout?: Duration } = {}): Promise<MessageObject> {
    return this.#inbox.next(msgType, options);
  }

  outgoing(fn: RouteFn): Remove {
    this.#outgoing.push(fn);
    return remover(() => this.#outgoing.splice(this.#outgoing.indexOf(fn), 1));
  }

  incoming(fn: RouteFn): Remove {
    this.#incoming.push(fn);
    return remover(() => this.#incoming.splice(this.#incoming.indexOf(fn), 1));
  }

  watch(fn: (entry: Entry) => void): Remove {
    this.#watchers.add(fn);
    return remover(() => this.#watchers.delete(fn));
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  #now(): number {
    return this.#clock.now().getTime();
  }

  /**
   * An error from a handler, route or watcher, or an internal failure: recorded as an 'error' entry (in
   * the store too, unless the store is what failed) and given to onHandlerError. When it happened while
   * handling a message, any hidden value of that message its text quotes is masked first (see
   * maskError). What onHandlerError throws is recorded as well. Never throws.
   */
  #reportError(error: unknown, during?: MessageObject, persist = true): void {
    const reported = this.#redaction && during ? maskError(error, during, this.#redaction, this.#dict) : error;
    this.#recordError(reported, during, persist);
    const handler = this.#onHandlerError;
    if (!handler) return;
    try {
      handler(reported);
    } catch (handlerError) {
      this.#recordError(this.#redaction && during ? maskError(handlerError, during, this.#redaction, this.#dict) : handlerError, during, persist);
    }
  }

  #recordError(error: unknown, during: MessageObject | undefined, persist: boolean): void {
    try {
      this.#record(errorEntry(error, this.#clock.now(), during), persist);
    } catch {
      // Recording failed too (a clock that throws, say): there's nowhere left to put it.
    }
  }

  /** #fail from within a promise callback must never itself throw and poison that chain (e.g. because the clock it reads from is having a bad moment); route any such failure through #reportError instead. */
  #failSafely(error: unknown): void {
    try {
      this.#fail(error);
    } catch (failError) {
      this.#reportError(failError);
    }
  }

  /**
   * Run one engine step and carry out its actions. Returns the messages sent, in order.
   * Handlers/listeners/watchers for this step run only once the whole (possibly nested)
   * dispatch is done. `inbound`, when this event is about a just-received message, lets any
   * 'problem' action from this very step mask that message's redacted values out of its text.
   * `record` is that message's record on its way to the store: it takes `expected` as this step
   * leaves it, before any handler runs, and begins the new epoch when the step is a reset.
   */
  #dispatch(event: EngineEvent, inbound?: MessageObject, record?: PendingRecord): Sent[] {
    this.#dispatchDepth++;
    try {
      const result = step(this.#state, this.#config, event, this.#now());
      this.#adopt(result.state);
      const sent: Sent[] = [];
      this.#carryOut(result.actions, sent, inbound, record);
      return sent;
    } finally {
      if (record) {
        record.expected = this.#state.expected;
        record.expectedStamp = 2 * this.#setCalls + 1;
      }
      this.#dispatchDepth--;
      if (this.#dispatchDepth === 0) {
        try {
          this.#flushDeferred();
        } catch (error) {
          // #flushDeferred already guards each callback; this is a last-resort net so nothing ever escapes here.
          this.#reportError(error);
        }
      }
    }
  }

  /** Queue a callback (a handler, listener or watcher) to run once the outermost dispatch finishes, so it never runs ahead of that step's own actions. */
  #defer(callback: () => void): void {
    this.#deferredQueue.push(callback);
    if (this.#dispatchDepth === 0) this.#flushDeferred();
  }

  #flushDeferred(): void {
    if (this.#flushing) return;   // an enclosing flush is already draining the queue; it will pick up anything we add
    this.#flushing = true;
    try {
      while (this.#deferredQueue.length > 0) {
        const callback = this.#deferredQueue.shift()!;
        try {
          callback();
        } catch (error) {
          this.#reportError(error);
        }
      }
    } finally {
      this.#flushing = false;
    }
  }

  #adopt(state: EngineState): void {
    const before = this.#state;
    this.#state = state;
    // A sequence reset (setSeqNums, or a Logon with ResetSeqNumFlag) moves `next` backward: a
    // ResendRequest taken before it asked for what those numbers carried then, and is not answered.
    if (state.next < before.next) this.#resets++;
  }

  #carryOut(actions: readonly Action[], sent: Sent[], inbound?: MessageObject, record?: PendingRecord): void {
    for (const action of actions) {
      switch (action.type) {
        case 'send': {
          const transmitted = this.#tryTransmit(action.msgType, action.fields);
          if (transmitted) sent.push(transmitted);
          break;
        }
        case 'resend':
          this.#queueResend(action.from, action.to);
          break;
        case 'deliver':
          this.#deliver(action.message);
          break;
        case 'reset':
          // this.seqNums already reflects the engine's whole new state (#adopt ran before #carryOut),
          // including any reply this same step sends — see epochStart. A reset this step's own received
          // message asked for begins the epoch at that message's record. Any other is ours: the Logon
          // this step sends (right after) begins it, whatever else is being received or handled just then.
          if (record) {
            record.newEpoch = true;
            record.epochStart = this.seqNums;
          } else {
            this.#newEpoch = this.seqNums;
          }
          break;
        case 'active':
          this.#isActive = true;
          this.#loggedOnAt = this.#clock.now();
          this.#active.resolve();
          break;
        case 'problem': {
          // A decode problem can quote the bad wire text of a field that should be hidden; mask it
          // using the message it was decoded from, when this problem came from processing one.
          const problem = this.#redaction && inbound ? maskProblem(action.problem, inbound, this.#redaction, this.#dict) : action.problem;
          // Only a problem that ends the session can be the reason it closed: one it carried on from is not.
          if (problem.action === 'LoggedOut' || problem.action === 'Disconnected') this.#lastProblem = problem;
          this.#record({ kind: 'problem', direction: 'in', at: this.#clock.now(), problem });
          break;
        }
        case 'disconnect': {
          // A disconnect's own text can quote the same bad wire value a decode problem from this
          // receive already did (e.g. a malformed Logon field): mask it the same way.
          const text = this.#redaction && inbound ? redactText(action.text, inbound, this.#redaction, this.#dict) : action.text;
          // A graceful, engine-decided disconnect waits (bounded) for what's already queued to go out; a transport-initiated close does not.
          this.#finish(action.by === 'us' && this.#lastProblem
            ? { by: action.by, text, problem: this.#lastProblem }
            : { by: action.by, text }, true);
          break;
        }
      }
    }
  }

  /** #transmit must never throw out of #carryOut: an encoding failure is reported, and the rest of the step still runs. */
  #tryTransmit(msgType: string, fields: Readonly<Record<string, unknown>>): Sent | undefined {
    const outgoing: MessageObject = { MsgType: msgType, ...fields };
    try {
      return this.#transmit(msgType, fields);
    } catch (error) {
      this.#reportError(error, outgoing);   // masked there, against the message that failed
      return undefined;
    }
  }

  /**
   * Answer a ResendRequest for from..to as one item of the outgoing queue: it begins once every
   * message numbered before it has been kept and written, and everything sent later waits behind it.
   * One is answered at a time and MAX_RESENDS_WAITING may wait; one more closes the session.
   */
  #queueResend(from: number, to: number): void {
    if (this.#resendsWaiting >= MAX_RESENDS_WAITING) {
      this.#failSafely(new Error('Too many ResendRequests waiting'));
      return;
    }
    this.#resendsWaiting++;
    // `next` and the resets as they stand now: what each record of the answer holds, and how the answer knows the sequences were reset under it.
    const next = this.#state.next;
    const resets = this.#resets;
    void this.#out.push(0, async before => {
      await before;
      this.#resendsWaiting--;
      await this.#resend(from, to, next, resets);
    });
  }

  /**
   * The answer to a ResendRequest, read from the store an entry at a time: an application message
   * goes again as a possible duplicate, and everything else in the range is covered by gap fills
   * (see resendPlan). Each message is routed, kept and written before the next entry is read, so the
   * answer holds one entry in memory whatever the range. The store is read only once every record
   * queued for it so far has settled, so it holds every message numbered before the request, a
   * message an outgoing route dropped included. The answer stops, sending nothing more, once the
   * session is closing or its sequences were reset. A store that fails to give an entry, or gives
   * more entries than the range holds MsgSeqNums, closes the session without a gap fill for the
   * rest: those messages may only be out of reach for a moment.
   */
  async #resend(from: number, to: number, next: number, resets: number): Promise<void> {
    const stopped = () => this.#closeReason !== undefined || this.#resets !== resets;
    if (stopped()) return;
    await this.#storeCaughtUp();
    if (stopped()) return;
    const plan = resendPlan(from, to);
    let reader: AsyncIterator<Entry> | undefined;
    /** The MsgSeqNum of the last original the store gave: the next must be higher. */
    let last = from - 1;
    /** Entries the store has given so far. */
    let given = 0;
    try {
      for (;;) {
        let step: IteratorResult<Entry>;
        try {
          reader ??= this.#store.sent(this.id, { from, to }, this.#storeContext)[Symbol.asyncIterator]();
          step = await this.#nextForResend(reader);
          if (step === null || typeof step !== 'object') throw new TypeError("The store's sent() did not give an iterator result");
        } catch (error) {
          if (stopped()) return;
          this.#resendReadFailed(error);
          return;
        }
        if (stopped()) return;
        if (step.done) break;
        // One original for each MsgSeqNum at most: a store that gives more would be read without end.
        if (++given > to - from + 1) {
          this.#resendReadFailed(new RangeError(`The store's sent() gave more entries than the ${to - from + 1} MsgSeqNums from ${from} to ${to}`));
          return;
        }
        if (given % RESEND_ENTRIES_PER_TURN === 0) {
          await new Promise<void>(resolve => { setImmediate(resolve); });
          if (stopped()) return;
        }
        const found = this.#resendable(step.value, last, to);
        if (!found) continue;
        last = found.seq;
        if (found.message && !await this.#sendPlanned(plan.next(found.seq, found.message, this.#now()), next, stopped)) return;
      }
      await this.#sendPlanned(plan.end(this.#now()), next, stopped);
    } finally {
      if (reader) this.#closeReader(reader);
    }
  }

  /** The store could not be read for a resend: its error is recorded, though not in the store that has just failed, and the session closes. */
  #resendReadFailed(error: unknown): void {
    this.#reportError(error, undefined, false);
    this.#fail(new Error('Store could not be read for a resend'));
  }

  /** Settles once every record queued for the store so far has settled, kept or not, or once the link has ended. */
  #storeCaughtUp(): Promise<void> {
    return new Promise<void>(resolve => {
      const done = () => {
        this.#storeWaits.delete(done);
        resolve();
      };
      this.#untilLinkEnds(done);
      void this.#storeQueue.idle.then(done);
    });
  }

  /**
   * What an entry the store gave for a resend is: nothing, when it is not an original (a message we
   * sent, not marked PossDupFlag) numbered above `last` and no higher than `to`, whatever else it
   * is; otherwise its MsgSeqNum, and its message unless that must not or cannot go again (one of
   * its values is the mask of a hidden value, whatever this session hides, or it no longer encodes)
   * and so is treated as missing. Never throws.
   */
  #resendable(entry: unknown, last: number, to: number): { seq: number; message?: MessageObject } | undefined {
    try {
      const seq = originalSeq(entry as Entry);
      if (seq === undefined || seq <= last || seq > to) return undefined;
      const { message } = entry as Extract<Entry, { kind: 'message' }>;
      if (hasRedactedValue(message)) return { seq };
      return tryEncodeMessage(message, this.#dict, this.#encodeContext()) ? { seq, message } : { seq };
    } catch {
      return undefined;
    }
  }

  /**
   * Send what a resend plan gives, one at a time: the header filled against the session's state as
   * it is now, then the routes, the store and the socket, as for any other message; each record
   * holds `next` as it stood when the ResendRequest was taken. False once the session is closing or
   * its sequences were reset: nothing more is sent.
   */
  async #sendPlanned(planned: readonly PlannedSend[], next: number, stopped: () => boolean): Promise<boolean> {
    for (const { msgType, fields } of planned) {
      if (stopped()) return false;
      const filled = fillHeader(this.#state, this.#config, fields, this.#now());
      this.#adopt(filled.state);
      let encoded: { message: MessageObject; bytes: Uint8Array };
      try {
        encoded = this.#encode(msgType, filled.fields);
      } catch (error) {
        this.#reportError(error, { MsgType: msgType, ...filled.fields });
        continue;
      }
      // Written before the next is read, so what a route makes of it is not held: nothing to count.
      await (await this.#route(encoded.message, encoded.bytes, next, undefined, () => {}))();
    }
    return !stopped();
  }

  /**
   * The store's next entry for a resend. The wait is timed (see the tick: longer than storeTimeout
   * closes the session), and given up once the link has ended.
   */
  #nextForResend(reader: AsyncIterator<Entry>): Promise<IteratorResult<Entry>> {
    return new Promise<IteratorResult<Entry>>((resolve, reject) => {
      const giveUp = () => reject(new FIXStateError('The session closed while the store was being read for a resend'));
      const done = () => {
        this.#storeWaits.delete(giveUp);
        this.#resendReadSince = undefined;
      };
      this.#untilLinkEnds(giveUp);
      this.#resendReadSince = this.#now();
      let asked: Promise<IteratorResult<Entry>>;
      try {
        asked = Promise.resolve(reader.next());
      } catch (error) {
        asked = Promise.reject(error);
      }
      asked.then(
        step => { done(); resolve(step); },
        (error: unknown) => { done(); reject(error); },
      );
    });
  }

  /** Tell the store a resend's read is over, however it ended. Not waited for: a store that has stopped answering must not hold the outgoing queue. */
  #closeReader(reader: AsyncIterator<Entry>): void {
    try {
      Promise.resolve(reader.return?.()).catch((error: unknown) => this.#reportError(error, undefined, false));
    } catch (error) {
      this.#reportError(error, undefined, false);
    }
  }

  /** The wire bytes of a message about to be sent, and the message as they decode. Throws when it does not encode. */
  #encode(msgType: string, fields: Readonly<Record<string, unknown>>): { message: MessageObject; bytes: Uint8Array } {
    const { fields: raw, framing } = fromMessage(msgType, fields, this.#dict, this.#encodeContext());
    const bytes = buildFrame(raw, framing);
    return { message: inspectMessage(parseFrame(bytes, { dataTags: this.#dict.dataTags }).fields, this.#dict).message, bytes };
  }

  /** Encode now (so sequence numbers and order are fixed), then route and write in order. Returns a promise that rejects if routing or writing this particular message failed (including because the session closed before its turn came). */
  #transmit(msgType: string, fields: Readonly<Record<string, unknown>>): Sent {
    const { message, bytes } = this.#encode(msgType, fields);
    // `next` as it stands once this message is numbered: what its record holds, however long it waits for its turn.
    const next = this.#state.next;
    // A Logon that resets the sequences carries the new epoch to its own record, whatever else reaches the store before it.
    const epoch = msgType === 'Logon' ? this.#newEpoch : undefined;
    if (epoch) this.#newEpoch = undefined;
    const done = this.#out.push(bytes.length, (_before, carry) => this.#route(message, bytes, next, epoch, carry));
    return { message, done };
  }

  /**
   * The first step of sending a message: its outgoing routes, then a record handed to the store for
   * each message they give (or for the message itself, when they drop it). What it gives is the
   * second step: each of those messages written once its record is kept, and shown in history. The
   * second step is for the caller to run when every message numbered before this one has been
   * written. `next` as it stood once the message was numbered; `epoch`, when the message begins a
   * new epoch. Until its routes have run the message counts toward outgoingBytes as it was encoded;
   * `carry` then makes it count as what will be written instead: each message the routes gave, once,
   * at the size it has on the wire (all of them are held, encoded, until they are written), and
   * nothing when they dropped it.
   */
  async #route(message: MessageObject, bytes: Uint8Array, next: number, epoch: SeqNums | undefined, carry: (bytes: number) => void): Promise<SecondStep> {
    let beginsEpoch = epoch;
    const begin = (): { newEpoch?: boolean; epochStart?: SeqNums } => {
      const mark = beginsEpoch ? { newEpoch: true, epochStart: beginsEpoch } : {};
      beginsEpoch = undefined;
      return mark;
    };
    if (this.#linkEnded) throw closedBeforeSent(message);
    const messages = await this.#applyRoutes(this.#outgoing, [message]);
    if (this.#linkEnded) throw closedBeforeSent(message);
    if (messages.length === 0) {
      carry(0);
      const entry = this.#redacted({ kind: 'message', direction: 'out', at: this.#clock.now(), message });
      void this.#queueRecord({ at: entry.at, entry, next, ...begin() });
      return async () => { this.#show(entry); };
    }
    const queued: { readonly entry: Entry; readonly data: Uint8Array; readonly kept: Promise<void> }[] = [];
    let toWrite = 0;
    for (const item of messages) {
      if (this.#linkEnded) throw closedBeforeSent(message);
      let data: Uint8Array;
      if (item === message) {
        data = bytes;
      } else {
        try {
          data = this.#reencode(item);
        } catch (error) {
          // A route can rewrite a hidden field into something that no longer encodes (a route
          // turning Password into a number, say); the encoder's own error can quote that value.
          throw this.#redaction ? maskError(error, item, this.#redaction, this.#dict) : error;
        }
      }
      toWrite += data.length;
      // Passing outgoingBytes closes the session.
      carry(toWrite);
      if (this.#linkEnded) throw closedBeforeSent(message);
      const entry = this.#redacted({ kind: 'message', direction: 'out', at: this.#clock.now(), message: item, bytes: data });
      queued.push({ entry, data, kept: this.#keptBeforeSending(this.#queueRecord({ at: entry.at, entry, next, ...begin() }), message) });
    }
    return async () => {
      for (const { entry, data, kept } of queued) {
        // The store has it, with the sequence numbers after it, before the network does: a restart never reuses a MsgSeqNum already sent.
        await kept;
        if (this.#linkEnded) throw closedBeforeSent(message);
        await this.#write(data);
        this.#show(entry);
      }
    };
  }

  /** Run messages through a snapshot of a route list. A route that throws or rejects is reported (onHandlerError) and treated as if it had returned the message unchanged; it never closes the session. */
  async #applyRoutes(routes: readonly RouteFn[], messages: readonly MessageObject[]): Promise<MessageObject[]> {
    let current: readonly MessageObject[] = messages;
    for (const route of [...routes]) {
      const next: MessageObject[] = [];
      for (const item of current) {
        let result: MessageObject | null | readonly MessageObject[];
        try {
          result = await route(item);
        } catch (error) {
          this.#reportError(error, item);
          result = item;
        }
        next.push(...asList(result));
      }
      current = next;
    }
    return [...current];
  }

  /** `arrived`: when the frame's last byte arrived (session clock, ms), when that was noted. */
  async #receiveFrame(frame: SplitFrame, arrived?: number): Promise<void> {
    if (this.#closeReason) return;
    if (!frame.valid) {
      this.#dispatch({ type: 'garbled', error: frame.error ?? 'Invalid frame' });
      return;
    }
    const parsed = parseFrame(frame.bytes, { dataTags: this.#dict.dataTags });
    if (parsed.errors.length > 0) {
      this.#dispatch({ type: 'garbled', error: parsed.errors.join('; ') });
      return;
    }
    const inspected = inspectMessage(parsed.fields, this.#dict);
    const messages = await this.#applyRoutes(this.#incoming, [inspected.message]);
    for (const message of messages) {
      if (this.#closeReason) return;
      const original = message === inspected.message;
      const problems: readonly DecodeProblem[] = original ? inspected.problems : [];
      // From here the frame counts toward the read pause as its record, not as received and not yet processed as well.
      if (original) this.#recordedIncomingBytes = frame.bytes.length;
      const record = this.#record(original
        ? { kind: 'message', direction: 'in', at: this.#clock.now(), message, bytes: frame.bytes }
        : { kind: 'message', direction: 'in', at: this.#clock.now(), message });
      this.#pendingInboundSize = original ? frame.bytes.length : UNSIZED_ENTRY_BYTES;
      // The message's record goes to the store with `expected` as its step leaves it, and begins the
      // new epoch when the step is a reset; the store is given it only once the step is done.
      this.#dispatch({ type: 'received', message, problems, ...(arrived === undefined ? {} : { arrived }) }, message, record);
    }
  }

  #deliver(message: MessageObject): void {
    const size = this.#pendingInboundSize ?? UNSIZED_ENTRY_BYTES;
    this.#inbox.keep(message, size);
    this.#defer(() => {
      this.#inbox.notify(message, size);
      const handlers = this.#handlers.get(String(message.MsgType));
      if (!handlers) return;
      for (const handler of [...handlers]) {
        try {
          const result = handler(message, this);
          Promise.resolve(result).catch(error => this.#reportError(error, message));
        } catch (error) {
          this.#reportError(error, message);
        }
      }
    });
  }

  /**
   * Redact an entry, keep it in history, show it to watchers, and (unless `persist` is false) queue it
   * for the store. Returns its record while it waits for the store, for #receiveFrame to complete.
   */
  #record(original: Entry, persist = true): PendingRecord | undefined {
    const entry = this.#redacted(original);
    let record: PendingRecord | undefined;
    if (persist) {
      record = { at: entry.at, entry };
      void this.#queueRecord(record);
    }
    this.#show(entry);
    return record;
  }

  #redacted(entry: Entry): Entry {
    return this.#redaction ? redactEntry(entry, this.#redaction, this.#dict) : entry;
  }

  /**
   * Hand a record to the store, in order. It begins a new epoch when a reset is waiting to be marked
   * and no Logon of ours has taken it.
   * Settles once the store has it; rejects if the store failed.
   */
  #queueRecord(record: PendingRecord): Promise<void> {
    // A closed session that has handed everything over may have been followed by another for the same id (see #finish).
    if (this.#storeOver) return Promise.resolve();
    if (this.#newEpoch) {
      record.newEpoch = true;
      record.epochStart = this.#newEpoch;
      this.#newEpoch = undefined;
    }
    const size = record.entry ? entrySize(record.entry) : UNSIZED_ENTRY_BYTES;
    if (record.entry && record.entry.kind !== 'error' && record.entry.direction === 'in') {
      record.received = size;
      this.#receivedUnkeptBytes += size;
    }
    return this.#storeQueue.push(size, record);
  }

  /**
   * Give the store a list of records, in the order they were queued. Each takes its sequence numbers
   * here, in that order (see #seqNumsFor). The call is timed from here until it settles (see the tick).
   */
  async #keep(records: readonly PendingRecord[]): Promise<void> {
    const list = records.map((record): StoreRecord => ({
      at: record.at,
      ...(record.entry ? { entry: record.entry } : {}),
      seqNums: this.#seqNumsFor(record),
      ...(record.newEpoch ? { newEpoch: true } : {}),
    }));
    this.#storeSince = this.#now();
    try {
      await this.#store.append(this.id, list, this.#storeContext);
    } finally {
      this.#storeSince = undefined;
      // Before the queue reports the list settled, so the read pause is judged on what is left.
      for (const record of records) this.#receivedUnkeptBytes -= record.received ?? 0;
    }
  }

  /**
   * A record's sequence numbers as they stand at its place in store order, which is not the order
   * things happened in: a sent message waits on the outgoing queue, while a received one goes to the
   * store at once. `next` comes from the outgoing queue, in its order: a message numbered there, or
   * setSeqNums, sets it; every other record keeps the one before it. So a received message never takes
   * a `next` that setSeqNums lowered while sends numbered before it still wait. `expected` comes from
   * received messages' steps and setSeqNums, in the order they happened: a setSeqNums record that
   * reaches the store after a message received since that call leaves the message's `expected` as it
   * is (stamps: setSeqNums call k is 2k, a message received after k calls is 2k + 1). A record that
   * begins a new epoch at a reset starts from epochStart, not `#recorded`: the sequence numbers already
   * in force when the reset action ran. At an acceptor replying to a reset Logon, the engine has by
   * then numbered that reply too, so the received Logon's own record already shows next 2, not 1 — a
   * crash between that record and the sent reply's record only skips MsgSeqNum 1, which is gap-filled
   * and never reused.
   */
  #seqNumsFor(record: PendingRecord): SeqNums {
    const before = record.epochStart ? { ...record.epochStart, expectedStamp: this.#recorded.expectedStamp } : this.#recorded;
    const stamp = record.expectedStamp ?? -1;
    const takesExpected = record.expected !== undefined && stamp >= before.expectedStamp;
    this.#recorded = {
      next: record.next ?? before.next,
      expected: takesExpected ? record.expected! : before.expected,
      expectedStamp: takesExpected ? stamp : before.expectedStamp,
    };
    return { next: this.#recorded.next, expected: this.#recorded.expected };
  }

  /**
   * Wait for the store to keep a message about to be sent. Rejects as the store did, or, once the link
   * has ended while waiting, with the session closing before `message` was sent.
   */
  #keptBeforeSending(kept: Promise<void>, message: MessageObject): Promise<void> {
    const waited = new Promise<void>((resolve, reject) => {
      const giveUp = () => reject(closedBeforeSent(message));
      this.#untilLinkEnds(giveUp);
      kept.then(
        () => { this.#storeWaits.delete(giveUp); resolve(); },
        (error: unknown) => { this.#storeWaits.delete(giveUp); reject(error); },
      );
    });
    // It may reject before the message's turn to be written comes, or with no one left to wait for it (the write before it failed).
    waited.catch(() => {});
    return waited;
  }

  /**
   * Have `giveUp` called once the link has ended, unless it is taken out of #storeWaits first. When
   * the link has ended already it is called a microtask from now: handing a record to the store can
   * itself close the session (the record passes storeBytes), and whoever waits for that record is
   * registered only afterwards.
   */
  #untilLinkEnds(giveUp: () => void): void {
    if (this.#linkEnded) queueMicrotask(giveUp);
    else this.#storeWaits.add(giveUp);
  }

  /** The append() now in flight has taken storeTimeout or longer. */
  #storeTooSlow(): boolean {
    return this.#storeSince !== undefined && this.#now() - this.#storeSince >= this.#storeTimeoutMs;
  }

  /** Keep an entry in history, and show it to watchers. */
  #show(entry: Entry): void {
    this.#log.add(entry);
    this.#defer(() => {
      for (const watcher of [...this.#watchers]) {
        try {
          watcher(entry);
        } catch (error) {
          if (entry.kind !== 'error') {
            this.#reportError(error, entry.kind === 'message' ? entry.message : undefined);
            continue;
          }
          // A watcher failing on an error entry is never recorded again, or a broken watcher would loop.
          try {
            this.#onHandlerError?.(error);
          } catch {
            // Nowhere left to report it.
          }
        }
      }
    });
  }

  async #write(bytes: Uint8Array): Promise<void> {
    if (this.#linkEnded) throw new FIXStateError('The session is closed');
    if (!this.#link) throw new FIXStateError('The session has no connection');
    await this.#link.write(bytes);
  }

  #reencode(message: MessageObject): Uint8Array {
    return encodeMessage(message, this.#dict, this.#encodeContext());
  }

  /** How this session encodes: its version, and TransactTime from its clock. */
  #encodeContext(): { version: string; now: () => Date } {
    return { version: this.#config.version, now: () => this.#clock.now() };
  }

  #isApplication(message: MessageObject): boolean {
    const info = this.#dict.messageByName.get(String(message.MsgType));
    return info !== undefined && !info.admin;
  }

  /**
   * Received frames are waiting (or reads are paused) and none has finished processing for
   * processingTimeout. A store write counts as progress only while reads are paused with no received
   * frame waiting, that is, paused for the store backlog: our own outgoing messages are recorded too,
   * and must not hide received frames stuck behind a route. Handlers run after a message is delivered
   * and aren't waited for, so a handler holding a message doesn't count. Checked on the tick, so it can
   * fire up to 1 s late.
   */
  #stalled(): boolean {
    const limit = this.#processingTimeoutMs;
    if (limit === undefined) return false;
    const now = this.#now();
    const waiting = this.#pendingIncoming > 0 || this.#incomingPaused;
    const progressed = this.#incomingDone !== this.#incomingSeen
      || (this.#pendingIncoming === 0 && this.#storeDone !== this.#storeSeen);
    this.#incomingSeen = this.#incomingDone;
    this.#storeSeen = this.#storeDone;
    if (progressed || !waiting) {
      this.#progressAt = now;
      return false;
    }
    return now - this.#progressAt >= limit;
  }

  #scheduleTick(): void {
    this.#tickTimer = this.#clock.setTimeout(() => {
      try {
        if (this.#closeReason) return;
        if (this.#storeTooSlow()) {
          this.#fail(new TimeoutError(`Store write took longer than ${this.#storeTimeoutMs / 1000} s`, { kind: 'store' }));
          return;
        }
        if (this.#resendReadSince !== undefined && this.#now() - this.#resendReadSince >= this.#storeTimeoutMs) {
          this.#fail(new TimeoutError(`Store read took longer than ${this.#storeTimeoutMs / 1000} s`, { kind: 'store' }));
          return;
        }
        if (this.#stalled()) {
          this.#closeStalled();
          return;
        }
        // While the session holds bytes it has not taken in, or has stopped reading for what it has
        // not finished, the counterparty's Heartbeat may be among what is unread: its silence is ours,
        // and is not counted against it (no TestRequest, no heartbeat timeout). So may the answer to
        // a ResendRequest: it is not asked for again while this lasts. A counterparty with nothing
        // held and reads not paused is judged as ever. Our own Heartbeats go on either way.
        if (this.#readsPaused) this.#dispatch({ type: 'heard' });
        this.#dispatch({ type: 'tick' });
        if (!this.#closeReason) this.#scheduleTick();
      } catch (error) {
        this.#failSafely(error);
      }
    }, TICK_MS);
  }

  /**
   * Received messages made no progress for processingTimeout: an 'error' entry, then, when logged on
   * (and not manual), a Logout saying so, and the session closes. The Logout gets a bounded chance
   * (logoutTimeout) to reach the wire first.
   */
  #closeStalled(): void {
    const text = `No progress on received messages for ${(this.#processingTimeoutMs ?? 0) / 1000} s`;
    this.#record(errorEntry(new Error(text), this.#clock.now()), false);
    const loggedOn = !this.#config.manual && this.#state.phase === 'active';
    if (loggedOn) this.#dispatch({ type: 'send', msgType: 'Logout', fields: { Text: text } });
    this.#dispatch({ type: 'disconnected' });
    this.#finish({ by: 'us', text }, loggedOn);
  }

  /** An internal failure (a write, the store, or a memory budget failing): close the session with the reason. */
  #fail(error: unknown): void {
    if (this.#closeReason) return;
    // Recorded (but not persisted: the store may be exactly what just failed), so the failure shows up
    // in history and watch(), not just the close reason. Deliberately not routed through #recordError:
    // a failure while recording here (the clock throwing, say) must still propagate out of #fail so
    // #failSafely's own catch reports it, the same as any other failure inside #fail.
    this.#record(errorEntry(error, this.#clock.now()), false);
    this.#dispatch({ type: 'disconnected' });
    this.#finish({ by: 'us', text: error instanceof Error ? error.message : String(error) });
  }

  /**
   * Put this session among those handing over to its store until #storeSettled. When the last of
   * them for this id has settled (one that closed before this one may settle after it), whoever
   * waits is told.
   */
  #handOver(): void {
    const key = idKey(this.id);
    let byId = handingOver.get(this.#store);
    if (!byId) handingOver.set(this.#store, (byId = new Map()));
    let entry = byId.get(key);
    if (!entry) byId.set(key, (entry = { sessions: 0, waiters: new Set() }));
    const mine = entry;
    mine.sessions++;
    void this.#storeSettled.promise.then(() => {
      if (--mine.sessions > 0) return;
      byId.delete(key);
      for (const wake of mine.waiters) wake();
      mine.waiters.clear();
    });
  }

  /** Once the link has ended: #storeSettled, when the store has settled every record queued, those queued while it did too. */
  #settleStore(): void {
    const idle = this.#storeQueue.idle;
    void idle.then(() => {
      if (this.#storeQueue.idle !== idle) {
        this.#settleStore();
        return;
      }
      this.#storeOver = true;
      this.#storeSettled.resolve();
    });
  }

  /**
   * Settle the session's terminal state. `wait`: for a graceful, engine-decided
   * disconnect, give already-queued writes a bounded chance (config.logoutTimeout)
   * to reach the wire before ending the link; a transport-initiated close ends
   * it at once. Either way, `closed` itself resolves only once the store has
   * flushed (also bounded by config.logoutTimeout — a store that never settles
   * is reported via onHandlerError, and closed resolves anyway), so a caller
   * who awaits it is never left hanging. link.end() throwing is reported the
   * same way; it never stops closed from resolving.
   *
   * The store may still have records of this session to keep after `closed`
   * has resolved, and is given them in order. Until it has settled them all,
   * the session is among those handing over (see lastSessionSettled), so that
   * the next session for this id waits; after that it gives the store nothing.
   */
  #finish(reason: CloseReason, wait = false): void {
    if (this.#closeReason) return;
    this.#closeReason = reason;
    this.#handOver();
    this.#clock.clearTimeout(this.#tickTimer);
    // What was received and not taken in is dropped, as messages received and not yet processed
    // are: none of it was recorded, so the counterparty is asked for it again by its MsgSeqNum.
    clearImmediate(this.#turn);
    this.#turn = undefined;
    this.#splitter.clear();
    this.#arrivals.clear();
    this.#heldBack = false;
    this.#syncReads();
    if (!this.#isActive) this.#active.reject(new FIXLogonError(reason));
    this.#inbox.close(reason.text);
    const link = this.#link;
    const end = () => {
      if (this.#linkEnded) return;
      this.#linkEnded = true;
      // A sent message still waiting for the store will never be written now. Given up a microtask
      // later, so that a store which has just failed rejects its send with its own error.
      const waits = [...this.#storeWaits];
      this.#storeWaits.clear();
      queueMicrotask(() => { for (const giveUp of waits) giveUp(); });
      try {
        link?.end();
      } catch (error) {
        this.#reportError(error);
      }
      let settled = false;
      const finishClosed = () => {
        if (settled) return;
        settled = true;
        this.#closed.resolve(reason);
      };
      const storeTimer = this.#clock.setTimeout(() => {
        this.#reportError(new TimeoutError('The store did not flush before the session closed', { kind: 'store' }), undefined, false);
        finishClosed();
      }, this.#config.logoutTimeout * 1000);
      void this.#storeQueue.idle.finally(() => {
        this.#clock.clearTimeout(storeTimer);
        finishClosed();
      });
      this.#settleStore();
    };
    if (!wait) {
      end();
      return;
    }
    const timer = this.#clock.setTimeout(end, this.#config.logoutTimeout * 1000);
    void this.#out.idle.finally(() => {
      this.#clock.clearTimeout(timer);
      end();
    });
  }
}

/** The session closed (or its link ended) before this particular message could be routed/written. */
function closedBeforeSent(message: MessageObject): FIXStateError {
  return new FIXStateError(`The session closed before ${String(message.MsgType)} was sent`);
}

function asList(result: MessageObject | null | readonly MessageObject[]): readonly MessageObject[] {
  if (result === null) return [];
  return Array.isArray(result) ? result : [result as MessageObject];
}
