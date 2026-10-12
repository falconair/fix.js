import { checkKnownKeys, describe, isObject, plainObject, wholeNumber } from './options.ts';
import type { LogLimits } from './log.ts';
import { entrySize } from './size.ts';
import type { Entry, SessionId, StoredSession, StoreReadOptions, StoreRecord } from './types.ts';

// What memoryStore and fileStore share: session keys and order, read()'s options, and what a store holds for a session it has nothing for.

/** A session's key: its version and CompIDs, exactly. */
export const sessionKey = (id: SessionId) => JSON.stringify([id.version, id.sender, id.target]);

/** Sessions in a steady order: by version, then our CompID, then theirs. */
export function byId(a: StoredSession, b: StoredSession): number {
  const [x, y] = [sessionKey(a.id), sessionKey(b.id)];
  return x < y ? -1 : x > y ? 1 : 0;
}

const READ_KEYS: readonly string[] = Object.keys({ from: 1, to: 1, epoch: 1 } satisfies Record<keyof StoreReadOptions, 1>);

/** read()'s options, checked: RangeError for a key it doesn't know or a value of the wrong kind. */
export function checkReadOptions(options: unknown): StoreReadOptions {
  const o = plainObject(options, 'read() options', 'an object of options');
  checkKnownKeys(o, READ_KEYS, 'read() options');
  for (const key of ['from', 'to'] as const) {
    const value = o[key];
    if (value !== undefined && !(value instanceof Date && !Number.isNaN(value.getTime()))) throw new RangeError(`read() ${key} must be a Date, got ${describe(value)}`);
  }
  if (o.epoch !== undefined) wholeNumber(o.epoch, 'read() epoch', 1);
  return o as StoreReadOptions;
}

/** Whether an entry falls within read()'s `from` and `to`. */
export function inRange(entry: Entry, { from, to }: StoreReadOptions): boolean {
  const at = entry.at.getTime();
  return (from === undefined || at >= from.getTime()) && (to === undefined || at <= to.getTime());
}

const SENT_KEYS: readonly string[] = ['from', 'to'];

/** sent()'s range, checked: RangeError for anything but whole numbers with 1 <= from <= to. */
export function checkSentRange(range: unknown): { readonly from: number; readonly to: number } {
  const o = plainObject(range, 'sent() range', 'an object with from and to');
  checkKnownKeys(o, SENT_KEYS, 'sent() range');
  const from = wholeNumber(o.from, 'sent() from', 1);
  return { from, to: wholeNumber(o.to, 'sent() to', from) };
}

/**
 * append()'s records, checked, as a list of the store's own: what the caller does with its array
 * after the call changes nothing. RangeError for anything but a list with a record in it (a store
 * written for a list is told at once when it is given one record), and for a place in the list that
 * holds no record: a hole, something that is not an object, or one without its time (`at`, a Date)
 * or the sequence numbers after it (`seqNums`, whole numbers of at least 1). The error says which
 * record, counted from 1. A record's entry is not looked at here.
 */
export function checkRecords(records: unknown): readonly StoreRecord[] {
  if (!Array.isArray(records)) throw new RangeError(`append() takes a list of records, got ${describe(records)}`);
  if (records.length === 0) throw new RangeError('append() takes a list with a record in it, got an empty list');
  const list: StoreRecord[] = [];
  for (let index = 0; index < records.length; index++) {
    const record: unknown = records[index];
    const name = `append() record ${index + 1} of ${records.length}`;
    if (!isObject(record) || Array.isArray(record)) throw new RangeError(`${name} must be a record, got ${describe(record)}`);
    const { at, seqNums } = record;
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new RangeError(`${name} must have at, a Date, got ${describe(at)}`);
    if (!isObject(seqNums)) throw new RangeError(`${name} must have seqNums, the sequence numbers after it, got ${describe(seqNums)}`);
    wholeNumber(seqNums.next, `${name} seqNums.next`, 1);
    wholeNumber(seqNums.expected, `${name} seqNums.expected`, 1);
    list.push(record as unknown as StoreRecord);
  }
  return list;
}

/**
 * The MsgSeqNum of an original: a message the session sent (direction 'out') that is not marked
 * PossDupFlag and has a whole MsgSeqNum of 1 or more. Undefined for any other entry.
 */
export function originalSeq(entry: Entry): number | undefined {
  if (entry.kind !== 'message' || entry.direction !== 'out' || entry.message.PossDupFlag === true) return undefined;
  const seq = entry.message.MsgSeqNum;
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 1 ? seq : undefined;
}

/** What a store holds for a session it has nothing for. */
export const empty = (): { history: Entry[]; next: number; expected: number } => ({ history: [], next: 1, expected: 1 });

/** The newest entries of `entries` (oldest first) within `limits`, oldest first. */
export function newest(entries: readonly Entry[], limits: LogLimits): Entry[] {
  const out: Entry[] = [];
  let bytes = 0;
  for (let index = entries.length - 1; index >= 0 && out.length < limits.entries; index--) {
    const entry = entries[index]!;
    bytes += entrySize(entry);
    if (bytes > limits.bytes) break;
    out.push(entry);
  }
  return out.reverse();
}
