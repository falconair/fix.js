import { listen } from 'fix.js';

// The minimum: a port and our CompID. Any counterparty can log on; every
// order is acknowledged; cancels and replaces are accepted.
const server = await listen(9878, { compID: 'EXCHANGE' });
