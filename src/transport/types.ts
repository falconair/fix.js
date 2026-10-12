import type { DictionaryDef } from '../dictionary/define.ts';
import type { MessageObject } from '../wire/message.ts';
import type { Problem } from '../session/types.ts';
import type { Version } from '../version.ts';

export interface SessionId {
  readonly version: Version;
  /** Our CompID. */
  readonly sender: string;
  /** Their CompID. */
  readonly target: string;
}

/** Where a connection comes from. */
export interface Peer {
  readonly address: string;
  readonly port: number;
}

/** One record in a session's history. `bytes` is what reached the wire (absent if a route dropped it). */
export type Entry =
  | { readonly kind: 'message'; readonly direction: 'in' | 'out'; readonly at: Date; readonly message: MessageObject; readonly bytes?: Uint8Array }
  | { readonly kind: 'problem'; readonly direction: 'in'; readonly at: Date; readonly problem: Problem }
  | ErrorEntry;

/** What was being handled when an error happened. */
export interface ErrorContext {
  readonly MsgType?: string;
  readonly MsgSeqNum?: number;
  readonly ClOrdID?: string;
}

/** Something that went wrong in a handler, route or watcher, or inside the session itself. */
export interface ErrorEntry {
  readonly kind: 'error';
  readonly at: Date;
  readonly text: string;
  readonly stack?: string;
  /** The message being handled, when there was one. */
  readonly during?: ErrorContext;
}

/** The version and CompIDs a Logon carried, read before any session exists. */
export interface LogonIds {
  readonly BeginString: string;
  readonly SenderCompID: string;
  readonly TargetCompID: string;
}

/** An error, as plain data. */
export interface ErrorInfo {
  readonly text: string;
  readonly stack?: string;
}

/** The fields only some connection entries carry. */
interface ConnectionFields {
  readonly problem: Problem;
  readonly bytes: Uint8Array;
  readonly logon: LogonIds;
  readonly sessionKey: string;
  readonly error: ErrorInfo;
}

/** A connection entry for one event: what every entry has, the event's own fields `F`, and the other fields absent. */
type ConnectionEntryOf<E extends string, F extends Partial<ConnectionFields>> = {
  readonly kind: 'connection';
  readonly event: E;
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
 * - rejected: refused, with the problem, and the Logon's CompIDs when one was read.
 * - loggedOn: the session is logged on; its log continues in session.watch().
 * - closed: the connection ended; sessionKey once it had a session.
 * - error: a failure outside any session (accept() throwing, settings from
 *   accept() that can't be used, the store failing to load, a watcher
 *   throwing); one without connectionId is the listening socket's own.
 * A connection is rejected at most once, and never after it closed.
 */
export type ConnectionEntry =
  | ConnectionEntryOf<'opened', {}>
  | ConnectionEntryOf<'received', { readonly bytes: Uint8Array }>
  | ConnectionEntryOf<'rejected', { readonly problem: Problem; readonly logon?: LogonIds }>
  | ConnectionEntryOf<'loggedOn', { readonly logon: LogonIds; readonly sessionKey: string }>
  | ConnectionEntryOf<'closed', { readonly sessionKey?: string }>
  | ConnectionEntryOf<'error', { readonly error: ErrorInfo }>
  | {
    readonly kind: 'connection';
    readonly event: 'error';
    readonly connectionId?: undefined;
    readonly peer?: undefined;
    readonly at: Date;
    readonly error: ErrorInfo;
    readonly problem?: undefined;
    readonly bytes?: undefined;
    readonly logon?: undefined;
    readonly sessionKey?: undefined;
  };

export interface CloseReason {
  readonly by: 'us' | 'them' | 'network';
  readonly text: string;
  readonly problem?: Problem;
}

export interface SeqNums {
  readonly next: number;
  readonly expected: number;
}

/** What a session tells its store about itself. */
export interface StoreContext {
  /** The session's custom dictionary, for encoding and decoding messages that use its fields. */
  readonly dictionary?: { readonly definition: DictionaryDef };
  /**
   * How much history the session keeps: load() need return only the newest entries within it. It
   * has no effect on sent(), which answers from everything the store keeps of the current epoch.
   */
  readonly history?: { readonly entries: number; readonly bytes: number };
}

/**
 * What a session asks its store to keep: one record per entry, or one with no
 * entry when only the sequence numbers changed (setSeqNums). A store is given
 * records in lists (see Store). A sent message's record is kept before the
 * message is written to the network.
 */
export interface StoreRecord {
  /** When it happened: the entry's own time, when there is an entry. */
  readonly at: Date;
  readonly entry?: Entry;
  /** The sequence numbers once this record is kept. */
  readonly seqNums: SeqNums;
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

/** The session's only view of the network. */
export interface Link {
  /** Resolves once the bytes are handed to the OS. */
  write(bytes: Uint8Array): Promise<void>;
  /** Close after everything written so far. */
  end(): void;
  /** Stop/restart delivering received bytes (backpressure). */
  pause?(): void;
  resume?(): void;
}

/** A function on a message route: return the message, a changed copy, null to drop it, several, or a promise (to delay). */
export type RouteFn = (message: MessageObject) =>
  | MessageObject | null | readonly MessageObject[]
  | Promise<MessageObject | null | readonly MessageObject[]>;

/** Calling it removes what was added. Also Disposable, for `using`. */
export type Remove = (() => void) & Disposable;

export function remover(fn: () => void): Remove {
  let done = false;
  const remove = () => {
    if (done) return;
    done = true;
    fn();
  };
  return Object.assign(remove, { [Symbol.dispose]: remove });
}
