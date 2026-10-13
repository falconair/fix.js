# fix.js

A JavaScript implementation of the [FIX protocol](https://www.fixtrading.org/) (Financial Information eXchange) for Node.js. Useful for building monitoring tools, order flow utilities, and other non-latency-sensitive trading infrastructure.

> **Note:** This library is intended for tooling and support applications. It is not designed for latency-sensitive or high-frequency trading environments.

## What is FIX?

FIX is a text-based TCP/IP protocol used ubiquitously in financial markets to communicate orders, executions, and market data. Messages are sequences of `tag=value` pairs delimited by SOH (`\x01`):

```
8=FIX.4.2|9=073|35=D|49=SENDER|56=TARGET|52=20240101-12:00:00|11=ORD001|55=GOOG|54=1|38=100|40=2|44=150.00|10=123|
```

Tag numbers like `35`, `49`, `55` are hard to read, which is where this library helps.

## Features

- FIX 4.2, FIX 4.4 and FIX 5.0 SP2 (over FIXT.1.1) sessions over TCP: `connect()` for a client, `listen()` for a server
- The session protocol handled for you: logon, heartbeats, sequence numbers, resends and logout
- Messages are plain objects with FIX names (`order.ClOrdID`), and constants for every enum value (`Side.Buy`)
- Custom fields declared once with `defineDictionary()`
- A history of everything sent, received and noticed (`session.history`, `session.watch()`), with credentials hidden
- A server that bounds what each counterparty can take, and reports every connection, including the ones that never log on (`server.watch()`)
- Sessions tested against QuickFIX/J in FIX 4.2, FIX 4.4 and FIXT.1.1 carrying FIX 5.0 SP2, as client and as server, the server also with QuickFIX/J's own acceptance scripts ([interop](interop/README.md))

Requires Node.js 24 or later.

## Quick start

```ts
import { connect, listen, MsgType, OrdType, Side } from 'fix.js';

// A server: a port and our CompID. A handler runs for that message type on every session.
const server = await listen(9878, { compID: 'EXCHANGE' });
server.on(MsgType.NewOrderSingle, (order, session) => {
  console.log(`${session.id.target} wants ${order.Side} ${order.OrderQty} ${order.Symbol} at ${order.Price}`);
});

// A client: where, and who we are to each other. It is logged on once connect() resolves.
const session = await connect('localhost:9878', { sender: 'MY_FIRM', target: 'EXCHANGE' });
await session.send(MsgType.NewOrderSingle, {
  ClOrdID: 'order-1', Symbol: 'GOOG', Side: Side.Buy, OrderQty: 100, OrdType: OrdType.Limit, Price: 150,
});

await session.logout();
await server.close();
```

For FIX 5.0 SP2, give `connect()` `version: Version['FIXT.1.1']` and take the constants from `fix.js/fix50sp2` ([examples/01c-fix50sp2.ts](examples/01c-fix50sp2.ts)); a server takes such sessions as it is.

The full API, with its options and what is still to come, is described in [api/README.md](api/README.md); [examples](examples) has more programs. How the library is built is in [docs/DESIGN.md](docs/DESIGN.md).

## Acknowledgements

fix.js is tested against [QuickFIX/J](https://www.quickfixj.org/), and much of what it gets right at the session layer was found by running QuickFIX/J's own acceptance scripts against it. Thank you to the QuickFIX and QuickFIX/J projects for an engine and a test suite of that quality. fix.js contains no QuickFIX code: the interop suite downloads QuickFIX/J's engine and acceptance scripts when it first runs ([interop](interop/README.md)).

## Related projects

- [nodefix](https://github.com/falconair/nodefix) — earlier FIX engine for Node.js
- [fixparser.targetcompid.com](https://fixparser.targetcompid.com) — web tool for parsing FIX messages interactively
- [QuickFIX](http://quickfixengine.org/) — production-grade FIX engine (C++/Java)

