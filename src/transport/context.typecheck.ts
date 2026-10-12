// Compiled by `npm run typecheck`, never executed: a session's context is absent when accept()
// gave none (or for connect()), so its type says so and it must be checked before use.
import { listen } from './server.ts';

export async function contextNeedsAGuard(): Promise<void> {
  const server = await listen(0, { compID: 'EXCHANGE', accept: logon => (logon.SenderCompID === 'GOLD' ? { context: { tier: 'gold' as const } } : true) });
  const session = server.sessions[0]!;
  // @ts-expect-error — a session accepted with `true` has no context
  const unguarded: 'gold' = session.context.tier;
  const guarded: 'gold' | undefined = session.context?.tier;
  server.on('NewOrderSingle', (_message, from) => {
    // @ts-expect-error — the same for the session a handler is given
    void from.context.tier;
  });
  const connected = await server.whenConnected('GOLD');
  // @ts-expect-error — and for whenConnected()
  void connected.context.tier;
  void [unguarded, guarded];
}
