// A sketch of driving fix.js against another engine, with message types known only at run time.
// It cannot run yet: its first test places an order with newOrder(), and orders are not built.
// Until they are it is only type-checked, like every example (npm run check:api).
// It assumes a QuickFIX/J Executor on localhost:9880 and a folder of its acceptance scripts.
// The suite that really tests fix.js's sessions against QuickFIX/J is in ../interop (npm run test:interop).
//  1. Our client trades with QuickFIX/J's sample Executor.
//  2. QuickFIX/J's acceptance scripts (I = send, E = expect) run against our server,
//     played by a manual-mode client so nothing automatic interferes.

import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { connect, listen, Side, OrdStatus } from 'fix.js';
import { decode } from 'fix.js/wire';

test('trades with QuickFIX/J Executor', async () => {
  const session = await connect('localhost:9880', { sender: 'BANZAI', target: 'EXEC' });
  const order = await session.newOrder({ Symbol: 'IBM', Side: Side.Buy, OrderQty: 100, Price: 10 });
  await order.until(OrdStatus.Filled);
});

const scripts = 'qfj-definitions/server/fix44';
for (const file of await readdir(scripts)) {
  test(`acceptance: ${file}`, async () => {
    const server = await listen(0, { compID: 'ISLD' });
    const session = await connect({ host: 'localhost', port: server.port }, { sender: 'TW', target: 'ISLD', manual: true });

    for (const line of (await readFile(`${scripts}/${file}`, 'utf8')).split('\n')) {
      if (line.length < 2) continue;
      const { MsgType, ...fields } = decode(line.slice(1).replaceAll('<TIME>', ''), { lenient: true });
      if (line[0] === 'I') await session.send(MsgType, { ...fields, SendingTime: undefined });
      if (line[0] === 'E') await session.next(MsgType, { where: { ...fields, SendingTime: undefined } });
    }
    await server.close();
  });
}
