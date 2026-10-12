import { connect, defineDictionary, Side } from 'fix.js';

// Declare the firm's custom fields once (for example in acme-fix.ts) ...
export const acme = defineDictionary({
  fields: {
    AlgoStrategy: { tag: 9702, values: { VWAP: 'V', TWAP: 'T', POV: 'P' } },
    DeskName: { tag: 9703 },
    MinFillQty: { tag: 9704, type: 'number' },
  },
  messages: {
    NewOrderSingle: ['AlgoStrategy', 'DeskName', 'MinFillQty'],
    ExecutionReport: ['AlgoStrategy'],
  },
});

// ... and they work exactly like standard fields: named, typed, autocompleted.
const session = await connect('broker:9878', { sender: 'FUND', target: 'BROKER', dictionary: acme });

const order = await session.newOrder({
  Symbol: 'AAPL',
  Side: Side.Buy,
  OrderQty: 5_000,
  AlgoStrategy: acme.AlgoStrategy.VWAP,     // sent as 9702=V
  DeskName: 'EQ-7',
  MinFillQty: 100,
});
console.log(order.AlgoStrategy);            // 'VWAP'

// Without a dictionary, any tag still works by number, as raw wire text:
await session.newOrder({ Symbol: 'AAPL', Side: Side.Buy, OrderQty: 100, 9999: 'X' });
