// The server process of killed-server.test.ts: every session in a fileStore under the folder DIR,
// two ExecutionReports for each order. It says `PORT <n>` once it listens, and ends when its
// parent's end of its input closes, so it never outlives the test that started it.
import { fileStore, listen } from '../src/index.ts';

const folder = process.env.DIR;
if (!folder) throw new Error('DIR must name the folder of the fileStore');
const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', store: fileStore(folder), limits: { connectionsPerAddress: 100 } });
let reports = 0;
server.on('NewOrderSingle', (order, session) => {
  const common = { OrderID: `O${process.pid}-${reports}`, ClOrdID: order.ClOrdID, Symbol: order.Symbol, Side: order.Side };
  // A send is rejected when its session has closed: the order's sender is gone.
  session.send('ExecutionReport', { ...common, ExecID: `E${process.pid}-${++reports}`, ExecType: 'New', OrdStatus: 'New', LeavesQty: order.OrderQty, CumQty: 0, AvgPx: 0 }).catch(() => {});
  session.send('ExecutionReport', { ...common, ExecID: `E${process.pid}-${++reports}`, ExecType: 'Trade', OrdStatus: 'Filled', LeavesQty: 0, CumQty: order.OrderQty, AvgPx: 25.5, LastQty: order.OrderQty, LastPx: 25.5 }).catch(() => {});
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();
console.log(`PORT ${server.port}`);
