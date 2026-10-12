// A complete test file (node:test; vitest and bun test work the same way).
// The exchange and its client run in one process on a free port.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { listen, connect, MsgType, Side, OrdStatus, ExecType, OrderRejectedError, type Server } from 'fix.js';
import { drop } from 'fix.js/faults';
import { expectNone, within, fakeClock } from 'fix.js/test';

const clock = fakeClock();
let exchange: Server;

before(async () => {
  exchange = await listen(0, { compID: 'EXCHANGE', clock, marketPrice: () => 100 });
  exchange.on(MsgType.NewOrderSingle, order =>
    order.Symbol === 'HALTED' ? order.reject('Trading halted') : order.fill());
});
after(() => exchange.close());

const client = () => connect({ host: 'localhost', port: exchange.port }, { sender: 'TEST', target: 'EXCHANGE', clock });

test('fills market orders at the market price', async () => {
  const session = await client();
  const order = await session.newOrder({ Symbol: 'GOOG', Side: Side.Buy, OrderQty: 10 });
  const filled = await order.until(OrdStatus.Filled);
  assert.equal(filled.AvgPx, 100);
});

test('rejects halted symbols without an ack', async () => {
  const session = await client();
  await assert.rejects(
    session.newOrder({ Symbol: 'HALTED', Side: Side.Buy, OrderQty: 10 }),
    (error: OrderRejectedError) => error.report.Text === 'Trading halted',
  );
  await expectNone(session, MsgType.ExecutionReport, { where: { ExecType: ExecType.New }, for: '1s' });
});

test('disconnects a client that stops heartbeating', async () => {
  const session = await client();
  const serverSide = await exchange.whenConnected('TEST');
  session.outgoing(drop(MsgType.Heartbeat));

  await clock.advance('40s');                          // no real waiting
  await session.next(MsgType.TestRequest);             // the exchange checks on us...
  await clock.advance('40s');
  const { by } = await within(serverSide.closed, '1s'); // ...then gives up
  assert.equal(by, 'us');
});
