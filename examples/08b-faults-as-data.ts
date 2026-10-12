import { connect, type Fault } from 'fix.js';

const session = await connect('localhost:9878', { sender: 'MY_FIRM', target: 'EXCHANGE' });

// Faults are plain data, so a GUI, a DSL or a saved scenario can send them as JSON.
// drop(MsgType.Heartbeat) and this object are the same thing:
const fromTheUI: Fault = JSON.parse('{ "fault": "drop", "type": "Heartbeat", "count": { "after": 10 } }');
session.outgoing(fromTheUI);

// Session history is plain data too, including when faults were added and removed.
session.watch(entry => console.log(JSON.stringify(entry)));
