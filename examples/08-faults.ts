import { connect, MsgType, ExecType } from 'fix.js';
import { drop, delay, set, duplicate, dropSeq, nth, after, sometimes } from 'fix.js/faults';

const session = await connect('localhost:9878', { sender: 'MY_FIRM', target: 'EXCHANGE' });

// Stop sending heartbeats, and later start again.
const resume = session.outgoing(drop(MsgType.Heartbeat));
resume();

// Slow down execution reports; lose only the third fill.
session.outgoing(delay(MsgType.ExecutionReport, 2_000));
session.outgoing(nth(3, drop(MsgType.ExecutionReport, { ExecType: ExecType.Trade })));

// Corrupt, duplicate, go quiet after a while, or lose 5% of everything, repeatably.
session.outgoing(set(MsgType.TestRequest, { CheckSum: '000' }));
session.outgoing(duplicate(MsgType.NewOrderSingle));
session.outgoing(after(10, drop(MsgType.Heartbeat)));
session.outgoing(sometimes(0.05, drop(), { seed: 7 }));

// Incoming: act as if their messages 5 and 6 never arrived. Our engine sees
// the gap and sends a ResendRequest, which tests *their* recovery.
session.incoming(dropSeq(5, 6));

// Scoped: removed when the function ends, even if it throws.
async function whileQuiet(work: () => Promise<void>) {
  using _ = session.outgoing(drop(MsgType.Heartbeat));
  await work();
}
