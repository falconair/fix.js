// 100,000 orders through a system under test, measuring time to acknowledgement.

import { connect, Side } from 'fix.js';

const session = await connect('oms-under-test:9878', { sender: 'LOAD1', target: 'OMS' });
const symbols = ['GOOG', 'AAPL', 'MSFT'];
const latencies: number[] = [];

const pending = Array.from({ length: 100_000 }, async (_, i) => {
  const sentAt = performance.now();
  await session.newOrder({                        // resolves when the order is accepted
    Symbol: symbols[i % symbols.length]!,
    Side: i % 2 ? Side.Buy : Side.Sell,
    OrderQty: 100,
    Price: 100 + (i % 50),
  }, { timeout: '30s' });
  latencies.push(performance.now() - sentAt);
});
await Promise.all(pending);

latencies.sort((a, b) => a - b);
console.log(`p50 ${latencies[latencies.length >> 1]} ms, p99 ${latencies[Math.floor(latencies.length * 0.99)]} ms`);
