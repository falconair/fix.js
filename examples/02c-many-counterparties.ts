// One acceptor for many counterparties: per-counterparty settings, limits,
// and a feed of every connection, including ones that never log on.
import { listen, fileStore, MsgType } from 'fix.js';

interface Account { readonly name: string; readonly tier: 'standard' | 'premium' }
declare const accounts: { find(compID: string, password?: string): Promise<Account | undefined> };

const server = await listen(9878, {
  compID: ['EXCHANGE', 'EXCHANGE-UAT'],
  store: fileStore('./fix-logs'),
  heartbeat: { min: 5, max: 60 },
  limits: { maxSessions: 500, connectionsPerAddress: 4 },
  accept: async logon => {
    const account = await accounts.find(logon.SenderCompID, logon.Password);
    if (!account) return 'Unknown CompID or wrong password';
    return { context: account, heartbeat: account.tier === 'premium' ? { max: 120 } : {} };
  },
});

// "Why won't they connect?": refusals carry the reason and the CompIDs they sent.
server.watch(entry => {
  if (entry.event === 'rejected') console.log(`${entry.peer.address} ${entry.logon?.SenderCompID ?? '?'}: ${entry.problem.text}`);
}, { replay: true });

server.on(MsgType.Logon, (_logon, session) => {
  console.log(`${session.key} (${session.context?.name}) logged on from ${session.peer?.address}`);
});
