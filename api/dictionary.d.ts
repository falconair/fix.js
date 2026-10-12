/**
 * STAND-IN for the types that will be generated from the FIX Orchestra files.
 *
 * Hand-written subset of FIX 4.4 — just enough messages and fields for the API
 * and the use-case examples to type-check. The real file is produced by the
 * dictionary generator and covers every message, field and enum.
 *
 * Conventions the generator will follow (and this file already does):
 *  - Field names are the FIX names (Symbol, OrderQty, ...).
 *  - Enum fields take the enum's *name* ('Buy'), never the wire value ('1').
 *    The raw wire value can always be written with a numeric tag: { 54: '1' }.
 *  - Y/N fields are booleans, UTCTimestamp fields are Dates, Qty/Price/Amt are numbers.
 *  - Repeating groups are arrays of objects, named after the group (Parties).
 */

// ─── Enums ──────────────────────────────────────────────────────────────────

export type Side = 'Buy' | 'Sell' | 'SellShort' | 'SellShortExempt' | 'Cross';
export type OrdType = 'Market' | 'Limit' | 'Stop' | 'StopLimit';
export type TimeInForce = 'Day' | 'GoodTillCancel' | 'ImmediateOrCancel' | 'FillOrKill' | 'GoodTillDate';
export type OrdStatus =
  | 'New' | 'PartiallyFilled' | 'Filled' | 'DoneForDay' | 'Canceled' | 'Replaced'
  | 'PendingCancel' | 'Rejected' | 'PendingNew' | 'Expired' | 'PendingReplace';
export type ExecType =
  | 'New' | 'Trade' | 'DoneForDay' | 'Canceled' | 'Replaced' | 'PendingCancel'
  | 'Rejected' | 'PendingNew' | 'Expired' | 'PendingReplace' | 'OrderStatus';
export type OrdRejReason =
  | 'BrokerOption' | 'UnknownSymbol' | 'ExchangeClosed' | 'OrderExceedsLimit'
  | 'TooLateToEnter' | 'UnknownOrder' | 'DuplicateOrder' | 'Other';
export type CxlRejReason = 'TooLateToCancel' | 'UnknownOrder' | 'BrokerOption' | 'AlreadyPending' | 'Other';
export type CxlRejResponseTo = 'OrderCancelRequest' | 'OrderCancelReplaceRequest';
export type SessionRejectReason =
  | 'InvalidTagNumber' | 'RequiredTagMissing' | 'TagNotDefinedForThisMessageType'
  | 'UndefinedTag' | 'TagSpecifiedWithoutAValue' | 'ValueIsIncorrect'
  | 'IncorrectDataFormatForValue' | 'CompIDProblem' | 'SendingTimeAccuracyProblem'
  | 'InvalidMsgType' | 'Other';
export type BusinessRejectReason =
  | 'Other' | 'UnknownID' | 'UnknownSecurity' | 'UnsupportedMessageType'
  | 'ApplicationNotAvailable' | 'ConditionallyRequiredFieldMissing' | 'NotAuthorized';
export type EncryptMethod = 'None';
/**
 * The application versions fix.js reads over FIXT.1.1, by the names FIX gives
 * the values of ApplVerID (1128) and DefaultApplVerID (1137). All four are read
 * with one dictionary: FIX 5.0 SP2 with every extension pack since.
 */
export type ApplVerID = 'FIX50' | 'FIX50SP1' | 'FIX50SP2' | 'FIXLatest';
export type PartyRole = 'ExecutingFirm' | 'ClientID' | 'EnteringTrader' | 'ContraFirm';
export type PartyIDSource = 'Proprietary' | 'BIC';

// ─── Header and trailer ─────────────────────────────────────────────────────

/** Standard header. Every field here is filled in by the session unless you write it yourself. */
export interface Header {
  BeginString: string;
  SenderCompID: string;
  TargetCompID: string;
  MsgSeqNum: number;
  SendingTime: Date;
  PossDupFlag?: boolean;
  PossResend?: boolean;
  OrigSendingTime?: Date;
  OnBehalfOfCompID?: string;
  DeliverToCompID?: string;
  /** FIXT.1.1 only: the application version of this one message, when it is not the session's default. */
  ApplVerID?: ApplVerID;
}

/**
 * Fields that describe the encoding rather than the message. They are never
 * part of a message object (so spreading a received message into send() can't
 * carry a stale checksum); they can only be *written*, to corrupt a frame on purpose.
 */
export interface Framing {
  BodyLength: number;
  CheckSum: string;
}

// ─── Components / groups ────────────────────────────────────────────────────

export interface Party {
  PartyID: string;
  PartyIDSource?: PartyIDSource;
  PartyRole: PartyRole;
}

// ─── Message bodies ─────────────────────────────────────────────────────────

/** Body fields per message, keyed by message name. Optional (?) means optional in the FIX spec. */
export interface Messages {
  // Session (admin) messages
  Heartbeat: { TestReqID?: string };
  TestRequest: { TestReqID: string };
  ResendRequest: { BeginSeqNo: number; EndSeqNo: number };
  Reject: {
    RefSeqNum: number; RefTagID?: number; RefMsgType?: string;
    SessionRejectReason?: SessionRejectReason; Text?: string;
  };
  SequenceReset: { GapFillFlag?: boolean; NewSeqNo: number };
  Logout: { Text?: string };
  Logon: {
    EncryptMethod: EncryptMethod; HeartBtInt: number; ResetSeqNumFlag?: boolean;
    Username?: string; Password?: string;
    /** FIXT.1.1 only, where FIX requires it: the application version of the messages the sender will send. Filled in unless written. */
    DefaultApplVerID?: ApplVerID;
  };

  // Application messages
  NewOrderSingle: {
    ClOrdID: string; Account?: string; Parties?: Party[];
    Symbol: string; Side: Side; TransactTime: Date;
    OrderQty: number; OrdType: OrdType; Price?: number; StopPx?: number;
    TimeInForce?: TimeInForce; Text?: string;
  };
  ExecutionReport: {
    OrderID: string; ClOrdID?: string; OrigClOrdID?: string; ExecID: string;
    ExecType: ExecType; OrdStatus: OrdStatus; OrdRejReason?: OrdRejReason;
    Account?: string; Parties?: Party[];
    Symbol: string; Side: Side; OrderQty?: number; OrdType?: OrdType; Price?: number;
    LastQty?: number; LastPx?: number; LeavesQty: number; CumQty: number; AvgPx: number;
    TransactTime?: Date; Text?: string;
  };
  OrderCancelRequest: {
    OrigClOrdID: string; ClOrdID: string; OrderID?: string;
    Symbol: string; Side: Side; TransactTime: Date; OrderQty?: number; Text?: string;
  };
  OrderCancelReplaceRequest: {
    OrigClOrdID: string; ClOrdID: string; OrderID?: string;
    Symbol: string; Side: Side; TransactTime: Date;
    OrderQty: number; OrdType: OrdType; Price?: number; TimeInForce?: TimeInForce; Text?: string;
  };
  OrderCancelReject: {
    OrderID: string; ClOrdID: string; OrigClOrdID: string; OrdStatus: OrdStatus;
    CxlRejResponseTo: CxlRejResponseTo; CxlRejReason?: CxlRejReason; Text?: string;
  };
  BusinessMessageReject: {
    RefSeqNum?: number; RefMsgType: string; BusinessRejectReason: BusinessRejectReason; Text?: string;
  };
}

/** Every message name: 'Logon', 'NewOrderSingle', ... (autocompletes). */
export type MsgTypeName = keyof Messages;

/** Session-layer messages. The session engine produces and consumes these. */
export type AdminMsgType =
  | 'Heartbeat' | 'TestRequest' | 'ResendRequest' | 'Reject'
  | 'SequenceReset' | 'Logout' | 'Logon';

/** Application messages: everything that isn't session-layer. */
export type AppMsgType = Exclude<MsgTypeName, AdminMsgType>;

/**
 * Body fields the session can compute, so they're optional when sending even
 * though FIX requires them. Same rule as the header: leave out → filled, write → sent as written.
 */
export type AutoFilledBodyField = 'TransactTime';

/**
 * BeginStrings: connect() and listen() refuse any other with a RangeError.
 * FIXT.1.1 is the session layer that carries FIX 5.0 and later; which
 * application version, the Logon says (DefaultApplVerID: see ApplVerID).
 */
export type Version = 'FIX.4.2' | 'FIX.4.4' | 'FIXT.1.1';

// ─── Constants ──────────────────────────────────────────────────────────────
// Each enum is both a type and a constant object whose values are the names
// themselves, so Side.Buy === 'Buy'. The constant form is the documented style:
//   order.TimeInForce === TimeInForce.ImmediateOrCancel

type Constants<T extends string> = { readonly [K in T]: K };

export declare const MsgType: Constants<MsgTypeName>;
export declare const Side: Constants<Side>;
export declare const OrdType: Constants<OrdType>;
export declare const TimeInForce: Constants<TimeInForce>;
export declare const OrdStatus: Constants<OrdStatus>;
export declare const ExecType: Constants<ExecType>;
export declare const OrdRejReason: Constants<OrdRejReason>;
export declare const CxlRejReason: Constants<CxlRejReason>;
export declare const SessionRejectReason: Constants<SessionRejectReason>;
export declare const BusinessRejectReason: Constants<BusinessRejectReason>;
export declare const PartyRole: Constants<PartyRole>;
export declare const PartyIDSource: Constants<PartyIDSource>;
export declare const Version: Constants<Version>;
export declare const ApplVerID: Constants<ApplVerID>;
