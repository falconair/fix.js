import type { DictionaryDef } from '../dictionary/define.ts';
import { kindOf } from '../dictionary/datatypes.ts';
import type { IndexedDictionary } from '../dictionary/index.ts';
import { PROBLEM_ACTIONS, PROBLEM_CODES, type Problem, type ProblemCode } from '../session/types.ts';
import { isVersion, oneOf, VERSIONS, type Version } from '../version.ts';
import type { MessageObject } from '../wire/message.ts';
import { describe, isPlainObject, usableDictionary } from './options.ts';
import type { ConnectionEntry, Entry, ErrorContext, ErrorInfo, LogonIds, Peer } from './types.ts';

/**
 * An entry, or a connection entry, as plain JSON: the same fields, with every
 * Date as ISO 8601 text and every byte array as base64. Ready for
 * JSON.stringify(); entryFromJSON() turns it back.
 */
export interface EntryJSON {
  readonly kind: 'message' | 'problem' | 'error' | 'connection';
  readonly at: string;
  readonly [key: string]: unknown;
}

/** A value as JSON: Dates as ISO 8601 text, byte arrays as base64, objects and arrays field by field. */
function toJSON(value: unknown): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Array.isArray(value)) return value.map(toJSON);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      if (field !== undefined && key !== '__proto__') out[key] = toJSON(field);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/**
 * An entry (from history, watch() or a store) or a connection entry (from
 * server.watch()) as plain JSON. A message's fields keep their names; a
 * timestamp field is ISO 8601 text, which entryFromJSON() turns back into a
 * Date. rawValue() (wire/message.ts) is not carried: only a decoded value and,
 * for a received message, its wire bytes.
 */
export function entryToJSON(entry: Entry | ConnectionEntry): EntryJSON {
  return toJSON(entry) as EntryJSON;
}

/** A RangeError that says what entryFromJSON() was given instead. */
function wrong(what: string, value: unknown): RangeError {
  return new RangeError(`entryFromJSON: ${what}, got ${describe(value)}`);
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw wrong(`${what} must be an object`, value);
  return value;
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') throw wrong(`${what} must be text`, value);
  return value;
}

function number(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw wrong(`${what} must be a finite number`, value);
  return value;
}

/** peer.port: a whole number in the range a TCP port can actually hold. */
function port(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 65535) {
    throw wrong('peer.port must be an integer from 0 to 65535', value);
  }
  return value;
}

/**
 * ISO 8601 with an explicit zone (`Z` or `±HH:MM`): what entryToJSON() always
 * writes. Anything Date's own lenient parser would otherwise accept — a bare
 * number, a weekday-named string, a date with no zone (whose meaning would
 * depend on the machine's local time zone) — is refused instead.
 */
const STRICT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function date(value: unknown, what: string): Date {
  const parsed = typeof value === 'string' && STRICT_ISO.test(value) ? new Date(value) : undefined;
  if (!parsed || Number.isNaN(parsed.getTime())) throw wrong(`${what} must be an ISO 8601 time`, value);
  return parsed;
}

/**
 * The base64 alphabet and padding characters, checked as one flat character
 * class (no nested, repeated groups) so a huge string can't send a
 * backtracking regex engine into runaway recursion of its own.
 */
const BASE64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;

function bytes(value: unknown, what: string): Buffer {
  if (typeof value !== 'string' || !BASE64_CHARS.test(value) || value.length % 4 !== 0) throw wrong(`${what} must be base64`, value);
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (value.slice(0, value.length - padding).includes('=')) throw wrong(`${what} must be base64`, value);   // '=' only as trailing padding
  const decoded = Buffer.from(value, 'base64');
  // Buffer's decoder accepts more than the checks above let through (stray bits in the last group,
  // say); re-encoding and comparing catches anything that isn't the canonical text for its bytes.
  if (decoded.toString('base64') !== value) throw wrong(`${what} must be base64`, value);
  return decoded;
}

function direction(value: unknown): 'in' | 'out' {
  if (value !== 'in' && value !== 'out') throw wrong("direction must be 'in' or 'out'", value);
  return value;
}

function problem(value: unknown): Problem {
  const o = object(value, 'problem');
  const code = text(o.code, 'problem.code');
  if (!PROBLEM_CODES.includes(code)) throw wrong('problem.code must be a known problem code', code);
  const action = text(o.action, 'problem.action');
  if (!(PROBLEM_ACTIONS as readonly string[]).includes(action)) throw wrong('problem.action must be a known action', action);
  const refSeqNum = o.refSeqNum === undefined ? undefined : number(o.refSeqNum, 'problem.refSeqNum');
  return {
    code: code as ProblemCode,
    text: text(o.text, 'problem.text'),
    action: action as Problem['action'],
    ...(refSeqNum === undefined ? {} : { refSeqNum }),
  };
}

function errorInfo(value: unknown, what: string): ErrorInfo {
  const o = object(value, what);
  return { text: text(o.text, `${what}.text`), ...(o.stack === undefined ? {} : { stack: text(o.stack, `${what}.stack`) }) };
}

/** `during`, rebuilt field by field from its three known names; anything else present is dropped, not carried through. */
function errorContext(value: unknown): ErrorContext {
  const o = object(value, 'during');
  return {
    ...(o.MsgType === undefined ? {} : { MsgType: text(o.MsgType, 'during.MsgType') }),
    ...(o.MsgSeqNum === undefined ? {} : { MsgSeqNum: number(o.MsgSeqNum, 'during.MsgSeqNum') }),
    ...(o.ClOrdID === undefined ? {} : { ClOrdID: text(o.ClOrdID, 'during.ClOrdID') }),
  };
}

/** How deep a message's groups may nest; well short of a real call-stack limit, so a RangeError is what a deeply nested input gets, not a native stack overflow. */
const MAX_GROUP_DEPTH = 32;

/**
 * A field value as entryFromJSON() accepts it: a string, a finite number, a
 * boolean, or an array of strings (a multi-value field). The shape only, never
 * the FIX type — a message that was malformed on the wire can legitimately
 * decode a numeric or boolean field as raw text, and that must still load. A
 * bare object is never a field value: only a dictionary-known group may hold
 * objects (see fields() below), which closes the __proto__-as-field-value route.
 */
function fieldValue(value: unknown, what: string): unknown {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw wrong(`${what} must be a string, a finite number, a boolean or an array of strings`, value);
    return value;
  }
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value;
  throw wrong(`${what} must be a string, a finite number, a boolean or an array of strings`, value);
}

/**
 * A message's fields from JSON. Text in a timestamp field (by the dictionary)
 * becomes a Date again; a dictionary-known group is an array, read entry by
 * entry up to MAX_GROUP_DEPTH levels deep; every other field is validated by
 * fieldValue() (shape only, never the FIX type). Frozen, like a decoded message.
 */
function message(value: unknown, dict: IndexedDictionary): MessageObject {
  const fields = (o: Record<string, unknown>, depth: number): MessageObject => {
    if (depth > MAX_GROUP_DEPTH) throw wrong(`message groups must not nest more than ${MAX_GROUP_DEPTH} levels deep`, `${depth} levels`);
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(o)) {
      if (key === '__proto__') continue;   // never a field; assigning it would replace the object's prototype
      // A name can be both a group and a field (RateSource, in FIX 5.0 SP2): it is the group where its value is a list of entries.
      const isField = dict.fieldByName.has(key) && !(Array.isArray(field) && field.every(isPlainObject));
      if (dict.groupByName.has(key) && !isField) {
        if (!Array.isArray(field)) throw wrong(`message.${key} must be an array`, field);
        out[key] = Object.freeze(field.map(item => fields(object(item, `an entry of ${key}`), depth + 1)));
        continue;
      }
      const info = dict.fieldByName.get(key);
      if (typeof field === 'string' && info && kindOf(info) === 'timestamp') out[key] = date(field, `message.${key}`);
      else out[key] = fieldValue(field, `message.${key}`);
    }
    return Object.freeze(out);
  };
  return fields(object(value, 'message'), 0);
}

/** The dictionary a message of `version` is read with; a RangeError when `dictionary`'s custom fields cannot be added to it. */
function dictionaryOf(version: Version, dictionary: { readonly definition: DictionaryDef } | undefined): IndexedDictionary {
  try {
    return usableDictionary(version, dictionary);
  } catch (error) {
    throw new RangeError(`entryFromJSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const EVENTS = new Set(['opened', 'received', 'rejected', 'loggedOn', 'closed', 'error']);

function connectionEntry(o: Record<string, unknown>, at: Date): ConnectionEntry {
  const event = o.event;
  if (typeof event !== 'string' || !EVENTS.has(event)) throw wrong('event must be a connection event', event);
  const peer = o.peer === undefined ? undefined : object(o.peer, 'peer');
  const entry: Record<string, unknown> = {
    kind: 'connection', event,
    ...(o.connectionId === undefined ? {} : { connectionId: text(o.connectionId, 'connectionId') }),
    ...(peer === undefined ? {} : { peer: { address: text(peer.address, 'peer.address'), port: port(peer.port) } satisfies Peer }),
    at,
    ...(o.problem === undefined ? {} : { problem: problem(o.problem) }),
    ...(o.bytes === undefined ? {} : { bytes: bytes(o.bytes, 'bytes') }),
    ...(o.sessionKey === undefined ? {} : { sessionKey: text(o.sessionKey, 'sessionKey') }),
    ...(o.error === undefined ? {} : { error: errorInfo(o.error, 'error') }),
  };
  if (o.logon !== undefined) {
    const logon = object(o.logon, 'logon');
    entry.logon = {
      BeginString: text(logon.BeginString, 'logon.BeginString'),
      SenderCompID: text(logon.SenderCompID, 'logon.SenderCompID'),
      TargetCompID: text(logon.TargetCompID, 'logon.TargetCompID'),
    } satisfies LogonIds;
  }
  return entry as ConnectionEntry;
}

/**
 * The entry entryToJSON() gave as JSON (or JSON.parse() read back). A
 * message's timestamp fields become Dates again, by the standard dictionary for
 * its BeginString with `dictionary`'s custom fields added. RangeError, saying
 * what is wrong, for anything that isn't such an entry, and for a `dictionary`
 * whose fields cannot be added to the dictionary of the message's BeginString.
 *
 * `json` is untrusted input, not a stored entry: its shape is checked field by
 * field, but a message's fields and its `bytes` are never checked against each
 * other (a frame that doesn't match the fields is not an error here — restoring
 * a stored entry from its own frame, where that matters, is stored-entry.ts's job).
 * rawValue() (wire/message.ts) cannot be recovered: only a decoded value and,
 * for a received message, its wire bytes survive the round trip. Callers
 * decoding text from an untrusted source should cap its size before
 * JSON.parse(); entryFromJSON() bounds what it builds from the parsed value
 * (base64 is decoded once, group nesting is capped), but JSON.parse() itself
 * has already read the whole text by the time entryFromJSON() sees it.
 */
export function entryFromJSON(json: unknown, dictionary?: { readonly definition: DictionaryDef }): Entry | ConnectionEntry {
  const o = object(json, 'an entry');
  const at = date(o.at, 'at');
  switch (o.kind) {
    case 'message': {
      const raw = object(o.message, 'message');
      const dir = direction(o.direction);
      if (typeof raw.MsgType !== 'string' || raw.MsgType === '') throw wrong('message.MsgType must be text', raw.MsgType);
      if (raw.BeginString !== undefined && !isVersion(raw.BeginString)) {
        throw wrong(`message.BeginString must be a supported version (${oneOf(VERSIONS)})`, raw.BeginString);
      }
      const version = isVersion(raw.BeginString) ? raw.BeginString : 'FIX.4.4';
      const entry = { kind: 'message' as const, direction: dir, at, message: message(raw, dictionaryOf(version, dictionary)) };
      return o.bytes === undefined ? entry : { ...entry, bytes: bytes(o.bytes, 'bytes') };
    }
    case 'problem':
      if (o.direction !== 'in') throw wrong("a problem's direction must be 'in'", o.direction);
      return { kind: 'problem', direction: 'in', at, problem: problem(o.problem) };
    case 'error': {
      const { text: errorText, stack } = errorInfo(o, 'an error entry');
      const during = o.during === undefined ? undefined : errorContext(o.during);
      return { kind: 'error', at, text: errorText, ...(stack === undefined ? {} : { stack }), ...(during === undefined ? {} : { during }) };
    }
    case 'connection':
      return connectionEntry(o, at);
    default:
      throw wrong("kind must be 'message', 'problem', 'error' or 'connection'", o.kind);
  }
}
