/**
 * fix.js
 *
 * Naming: FIX data keeps FIX's names exactly (ClOrdID, OrdStatus, Side.Buy);
 * our own API uses JavaScript conventions (camelCase functions and options,
 * PascalCase types). Every enum is exported as a constant: Side.Buy, MsgType.Logon.
 *
 * One pattern throughout: the message type is always the first argument.
 *   session.on(MsgType.ExecutionReport, report => ...)
 *   session.next(MsgType.Heartbeat)
 *   session.send(MsgType.TestRequest, { TestReqID: 'ping' })
 *
 * One auto-fill rule for everything outgoing, including order replies:
 *   leave a field out → filled in correctly
 *   write a field     → sent exactly as written
 *   set it to null    → left out
 */

import type {
  Messages, MsgTypeName, AppMsgType, Header, Framing, AutoFilledBodyField, Version,
} from './dictionary';
import type { IncomingOrder, IncomingCancel, IncomingReplace, OutgoingOrder } from './orders';
import type { Fault, RouteFn } from './faults';

export * from './dictionary';
export type { IncomingOrder, IncomingCancel, IncomingReplace, OutgoingOrder, OrderState } from './orders';
export { OrderRejectedError, CancelRejectedError, TimeoutError } from './orders';
export type { WaitingFor } from './orders';
export type { Fault, RouteFn } from './faults';

// ─── Errors ─────────────────────────────────────────────────────────────────

/** A message couldn't be encoded: unknown field or message, wrong value type, missing required field. */
export declare class FIXEncodeError extends Error {}
/** Bytes couldn't be decoded as a FIX message. */
export declare class FIXDecodeError extends Error {}
/** An operation isn't possible in the session's current state (e.g. sending before logon). */
export declare class FIXStateError extends Error {}
/** connect() couldn't log on. `reason` says why (their Logout text, a timeout, the connection closing). */
export declare class FIXLogonError extends Error {
  constructor(reason: CloseReason);
  readonly reason: CloseReason;
}

// ─── Custom dictionaries ────────────────────────────────────────────────────

export interface FieldDef {
  readonly tag: number;
  /** Default 'string'. A field with `values` is an enum and gets constants. */
  readonly type?: 'string' | 'int' | 'number' | 'boolean' | 'timestamp';
  /** Enum values: name → wire value. */
  readonly values?: Readonly<Record<string, string>>;
}

export interface DictionaryDef {
  readonly fields?: Readonly<Record<string, FieldDef>>;
  /** Which custom fields each message may carry. */
  readonly messages?: { readonly [K in MsgTypeName]?: readonly string[] };
}

type FieldValue<F> =
  F extends { values: infer V } ? keyof V & string :
  F extends { type: 'int' | 'number' } ? number :
  F extends { type: 'boolean' } ? boolean :
  F extends { type: 'timestamp' } ? Date :
  string;

/** The custom fields dictionary D adds to message K (all optional). */
export type CustomFields<D, K> =
  D extends { fields: infer F; messages: infer M }
    ? K extends keyof M
      ? M[K] extends readonly (infer N)[]
        ? { [P in N & keyof F]?: FieldValue<F[P]> }
        : {}
      : {}
    : {};

/** Constants for the dictionary's enum fields: acme.AlgoStrategy.VWAP === 'VWAP'. */
type EnumConstants<D> =
  D extends { fields: infer F }
    ? { readonly [P in keyof F as F[P] extends { values: object } ? P : never]:
          F[P] extends { values: infer V } ? { readonly [N in keyof V & string]: N } : never }
    : {};

export type Dictionary<D extends DictionaryDef = {}> = { readonly definition: D } & EnumConstants<D>;

/**
 * Declare a firm's custom fields once; they then behave like standard FIX
 * fields: named, typed, autocompleted, with constants for their values.
 * (A firm with an Orchestra file for its rules of engagement can generate the
 * same thing instead.) Raw numeric tags keep working with no dictionary at all.
 */
export declare function defineDictionary<const D extends DictionaryDef>(definition: D): Dictionary<D>;

// ─── Messages ───────────────────────────────────────────────────────────────

/** Tags no dictionary knows: number → raw wire text. Always readable and writable. */
export interface RawTags {
  readonly [tag: number]: string;
}

/**
 * A message of type K as received (or as sent, once filled in).
 * BodyLength and CheckSum are not message fields; they describe the encoding.
 */
export type Message<K extends MsgTypeName = MsgTypeName, D = {}> =
  K extends MsgTypeName
    ? Readonly<{ MsgType: K } & Header & Messages[K] & CustomFields<D, K>> & RawTags
    : never;

export type AppMessage<D = {}> = Message<AppMsgType, D>;

type Nullable<T> = { [P in keyof T]: T[P] | null };
type Optional<T, F extends PropertyKey> = Omit<T, F & keyof T> & Partial<Pick<T, F & keyof T>>;

/**
 * The fields you write when sending message K. Required body fields are
 * required (null to leave one out on purpose); header, framing and computable
 * fields are optional (omitted → filled); numeric tags are raw text.
 */
export type Fields<K extends MsgTypeName, D = {}> =
  Nullable<Optional<Messages[K], AutoFilledBodyField>>
  & Partial<Nullable<Header & Framing>>
  & Partial<Nullable<CustomFields<D, K>>>
  & { [tag: number]: string | number | null };

/** Field values to match on: a partial message. */
export type Where<K extends MsgTypeName, D = {}> = Partial<Omit<Message<K, D>, 'MsgType'>>;

/** `fields` is optional when the message has no required fields (Heartbeat, Logout). */
type FieldsArg<K extends MsgTypeName, D> = {} extends Fields<K, D> ? [fields?: Fields<K, D>] : [fields: Fields<K, D>];

/** What a handler receives: order messages arrive as order objects with methods. */
export type Incoming<K extends MsgTypeName, D = {}> =
  K extends 'NewOrderSingle' ? IncomingOrder<D> :
  K extends 'OrderCancelRequest' ? IncomingCancel<D> :
  K extends 'OrderCancelReplaceRequest' ? IncomingReplace<D> :
  Message<K, D>;

/** Removes what was added. Also Disposable: `using _ = session.outgoing(...)`. */
export type Remove = (() => void) & Disposable;

/** Milliseconds, or '5s' / '500ms'. */
export type Duration = number | `${number}s` | `${number}ms`;

// ─── History ────────────────────────────────────────────────────────────────

export interface Problem {
  /** Session problems, then the decode problems a received message can have (named after SessionRejectReason). */
  readonly code:
    | 'Garbled' | 'NotLoggedOn' | 'UnexpectedLogon' | 'BeginStringMismatch' | 'CompIDMismatch'
    | 'SendingTimeAccuracy' | 'MissingMsgSeqNum' | 'SeqNumTooLow' | 'SeqNumGap'
    | 'HeartbeatTimeout' | 'LogonTimeout' | 'LogoutTimeout' | 'LogonRejected' | 'InvalidUnsupportedAppVersion'
    | 'LogonRefused' | 'ConnectionLimit' | 'MessageTooLarge' | 'TLSMismatch'
    | 'InvalidTagNumber' | 'RequiredTagMissing' | 'TagNotDefinedForThisMessageType'
    | 'TagSpecifiedWithoutAValue' | 'ValueIsIncorrect' | 'IncorrectDataFormatForValue'
    | 'InvalidMsgType' | 'TagAppearsMoreThanOnce' | 'TagSpecifiedOutOfRequiredOrder'
    | 'RepeatingGroupFieldsOutOfOrder' | 'IncorrectNumInGroupCountForRepeatingGroup';
  readonly text: string;
  /** What the session did about it. */
  readonly action: 'Ignored' | 'Rejected' | 'ResendRequested' | 'LoggedOut' | 'Disconnected';
  /** MsgSeqNum of the message concerned, when there is one. */
  readonly refSeqNum?: number;
  readonly bytes?: Uint8Array;
}

/** Something that went wrong in a handler, route or watcher, or inside the session itself. */
export interface ErrorEntry {
  readonly kind: 'error';
  readonly at: Date;
  readonly text: string;
  readonly stack?: string;
  /** The message being handled, when there was one. */
  readonly during?: { readonly MsgType?: string; readonly MsgSeqNum?: number; readonly ClOrdID?: string };
}

/** One record in a session's history. Plain data, so a UI can show it directly. */
export type Entry =
  | { readonly kind: 'message'; readonly direction: 'in' | 'out'; readonly at: Date; readonly message: Message; readonly bytes?: Uint8Array }
  | { readonly kind: 'problem'; readonly direction: 'in'; readonly at: Date; readonly problem: Problem }
  | ErrorEntry
  | { readonly kind: 'fault'; readonly route: 'incoming' | 'outgoing'; readonly at: Date; readonly fault: Fault; readonly added: boolean };

// ─── Session ────────────────────────────────────────────────────────────────

export interface SessionId {
  readonly version: Version;
  readonly sender: string;
  readonly target: string;
}

export interface CloseReason {
  readonly by: 'us' | 'them' | 'network';
  readonly text: string;
  readonly problem?: Problem;
}

export interface Session<D = {}, C = unknown> {
  readonly id: SessionId;
  /**
   * `${version}:${sender}:${target}`: a label for logs and metrics. Not guaranteed
   * unique when a CompID contains ':'; look sessions up by `id`.
   */
  readonly key: string;
  /**
   * This connection's id. For a server session, the id the server's connection
   * feed (server.watch()) uses for this connection; a client session's id is local.
   */
  readonly connectionId: string;
  /** The other end of the TCP connection. */
  readonly peer: Peer | undefined;
  readonly connectedAt: Date;
  /** When the Logon handshake completed; undefined until then. With `manual`, when the session was created. */
  readonly loggedOnAt: Date | undefined;
  /** What accept() returned as `context` for this counterparty; undefined when it gave none, and for connect(). */
  readonly context: C | undefined;
  readonly state: 'loggingOn' | 'active' | 'loggingOut' | 'closed';
  /** Negotiated heartbeat interval, in seconds. */
  readonly heartbeat: number;
  /** Next MsgSeqNum we send, and next we expect. */
  readonly seqNums: { readonly next: number; readonly expected: number };

  // Orders ------------------------------------------------------------------

  /**
   * Send a NewOrderSingle and wait for the other side to accept it.
   * Resolves with the order once accepted (its first ExecutionReport that isn't
   * a rejection); throws OrderRejectedError if it's rejected.
   *
   * Filled in unless you write them: ClOrdID (generated), TransactTime, and
   * OrdType, from the prices you give: none → Market, Price → Limit,
   * StopPx → Stop, both → StopLimit.
   */
  newOrder(
    fields: Omit<Fields<'NewOrderSingle', D>, 'ClOrdID' | 'OrdType'> & { ClOrdID?: string; OrdType?: Fields<'NewOrderSingle'>['OrdType'] },
    options?: { timeout?: Duration },
  ): Promise<OutgoingOrder<D>>;

  /** Every order on this session, sent or received, oldest first. */
  readonly orders: readonly (OutgoingOrder<D> | IncomingOrder<D>)[];

  // Receiving ---------------------------------------------------------------

  /** Call `handler` for each message of this type. Order messages arrive as order objects. */
  on<K extends MsgTypeName>(type: K, handler: (msg: Incoming<K, D>, session: Session<D, C>) => unknown): Remove;

  /**
   * Iterate messages of one type, or all application messages. Not redacted:
   * like on() and next(), it delivers messages as received/sent; `redact`
   * only hides values in what's recorded (history, the store) or shown
   * (this session's own watch()).
   */
  messages<K extends MsgTypeName>(type: K): AsyncIterable<Incoming<K, D>>;
  messages(): AsyncIterable<AppMessage<D>>;

  /**
   * Wait for the next message of this type (optionally with these field
   * values in `where`). Includes session-level messages. "Next" means not already
   * returned by an earlier next(), so a reply that arrived early isn't missed.
   * Default timeout 5s. Not redacted: see messages().
   */
  next<K extends MsgTypeName>(type: K, options?: { where?: Where<K, D>; timeout?: Duration }): Promise<Message<K, D>>;

  // Sending (low level) -----------------------------------------------------

  /**
   * Send any message under the auto-fill rule. Resolves with the message as sent.
   *
   * A Logon with ResetSeqNumFlag: true (or 141: 'Y'), sent on a logged-on
   * session, starts both sequences again at 1, and goes out as MsgSeqNum 1.
   * Every reset we start is owed one such Logon from the counterparty: one
   * that arrives while a reply is owed is that reply, however late, and is not
   * answered; any other is a request, and is answered with the same. While a
   * reset of ours awaits its reply, another is refused (rejects with
   * FIXStateError). That wait ends with the reply, or with the counterparty's
   * MsgSeqNum 1 of the new sequence when that is another message, not marked as
   * resent (PossDupFlag): not every engine replies. The reply stays owed.
   *
   * Under FIXT.1.1 a Logon is sent with the session's application version
   * (DefaultApplVerID) filled in, unless it is written.
   */
  send<K extends MsgTypeName>(type: K, ...fields: FieldsArg<K, D>): Promise<Message<K, D>>;

  /** The bytes send() would produce, without sending or using a sequence number. */
  encode<K extends MsgTypeName>(type: K, ...fields: FieldsArg<K, D>): Uint8Array;

  /** Bytes exactly as given: no filling, no route, no sequence number. */
  sendBytes(bytes: Uint8Array | string): Promise<void>;

  /** Move the sequence counters (e.g. to act like a restarted engine). */
  setSeqNums(seqNums: { next?: number; expected?: number }): void;

  // Faults ------------------------------------------------------------------

  /** Apply a fault to what we send (after filling, before the wire). */
  outgoing(fault: Fault | RouteFn): Remove;
  /** Apply a fault to what we receive (before the session engine sees it). */
  incoming(fault: Fault | RouteFn): Remove;

  // Log and lifecycle ------------------------------------------------------

  /**
   * Everything sent, received, noticed, faulted and failed, oldest first. Keeps the
   * newest 1,000 entries / 1 MiB unless `memory` says otherwise; a fileStore keeps everything.
   * A view for a program to read: a ResendRequest is answered from the store, not from this.
   */
  readonly history: readonly Entry[];
  /** Follow the history live. */
  watch(fn: (entry: Entry) => void): Remove;

  /** Graceful Logout handshake, then disconnect. */
  logout(text?: string): Promise<CloseReason>;
  /** Drop the connection without logging out. */
  close(): void;
  /** Resolves when the session ends, for any reason. */
  readonly closed: Promise<CloseReason>;
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface Clock {
  now(): Date;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** What a session tells its store about itself. */
export interface StoreContext {
  /** The session's custom dictionary, for encoding and decoding messages that use its fields. */
  readonly dictionary?: Dictionary<DictionaryDef>;
  /**
   * How much history the session keeps (memory.history, memory.historyBytes): load() need return
   * only the newest entries within it. It has no effect on sent(), which answers from everything
   * the store keeps of the current epoch.
   */
  readonly history?: { readonly entries: number; readonly bytes: number };
}

/**
 * What a session asks its store to keep: one record per entry, or one with no
 * entry when only the sequence numbers changed (setSeqNums). A store is given
 * records in lists (see Store). A sent message's
 * record is kept before the message is written to the network, so a restart
 * never reuses a MsgSeqNum that was already sent.
 */
export interface StoreRecord {
  /** When it happened: the entry's own time, when there is an entry. */
  readonly at: Date;
  readonly entry?: Entry;
  /** The sequence numbers once this record is kept. */
  readonly seqNums: { readonly next: number; readonly expected: number };
  /**
   * The sequence numbers were reset (a Logon with ResetSeqNumFlag=Y, or setSeqNums
   * bringing `next` down to 1): this record begins a new epoch.
   */
  readonly newEpoch?: boolean;
}

/** Which part of a session's log read() gives. */
export interface StoreReadOptions {
  /** Only entries at or after this time. */
  readonly from?: Date;
  /** Only entries at or before this time. */
  readonly to?: Date;
  /** Only this epoch. */
  readonly epoch?: number;
}

/** One epoch of a session a store holds. */
export interface StoredEpoch {
  readonly epoch: number;
  readonly startedAt: Date;
  /** How many of its entries the store keeps, when it knows without reading them: a memoryStore does, a fileStore doesn't. */
  readonly entries?: number;
}

/** A session a store holds, and its epochs, oldest first. */
export interface StoredSession {
  readonly id: SessionId;
  readonly epochs: readonly StoredEpoch[];
}

/**
 * Where sessions' history and sequence numbers are kept, and where a
 * ResendRequest is answered from. Each session's log is kept in epochs: a new
 * one begins at every sequence reset, so what came before a reset is never
 * resent after it. To check a store of your own, storeContract() in
 * fix.js/test defines the tests the library's own stores pass.
 *
 * What a session does with its store, for anyone who writes one:
 * - One store may serve many sessions at once (every session of a server,
 *   say). A session is its SessionId, all three parts exactly. Calls for
 *   different sessions come in no order, and what is kept for one is never
 *   given for another.
 * - load() is called when a session begins (connect(), or a server taking a
 *   Logon), before any append() for it. A store is not told when a session
 *   ends.
 * - append() is given a list of records to keep, in order, and is called for
 *   one session one call at a time: the next is not made until the one
 *   before has settled, and the records made meanwhile wait and go in the
 *   next, in order, as many as a list may hold. A list is never empty, and
 *   holds at most 256 records and 1 MiB of entries (an entry counted as its
 *   wire bytes, or 256 without any; a record larger than that goes alone).
 *   A sent message is written to the network only once the call that
 *   carried its record has resolved, so resolve once every record of the
 *   list is kept and not before. When a call rejects, the session treats
 *   none of its records as kept: it closes, and writes none of their
 *   messages. The store may have kept some of them all the same (the first
 *   of the list, say) and need not undo it: a session that starts again then
 *   finds their sequence numbers, so MsgSeqNums are passed over and never
 *   used twice. The session does not change a list it has given, and does
 *   not use it again. The records made before it closed are still given, in
 *   later calls, and the next session for the same id on this store (from
 *   listen(), or from connect()) is not begun until they have settled: its
 *   load() comes after them, so two sessions of one id never have calls for
 *   the store at the same time. While a call of the last session has not
 *   settled, a Logon for that id waits, and is refused once it has waited
 *   storeTimeout ('Store unavailable') or when the time its connection has
 *   to log on ends ('Logon timed out'), whichever comes first; connect()
 *   rejects as for a load() too slow. Before either refusal, the server's
 *   feed has one 'error' entry saying that the store has not settled the
 *   records of the last session with that counterparty, and how long the
 *   Logon waited. The wait is kept for each store
 *   object: two objects over the same files know nothing of each other's
 *   sessions, so an accept() that gives a new store object for each Logon
 *   gets no wait. Give a counterparty the same object each time.
 * - The sequence numbers of the newest record, the last of the last list,
 *   are the session's: load() gives them back, whether that record had an
 *   entry or not, and whether the store still keeps its entry or not.
 * - A session's first record begins epoch 1, whether it has `newEpoch` or
 *   not, and every later record with `newEpoch` begins the next, wherever
 *   in a list it is: that record is the first of its epoch, and its `at` is
 *   when the epoch began (StoredEpoch.startedAt). The records after it in
 *   the list belong to the new epoch. load() and sent() look only at the newest
 *   epoch; read() and list() at every epoch the store keeps.
 * - A store may drop the oldest entries it keeps, or the oldest epochs. What
 *   it has dropped is not resent: a gap fill covers it.
 * - An entry arrives with hidden values already replaced by '*****', in its
 *   message and in its bytes (see `redact`; with `redact: false` it arrives
 *   as it was sent or received). Give back what was kept, with the mask
 *   where it was: by it the session knows a message must not be sent again.
 *   Bytes with a value masked no longer pass their CheckSum.
 * - A message entry has `bytes` when it reached the wire and none when it did
 *   not (one an outgoing route dropped, say); keep it either way, and give it
 *   back the same. context.dictionary is the session's custom dictionary,
 *   for a store that encodes or decodes messages itself.
 * - Give an entry back as it was appended: its kind, direction and `at`, and
 *   its message with every field as it was, a number as a number, a Date as
 *   a Date, a boolean as a boolean, a group as a list of its entries. A copy
 *   sent again is encoded from `entry.message`, not from `bytes`: a message
 *   that comes back with a time as text does not encode, and is answered
 *   with a gap fill as if it had not been kept, with no error. A store that
 *   keeps text can keep an entry with entryToJSON() and give it back with
 *   entryFromJSON(). An entry given back with a property added, or with
 *   itself or its message as something other than a plain object (one whose
 *   prototype is Object.prototype or null), is refused by storeContract().
 * - A store may leave out the copies sent again (a message the session sent
 *   marked PossDupFlag, a SequenceReset-GapFill among them): nothing reads
 *   them back for a resend. Their records' sequence numbers still count. A
 *   message the program itself sends marked PossDupFlag is one of these: it
 *   is not an original, so sent() never gives it, and a resend answers its
 *   MsgSeqNum with a gap fill.
 * - sent() is called once every record the session has queued for the store
 *   has settled, so never for a message still on its way to the store. A
 *   session reads one sent() at a time. While it reads, it appends each
 *   message it sends in answer, and whatever it receives: sent() need not
 *   see those appends and, like read(), must not hold up append() while its
 *   reader pauses.
 * - What sent() gives is checked: an entry that is not a message the session
 *   sent, is marked PossDupFlag, is outside the range, or does not have a
 *   higher MsgSeqNum than the one before is left out, and what is left out is
 *   answered with a gap fill. So is a message with the mask for any value.
 *   More entries than the range holds MsgSeqNums is a failure of the store.
 * - Any method may throw or reject: a store cannot crash the process. A
 *   failing load() refuses the session (connect() rejects; a server refuses
 *   the connection, 'Store unavailable'). A failing append() closes the
 *   session with the store's own error. A failing sent() is recorded and
 *   closes the session ('Store could not be read for a resend'), with no gap
 *   fill for the rest of the range.
 * - One append() call, or one entry of sent(), that takes longer than
 *   `storeTimeout` closes the session ('Store write took longer than N s',
 *   'Store read took longer than N s'); connect() waits no longer than that
 *   for load().
 * - read(), list() and reset() are for the program: a session calls none of
 *   them.
 */
export interface Store {
  /**
   * The current epoch's newest entries, oldest first, and the sequence numbers of the newest record
   * kept. No more entries than context.history asks for need be given (1,000 entries / 1 MiB when it
   * asks for none; an entry counts as its wire bytes, or about 256 without any): the session drops the
   * oldest past that. A session with nothing kept gives `{ history: [], next: 1, expected: 1 }`.
   */
  load(id: SessionId, context?: StoreContext): Promise<{ history: Entry[]; next: number; expected: number }>;
  /**
   * Keep these records, in order: each an entry and/or the sequence numbers after it. Resolves once
   * all are kept; rejects when any could not be. The session then treats none of the list as kept
   * and sends none of its messages; the store may have kept some of it, and need not undo that: a
   * restart then finds their sequence numbers (numbers are passed over, never used twice). Never an
   * empty list. A memoryStore and a fileStore take their own copy of the list when called, and refuse
   * (RangeError) what is not a list, an empty one, and a list with something that is not a record in
   * it, saying which: a memoryStore keeps the records before one whose entry it cannot keep, and a
   * fileStore none of such a list, but the first records of a list whose write failed part-way.
   */
  append(id: SessionId, records: readonly StoreRecord[], context?: StoreContext): Promise<void>;
  /**
   * The entries the store keeps for a session, across epochs, oldest first,
   * read as they are asked for. The two stores differ in what a read sees of
   * appends made while it is going: a memoryStore reads a snapshot taken when
   * the read begins, so it sees none of them; a fileStore reads the epochs there
   * are when it begins, and the last of them on to the end of the file as it
   * finds it, so it sees appends to that epoch, and a writer appending faster
   * than the reader reads can keep it going. A read stops at a reset of the
   * session, and never gives anything written after it.
   * A reader that pauses never holds up the session's appends. A session with
   * nothing kept gives nothing. RangeError for options that are not what
   * StoreReadOptions says (a memoryStore and a fileStore give it when the first
   * entry is asked for).
   */
  read(id: SessionId, options?: StoreReadOptions, context?: StoreContext): AsyncIterable<Entry>;
  /**
   * The messages this session sent in its current epoch whose MsgSeqNum is
   * within from..to (both included), for answering a ResendRequest. Only
   * originals: direction 'out', not marked PossDupFlag. In MsgSeqNum order, at
   * most one per MsgSeqNum; where several were appended with one MsgSeqNum, the
   * latest. A MsgSeqNum with no original kept is passed over. Read as they are
   * asked for, so a range of any size costs no more memory than one entry.
   * Never anything from an earlier epoch. A session with nothing kept gives
   * nothing. RangeError for a range that is not whole numbers with
   * 1 <= from <= to (a memoryStore and a fileStore give it when the first
   * entry is asked for). A message kept without wire bytes (one an outgoing
   * route dropped) is given like any other. Gives nothing more once the
   * session is reset (reset()) while it is being read. `to` may be far above
   * any MsgSeqNum kept: what sent() costs must follow what is kept, not how
   * many numbers the range holds.
   * The session closes the iterator (return()) when it has what it needs, or
   * is closing, and does not wait for it.
   */
  sent(id: SessionId, range: { readonly from: number; readonly to: number }, context?: StoreContext): AsyncIterable<Entry>;
  /** Every session the store holds, in a steady order (a memoryStore and a fileStore: by version, then our CompID, then theirs), each with the epochs kept of it, oldest first. A fileStore lists a file from before epochs once its session has been loaded or appended to. */
  list(): Promise<StoredSession[]>;
  /**
   * Forget a session: every epoch of it, and its sequence numbers. load() then gives what it gives for
   * a session with nothing kept, and the next append() begins epoch 1. A sent() being read gives
   * nothing more, and a read() nothing written after the reset. A session the store does not hold is
   * no error.
   */
  reset(id: SessionId): Promise<void>;
}
export interface MemoryStoreOptions {
  /**
   * Entries kept per session, of every kind and in both directions, but no message sent with
   * PossDupFlag; the oldest are dropped. Default 1,000. Sequence numbers are always kept. A resend
   * reaches no further back than the entries kept: raise this, or use a fileStore, to resend more.
   */
  history?: number;
  /** Bytes of entries kept per session. Default 1 MiB. A resend reaches no further back than this either. */
  historyBytes?: number;
  /** Sessions kept; past this, the least recently used is forgotten. Default 1,000. */
  sessions?: number;
}
/**
 * The default. Keeps its own copy of each session's entries (up to 1,000 per
 * session), separately from `session.history`. At its defaults it can hold about
 * 1 GiB of wire bytes (1,000 sessions × 1 MiB), so roughly 5–15 GiB of heap.
 * read() reads a snapshot of what it keeps, taken when the read begins.
 * sent() answers with what it keeps of the current epoch, chosen when it is
 * called. Both give nothing more once the session is reset or forgotten.
 * Received messages, problems and errors count toward the limits like sent
 * messages, so a resend reaches back less than 1,000 messages at the
 * defaults; what is not kept is gap-filled.
 *
 * A message sent with PossDupFlag (a copy that answers a ResendRequest, the
 * SequenceReset-GapFill sent in its place, or a message the program itself
 * sends with PossDupFlag) is not kept, so answering a ResendRequest never
 * pushes out the originals another one may ask for. Its record's sequence
 * numbers still count. So read() and load() show no such message, while
 * `session.history` and watch() do; a fileStore keeps them. With either
 * store, a message the program sent with PossDupFlag is not resent: a gap
 * fill answers its MsgSeqNum.
 */
export declare function memoryStore(options?: MemoryStoreOptions): Store;
/**
 * A folder per session in `dir`, named from its CompIDs but never raw wire data;
 * each epoch is one JSONL file in it, one line per record. load() reads only the
 * end of the current epoch. A file written before epochs becomes the session's
 * first epoch the first time the session is loaded or appended to; if the
 * session's folder already has an epoch, the old file is left alone and never
 * read. A new epoch's file is written whole, so a crash never leaves one
 * half-begun. Calls on one session run one at a time, in the order they are made.
 *
 * append() writes the records of a list with one write, to a file it keeps
 * open: the current epoch's file of each session written lately, at most
 * `openFiles` of them (256 unless given). A session without a place among
 * them is given one in the order sessions asked: a free one, or that of the
 * least recently written file whose session has no call part-way through,
 * which is closed for it; when every open file has a call part-way through,
 * the first of those calls to finish gives its file up. See FileStoreOptions
 * for what that costs a store written by more sessions than it has places.
 * A file that cannot be opened refuses its append with the error, and its
 * place goes to the next session. A file is also closed
 * when its session begins a new epoch, is reset, has an append fail, or is
 * no longer among the 1,000 remembered, and
 * once nothing has been appended to it for 2 s (within 4 s of its last
 * append, or of the end of a call that was part-way through then), on a timer
 * that does not keep the process alive: a store no longer
 * used leaves nothing open, and one that is only read opens none. A list that holds a record with `newEpoch` is
 * written in parts: the records before it to the epoch before, then the new
 * epoch's file whole. A list that fails may leave its first records written,
 * and those are kept: load() gives their sequence numbers;
 * the next call cuts off a line cut short. A record counts as kept once the
 * operating system has it: nothing waits for the disk (no fsync), so what was
 * kept survives the process ending, and not a loss of power. Because the file
 * stays open, a session folder that something other than this store removes
 * or renames under it is not noticed until the file is next closed, and a
 * file in steady use (appended to more often than every 2 s, with a place to
 * itself) is never closed by the idle rule: for as long as that lasts every
 * append resolves and goes to the removed file, while load(), read() and
 * sent() find nothing of the session. Remove a session with reset(id).
 *
 * read() streams, and changes nothing (it reads a file from before epochs where
 * it is), so another fileStore, a log viewer say, can read a folder a live
 * writer is using. It reads the epochs there are when it begins, and the last
 * of them on to the end of the file as it finds it, so it sees appends to that
 * epoch; it stops at a reset, by any store on the folder. With `from` or `to`
 * it leaves out whole epochs by when each began. Only regular files are read: a
 * folder or symlink named like an epoch file is not one. list() fails when the
 * operating system won't let it read a session's files.
 *
 * reset() renames the session's folder before removing it, so a reset cut
 * short never leaves a session half there; the store removes what is left the
 * next time it lists, or first loads.
 *
 * sent() reads the current epoch's file, so a resend reaches back to the start
 * of the epoch however long ago that was. The line of an original (a message
 * sent for the first time, not a copy sent again) names its MsgSeqNum, and
 * the store remembers where some of those lines are (at most 1,024 places a
 * session, for at most the 1,000 sessions it remembers), so it begins reading
 * near the first message asked for. To learn them it reads the epoch through
 * once, in the session's turn, so appends to that session wait for it (a
 * fraction of a second for 200,000 records): at the first sent() for a
 * session after the store is created, and again after a new epoch, an append
 * that failed, the session no longer being among those remembered, or a file
 * that is not the length remembered.
 *
 * The places it remembers are in the latest run of originals written in
 * MsgSeqNum order: from the last original whose MsgSeqNum was not higher than
 * the one before it, on to the end of the file. That is the whole epoch
 * unless a MsgSeqNum stepped backward in it, which happens when setSeqNums
 * moves `next` back, when a message is sent with a MsgSeqNum written by hand,
 * and when the counterparty's Logon resets the sequences while messages
 * numbered before it are still waiting to be kept: those are kept at the head
 * of the new epoch, before the Logon sent in reply as MsgSeqNum 1. Of the
 * lines before the run the store remembers only the lowest and the highest
 * MsgSeqNum. It reads them only for a MsgSeqNum of the range that they could
 * hold and the run is not known to hold, in passes: each reads those lines
 * through to find the next 4,096 originals of the range, holding at most
 * 8,192 places, then reads those originals. What that costs follows the lines
 * before the run and how many originals of the range they hold, not how large
 * a MsgSeqNum is. Those lines are nearly the whole epoch when a MsgSeqNum
 * steps backward late in a long one. Of a MsgSeqNum both parts hold, the
 * run's original is given: the latest appended.
 *
 * A MsgSeqNum a line names is trusted only when it is a whole number from 1
 * that a number holds exactly; for any other the frame is decoded. A line that
 * does not hold the original it names is left out, and so is a last line cut
 * short, as read() leaves it. Like read(), sent() does not hold up appends
 * while its reader pauses. Unlike read(), it is for the store that writes the
 * session: like load() it may mend a last line cut short and take in a file
 * from before epochs, and it notices a reset made through this store only.
 *
 * Every sequence reset begins a new epoch file, and a fileStore never removes
 * one: only reset() removes a session, all of it. list() and read() take
 * longer the more sessions and epochs there are. Remove old epoch files
 * yourself for now (never a session's last one).
 */
export declare function fileStore(dir: string, options?: FileStoreOptions): Store;
export interface FileStoreOptions {
  /**
   * How many files the store keeps open to append to, at most: the current epoch's file of each of
   * the sessions written most recently. Default 256. A whole number of at least 1 (RangeError
   * otherwise, and for an option fileStore() does not know).
   *
   * With more sessions written at once than this, a session without a place among them waits for
   * one: for the file of a session with no call part-way through to be closed (the least recently
   * written first), or, when every open file has a call part-way through, for the first of those
   * calls to finish, which then gives its place up. Sessions that wait are given places in the order
   * they asked. Such a session's append costs an open and a close besides its write, so a store
   * written by many more sessions at once than it has places keeps far fewer records a second, and
   * each record waits longer: give it as many places as it has sessions written at the same time.
   *
   * The operating system's limit on the files a process may have open must be above this, with room
   * for the process's sockets and for reads: read(), sent() and load() each open the file they read
   * for as long as they read it, and those are not counted here.
   */
  openFiles?: number;
}

/**
 * Memory bounds for one session, counted in wire bytes. The heap holds about
 * 5–15× the wire bytes per history entry, more inside a live session. The
 * default memoryStore keeps its own copy of up to 1,000 entries per session,
 * separately from these. On a server with many sessions what each session
 * keeps is the largest fixed cost: its history (`history`, `historyBytes`) and
 * its inbox (`inbox`, `inboxBytes`), each several times its wire bytes in
 * heap. Measured with messages of about 150 bytes: about 3 MiB of heap (about
 * 2 MiB for a full history, about 1 MiB for an inbox of 1,000 orders) and
 * 1.3 MiB of buffers for each session. Nothing but `limits.maxSessions`
 * bounds that across sessions: sessions x that figure must fit the heap, and
 * the default of 1,000 sessions is about 3 GiB. Lower `history` and `inbox`
 * there (and the memoryStore's `history`), or `maxSessions`.
 */
export interface MemoryOptions {
  /**
   * History entries kept; the oldest are dropped. Default 1,000. It sizes `session.history` and
   * what the store's load() returns; how far back a resend reaches is up to the store.
   */
  history?: number;
  /** History bytes kept. Default 1 MiB. */
  historyBytes?: number;
  /**
   * Received messages kept for next() and messages(); the oldest are dropped. Default 1,000.
   * They are kept whether or not the program calls either: about 1 MiB of heap a session for
   * 1,000 orders of about 150 bytes. A server with many sessions that only uses handlers lowers it.
   * Past half as many received and not yet processed, the session takes in no more and reads
   * pause, as at `pendingBytes`: what arrives meanwhile waits as bytes, bounded by `inboxBytes`.
   * Also how many messages a messages() iterator may fall behind (past that it throws once,
   * then ends).
   */
  inbox?: number;
  /**
   * The same limits, in bytes. Default 1 MiB. It is also the most a session may have received
   * and not processed: the bytes it holds and has not yet taken in as messages, and the
   * messages taken in and not yet processed, together. Past it the session closes ('Too many
   * unprocessed incoming messages'). A socket is paused as soon as bytes are held, so a
   * session on one holds one read of it (up to 64 KiB) beside what it has taken in
   * (`pendingBytes` and one message): keep this above the three together, as the default is, or
   * one full read closes the session. A link that goes on delivering after it was told to
   * pause reaches it whatever it is.
   */
  inboxBytes?: number;
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
  outgoingBytes?: number;
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
  storeBytes?: number;
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
  pendingBytes?: number;
}

interface CommonOptions<D> {
  /** Default: memoryStore(). */
  store?: Store;
  /** Custom fields. Default: standard FIX only. */
  dictionary?: Dictionary<D & DictionaryDef>;
  /** Nothing automatic: no Logon, heartbeats, replies or order defaults. For scripts that control every message. */
  manual?: boolean;
  /** Inject time (tests). */
  clock?: Clock;
  /** How long to wait for the Logout reply. Default '10s'. Checked on a once-a-second tick, so it can fire up to 1 s late. */
  logoutTimeout?: Duration;
  /**
   * How long one store write (one append() call, with every record it carries) may take; past it
   * the session closes ('Store write took longer than N s'). A sent message waits for the store
   * before it is written, so a store that stops would otherwise hold up every outgoing message,
   * Heartbeats included. connect() also waits this long
   * for store.load(): past it, it rejects with a TimeoutError (waitingFor { kind: 'store' }) and
   * opens no connection. That wait includes the one for a session with the same store and CompIDs
   * that was closed a moment ago to have its last records kept; a server waits as long for the
   * same before it loads a session for a Logon, and then refuses it ('Store unavailable'). A
   * Logon still waiting when limits.logonTimeout ends is refused then ('Logon timed out'): at
   * the defaults both are '10s' and the logon timeout, counted from when the connection opened,
   * ends first. Whichever refuses it, server.watch() has one 'error' entry before the refusal
   * ('The store has not settled the records of the last session with "CLIENT": a Logon has
   * waited N s for it'; onHandlerError is given a TimeoutError, waitingFor { kind: 'store' }), so
   * a store call that does not return shows there even when the refusal is 'Logon timed out'.
   * The wait is by store object: see Store.
   * Default '10s'. A write's limit is checked on a once-a-second tick, so it
   * can fire up to 1 s late. A store read for a resend has the same limit for each entry it
   * gives ('Store read took longer than N s', a TimeoutError too).
   */
  storeTimeout?: Duration;
  /**
   * Errors thrown by handlers, routes and watchers, and the session's own
   * internal failures, are recorded in history as 'error' entries and never
   * crash the process. On a server, failures outside any session (accept()
   * throwing, the store failing to load, the listening socket's errors, a
   * server.watch() watcher throwing) are 'error' entries in server.watch().
   * Set this to also receive each one; what it throws is recorded too.
   */
  onHandlerError?: (error: unknown) => void;
  /**
   * Values hidden as '*****' in history, watch(), the store and server.watch();
   * the wire is unchanged. Default: Password (554), NewPassword (925),
   * EncryptedPassword (1402) and EncryptedNewPassword (1404) in every message,
   * RawDataLength (95) and RawData (96) in Logons. A list of tags hides
   * those in every message instead; false hides nothing. Redacted bytes no longer
   * pass their CheckSum; a hidden data field's length is rewritten to fit the mask,
   * so the frame still parses. A Logon is told by its MsgType wherever 35 sits in
   * the frame. A received frame that fails to parse is masked from its first
   * hidden or data field (or from where it can no longer be read) to its end.
   *
   * Inside free text (an 'error' entry's text and stack, a problem's text, a close
   * reason) a hidden value is masked only where it's quoted ('value', "value", or
   * `number value`, the way fix.js's own errors quote values), and only when it's at
   * least 4 characters long. Shorter values, and echoes in other forms (a handler's
   * own `new Error('bad ' + msg.Password)`, say), aren't masked there.
   */
  redact?: readonly number[] | false;
  /** Per-session memory bounds, each a positive integer; anything else is a RangeError up front. */
  memory?: MemoryOptions;
}

export interface ConnectOptions<D = {}> extends CommonOptions<D> {
  /** Our CompID. */
  sender: string;
  /** Their CompID. */
  target: string;
  /**
   * Default 'FIX.4.4'. 'FIXT.1.1' is a session that carries FIX 5.0 SP2, unless
   * `logon` names another application version (DefaultApplVerID).
   */
  version?: Version;
  /** Heartbeat interval in seconds, sent as HeartBtInt. Default 30. */
  heartbeat?: number;
  /**
   * Extra Logon fields: Username, Password, ResetSeqNumFlag; and under FIXT.1.1
   * DefaultApplVerID, the application version (see ApplVerID), which is filled
   * in as FIX50SP2 when left out.
   */
  logon?: Partial<Fields<'Logon'>>;
  /**
   * Connect over TLS: true for Node's defaults (the server's certificate is checked against Node's
   * default CAs: its bundled list plus the system's and NODE_EXTRA_CA_CERTS), or Node's TLS
   * connection options (`ca` for a private CA, …). connectTimeout covers the handshake too.
   */
  tls?: boolean | import('node:tls').ConnectionOptions;
  /** How long to wait for the Logon reply. Default '10s'. Checked on a once-a-second tick, so it can fire up to 1 s late. */
  logonTimeout?: Duration;
  /** How long to wait for the TCP connection itself before giving up. Default '10s'. */
  connectTimeout?: Duration;
}

/** Settings for one counterparty, returned by accept(). Anything left out uses the listen() options. */
export interface AcceptOptions<C = unknown> {
  /** Allowed HeartBtInt range, in seconds; a missing end comes from listen(). */
  heartbeat?: { min?: number; max?: number };
  manual?: boolean;
  store?: Store;
  memory?: MemoryOptions;
  /** Custom fields for this counterparty's session. */
  dictionary?: Dictionary<DictionaryDef>;
  /** Any value, kept as session.context. */
  context?: C;
}

export interface ListenOptions<D = {}, C = unknown> extends CommonOptions<D> {
  /** Our CompID, or several: each session's SenderCompID is the one its counterparty addressed. */
  compID: string | readonly string[];
  host?: string;
  /**
   * Default: all supported, FIXT.1.1 included. A FIXT.1.1 Logon may name any
   * application version in ApplVerID; accept() sees it (logon.DefaultApplVerID)
   * and can refuse the ones a server does not want.
   */
  versions?: readonly Version[];
  /**
   * Check each Logon before any session exists: return true to accept, a
   * string (the text of the Logout that refuses it), or settings for this
   * counterparty (accepted). Settings that can't be used (an unknown key, a
   * value of the wrong kind) are an 'error' entry in server.watch(), and the
   * Logon is refused.
   */
  accept?: (logon: Message<'Logon', D>, peer: Peer) => true | string | AcceptOptions<C> | Promise<true | string | AcceptOptions<C>>;
  /**
   * Allowed HeartBtInt range in seconds; a Logon outside it is refused. Default 1 to 120,
   * so HeartBtInt=0 (heartbeats off) is refused unless `min` is 0.
   */
  heartbeat?: { min?: number; max?: number };
  /**
   * Serve over TLS: Node's TLS server options (key, cert, …). A connection counts toward the
   * limits, and is in watch(), from the moment TCP opens. Its handshake must finish within
   * limits.logonTimeout (Node also gives up after handshakeTimeout without progress, by default
   * the same): one that fails is rejected ('TLSMismatch', saying why), one that takes too long is
   * rejected ('LogonTimeout'), and either is closed. Without tls, a connection that opens with a
   * TLS handshake is rejected ('TLSMismatch') and closed. A client that refuses our certificate
   * does so after our side of the handshake is done, so watch() shows only 'opened' then
   * 'closed'. For a server open to the internet, set minVersion: 'TLSv1.3'.
   */
  tls?: import('node:tls').TlsOptions;
  /** Price for filling Market orders when fill() isn't given a LastPx. Default: none, so such a fill throws. */
  marketPrice?: (order: IncomingOrder<D>) => number;
  /** What one server takes on. Past a limit a connection is closed, with a Logout saying why once its Logon was read. */
  limits?: {
    /** Live sessions. Default 1,000. */
    maxSessions?: number;
    /**
     * Open connections from one IP address, logged-on sessions included. Default 10. Raise it when
     * many counterparties share an address: a gateway, NAT, or a test harness running many clients.
     * Each exact address counts on its own (one IPv6 /64 network has many); pendingLogons is the
     * backstop across all of them.
     */
    connectionsPerAddress?: number;
    /**
     * Open connections that haven't logged on yet (TLS ones still in their handshake included), from all
     * addresses together. Default 100. Silent connections can hold these places until logonTimeout, so a
     * shorter logonTimeout makes that costlier.
     */
    pendingLogons?: number;
    /** Largest message, in bytes. Default 64 KiB. */
    maxMessageSize?: number;
    /**
     * How long a connection has to log on. Default '10s'. A Logon still being checked then (accept()
     * or the store not done with it) is refused with a Logout, 'Logon timed out'. One that was
     * waiting for the store to settle the last session of its counterparty has an 'error' entry
     * saying so before the refusal in server.watch(); see storeTimeout. Checked on a
     * once-a-second tick, so it can fire up to 1 s late.
     */
    logonTimeout?: Duration;
    /**
     * How long received messages may wait with none of them processed (a route or the store holding
     * them up) before the session is closed, with a Logout once logged on ('No progress on received
     * messages for N s'). Our own outgoing messages don't count as progress; a handler holding a
     * message doesn't hold anything up. Default '60s'. Checked on a once-a-second tick, so it can
     * fire up to 1 s late.
     */
    processingTimeout?: Duration;
  };
}

// ─── Client and server ──────────────────────────────────────────────────────

/**
 * Connect and log on. Resolves with an active session; with `manual`, as soon as TCP connects.
 * Options are checked first: a key it doesn't know, or a value of the wrong kind, is a RangeError
 * before anything is opened.
 */
export declare function connect<D = {}>(
  address: string | { host: string; port: number },
  options: ConnectOptions<D>,
): Promise<Session<D>>;

export interface Peer {
  readonly address: string;
  readonly port: number;
}

/** The version and CompIDs a Logon carried, read before any session exists. */
export interface LogonIds {
  readonly BeginString: string;
  readonly SenderCompID: string;
  readonly TargetCompID: string;
}

/** The fields only some connection entries carry. */
interface ConnectionFields {
  readonly problem: Problem;
  readonly bytes: Uint8Array;
  readonly logon: LogonIds;
  /** The session's key. */
  readonly sessionKey: string;
  readonly error: { readonly text: string; readonly stack?: string };
}

/** A connection entry for one event: what every entry has, the event's own fields `F`, and the other fields absent. */
type ConnectionEntryOf<E extends string, F extends Partial<ConnectionFields>> = {
  readonly kind: 'connection';
  readonly event: E;
  /** The same id as session.connectionId once a session exists. */
  readonly connectionId: string;
  readonly peer: Peer;
  readonly at: Date;
} & F & { readonly [K in Exclude<keyof ConnectionFields, keyof F>]?: undefined };

/**
 * What happened on a connection before (and until) it became a session; each
 * event carries its own fields.
 * - opened: TCP connected.
 * - received: the bytes read before a session took over (garbage included;
 *   redacted). Up to limits.maxMessageSize plus one socket read.
 * - rejected: refused, with the problem, and the Logon's CompIDs when one was
 *   read. A connection lost before it logged on is closed, not rejected.
 * - loggedOn: the session is logged on; its log continues in session.watch().
 * - closed: the connection ended; sessionKey once it had a session.
 * - error: a failure outside any session (accept() throwing, settings from
 *   accept() that can't be used, the store failing to load, a watcher
 *   throwing); one without a connectionId is the listening socket's own.
 * A connection is rejected at most once, and never after it closed.
 */
export type ConnectionEntry =
  | ConnectionEntryOf<'opened', {}>
  | ConnectionEntryOf<'received', { readonly bytes: Uint8Array }>
  | ConnectionEntryOf<'rejected', { readonly problem: Problem; readonly logon?: LogonIds }>
  | ConnectionEntryOf<'loggedOn', { readonly logon: LogonIds; readonly sessionKey: string }>
  | ConnectionEntryOf<'closed', { readonly sessionKey?: string }>
  | ConnectionEntryOf<'error', { readonly error: { readonly text: string; readonly stack?: string } }>
  | {
    readonly kind: 'connection';
    readonly event: 'error';
    readonly connectionId?: undefined;
    readonly peer?: undefined;
    readonly at: Date;
    readonly error: { readonly text: string; readonly stack?: string };
    readonly problem?: undefined;
    readonly bytes?: undefined;
    readonly logon?: undefined;
    readonly sessionKey?: undefined;
  };

export interface Server<D = {}, C = unknown> {
  readonly port: number;
  /** Follow every connection, including ones that never become a session. replay: first report the connections already open. */
  watch(fn: (entry: ConnectionEntry) => void, options?: { replay?: boolean }): Remove;
  readonly sessions: readonly Session<D, C>[];
  /** Orders across every session. */
  readonly orders: readonly IncomingOrder<D>[];
  /**
   * The live session with this counterparty, if connected. compID: the one of
   * our CompIDs it logged on to; without it, the first of its sessions to be
   * accepted.
   */
  session(target: string, options?: { compID?: string }): Session<D, C> | undefined;
  /** Wait for this counterparty to be logged on (to `compID`, when given). Default timeout 5s. */
  whenConnected(target: string, options?: { compID?: string; timeout?: Duration }): Promise<Session<D, C>>;
  /** Handle a message type on every session, current and future. */
  on<K extends MsgTypeName>(type: K, handler: (msg: Incoming<K, D>, session: Session<D, C>) => unknown): Remove;
  /**
   * Log everyone out and stop listening. From the moment it's called, a Logon is refused ('Server
   * shutting down') and a new connection is closed. Resolves once every connection has closed.
   */
  close(): Promise<void>;
}

/**
 * Accept connections. By default every NewOrderSingle is acknowledged, and
 * cancel/replace requests are accepted (or refused TooLateToCancel once the
 * order is done). A handler for those messages runs first and may answer
 * instead; anything it leaves unanswered gets the default. Options are checked
 * first: a key it doesn't know, or a value of the wrong kind, is a RangeError.
 */
export declare function listen<D = {}, C = unknown>(port: number, options: ListenOptions<D, C>): Promise<Server<D, C>>;


// ─── Entries as JSON ────────────────────────────────────────────────────────

/**
 * An entry, or a connection entry, as plain JSON: the same fields, with every
 * Date as ISO 8601 text and every byte array as base64. Ready for
 * JSON.stringify(); entryFromJSON() turns it back.
 */
export interface EntryJSON {
  readonly kind: Entry['kind'] | 'connection';
  readonly at: string;
  readonly [key: string]: unknown;
}

/**
 * An entry (from history, watch() or a store) or a connection entry (from
 * server.watch()) as plain JSON, to send to a browser or write to a log. A
 * message keeps its field names; a timestamp field is ISO 8601 text.
 * rawValue() (fix.js/wire) is not carried: only a decoded value and, for a
 * received message, its wire bytes.
 */
export declare function entryToJSON(entry: Entry | ConnectionEntry): EntryJSON;

/**
 * The entry entryToJSON() gave as JSON (or JSON.parse() read back). A message's
 * timestamp fields become Dates again, by the standard dictionary for its
 * BeginString with `dictionary`'s custom fields added. A RangeError, saying
 * what is wrong, for anything that isn't such an entry.
 *
 * `json` is untrusted input, not a stored entry: its shape is checked field by
 * field, but a message's fields and its `bytes` are never checked against each
 * other. Callers reading JSON text from an untrusted source should cap its
 * size before JSON.parse(); entryFromJSON() itself never reads more than what
 * JSON.parse() already handed it.
 */
export declare function entryFromJSON(json: unknown, dictionary?: Dictionary<DictionaryDef>): Entry | ConnectionEntry;
