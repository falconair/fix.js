import { listen, MsgType } from 'fix.js';

declare const accounts: { verify(compID: string, password?: string): Promise<boolean> };

const server = await listen(9878, {
  compID: 'EXCHANGE',
  // Checked before the connection gets any resources. Return true, or the Logout text.
  accept: async logon =>
    (await accounts.verify(logon.SenderCompID, logon.Password)) || 'Unknown CompID or wrong password',
});

server.on(MsgType.Logon, (logon, session) => {
  console.log(`${session.id.target} logged on`);
});

const acme = server.session('ACME');     // a counterparty, if connected
await acme?.logout('Maintenance at 17:00');
