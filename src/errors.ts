import type { CloseReason } from './transport/types.ts';

/** A message couldn't be encoded: unknown field or message, wrong value type, missing required field. */
export class FIXEncodeError extends Error {
  override name = 'FIXEncodeError';
}

/** Bytes couldn't be decoded as a FIX message. */
export class FIXDecodeError extends Error {
  override name = 'FIXDecodeError';
}

/** An operation isn't possible in the session's current state (e.g. sending before logon). */
export class FIXStateError extends Error {
  override name = 'FIXStateError';
}

/** What a timed-out wait was for. */
export type WaitingFor =
  /** next(): a message of this type. */
  | { readonly kind: 'message'; readonly msgType: string }
  /** whenConnected(): this counterparty to log on. */
  | { readonly kind: 'logon'; readonly target: string }
  /** connect(): the TCP connection to this address (host:port). */
  | { readonly kind: 'connect'; readonly address: string }
  /** The store: a write, the flush when closing, or connect()'s load. */
  | { readonly kind: 'store' };

/** A wait (next, whenConnected, connecting, …) ran out of time. */
export class TimeoutError extends Error {
  override name = 'TimeoutError';
  /** What the wait was for; undefined when the error was made without saying. */
  readonly waitingFor: WaitingFor | undefined;

  constructor(message: string, waitingFor?: WaitingFor) {
    super(message);
    this.waitingFor = waitingFor;
  }
}

/** connect() couldn't log on. `reason` says why (their Logout text, a timeout, the connection closing). */
export class FIXLogonError extends Error {
  override name = 'FIXLogonError';
  readonly reason: CloseReason;

  constructor(reason: CloseReason) {
    super(`Logon failed: ${reason.text}`);
    this.reason = reason;
  }
}
