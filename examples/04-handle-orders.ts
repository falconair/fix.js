import { listen, MsgType } from 'fix.js';

// A test exchange that fills every order. The ack is sent automatically first.
const server = await listen(9878, { compID: 'EXCHANGE', marketPrice: () => 100 });

server.on(MsgType.NewOrderSingle, order => order.fill());
