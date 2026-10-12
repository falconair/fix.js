import { connect, Version } from 'fix.js';
import { MsgType, OrdType, Side } from 'fix.js/fix50sp2';

// FIX 5.0 SP2 travels over a FIXT.1.1 session: say so with `version`. Everything
// else defaults as before, and the Logon names FIX 5.0 SP2 (DefaultApplVerID).
const session = await connect('localhost:9878', { sender: 'MY_FIRM', target: 'EXCHANGE', version: Version['FIXT.1.1'] });

// The constants of FIX Latest, which includes FIX 5.0 SP2, have an entry of their own (the root's are FIX 4.4's).
await session.send(MsgType.NewOrderSingle, {
  ClOrdID: 'order-1', Symbol: 'GOOG', Side: Side.Buy, OrderQty: 100, OrdType: OrdType.Limit, Price: 150,
});

await session.logout();
