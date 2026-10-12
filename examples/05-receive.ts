import { connect, MsgType, OrdStatus } from 'fix.js';

const session = await connect('localhost:9878', { sender: 'MY_FIRM', target: 'EXCHANGE' });

// Every message, as it arrives.
session.on(MsgType.ExecutionReport, report => {
  console.log(report.ClOrdID, report.OrdStatus, report.CumQty);
});

// The next one of a kind, optionally with particular field values.
const heartbeat = await session.next(MsgType.Heartbeat, { timeout: '35s' });
const fill = await session.next(MsgType.ExecutionReport, { where: { OrdStatus: OrdStatus.Filled } });

// As a stream, for scripts.
for await (const reject of session.messages(MsgType.BusinessMessageReject)) {
  console.warn(`${reject.RefMsgType} rejected: ${reject.Text}`);
}
