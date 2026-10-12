import { DEFAULT_HISTORY } from './log.ts';
import { entrySize } from './size.ts';
import { byId, checkReadOptions, checkRecords, checkSentRange, empty, inRange, newest, originalSeq, sessionKey } from './store-common.ts';
import type { Entry, SessionId, Store, StoreRecord } from './types.ts';

export interface MemoryStoreOptions {
  /**
   * Entries kept per session, of every kind and in both directions, but no message sent with
   * PossDupFlag; the oldest are dropped. Default 1,000. Sequence numbers are always kept in full. A
   * resend reaches no further back than the entries kept.
   */
  history?: number;
  /** Bytes of entries kept per session; the oldest are dropped once over. Default 1 MiB. An entry without wire bytes counts as 256 (matching FixSession's own accounting). A resend reaches no further back than this either. */
  historyBytes?: number;
  /** Sessions kept; past this, the least recently loaded or appended-to session is forgotten. Default 1,000. */
  sessions?: number;
}

/** An entry a memoryStore keeps, with the epoch it belongs to. */
interface Kept {
  readonly epoch: number;
  readonly entry: Entry;
  readonly size: number;
}

/** One epoch of a memoryStore session: when it began, and how many of its entries are still kept. */
interface MemoryEpoch {
  readonly epoch: number;
  readonly startedAt: Date;
  entries: number;
}

interface MemorySession {
  readonly id: SessionId;
  /** Oldest first, across epochs; bounded by `history` and `historyBytes`. */
  readonly kept: Kept[];
  bytes: number;
  /** The epochs that still have an entry kept, and always the current one (the last); oldest first. */
  readonly epochs: MemoryEpoch[];
  next: number;
  expected: number;
}

/**
 * Keeps everything in memory: the default. Bounded per session (count and bytes)
 * and in how many sessions it keeps, so a long-running host that sees many
 * CompIDs doesn't grow without limit. Its entries are its own copy, kept
 * separately from each session's history. At its defaults it can hold about
 * 1 GiB of wire bytes (1,000 sessions × 1 MiB); the heap holds about 5–15× the
 * wire bytes per entry. Epochs it no longer keeps an entry of are forgotten.
 * read() reads a snapshot of what it keeps, taken when the read begins: it
 * sees nothing appended while it is going. sent() answers with what is kept
 * of the current epoch, chosen when it is called: entries of every kind and
 * both directions count toward the limits, so a resend reaches no further
 * back than they do. Each gives nothing more once the session is reset, or
 * forgotten for the limit on sessions, while its reader pauses.
 *
 * A message sent with PossDupFlag (a copy that answers a ResendRequest, the
 * SequenceReset-GapFill sent in its place, or a message the program itself
 * sends with PossDupFlag) is not kept: answering a ResendRequest never pushes
 * out the originals another one may ask for. Its record's sequence numbers
 * still count, and a record with `newEpoch` still begins an epoch. So read()
 * and load() show no such message, while a session's history and watch() do;
 * a file store keeps them. With either store, a message the program sent with
 * PossDupFlag is not an original, and a resend answers its MsgSeqNum with a
 * gap fill.
 */
export function memoryStore(options: MemoryStoreOptions = {}): Store {
  const limit = options.history ?? 1_000;
  const byteLimit = options.historyBytes ?? 1_048_576;
  const sessionLimit = options.sessions ?? 1_000;
  // A Map iterates in insertion order; re-inserting on every use keeps the least recently used first.
  const sessions = new Map<string, MemorySession>();
  /** The session, marked as the most recently used; created only when `create`. */
  const use = (id: SessionId, create: boolean): MemorySession | undefined => {
    const key = sessionKey(id);
    let session = sessions.get(key);
    if (session) {
      sessions.delete(key);
    } else {
      if (!create) return undefined;
      session = { id: { version: id.version, sender: id.sender, target: id.target }, kept: [], bytes: 0, epochs: [], next: 1, expected: 1 };
      while (sessions.size >= sessionLimit) {
        const oldest = sessions.keys().next();
        if (oldest.done) break;
        sessions.delete(oldest.value);
      }
    }
    sessions.set(key, session);
    return session;
  };
  /** Keeps one record of a session: its entry, unless it was sent again, and its sequence numbers; begins an epoch where the record says so. */
  const keep = (session: MemorySession, record: StoreRecord): void => {
    // An epoch with nothing left in it is forgotten, unless it is the current one.
    const last = session.epochs.at(-1);
    if (!last || record.newEpoch) {
      if (last && last.entries === 0) session.epochs.pop();
      session.epochs.push({ epoch: (last?.epoch ?? 0) + 1, startedAt: record.at, entries: 0 });
    }
    const current = session.epochs.at(-1)!;
    if (record.entry && !sentAgain(record.entry)) {
      const size = entrySize(record.entry);
      session.kept.push({ epoch: current.epoch, entry: record.entry, size });
      session.bytes += size;
      current.entries++;
      while (session.kept.length > limit || session.bytes > byteLimit) {
        const removed = session.kept.shift();
        if (!removed) break;
        session.bytes -= removed.size;
        const index = session.epochs.findIndex(each => each.epoch === removed.epoch);
        const epoch = session.epochs[index];
        if (epoch && --epoch.entries === 0 && epoch !== current) session.epochs.splice(index, 1);
      }
    }
    session.next = record.seqNums.next;
    session.expected = record.seqNums.expected;
  };
  return {
    async load(id, context) {
      const session = use(id, false);
      if (!session) return empty();
      const current = session.epochs.at(-1)?.epoch;
      const entries = session.kept.filter(kept => kept.epoch === current).map(kept => kept.entry);
      return { history: newest(entries, context?.history ?? DEFAULT_HISTORY), next: session.next, expected: session.expected };
    },
    async append(id, records) {
      const list = checkRecords(records);
      const session = use(id, true)!;
      for (const record of list) keep(session, record);
    },
    async *read(id, options = {}) {
      const range = checkReadOptions(options);
      const key = sessionKey(id);
      const session = sessions.get(key);
      if (!session) return;
      // A copy: appends made while the reader pauses drop the oldest entries from the original.
      for (const kept of [...session.kept]) {
        if (range.epoch !== undefined && kept.epoch !== range.epoch) continue;
        if (!inRange(kept.entry, range)) continue;
        // A session reset or forgotten while the reader paused is gone, and one begun again under the same id is another.
        if (sessions.get(key) !== session) return;
        yield kept.entry;
      }
    },
    async *sent(id, range) {
      const { from, to } = checkSentRange(range);
      const key = sessionKey(id);
      const session = sessions.get(key);
      if (!session) return;
      const current = session.epochs.at(-1)?.epoch;
      // Chosen before the first is given: appends made while the reader pauses change nothing here.
      const latest = new Map<number, Entry>();
      for (const kept of session.kept) {
        if (kept.epoch !== current) continue;
        const seq = originalSeq(kept.entry);
        if (seq !== undefined && seq >= from && seq <= to) latest.set(seq, kept.entry);
      }
      for (const seq of [...latest.keys()].sort((a, b) => a - b)) {
        // A session reset or forgotten while the reader paused is gone, and one begun again under the same id is another.
        if (sessions.get(key) !== session) return;
        yield latest.get(seq)!;
      }
    },
    async list() {
      return [...sessions.values()]
        .map(session => ({ id: session.id, epochs: session.epochs.map(({ epoch, startedAt, entries }) => ({ epoch, startedAt, entries })) }))
        .sort(byId);
    },
    async reset(id) {
      sessions.delete(sessionKey(id));
    },
  };
}

/** Whether an entry is a message the session sent with PossDupFlag: a memoryStore keeps none of those. */
function sentAgain(entry: Entry): boolean {
  return entry.kind === 'message' && entry.direction === 'out' && entry.message.PossDupFlag === true;
}
