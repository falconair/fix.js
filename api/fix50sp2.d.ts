/**
 * fix.js/fix50sp2: the constants and types of FIX Latest, which is FIX 5.0 SP2
 * with every extension pack since, and what the library reads for a FIXT.1.1
 * session. Generated from FIX Orchestra (the session layer from FIXT.1.1, the
 * application messages from FIX Latest).
 *
 * STAND-IN, like dictionary.d.ts: a hand-written few of the constants and of
 * the message types (two messages, one group), enough for the examples and the
 * snippets in README.md to type-check. The generated module has a constant for
 * every enum field and message type (close to two thousand), and the types of
 * every message, group and field.
 *
 * What is typed, and what is not:
 *  - A value annotated with the entry's types (`Messages['NewOrderSingle']`,
 *    `RateSourceGroup`) is checked against FIX Latest.
 *  - The session's methods take any message type and any fields today, so
 *    nothing a `send()` is given is checked. This spec's `Session` describes
 *    messages by FIX 4.4's names, so against the spec a name FIX 4.4 lacks
 *    needs a cast, with `MsgTypeName` and `Fields` taken from the root (`fix.js`):
 *      session.send(MsgType.ExecutionAck as MsgTypeName, fields as Fields<MsgTypeName>)
 *    Typing messages by version is an open question of the spec.
 *
 * Names in both sets (the root's, FIX 4.4's, and these) are the same constant:
 * `Side.Buy` is 'Buy' in both. Each version's dictionary sends a name as its
 * own code, and a few differ (PartyRole.GiveupClearingFirm is 14 in FIX 4.4 and
 * 97 here), so use each entry's constants with its own sessions; a name both
 * have works in either.
 *
 * ApplVerID: use the root's, the four versions the library reads. This one is
 * FIX's whole list, and a Logon that names one the library does not read
 * (FIX44, say) is refused.
 */

type Constants<T extends string> = { readonly [K in T]: K };

/** Every FIX name for an application version, including the ones fix.js does not read (see ApplVerID in fix.js). */
export type ApplVerID = 'FIX27' | 'FIX30' | 'FIX40' | 'FIX41' | 'FIX42' | 'FIX43' | 'FIX44' | 'FIX50' | 'FIX50SP1' | 'FIX50SP2' | 'FIXLatest';
export type Side = 'Buy' | 'Sell' | 'SellShort' | 'SellShortExempt' | 'Cross';
export type OrdType = 'Market' | 'Limit' | 'Stop' | 'StopLimit';
export type OrdStatus = 'New' | 'PartiallyFilled' | 'Filled' | 'Canceled' | 'Rejected';
export type ExecType = 'New' | 'Trade' | 'Canceled' | 'Rejected';
export type MsgType =
  | 'Heartbeat' | 'TestRequest' | 'ResendRequest' | 'Reject' | 'SequenceReset' | 'Logout' | 'Logon'
  | 'NewOrderSingle' | 'ExecutionReport' | 'OrderCancelRequest' | 'OrderCancelReplaceRequest' | 'OrderCancelReject'
  | 'BusinessMessageReject' | 'ExecutionAck';

export declare const ApplVerID: Constants<ApplVerID>;
export declare const Side: Constants<Side>;
export declare const OrdType: Constants<OrdType>;
export declare const OrdStatus: Constants<OrdStatus>;
export declare const ExecType: Constants<ExecType>;
export declare const MsgType: Constants<MsgType>;

/** A group of FIX Latest that FIX 4.4 has no field for: a NewOrderSingle may carry a list of these as RateSource. */
export interface RateSourceGroup {
  RateSource?: 'Bloomberg' | 'Reuters' | 'Telerate' | 'ISDARateOption' | 'Other';
  RateSourceType?: 'Primary' | 'Secondary';
}

/** Body fields per message, keyed by message name; the generated module has all 181. Optional (?) means optional in FIX. */
export interface Messages {
  NewOrderSingle: {
    ClOrdID: string; Symbol?: string; Side: Side; TransactTime: Date; OrderQty?: number; OrdType: OrdType; Price?: number;
    RateSource?: readonly RateSourceGroup[];
  };
  ExecutionAck: { OrderID: string; ClOrdID?: string; ExecAckStatus: 'Received' | 'Accepted' | 'DontKnow'; ExecID: string; Side: Side; Text?: string };
}

/** Every message name of FIX Latest: 'NewOrderSingle', 'ExecutionAck', … (the root's MsgTypeName is FIX 4.4's). */
export type MsgTypeName = keyof Messages;
