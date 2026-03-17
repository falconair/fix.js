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

- Human-readable field/message lookups (`fields['Symbol']` → `'55'`, `fields['55']` → `'Symbol'`)
- Enum lookups for field values (`enums[fields['Side']]['Buy']` → `'1'`)
- `FIXSession` manages sequence numbers, sender/target IDs, and timestamps automatically
- `Heartbeater` handles keep-alive messages transparently via Node.js streams
- Frame decoder to split a raw TCP stream into complete FIX messages


## Usage

### Creating a FIX session

```js
const { FIXSession, Heartbeater } = require('./src/fix');

const session = new FIXSession('FIX.4.2', 'MY_SENDER', 'TARGET_COMP');
const heartbeater = new Heartbeater(session);

heartbeater.enable(30); // send a heartbeat every 30 seconds
```

### Connecting as a client

```js
const net = require('net');
const { FIXSession, Heartbeater, FrameDecoder, FIXParser } = require('./src/fix');

const session    = new FIXSession('FIX.4.2', 'MY_SENDER', 'TARGET_COMP');
const heartbeater = new Heartbeater(session);
heartbeater.enable(30);

const socket = net.connect({ port: 9878, host: 'localhost' }, () => {
  heartbeater.pipe(socket);  // outbound: heartbeater → socket
  session.logon();
});

socket
  .pipe(new FrameDecoder())  // split TCP stream into complete messages
  .pipe(new FIXParser())     // parse each message into a Map
  .on('data', (msg) => {
    const msgType = msg.get(fields['MsgType']);
    console.log('Received:', msgs[msgType], msg);
  });
```

### Accepting incoming connections (server)

```js
const net = require('net');
const { FIXSession, FrameDecoder, FIXParser } = require('./src/fix');

net.createServer((socket) => {
  const session = new FIXSession('FIX.4.2', 'TARGET_COMP', 'MY_SENDER');
  session.pipe(socket);

  socket
    .pipe(new FrameDecoder())
    .pipe(new FIXParser())
    .on('data', (msg) => {
      const msgType = msg.get(fields['MsgType']);
      if (msgType === msgs['Logon']) session.logon(); // respond to logon
      console.log('Received:', msgs[msgType], msg);
    });
}).listen(9878);
```
### Building and sending a message

Messages are standard JavaScript `Map` objects. `FIXSession` fills in the session-level fields (sequence number, sender/target IDs, timestamps) automatically.

```js
// Build a NewOrderSingle
const order = new Map();
order.set(fields['Symbol'],   'GOOG');
order.set(fields['Side'],      enums[fields['Side']]['Buy']);
order.set(fields['OrderQty'], '100');
order.set(fields['OrdType'],  enums[fields['OrdType']]['Limit']);
order.set(fields['Price'],    '150.00');

session.sendMsg(msgs['NewOrderSingle'], order);
```

## Related projects

- [nodefix](https://github.com/falconair/nodefix) — earlier FIX engine for Node.js
- [fixparser.targetcompid.com](http://fixparser.targetcompid.com) — web tool for parsing FIX messages interactively
- [QuickFIX](http://quickfixengine.org/) — production-grade FIX engine (C++/Java)

