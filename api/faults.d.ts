/**
 * fix.js/faults
 *
 * A fault is plain data. `drop(MsgType.Heartbeat)` returns
 *   { fault: 'drop', type: 'Heartbeat' }
 * and the session interprets it, so a GUI, a DSL or a stored scenario can
 * describe the same fault as JSON and pass it to session.outgoing() directly.
 *
 * Like the rest of the API, the message type comes first:
 *   drop(MsgType.ExecutionReport, { ExecType: ExecType.Trade })
 *
 * For anything the built-ins can't express, a plain function (RouteFn) works
 * too; it just isn't serializable.
 */

import type { Message, Where } from './index';
import type { MsgTypeName } from './dictionary';

/** Which of the matching messages. Omitted: all of them. */
export type Count =
  | { nth: number }
  | { first: number }
  | { after: number }
  | { probability: number; seed?: number };

type FieldValues = Readonly<Record<string | number, string | number | boolean | Date | null>>;

/** Omitting `type` means every message. `where` narrows by field values. */
interface Target { type?: MsgTypeName; where?: FieldValues; count?: Count }

export type Fault =
  | ({ fault: 'drop' } & Target)
  | ({ fault: 'delay'; ms: number } & Target)
  | ({ fault: 'set'; fields: FieldValues } & Target)
  | ({ fault: 'duplicate' } & Target)
  | { fault: 'dropSeq'; seqNums: readonly number[] };

/** Code-only: return the message, a changed copy, null to drop, several, or a promise (delay). */
export type RouteFn = (msg: Message) =>
  | Message | null | readonly Message[]
  | Promise<Message | null | readonly Message[]>;

// ─── Builders (each returns a Fault object) ─────────────────────────────────

export declare function drop<K extends MsgTypeName>(type?: K, where?: Where<K>): Fault;
export declare function delay<K extends MsgTypeName>(type: K | undefined, ms: number, where?: Where<K>): Fault;
/** Overwrite fields, named or numeric, header and framing included: set(MsgType.TestRequest, { CheckSum: '000' }). */
export declare function set<K extends MsgTypeName>(type: K | undefined, fields: FieldValues, where?: Where<K>): Fault;
/** Send twice; the copy is marked PossDupFlag=Y with OrigSendingTime. */
export declare function duplicate<K extends MsgTypeName>(type?: K, where?: Where<K>): Fault;
/** Incoming only: act as if their messages with these MsgSeqNums never arrived. */
export declare function dropSeq(...seqNums: number[]): Fault;

/** Only the nth matching message (1-based). */
export declare function nth(n: number, fault: Fault): Fault;
/** Only the first n matching messages. */
export declare function first(n: number, fault: Fault): Fault;
/** Every matching message after the first n. */
export declare function after(n: number, fault: Fault): Fault;
/** Each matching message with probability p; seeded so runs repeat. */
export declare function sometimes(p: number, fault: Fault, options?: { seed?: number }): Fault;
