// Compiled by `npm run typecheck`, never executed: proves the types and constants of fix.js/fix50sp2 (FIX Latest, which is FIX 5.0 SP2 with every extension pack since) catch mistakes in a value annotated with them. A session's methods take any message type and fields today, so a send() catches nothing.
import type { Header, Messages, MsgTypeName, RateSourceGroup } from '../fix50sp2.ts';
import { ApplVerID, DefaultApplVerID, MsgType, OrdType, RateSource, RateSourceType, Side } from '../fix50sp2.ts';

const order: Messages['NewOrderSingle'] = {
  ClOrdID: 'ord-1', Symbol: 'GOOG', Side: Side.Buy, TransactTime: new Date(), OrderQty: 100, OrdType: OrdType.Limit, Price: 150.25,
  // A group and a field of one name: the group at the message's level, the field in each entry.
  RateSource: [{ RateSource: RateSource.Bloomberg, RateSourceType: RateSourceType.Primary }],
};
// A Logon must name the application version; a message may name its own in the header.
const logon: Messages['Logon'] = { EncryptMethod: 'None', HeartBtInt: 30, DefaultApplVerID: DefaultApplVerID.FIX50SP2 };
const applVerID: Header['ApplVerID'] = ApplVerID.FIXLatest;
// @ts-expect-error — DefaultApplVerID is required
const unnamed: Messages['Logon'] = { EncryptMethod: 'None', HeartBtInt: 30 };
// @ts-expect-error — 'Buyy' is not a Side
const badSide: Messages['NewOrderSingle']['Side'] = 'Buyy';
// A message FIX 4.4 does not have.
const ack: typeof MsgType.ExecutionAck = 'ExecutionAck';

// The names of the messages, and a group's entry.
const name: MsgTypeName = MsgType.ExecutionAck;
const entry: RateSourceGroup = { RateSource: RateSource.Bloomberg, RateSourceType: RateSourceType.Primary };
// @ts-expect-error — 'ExecutionAckk' is not a message
const badName: MsgTypeName = 'ExecutionAckk';

void [order, logon, applVerID, unnamed, badSide, ack, name, entry, badName];
