import type { MessageObject } from '../wire/message.ts';
import type { ErrorContext, ErrorEntry, ErrorInfo } from './types.ts';

/** Longest error text and stack an entry keeps. */
const MAX_TEXT = 1_000;
const MAX_STACK = 4_000;

/**
 * Hand an error to `handler`. If the handler itself throws, re-raise that on
 * its own, so it never unwinds the caller's work.
 */
export function raiseSafely(error: unknown, handler: (error: unknown) => void): void {
  try {
    handler(error);
  } catch (handlerError) {
    queueMicrotask(() => { throw handlerError; });
  }
}

/** An error as a history entry: its text and stack (both capped), and the message being handled. Never throws, whatever was thrown. */
export function errorEntry(error: unknown, at: Date, during?: MessageObject): ErrorEntry {
  const { text, stack } = errorDetails(error);
  const context = during === undefined ? undefined : errorContext(during);
  return {
    kind: 'error', at, text,
    ...(stack === undefined ? {} : { stack }),
    ...(context === undefined ? {} : { during: context }),
  };
}

/** An error's text and stack, both capped. Never throws. */
export function errorDetails(error: unknown): ErrorInfo {
  let text: string;
  try {
    text = error instanceof Error ? error.message : String(error);
  } catch {
    text = 'An error that could not be described';
  }
  let stack: string | undefined;
  try {
    stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : undefined;
  } catch {
    stack = undefined;
  }
  return stack === undefined ? { text: text.slice(0, MAX_TEXT) } : { text: text.slice(0, MAX_TEXT), stack: stack.slice(0, MAX_STACK) };
}

function errorContext(message: MessageObject): ErrorContext | undefined {
  const { MsgType, MsgSeqNum, ClOrdID } = message;
  const context: ErrorContext = {
    ...(typeof MsgType === 'string' ? { MsgType } : {}),
    ...(typeof MsgSeqNum === 'number' ? { MsgSeqNum } : {}),
    ...(typeof ClOrdID === 'string' ? { ClOrdID } : {}),
  };
  return Object.keys(context).length === 0 ? undefined : context;
}
