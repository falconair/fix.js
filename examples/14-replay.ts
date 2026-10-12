// Something odd happened in UAT. Replay what we sent, 10× faster, against a fixed build.

import { connect } from 'fix.js';
import { listLogs, readLog, replay } from 'fix.js/log';

const [latest] = await listLogs('./fix-logs');       // written by fileStore('./fix-logs')
if (!latest) throw new Error('no session logs in ./fix-logs');

const log = await readLog(latest.path);
const session = await connect('localhost:9878', log.id);   // same CompIDs and version
await replay(log, session, { side: 'out', speed: 10 });
await session.logout();
