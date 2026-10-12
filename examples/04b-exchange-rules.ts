import { setTimeout as sleep } from 'node:timers/promises';
import { listen, MsgType, OrdRejReason, CxlRejReason, TimeInForce } from 'fix.js';

const listed = new Set(['GOOG', 'AAPL', 'MSFT']);
const server = await listen(9878, { compID: 'EXCHANGE', marketPrice: () => 100 });

server.on(MsgType.NewOrderSingle, async order => {
  if (!listed.has(order.Symbol)) {
    return order.reject(`${order.Symbol} is not listed`, { OrdRejReason: OrdRejReason.UnknownSymbol });
  }
  if (order.TimeInForce === TimeInForce.ImmediateOrCancel) {
    await order.fill(Math.floor(order.OrderQty / 2));
    return order.cancel();                                   // the rest is canceled
  }
  if (order.OrderQty > 1_000) {
    await order.fill(400);                                   // CumQty 400, LeavesQty 600
    await sleep(500);
    await order.fill(400, { LastPx: 150.30 });               // another price; AvgPx follows
    await sleep(500);
  }
  return order.fill();                                       // whatever is left
});

server.on(MsgType.OrderCancelReplaceRequest, request => {
  if (request.OrderQty > request.order.state.OrderQty) {
    return request.reject('Quantity increases not allowed', { CxlRejReason: CxlRejReason.BrokerOption });
  }
  // Not answering means the default: accepted.
});

// Open orders across every connected client, e.g. for a UI.
for (const order of server.orders.filter(o => o.isOpen)) {
  const { OrdStatus, CumQty, LeavesQty } = order.state;
  console.log(order.session.id.target, order.ClOrdID, OrdStatus, CumQty, LeavesQty);
}
