import type { IndexedDictionary } from '../dictionary/index.ts';
import { parseFrame } from '../wire/frame.ts';
import { inspectMessage, type MessageObject } from '../wire/message.ts';
import { tryEncodeMessage } from './codec.ts';
import { REDACTED } from './redact.ts';
import { originalSeq } from './store-common.ts';
import type { Entry, ErrorContext, StoreRecord } from './types.ts';

// How a fileStore writes a record as one line of an epoch file, and reads it back.

/** A line longer than this is never written (a message whose line would be is kept without its frame), and is read as corruption. */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** An epoch file's first line. */
export interface EpochHeader {
  readonly epoch: number;
  readonly startedAt: string;
}

/**
 * A line of an epoch file: a header, or a record (an entry and/or the sequence numbers after it).
 * `seq` is the MsgSeqNum of the record's entry when that is an original (a sent message not marked
 * PossDupFlag), so sent() finds it without decoding the frame; lines written before `seq` have
 * none. Files from before epochs hold records only.
 */
export type StoredLine = Partial<EpochHeader> & { readonly entry?: StoredEntry; readonly next?: number; readonly expected?: number; readonly seq?: number };

/** A line as JSON, or undefined when it isn't a JSON object. */
export function parseLine(text: string): StoredLine | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as StoredLine : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A record as one line: the sequence numbers first, then the MsgSeqNum of an original whose frame
 * is kept, then the entry. Never longer than MAX_LINE_BYTES.
 */
export function recordLine(record: StoreRecord, dict: IndexedDictionary): string {
  const { next, expected } = record.seqNums;
  if (!record.entry) return JSON.stringify({ next, expected });
  const stored = toStored(record.entry, dict);
  const seq = stored.kind === 'message' && stored.frame !== null ? originalSeq(record.entry) : undefined;
  const line = JSON.stringify({ next, expected, ...(seq === undefined ? {} : { seq }), entry: stored });
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
  if (stored.kind === 'message') {
    const frameless = JSON.stringify({ next, expected, entry: { ...stored, frame: null } });
    if (Buffer.byteLength(frameless) <= MAX_LINE_BYTES) return frameless;
  }
  return JSON.stringify({ next, expected });
}

/** How a record line that names its original's MsgSeqNum begins, as recordLine writes it. */
const SEQ_IN_CLEAR = /^\{"next":-?\d+,"expected":-?\d+,"seq":([1-9]\d{0,15}),"entry":\{"kind":"message","direction":"out",/;

/**
 * The MsgSeqNum a record line names in clear, read from its first characters alone; undefined for a
 * line that names none, or names a number too large to be a whole number exactly (never one this
 * code wrote: the line is then read as one that names none).
 */
export function seqInClear(line: string): number | undefined {
  const match = SEQ_IN_CLEAR.exec(line);
  const seq = match ? Number(match[1]) : undefined;
  return Number.isSafeInteger(seq) ? seq : undefined;
}

/** `frame` is null for a message that never reached the wire and couldn't be encoded. */
export type StoredEntry =
  | { kind: 'message'; direction: 'in' | 'out'; at: string; frame: string | null; onWire: boolean }
  | { kind: 'problem'; direction: 'in'; at: string; problem: Extract<Entry, { kind: 'problem' }>['problem'] }
  | { kind: 'error'; at: string; text: string; stack?: string; during?: ErrorContext };

/** The stack kept in the store; shorter than the 4,000 chars history and watch() keep, since it's rarely needed once something is already persisted. */
const MAX_STORED_STACK = 1_000;

function toStored(entry: Entry, dict: IndexedDictionary): StoredEntry {
  if (entry.kind === 'problem') return { kind: 'problem', direction: entry.direction, at: entry.at.toISOString(), problem: entry.problem };
  if (entry.kind === 'error') return { ...entry, at: entry.at.toISOString(), ...(entry.stack === undefined ? {} : { stack: entry.stack.slice(0, MAX_STORED_STACK) }) };
  // A message that never reached the wire is stored as the bytes it would have had.
  const bytes = entry.bytes ?? tryEncodeMessage(entry.message, dict, { version: String(entry.message.BeginString ?? dict.version) });
  const frame = bytes ? Buffer.from(bytes).toString('base64') : null;
  return { kind: 'message', direction: entry.direction, at: entry.at.toISOString(), frame, onWire: entry.bytes !== undefined };
}

/** The entry a stored record describes, or undefined when it has no frame or its frame no longer decodes (the line itself is left as it is). */
export function fromStored(stored: StoredEntry, dict: IndexedDictionary): Entry | undefined {
  if (stored.kind === 'problem') return { kind: 'problem', direction: 'in', at: new Date(stored.at), problem: stored.problem };
  if (stored.kind === 'error') return { ...stored, at: new Date(stored.at) };
  if (stored.frame === null) return undefined;
  let message: MessageObject;
  let bytes: Uint8Array;
  try {
    bytes = Buffer.from(stored.frame, 'base64');
    const parsed = parseFrame(bytes, { dataTags: dict.dataTags });
    if (parsed.errors.length > 0) {
      // A BodyLength or CheckSum that no longer matches is expected for a redacted frame (redaction
      // changes the bytes without recomputing framing); anything else that fails to parse is real
      // corruption (a hand-edited or torn frame, say) and must not be restored, let alone resent.
      const looksRedacted = Buffer.from(bytes).toString('latin1').includes(`=${REDACTED}\x01`);
      if (!looksRedacted || parsed.fields[0]?.tag !== 8 || parsed.fields.at(-1)?.tag !== 10) return undefined;
    }
    message = inspectMessage(parsed.fields, dict).message;
  } catch {
    return undefined;
  }
  const at = new Date(stored.at);
  return stored.onWire ? { kind: 'message', direction: stored.direction, at, message, bytes } : { kind: 'message', direction: stored.direction, at, message };
}
