import { connect, Side, TimeInForce, OrderRejectedError, CancelRejectedError } from 'fix.js';

const session = await connect('localhost:9878', { sender: 'MY_FIRM', target: 'EXCHANGE' });

try {
  const order = await session.newOrder({
    Symbol: 'AAPL', Side: Side.Sell, OrderQty: 500, Price: 230, TimeInForce: TimeInForce.Day,
  });
  await order.cancel();                                  // resolves once canceled
  console.log(order.state);                              // { OrdStatus: 'Canceled', CumQty: 0, LeavesQty: 0, ... }
} catch (error) {
  if (error instanceof OrderRejectedError) console.log(`order rejected: ${error.report.Text}`);
  else if (error instanceof CancelRejectedError) console.log(`cancel refused: ${error.reject.CxlRejReason}`);
  else throw error;
}
