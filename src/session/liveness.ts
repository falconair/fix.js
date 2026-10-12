import { disconnect, logoutAndDisconnect, problem, send, type Context } from './context.ts';

/** Silence tolerated before a TestRequest, as a multiple of the heartbeat interval. */
const TEST_REQUEST_AFTER = 1.2;

/** Timers: logon/logout timeouts, heartbeats, TestRequest and heartbeat timeout. */
export function tick(ctx: Context): void {
  const { state, config, now } = ctx;
  if (state.phase === 'loggingOn' && now - state.phaseSince >= config.logonTimeout * 1000) {
    problem(ctx, 'LogonTimeout', `No Logon reply within ${config.logonTimeout} s`, 'Disconnected');
    disconnect(ctx, 'us', 'Logon timed out');
    return;
  }
  if (state.phase === 'connected' && config.role === 'acceptor' && now - state.phaseSince >= config.logonTimeout * 1000) {
    problem(ctx, 'LogonTimeout', `No Logon within ${config.logonTimeout} s`, 'Disconnected');
    disconnect(ctx, 'us', 'Logon timed out');
    return;
  }
  if (state.phase === 'loggingOut' && now - state.phaseSince >= config.logoutTimeout * 1000) {
    problem(ctx, 'LogoutTimeout', `No Logout reply within ${config.logoutTimeout} s`, 'Disconnected');
    disconnect(ctx, 'us', 'Logout was not answered');
    return;
  }
  if (state.phase !== 'active') return;
  if (state.heartbeat <= 0) {
    rerequestResend(ctx);
    return;
  }

  const interval = state.heartbeat * 1000;
  if (state.testRequest && now - state.testRequest.sentAt >= interval) {
    problem(ctx, 'HeartbeatTimeout', `No reply to TestRequest ${state.testRequest.id} within ${state.heartbeat} s`, 'Disconnected');
    disconnect(ctx, 'us', 'Heartbeat timeout');
    return;
  }
  if (!rerequestResend(ctx)) return;
  if (!state.testRequest && now - state.lastReceived >= interval * TEST_REQUEST_AFTER) {
    const id = `TEST-${state.testRequests + 1}`;
    send(ctx, 'TestRequest', { TestReqID: id });
    ctx.state = { ...ctx.state, testRequest: { id, sentAt: now }, testRequests: state.testRequests + 1 };
  }
  if (now - ctx.state.lastSent >= interval) send(ctx, 'Heartbeat');
}

/** Most ResendRequests sent for one gap before we give up on it. */
const MAX_RESEND_ATTEMPTS = 3;

/**
 * A stalled resend: ask again every heartbeat interval (logonTimeout when
 * heartbeats are off), and after MAX_RESEND_ATTEMPTS requests log out.
 * Returns false if the session was ended.
 */
function rerequestResend(ctx: Context): boolean {
  const { state, config, now } = ctx;
  if (state.recovering === undefined || state.resendRequestedAt === undefined) return true;
  const interval = (state.heartbeat > 0 ? state.heartbeat : config.logonTimeout) * 1000;
  if (now - state.resendRequestedAt < interval) return true;
  if (state.resendAttempts >= MAX_RESEND_ATTEMPTS) {
    logoutAndDisconnect(ctx, 'SeqNumGap', `Resend from ${state.expected} still incomplete after ${MAX_RESEND_ATTEMPTS} requests`);
    return false;
  }
  problem(ctx, 'SeqNumGap', `Resend from ${state.expected} still incomplete after ${interval / 1000} s; requesting again`, 'ResendRequested');
  send(ctx, 'ResendRequest', { BeginSeqNo: state.expected, EndSeqNo: 0 });
  ctx.state = { ...ctx.state, resendRequestedAt: now, resendAttempts: state.resendAttempts + 1 };
  return true;
}
