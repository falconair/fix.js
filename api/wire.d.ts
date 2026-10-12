/**
 * fix.js/wire — bytes ↔ messages, with no session.
 * For parsers, log readers and fuzzers. The session layer is built on these.
 */

import type { Message, Fields, MsgTypeName } from './index';

/** Encode a message. Fills BeginString, BodyLength, CheckSum and TransactTime unless written. */
export declare function encode<K extends MsgTypeName>(type: K, fields: Fields<K>, options?: { version?: string }): Uint8Array;

/**
 * Decode one frame. Throws a FIXDecodeError saying what's wrong: BeginString,
 * BodyLength and MsgType must be its first three fields. `lenient` accepts
 * '|' delimiters, missing BodyLength/CheckSum, and MsgType anywhere in the
 * frame (hand-written text, QuickFIX acceptance scripts, pasted log lines).
 */
export declare function decode(bytes: Uint8Array | string, options?: { lenient?: boolean }): Message;

/** Split a byte stream into frames: fragmentation-safe; invalid frames are yielded, marked. */
export declare function frames(
  chunks: AsyncIterable<Uint8Array>, options?: { maxMessageSize?: number },
): AsyncIterable<{ bytes: Uint8Array; valid: boolean; error?: string }>;
