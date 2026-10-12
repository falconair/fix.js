import { connect } from 'fix.js';

// The minimum: where, and who we are to each other.
// Defaults: FIX.4.4, 30-second heartbeat, in-memory store, automatic logon.
const session = await connect('localhost:9878', { sender: 'MY_FIRM', target: 'EXCHANGE' });

// ...trade...

await session.logout();
