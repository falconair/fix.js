import type { IndexedDictionary } from '../dictionary/index.ts';
import type { Problem } from '../session/types.ts';
import { parseFrame } from '../wire/frame.ts';
import type { MessageObject } from '../wire/message.ts';
import { checkRedact } from './options.ts';
import type { Entry } from './types.ts';

/** What a hidden value is replaced with. */
export const REDACTED = '*****';

/** Which tags to hide: in every message, and in Logon messages only. */
export interface Redaction {
  readonly always: ReadonlySet<number>;
  readonly logon: ReadonlySet<number>;
}

/**
 * Password (554), NewPassword (925), EncryptedPassword (1402) and EncryptedNewPassword (1404)
 * everywhere; RawDataLength (95) and RawData (96) in Logons.
 */
export const DEFAULT_REDACTION: Redaction = { always: new Set([554, 925, 1402, 1404]), logon: new Set([95, 96]) };

/**
 * What a `redact` option asks for: the default when it's left out, these
 * tags in every message for a list, and nothing for false. RangeError for
 * anything that isn't a tag number.
 */
export function redaction(option: readonly number[] | false | undefined): Redaction | undefined {
  checkRedact(option, 'redact');
  if (option === undefined) return DEFAULT_REDACTION;
  if (option === false) return undefined;
  return { always: new Set(option), logon: new Set() };
}

/** An entry as it may be recorded and shown: hidden values replaced in its message and its bytes. Other entries are returned as they are. */
export function redactEntry(entry: Entry, rules: Redaction, dict: IndexedDictionary): Entry {
  if (entry.kind !== 'message') return entry;
  const message = redactMessage(entry.message, rules, dict);
  const bytes = entry.bytes === undefined ? undefined : redactBytes(entry.bytes, rules, dict.dataTags);
  if (message === entry.message && bytes === entry.bytes) return entry;
  return bytes === undefined ? { ...entry, message } : { ...entry, message, bytes };
}

/** A frozen copy with hidden values replaced (groups included), or the message itself when it has none. */
export function redactMessage(message: MessageObject, rules: Redaction, dict: IndexedDictionary): MessageObject {
  return redactFields(message, keysFor(message, rules, dict)) ?? message;
}

/**
 * Whether any value of a message is the mask, in any field and at any depth of its groups: it was
 * kept with a value hidden, under whatever rules were in force then, so it must not be resent. A
 * real value that happens to be the mask counts too.
 */
export function hasRedactedValue(message: MessageObject): boolean {
  return Object.values(message).some(value => value === REDACTED
    || (Array.isArray(value) && value.some(item => item === REDACTED || (isFields(item) && hasRedactedValue(item)))));
}

/**
 * The bytes with hidden values replaced, frame by frame. A frame is read the
 * way parseFrame reads it: a data field by the length before it, so an SOH
 * inside it is kept whole. Whether a frame is a Logon (so the Logon-only tags
 * apply) is decided by the MsgType anywhere in it, not by where 35 sits.
 *
 * When a data field is hidden but its length isn't, the length is rewritten
 * to the mask's length, so the frame still parses. BodyLength and CheckSum
 * are left as they were: redacted bytes no longer pass the checksum.
 *
 * A frame that fails to parse is masked from its first hidden or data field,
 * or from where reading its fields stopped (a data field longer or shorter
 * than its length, a field cut short or garbled), whichever comes first: what
 * follows can't be told apart. With `wire` (bytes as read from the network),
 * a frame whose BodyLength or CheckSum doesn't match fails too; without it,
 * those are left alone, since redacted bytes no longer pass their checksum.
 * Bytes that aren't a frame are copied as they are up to the first field
 * that would be hidden or is a data field, and masked from there. Returns the
 * same bytes when there is nothing to hide.
 */
export function redactBytes(bytes: Uint8Array, rules: Redaction, dataTags: ReadonlySet<number>, options: { readonly wire?: boolean } = {}): Uint8Array {
  const text = Buffer.from(bytes).toString('latin1');
  let out = '';
  let changed = false;
  for (let start = 0; start < text.length;) {
    const end = segmentEnd(text, start);
    const segment = text.slice(start, end);
    const redacted = redactSegment(segment, rules, dataTags, options.wire ?? false);
    if (redacted !== segment) changed = true;
    out += redacted;
    start = end;
  }
  return changed ? Buffer.from(out, 'latin1') : bytes;
}

const SOH = '\x01';
const BEGIN = '8=FIX';
/** BeginString and BodyLength at the start of a frame. */
const FRAME_HEADER = /^8=[^\x01]{1,32}\x019=(\d{1,9})\x01/;
/** "10=" + three digits + SOH */
const TRAILER_LENGTH = 7;

/**
 * Where the piece of `text` starting at `start` ends: a frame's own end when
 * its BodyLength leads to its CheckSum, otherwise the next '8=FIX' (or the end).
 */
function segmentEnd(text: string, start: number): number {
  if (text.startsWith(BEGIN, start)) {
    const header = FRAME_HEADER.exec(text.slice(start, start + 64));
    if (header) {
      const end = start + header[0].length + Number(header[1]) + TRAILER_LENGTH;
      if (end <= text.length && text.startsWith('10=', end - TRAILER_LENGTH) && text[end - 1] === SOH) return end;
    }
  }
  const next = text.indexOf(BEGIN, start + 1);
  return next < 0 ? text.length : next;
}

interface FieldAt {
  readonly tag: number;
  readonly valueStart: number;
  readonly valueEnd: number;
  /** Read by the length before it. */
  readonly data: boolean;
}

/** The fields of one piece of text, read as parseFrame reads them; `failedAt` is where reading stopped, when it did. */
function readFields(text: string, dataTags: ReadonlySet<number>): { fields: FieldAt[]; failedAt?: number } {
  const fields: FieldAt[] = [];
  let pos = 0;
  while (pos < text.length) {
    const equals = text.indexOf('=', pos);
    if (equals < 0 || !/^\d+$/.test(text.slice(pos, equals))) return { fields, failedAt: pos };
    const tag = Number(text.slice(pos, equals));
    const previous = fields.at(-1);
    const length = previous === undefined ? undefined : text.slice(previous.valueStart, previous.valueEnd);
    const data = dataTags.has(tag) && length !== undefined && /^\d+$/.test(length);
    const end = data ? equals + 1 + Number(length) : text.indexOf(SOH, equals + 1);
    if (end < 0 || end >= text.length || text[end] !== SOH) return { fields, failedAt: pos };
    fields.push({ tag, valueStart: equals + 1, valueEnd: end, data });
    pos = end + 1;
  }
  return { fields };
}

/** One frame (or a run of other bytes) with its hidden values replaced. */
function redactSegment(text: string, rules: Redaction, dataTags: ReadonlySet<number>, wire: boolean): string {
  const { fields, failedAt } = readFields(text, dataTags);
  if (failedAt !== undefined || (wire && parseFrame(text, { dataTags }).errors.length > 0)) {
    const sensitive = (tag: number) => rules.always.has(tag) || rules.logon.has(tag) || dataTags.has(tag);
    let cut = failedAt !== undefined && text.startsWith(BEGIN) ? failedAt : text.length;
    // Every place a field could start, read loosely: a tag number at the start or after an SOH, or
    // anywhere a tag number is followed by '=' (an SOH may itself be what was garbled).
    for (const match of text.matchAll(/(?:^|\x01)(\d+)(?=\D|$)|(?<!\d)(\d+)(?==)/g)) {
      const tag = match[1] ?? match[2]!;
      const at = match.index + match[0].length;
      if (at >= cut) break;
      if (sensitive(Number(tag))) {
        cut = text[at] === '=' ? at + 1 : at;
        break;
      }
    }
    return cut >= text.length ? text : `${text.slice(0, cut)}${REDACTED}`;
  }
  const logon = fields.some(field => field.tag === 35 && text.slice(field.valueStart, field.valueEnd) === 'A');
  const hidden = (tag: number) => rules.always.has(tag) || (logon && rules.logon.has(tag));
  let out = '';
  let copied = 0;
  fields.forEach((field, index) => {
    if (!hidden(field.tag)) return;
    const length = fields[index - 1];
    if (field.data && length !== undefined && !hidden(length.tag)) {
      out += `${text.slice(copied, length.valueStart)}${REDACTED.length}`;
      copied = length.valueEnd;
    }
    out += `${text.slice(copied, field.valueStart)}${REDACTED}`;
    copied = field.valueEnd;
  });
  return out + text.slice(copied);
}

/**
 * A problem whose text quotes a value `message` carries under a hidden field
 * (a decode problem quoting the bad wire text, a refusal quoting a password)
 * has it masked (see redactText). The problem itself when there's nothing to mask.
 */
export function maskProblem(problem: Problem, message: MessageObject, rules: Redaction, dict: IndexedDictionary): Problem {
  const text = redactText(problem.text, message, rules, dict);
  return text === problem.text ? problem : { ...problem, text };
}

/**
 * An error whose message (and stack, which often repeats it) quotes a value
 * `message` carries under a hidden field, masked the same way (see
 * redactText). The masked copy keeps the original's prototype and own
 * properties (so `instanceof FIXEncodeError` still holds); only message and
 * stack differ. The error itself when there's nothing to mask (not an Error,
 * or no match).
 */
export function maskError(error: unknown, message: MessageObject, rules: Redaction, dict: IndexedDictionary): unknown {
  if (!(error instanceof Error)) return error;
  const text = redactText(error.message, message, rules, dict);
  const stack = typeof error.stack === 'string' ? redactText(error.stack, message, rules, dict) : error.stack;
  if (text === error.message && stack === error.stack) return error;
  const masked = Object.create(Object.getPrototypeOf(error)) as Error;
  for (const key of Reflect.ownKeys(error)) {
    Object.defineProperty(masked, key, Object.getOwnPropertyDescriptor(error, key)!);
  }
  Object.defineProperty(masked, 'message', { value: text, writable: true, enumerable: false, configurable: true });
  if (stack !== undefined) Object.defineProperty(masked, 'stack', { value: stack, writable: true, enumerable: false, configurable: true });
  return masked;
}

/**
 * Masks, inside `text`, any value this redaction would hide for `message`,
 * where the text quotes it the way fix.js's own errors and problems do:
 * 'value', "value", a string's JSON form, or `number value` for a number.
 * For an error or problem whose own text echoes a value that should have
 * been hidden (an encode error reporting what it couldn't encode, a decode
 * problem quoting the bad wire text), not for redacting the entry itself.
 *
 * Not masked: values shorter than 4 characters (a short match is more likely
 * incidental than a leak), and a value echoed in any other form (unquoted,
 * say: a handler's `new Error('bad ' + message.Password)`). Only
 * the quoted forms are masked so that a value which is also an ordinary word
 * (a Password of 'Logon') doesn't mangle unrelated text.
 */
export function redactText(text: string, message: MessageObject, rules: Redaction, dict: IndexedDictionary): string {
  let out = text;
  for (const key of keysFor(message, rules, dict)) {
    const value = message[key];
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const str = String(value);
    if (str.length < 4) continue;
    const forms: [string, string][] = typeof value === 'string'
      ? [[JSON.stringify(str), `"${REDACTED}"`], [`'${str}'`, `'${REDACTED}'`], [`"${str}"`, `"${REDACTED}"`]]
      : [[`number ${str}`, `number ${REDACTED}`], [`'${str}'`, `'${REDACTED}'`], [`"${str}"`, `"${REDACTED}"`]];
    for (const [form, mask] of forms) out = out.split(form).join(mask);
  }
  return out;
}

/** The message keys hidden values may sit under: each tag's field name, and the tag number for raw tags. */
function keysFor(message: MessageObject, rules: Redaction, dict: IndexedDictionary): string[] {
  const tags = message.MsgType === 'Logon' ? [...rules.always, ...rules.logon] : [...rules.always];
  return tags.flatMap(tag => {
    const name = dict.fieldByTag.get(tag)?.name;
    return name === undefined ? [String(tag)] : [name, String(tag)];
  });
}

function redactFields(fields: MessageObject, keys: readonly string[]): MessageObject | undefined {
  let copy: Record<string, unknown> | undefined;
  for (const key of keys) {
    const value = fields[key];
    if (value === undefined || value === null || value === REDACTED) continue;
    copy ??= { ...fields };
    copy[key] = REDACTED;
  }
  for (const [key, value] of Object.entries(fields)) {
    if (!Array.isArray(value)) continue;
    let changed = false;
    const items = value.map(item => {
      const redacted = isFields(item) ? redactFields(item, keys) : undefined;
      if (redacted) changed = true;
      return redacted ?? item;
    });
    if (changed) {
      copy ??= { ...fields };
      copy[key] = items;
    }
  }
  return copy === undefined ? undefined : Object.freeze(copy);
}

function isFields(value: unknown): value is MessageObject {
  return value !== null && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value);
}
