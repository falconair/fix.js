import type { IndexedDictionary } from '../dictionary/index.ts';
import { buildFrame } from '../wire/frame.ts';
import { fromMessage, type EncodeContext, type MessageObject } from '../wire/message.ts';

/** The wire bytes for a message object (its MsgType and fields). Throws FIXEncodeError when it doesn't encode. */
export function encodeMessage(message: MessageObject, dict: IndexedDictionary, context: EncodeContext): Uint8Array {
  const { MsgType, ...fields } = message;
  const { fields: raw, framing } = fromMessage(String(MsgType), fields, dict, context);
  return buildFrame(raw, framing);
}

/** As encodeMessage, but undefined when it doesn't encode. */
export function tryEncodeMessage(message: MessageObject, dict: IndexedDictionary, context: EncodeContext): Uint8Array | undefined {
  try {
    return encodeMessage(message, dict, context);
  } catch {
    return undefined;
  }
}
