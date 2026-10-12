// Compiled by `npm run typecheck`, never executed.
import { decode, encode } from './index.ts';
import { defineDictionary, OrdType, Side } from '../index.ts';

encode('NewOrderSingle', { ClOrdID: '1', Side: Side.Buy, OrdType: OrdType.Market });            // TransactTime is filled in
encode('NewOrderSingle', { ClOrdID: '1', Side: null, OrdType: OrdType.Market, 9702: 'x' });     // deliberate omission, raw tag
// @ts-expect-error — misspelled field
encode('NewOrderSingle', { ClOrdID: '1', Side: Side.Buy, OrdType: OrdType.Market, Prise: 1 });
// @ts-expect-error — not a Side
encode('NewOrderSingle', { ClOrdID: '1', Side: 'Buyy', OrdType: OrdType.Market });
// @ts-expect-error — Side is required (null to leave it out on purpose)
encode('NewOrderSingle', { ClOrdID: '1', OrdType: OrdType.Market });
// @ts-expect-error — TestReqID is required
encode('TestRequest', {});

const acme = defineDictionary({ fields: { AlgoStrategy: { tag: 9702, values: { VWAP: 'V' } } }, messages: { NewOrderSingle: ['AlgoStrategy'] } });
encode('NewOrderSingle', { ClOrdID: '1', Side: Side.Buy, OrdType: OrdType.Market, AlgoStrategy: acme.AlgoStrategy.VWAP }, { dictionary: acme });
// @ts-expect-error — not an AlgoStrategy value
encode('NewOrderSingle', { ClOrdID: '1', Side: Side.Buy, OrdType: OrdType.Market, AlgoStrategy: 'VWAPP' }, { dictionary: acme });

const msg = decode(new Uint8Array());
if (msg.MsgType === 'ExecutionReport') {
  const status: string = msg.OrdStatus;
  void status;
}
// @ts-expect-error — OrdStatus exists only once the type is known
void msg.OrdStatus;
