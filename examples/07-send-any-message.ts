import { connect, MsgType } from 'fix.js';

const session = await connect('localhost:9878', { sender: 'MY_FIRM', target: 'EXCHANGE' });

// The low-level path, for any message. The session fills BeginString,
// BodyLength, SenderCompID, TargetCompID, MsgSeqNum, SendingTime and CheckSum.
await session.send(MsgType.TestRequest, { TestReqID: 'ping' });
await session.send(MsgType.Heartbeat);

// Deliberately wrong messages follow the same rule: what you write is sent as written.
await session.send(MsgType.Heartbeat, { MsgSeqNum: 99 });           // a sequence gap
await session.send(MsgType.Heartbeat, { CheckSum: '000' });         // bad checksum
await session.send(MsgType.Heartbeat, { SendingTime: null });       // required header field left out
await session.send(MsgType.TestRequest, { TestReqID: null });       // required body field left out
await session.send(MsgType.Heartbeat, { 52: 'not-a-time' });        // a numeric tag is raw wire text

// Below the rule entirely: bytes exactly as given.
await session.sendBytes('8=FIX.4.4\x019=5\x0135=0\x0110=000\x01');
