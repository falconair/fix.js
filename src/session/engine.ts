import { FIXStateError } from '../errors.ts';
import type { MessageObject } from '../wire/message.ts';
import { asksForReset, problem, send, type Context } from './context.ts';
import { logout, receiveBeforeLogon, start, startReset } from './handshake.ts';
import { tick } from './liveness.ts';
import { receive, seqNum } from './receive.ts';
import type { EngineConfig, EngineEvent, EngineState, Step } from './types.ts';

export { initialState } from './context.ts';

/**
 * The FIX session protocol as one pure function: given the state, the
 * configuration, an event and the time, it returns the new state and the
 * actions to carry out. It never touches sockets, timers, clocks or storage.
 * It throws FIXStateError only for local misuse (sending when not logged on).
 */
export function step(state: EngineState, config: EngineConfig, event: EngineEvent, now: number): Step {
  if (state.phase === 'closed') {
    if (event.type === 'send') throw new FIXStateError(`Can't send ${event.msgType}: the session is closed`);
    return { state, actions: [] };
  }
  const ctx: Context = { state, config, now, actions: [], ...(event.type === 'received' && event.arrived !== undefined ? { arrived: event.arrived } : {}) };
  switch (event.type) {
    case 'start':
      if (!config.manual) start(ctx);
      break;
    case 'send':
      if (!config.manual && state.phase !== 'active') {
        throw new FIXStateError(`Can't send ${event.msgType}: the session is ${state.phase}, not active`);
      }
      if (!config.manual && event.msgType === 'Logon' && asksForReset(event.fields)) {
        if (state.resetSent) throw new FIXStateError(`Can't send ${event.msgType}: a sequence reset is already awaiting its reply`);
        startReset(ctx);
      }
      send(ctx, event.msgType, event.fields);
      break;
    case 'logout':
      logout(ctx, event.text);
      break;
    case 'setSeqNums':
      ctx.state = { ...ctx.state, next: seqNumOrKeep(event.next, state.next), expected: seqNumOrKeep(event.expected, state.expected) };
      break;
    case 'tick':
      if (!config.manual) tick(ctx);
      break;
    case 'heard':
      ctx.state = { ...ctx.state, lastReceived: now, testRequest: undefined, resendRequestedAt: state.resendRequestedAt === undefined ? undefined : now };
      break;
    case 'garbled':
      problem(ctx, 'Garbled', event.error, 'Ignored');
      break;
    case 'received':
      ctx.state = { ...ctx.state, lastReceived: now, testRequest: undefined };
      if (config.manual) receiveManual(ctx, event.message);
      else if (state.phase === 'active' || state.phase === 'loggingOut') receive(ctx, event.message, event.problems);
      else receiveBeforeLogon(ctx, event.message, event.problems);
      break;
    case 'disconnected':
      ctx.state = { ...ctx.state, phase: 'closed', phaseSince: now };
      break;
  }
  return { state: ctx.state, actions: ctx.actions };
}

/** Manual mode: deliver everything, answer nothing; just keep count. */
function receiveManual(ctx: Context, message: MessageObject): void {
  const seq = seqNum(message);
  if (seq !== undefined && seq >= ctx.state.expected) ctx.state = { ...ctx.state, expected: seq + 1 };
  ctx.actions.push({ type: 'deliver', message });
}

/** A counter value from setSeqNums: a positive safe integer, or undefined to keep the current one. */
function seqNumOrKeep(value: number | undefined, current: number): number {
  if (value === undefined) return current;
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Sequence numbers must be positive whole numbers, not ${value}`);
  return value;
}
