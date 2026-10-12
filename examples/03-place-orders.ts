import { connect, Side, OrdStatus } from 'fix.js';

const session = await connect('localhost:9878', { sender: 'MY_FIRM', target: 'EXCHANGE' });

// No price: a market order. Resolves once the exchange accepts it.
const order = await session.newOrder({ Symbol: 'GOOG', Side: Side.Buy, OrderQty: 100 });
const filled = await order.until(OrdStatus.Filled);
console.log(`Bought ${filled.CumQty} at ${filled.AvgPx}`);

// A price makes it a limit order. Amend it, then wait for the fill.
const limit = await session.newOrder({ Symbol: 'GOOG', Side: Side.Buy, OrderQty: 100, Price: 150.25 });
await limit.replace({ Price: 150.50 });                  // resolves once confirmed
await limit.until(OrdStatus.Filled, { timeout: '60s' });
