/**
 * The dictionary data fix.js needs from a FIX Orchestra repository.
 * Components are flattened away: a message or group lists its fields and
 * groups in wire order.
 */

export interface CodeInfo {
  readonly name: string;
  readonly value: string;
}

export interface FieldInfo {
  readonly tag: number;
  readonly name: string;
  /** Orchestra datatype ('String', 'Qty', 'UTCTimestamp', …); for a code-set field, the code set's base type ('char', 'int', 'Boolean', …). */
  readonly type: string;
  /** The field's allowed values, when it has a code set. */
  readonly codes?: readonly CodeInfo[];
  /**
   * Set when the code set is open: the datatype of the values the field also takes outside it
   * (FIX Orchestra's unionDataType). 'Reserved100Plus', 'Reserved1000Plus' and 'Reserved4000Plus'
   * are whole numbers from 100, 1000 or 4000 up, left for counterparties to agree on; 'Qty' is a
   * quantity; 'Tenor' is a tenor such as D5 or M3.
   */
  readonly union?: UnionType;
}

export const UNION_TYPES = ['Reserved100Plus', 'Reserved1000Plus', 'Reserved4000Plus', 'Qty', 'Tenor'] as const;
export type UnionType = typeof UNION_TYPES[number];

export type Member =
  | { readonly kind: 'field'; readonly tag: number; readonly required: boolean }
  | { readonly kind: 'group'; readonly name: string; readonly required: boolean };

export interface GroupInfo {
  readonly name: string;
  /** The NumInGroup field that carries the entry count. */
  readonly countTag: number;
  /** In order; the first member starts each entry. */
  readonly members: readonly Member[];
}

export interface MessageInfo {
  readonly name: string;
  /** Wire value of MsgType (35). */
  readonly msgType: string;
  /** Session-level (Logon, Heartbeat, …) rather than application. */
  readonly admin: boolean;
  /** Body members only; the header and trailer are separate. */
  readonly members: readonly Member[];
}

export interface DictionaryData {
  /** BeginString, e.g. 'FIX.4.4'. */
  readonly version: string;
  readonly fields: readonly FieldInfo[];
  readonly groups: readonly GroupInfo[];
  readonly messages: readonly MessageInfo[];
  readonly header: readonly Member[];
  readonly trailer: readonly Member[];
}
