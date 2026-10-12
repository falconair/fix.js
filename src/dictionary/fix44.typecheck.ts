// Compiled by `npm run typecheck`, never executed: proves the generated types catch mistakes.
import type { Messages } from './fix44.ts';
import { Side, OrdType, MsgType, PartyRole, SecurityIDSource } from './fix44.ts';

const order: Messages['NewOrderSingle'] = {
  ClOrdID: 'ord-1', Symbol: 'GOOG', Side: Side.Buy, TransactTime: new Date(),
  OrderQty: 100, OrdType: OrdType.Limit, Price: 150.25,
  Parties: [{ PartyID: 'DESK-7', PartyRole: PartyRole.EnteringTrader }],
};
// @ts-expect-error — 'Buyy' is not a Side
const badSide: Messages['NewOrderSingle']['Side'] = 'Buyy';
// @ts-expect-error — Side is required
const missingSide: Messages['NewOrderSingle'] = { ClOrdID: 'ord-2', TransactTime: new Date(), OrdType: OrdType.Market };
const logon: typeof MsgType.Logon = 'Logon';

void [order, badSide, missingSide, logon];

// An open code set takes its names and the form it is open to; a name that is neither is still an error.
const reserved: Messages['NewOrderSingle'] = { ...order, SecurityIDSource: '100' };
const named: Messages['NewOrderSingle'] = { ...order, SecurityIDSource: SecurityIDSource.CUSIP };
const quantity: Messages['IOI'] = {
  IOIID: 'i-1', IOITransType: 'New', Symbol: 'GOOG', Side: Side.Buy, IOIQty: '15000',
};
// @ts-expect-error — 'NOPE' is neither a SecurityIDSource nor a number
const notASource: Messages['NewOrderSingle'] = { ...order, SecurityIDSource: 'NOPE' };
// @ts-expect-error — a number is written as text
const numberNotText: Messages['NewOrderSingle'] = { ...order, SecurityIDSource: 100 };
const comesIn = reserved.SecurityIDSource === '100';
const targetStrategy: Messages['NewOrderSingle']['TargetStrategy'] = '1000';

void [reserved, named, quantity, notASource, numberNotText, comesIn, targetStrategy];
