import { DEFAULT_VERSION } from '../dictionary/index.ts';
import type { Dictionary, DictionaryDef } from '../dictionary/define.ts';
import type { IndexedDictionary } from '../dictionary/index.ts';
import { resolveDictionary } from '../dictionary/resolve.ts';
import { FIXDecodeError, FIXEncodeError } from '../errors.ts';
import type { Fields, Message, MsgTypeName } from '../types.ts';
import { buildFrame, parseFrame } from './frame.ts';
import { fromMessage, toMessage } from './message.ts';

export { FrameSplitter, frames, type SplitFrame, type SplitterOptions } from './splitter.ts';

export interface WireOptions<D = {}> {
  /** BeginString when the fields don't give one. Default 'FIX.4.4'. */
  version?: string;
  /** Custom fields, from defineDictionary(). */
  dictionary?: Dictionary<D & DictionaryDef>;
  /** Clock for TransactTime. Default: the current time. */
  now?: () => Date;
}

/**
 * Encode a message. Fills BeginString, BodyLength, CheckSum and TransactTime
 * unless written; everything written is sent as written; null leaves a field out.
 */
export function encode<K extends MsgTypeName, D = {}>(type: K, fields: Fields<K, D>, options: WireOptions<D> = {}): Uint8Array {
  const input = fields as unknown as Readonly<Record<string, unknown>>;
  const version = typeof input.BeginString === 'string' ? input.BeginString : options.version ?? DEFAULT_VERSION;
  const dict = dictionaryOf(version, options.dictionary, FIXEncodeError);
  const { fields: raw, framing } = fromMessage(type, input, dict, { version, now: options.now });
  return buildFrame(raw, framing);
}

/**
 * Decode one frame. Throws FIXDecodeError saying what's wrong: BeginString,
 * BodyLength and MsgType must be its first three fields. `lenient` accepts
 * '|' delimiters, missing BodyLength/CheckSum, and MsgType anywhere in the
 * frame.
 */
export function decode<D = {}>(
  input: Uint8Array | string,
  options: { lenient?: boolean; dictionary?: Dictionary<D & DictionaryDef> } = {},
): Message<MsgTypeName, D> {
  const dict = dictionaryOf(beginString(input) ?? DEFAULT_VERSION, options.dictionary, FIXDecodeError);
  const frame = parseFrame(input, { lenient: options.lenient ?? false, dataTags: dict.dataTags });
  if (frame.errors.length) throw new FIXDecodeError(frame.errors.join('; '));
  return toMessage(frame.fields, dict) as unknown as Message<MsgTypeName, D>;
}

/** The dictionary for a version with a custom dictionary's fields added. A custom field the version cannot take (its tag is a standard field there) is `fail`'s error. */
function dictionaryOf(version: string, custom: Parameters<typeof resolveDictionary>[1], fail: new (message: string) => Error): IndexedDictionary {
  const standard = resolveDictionary(version);
  if (!custom) return standard;
  try {
    return resolveDictionary(version, custom);
  } catch (error) {
    throw new fail(`The custom dictionary cannot be used with ${version}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function beginString(input: Uint8Array | string): string | undefined {
  const head = typeof input === 'string' ? input.slice(0, 32) : Buffer.from(input.subarray(0, 32)).toString('latin1');
  return /^\s*8=([^\x01|]+)/.exec(head)?.[1];
}
