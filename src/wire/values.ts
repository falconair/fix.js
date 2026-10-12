import type { FieldInfo, UnionType } from '../dictionary/model.ts';
import { INTEGER_TYPES, kindOf } from '../dictionary/datatypes.ts';
import { FIXEncodeError } from '../errors.ts';
import { suggest } from '../util/suggest.ts';

/** Wire text (latin1, one char per byte) for a field's value. Throws FIXEncodeError for a value of the wrong kind. */
export function encodeValue(field: FieldInfo, value: unknown): string {
  switch (kindOf(field)) {
    case 'boolean':
      if (typeof value === 'boolean') return value ? 'Y' : 'N';
      break;
    case 'enum':
      if (typeof value === 'string') return codeValue(field, value);
      if (typeof value === 'number' && inUnion(field, String(value))) {
        throw new FIXEncodeError(`${field.name} (${field.tag}) can't be number ${value}; write it as text, '${value}'`);
      }
      break;
    case 'multiEnum':
      if (Array.isArray(value)) {
        if (value.length === 0) break;
        if (!value.every(item => typeof item === 'string')) break;
        return value.map(item => codeValue(field, item)).join(' ');
      }
      break;
    case 'number':
      if (typeof value === 'number' && Number.isFinite(value) && (Number.isInteger(value) || !INTEGER_TYPES.has(field.type))) {
        return formatNumber(value);
      }
      break;
    case 'timestamp':
      if (value instanceof Date && !Number.isNaN(value.getTime())) return formatTimestamp(value);
      break;
    case 'data':
      if (typeof value === 'string') return value;
      if (value instanceof Uint8Array) return Buffer.from(value).toString('latin1');
      break;
    case 'string':
      if (typeof value === 'string') return Buffer.from(value, 'utf8').toString('latin1');
      break;
  }
  throw new FIXEncodeError(`${field.name} (${field.tag}) can't be ${describe(value)}; expected ${expected(field)}`);
}

/** The value for a field's wire text. Text that can't be interpreted is returned unchanged. */
export function decodeValue(field: FieldInfo, text: string): unknown {
  switch (kindOf(field)) {
    case 'boolean':
      return text === 'Y' ? true : text === 'N' ? false : text;
    case 'enum':
      return codeName(field, text) ?? text;
    case 'multiEnum':
      return text === '' ? text : text.split(' ').map(item => codeName(field, item) ?? item);
    case 'number':
      return NUMBER.test(text) ? Number(text) : text;
    case 'timestamp':
      return parseTimestamp(text) ?? text;
    case 'data':
      return text;
    case 'string':
      return decodeText(text);
  }
}

const NUMBER = /^-?(\d+(\.\d*)?|\.\d+)$/;
const EXPONENT = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/;
const TIMESTAMP = /^(\d{4})(\d{2})(\d{2})-(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/;
const INTEGER = /^-?\d+$/;
/** A Length is a count of bytes: no sign. */
const UNSIGNED = /^\d+$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Text fields are UTF-8 when the bytes are valid UTF-8; otherwise the latin1 text is kept, so no byte is lost. */
function decodeText(text: string): string {
  try {
    return UTF8.decode(Buffer.from(text, 'latin1'));
  } catch {
    return text;
  }
}

export type ValueProblemCode = 'TagSpecifiedWithoutAValue' | 'ValueIsIncorrect' | 'IncorrectDataFormatForValue';

/** Why a field's wire text isn't a valid value for it, or undefined if it is. */
export function valueProblem(field: FieldInfo, text: string): { code: ValueProblemCode; text: string } | undefined {
  const at = `${field.name} (${field.tag})`;
  if (text === '') return { code: 'TagSpecifiedWithoutAValue', text: `${at} has no value` };
  const malformed = { code: 'IncorrectDataFormatForValue' as const, text: `${at} has a malformed value '${text}'` };
  const unknown = { code: 'ValueIsIncorrect' as const, text: `${at} has no value '${text}'` };
  const isCode = (value: string) => (field.codes?.some(code => code.value === value) ?? false) || inUnion(field, value);
  switch (kindOf(field)) {
    case 'boolean': return text === 'Y' || text === 'N' ? undefined : malformed;
    case 'enum': return isCode(text) ? undefined : unknown;
    case 'multiEnum': return text.split(' ').every(isCode) ? undefined : unknown;
    case 'number': return (field.type === 'Length' ? UNSIGNED : INTEGER_TYPES.has(field.type) ? INTEGER : NUMBER).test(text) ? undefined : malformed;
    case 'timestamp': return parseTimestamp(text) ? undefined : malformed;
    case 'data':
    case 'string': return undefined;
  }
}

/** Decimal text for a number, never in exponent notation. */
export function formatNumber(value: number): string {
  const text = String(value);
  const match = EXPONENT.exec(text);
  if (!match) return text;
  const [, sign = '', lead = '', rest = '', exponent = '0'] = match;
  const digits = lead + rest;
  const e = Number(exponent);
  return e < 0 ? `${sign}0.${'0'.repeat(-e - 1)}${digits}` : `${sign}${digits.padEnd(e + 1, '0')}`;
}

/** UTCTimestamp text with milliseconds: YYYYMMDD-HH:MM:SS.sss */
export function formatTimestamp(date: Date): string {
  const iso = date.toISOString();   // 2026-09-27T14:30:05.123Z
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 23)}`;
}

/** A UTCTimestamp with 0–9 fractional digits, to millisecond precision. Undefined if it isn't a valid timestamp. */
export function parseTimestamp(text: string): Date | undefined {
  const match = TIMESTAMP.exec(text);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const millis = Number((match[7] ?? '').padEnd(3, '0').slice(0, 3));
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis));
  const valid = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
  return valid ? date : undefined;
}

/** Where each reserved range of an open code set begins. */
const RESERVED_FROM = { Reserved100Plus: 100, Reserved1000Plus: 1000, Reserved4000Plus: 4000 } as const;
const TENOR = /^[DMWY]\d+$/;

/**
 * Whether wire text outside a field's code set is a value of it all the same. FIX leaves some
 * code sets open: whole numbers from 100, 1000 or 4000 up are for counterparties to agree on, and
 * a few fields take a quantity or a tenor (D5, M3) beside their codes.
 */
export function inUnion(field: FieldInfo, text: string): boolean {
  switch (field.union) {
    case undefined: return false;
    case 'Qty': return NUMBER.test(text);
    case 'Tenor': return TENOR.test(text);
    default: return /^\d+$/.test(text) && Number(text) >= RESERVED_FROM[field.union];
  }
}

/** What an open code set is open to, in words. */
export function unionDescription(union: UnionType): string {
  switch (union) {
    case 'Reserved100Plus': return 'a whole number from 100 up';
    case 'Reserved1000Plus': return 'a whole number from 1000 up';
    case 'Reserved4000Plus': return 'a whole number from 4000 up';
    case 'Qty': return 'a number';
    case 'Tenor': return 'a tenor such as D5 or M3';
  }
}

/** A code's wire value, by its name. A value an open code set also takes (see inUnion) has no name, and is written as it is. */
function codeValue(field: FieldInfo, name: string): string {
  const code = field.codes?.find(c => c.name === name);
  if (code) return code.value;
  if (inUnion(field, name)) return name;
  const hint = suggest(name, (field.codes ?? []).map(c => c.name));
  const open = field.union ? `; ${field.name} also takes ${unionDescription(field.union)}, written as text` : '';
  throw new FIXEncodeError(`'${name}' is not a ${field.name} value${hint ? `. Did you mean '${hint}'?` : ''}${open}`);
}

function codeName(field: FieldInfo, value: string): string | undefined {
  return field.codes?.find(c => c.value === value)?.name;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  if (value instanceof Date) return 'an invalid Date';
  if (Array.isArray(value)) return 'an array';
  return `${typeof value} ${String(value)}`;
}

function expected(field: FieldInfo): string {
  switch (kindOf(field)) {
    case 'boolean': return 'true or false';
    case 'enum': return `one of ${(field.codes ?? []).slice(0, 5).map(c => c.name).join(', ')}${(field.codes?.length ?? 0) > 5 ? ', …' : ''}${field.union ? `, or ${unionDescription(field.union)} written as text` : ''}`;
    case 'multiEnum': return `an array of ${field.name} values`;
    case 'number': return INTEGER_TYPES.has(field.type) ? 'a whole number' : 'a number';
    case 'timestamp': return 'a Date';
    case 'data': return 'a string or bytes';
    case 'string': return 'a string';
  }
}
