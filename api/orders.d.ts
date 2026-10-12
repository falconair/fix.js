/**
 * Order objects. An order is the NewOrderSingle's fields (order.Symbol,
 * order.ClOrdID, ...) plus methods, and its state is computed from the
 * session's history, so it survives reconnects and can't disagree with what
 * was actually sent.
 *
 * The one argument a reply is about comes first; any FIX fields come last, in
 * an object, under the auto-fill rule (left out → computed from the order,
 * written → sent as written).
 *   order.fill()                          // everything still open
 *   order.fill(40)                        // a partial fill; the next fill() completes it
 *   order.fill(40, { LastPx: 150.30 })    // at a price other than the limit
 *   order.fill(50, { CumQty: 150 })       // deliberately wrong: an overfill
 *   order.reject('Not listed', { OrdRejReason: OrdRejReason.UnknownSymbol })
 */

import type { Message, Fields, Session, Duration } from './index';
import type { OrdStatus } from './dictionary';

/** Current state of an order, in FIX terms. */
export interface OrderState {
  readonly OrdStatus: OrdStatus;
  /** Current ClOrdID (changes when the order is replaced). */
  readonly ClOrdID: string;
  readonly OrderQty: number;
  readonly Price?: number;
  readonly CumQty: number;
  readonly LeavesQty: number;
  readonly AvgPx: number;
}

interface OrderCommon<D> {
  readonly state: OrderState;
  /** False once filled, canceled, rejected or expired. */
  readonly isOpen: boolean;
  /** Every ExecutionReport for this order, oldest first. */
  readonly reports: readonly Message<'ExecutionReport', D>[];
  readonly session: Session<D>;
  /**
   * Wait until the order reaches this status; resolves with the report that
   * says so. Fails straight away, with the reason, if the order ends some
   * other way first (e.g. Rejected while waiting for Filled). Default timeout 5s.
   */
  until(status: OrdStatus, options?: { timeout?: Duration }): Promise<Message<'ExecutionReport', D>>;
}

type ReplyFields<K extends 'ExecutionReport' | 'OrderCancelReject', D> = Partial<Fields<K, D>>;

/** Sends a reply now; `.message()` builds it without sending. */
export interface Reply<K extends 'ExecutionReport' | 'OrderCancelReject', D> {
  (fields?: ReplyFields<K, D>): Promise<Message<K, D>>;
  message(fields?: ReplyFields<K, D>): ReplyFields<K, D>;
}

/** fill(qty?, fields?): qty is LastQty; omitted means everything still open. */
export interface FillReply<D> {
  (qty?: number, fields?: ReplyFields<'ExecutionReport', D>): Promise<Message<'ExecutionReport', D>>;
  message(qty?: number, fields?: ReplyFields<'ExecutionReport', D>): ReplyFields<'ExecutionReport', D>;
}

/** reject(text?, fields?): text is the Text field. */
export interface RejectReply<K extends 'ExecutionReport' | 'OrderCancelReject', D> {
  (text?: string, fields?: ReplyFields<K, D>): Promise<Message<K, D>>;
  message(text?: string, fields?: ReplyFields<K, D>): ReplyFields<K, D>;
}

// ─── The side that sends orders ─────────────────────────────────────────────

export type OutgoingOrder<D = {}> = Message<'NewOrderSingle', D> & OrderCommon<D> & {
  /**
   * Ask to cancel. Resolves with the confirming ExecutionReport; throws
   * CancelRejectedError (with their OrderCancelReject) if they refuse.
   */
  cancel(fields?: Partial<Fields<'OrderCancelRequest', D>>, options?: { timeout?: Duration }): Promise<Message<'ExecutionReport', D>>;
  /** Ask to amend. Unchanged fields are copied from the order. Same resolve/reject as cancel(). */
  replace(changes: Partial<Fields<'OrderCancelReplaceRequest', D>>, options?: { timeout?: Duration }): Promise<Message<'ExecutionReport', D>>;
};

// ─── The side that receives orders ──────────────────────────────────────────

export type IncomingOrder<D = {}> = Message<'NewOrderSingle', D> & OrderCommon<D> & {
  /** ExecType=New. Sent automatically unless the order is rejected first. */
  ack: Reply<'ExecutionReport', D>;
  /**
   * Fill `qty` (LastQty), or everything still open. Price: LastPx if written,
   * else the limit Price, else the server's marketPrice. Sends the ack first if
   * it hasn't gone. Throws if nothing is left, unless you write the fields yourself.
   */
  fill: FillReply<D>;
  /** ExecType=Rejected, with `text` as Text. No ack is ever sent for a rejected order. */
  reject: RejectReply<'ExecutionReport', D>;
  /** Cancel it unprompted (expiry, IOC remainder, kill switch). */
  cancel: Reply<'ExecutionReport', D>;
};

export type IncomingCancel<D = {}> = Message<'OrderCancelRequest', D> & {
  /** The order this request refers to. (Requests for unknown orders are rejected with UnknownOrder before any handler runs.) */
  readonly order: IncomingOrder<D>;
  /** Cancel the order (ExecType=Canceled). Default when your handler doesn't answer. */
  accept: Reply<'ExecutionReport', D>;
  /** Refuse, with `text` as Text (OrderCancelReject). */
  reject: RejectReply<'OrderCancelReject', D>;
};

export type IncomingReplace<D = {}> = Message<'OrderCancelReplaceRequest', D> & {
  readonly order: IncomingOrder<D>;
  /** Apply the amendment (ExecType=Replaced). Default when your handler doesn't answer. */
  accept: Reply<'ExecutionReport', D>;
  /** Refuse, with `text` as Text (OrderCancelReject). */
  reject: RejectReply<'OrderCancelReject', D>;
};

// ─── Errors ─────────────────────────────────────────────────────────────────

/** newOrder() was rejected. `report` is their ExecutionReport (OrdRejReason, Text). */
export declare class OrderRejectedError<D = {}> extends Error {
  readonly order: OutgoingOrder<D>;
  readonly report: Message<'ExecutionReport', D>;
}

/** cancel() or replace() was refused. `reject` is their OrderCancelReject (CxlRejReason, Text). */
export declare class CancelRejectedError<D = {}> extends Error {
  readonly order: OutgoingOrder<D>;
  readonly reject: Message<'OrderCancelReject', D>;
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

/** A wait (next, until, newOrder, cancel, replace, whenConnected, connecting) ran out of time. */
export declare class TimeoutError extends Error {
  constructor(message: string, waitingFor?: WaitingFor);
  /** What the wait was for; undefined when the error was made without saying. */
  readonly waitingFor: WaitingFor | undefined;
}
