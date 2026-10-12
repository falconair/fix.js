import { connect, fileStore, Version } from 'fix.js';

// Everything else, only when you need it.
const session = await connect('uat.broker.example:9878', {
  sender: 'MY_FIRM',
  target: 'BROKER',
  version: Version['FIX.4.2'],
  heartbeat: 60,
  logon: { Username: 'desk7', Password: process.env.FIX_PASSWORD },
  store: fileStore('./fix-logs'),       // sequence numbers and history survive restarts
});

session.closed.then(({ by, text }) => console.log(`session ended by ${by}: ${text}`));
