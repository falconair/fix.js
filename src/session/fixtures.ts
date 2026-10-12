// Test support for src/session. Not exported by the package.
import { dictionaryFor } from '../dictionary/index.ts';
import { buildFrame, parseFrame } from '../wire/frame.ts';
import { fromMessage, inspectMessage, type Inspected, type MessageObject } from '../wire/message.ts';
import { fillHeader } from './context.ts';
import { resendPlan, type PlannedSend } from './resend.ts';
import { engineConfig, type Action, type EngineConfig, type EngineOptions, type EngineState, type Step } from './types.ts';

/** 2026-09-29T12:00:00Z, the clock every test starts at. */
export const T0 = Date.parse('2026-09-29T12:00:00Z');

/** We are ME, they are THEM, FIX.4.4, acceptor, defaults otherwise. */
export function testConfig(overrides: Partial<EngineOptions> = {}): EngineConfig {
  return engineConfig({ version: 'FIX.4.4', sender: 'ME', target: 'THEM', role: 'acceptor', ...overrides });
}

/**
 * Makes messages from THEM to ME in one FIX version (its BeginString), each encoded and decoded
 * through the real wire layer with that version's dictionary. Any header field can be overridden.
 */
export function fromThemIn(version: string): (msgType: string, seq: number, fields?: Record<string, unknown>, now?: number) => Inspected {
  const dict = dictionaryFor(version);
  if (dict.version !== version) throw new RangeError(`The library has no dictionary for ${version}`);
  return (msgType, seq, fields = {}, now = T0) => {
    const input = { BeginString: version, SenderCompID: 'THEM', TargetCompID: 'ME', MsgSeqNum: seq, SendingTime: new Date(now), ...fields };
    const { fields: raw, framing } = fromMessage(msgType, input, dict, { version, now: () => new Date(now) });
    return inspectMessage(parseFrame(buildFrame(raw, framing), { dataTags: dict.dataTags }).fields, dict);
  };
}

/** A FIX 4.4 message from THEM to ME. */
export const fromThem = fromThemIn('FIX.4.4');

/** Just the send actions. */
export function sends(actions: readonly Action[]): Extract<Action, { type: 'send' }>[] {
  return actions.filter((action): action is Extract<Action, { type: 'send' }> => action.type === 'send');
}

/**
 * The whole answer to a ResendRequest at once, for a test that holds what was sent in memory: each
 * original `lookup` finds is fed to a resendPlan in MsgSeqNum order, and each message planned has
 * its header filled, as a session does when it sends it. Uses no new sequence numbers.
 */
export function resendAll(
  state: EngineState, config: EngineConfig, lookup: (seq: number) => MessageObject | undefined,
  from: number, to: number, now: number,
): Step {
  const plan = resendPlan(from, to);
  let current = state;
  const actions: Action[] = [];
  const emit = (planned: readonly PlannedSend[]) => {
    for (const { msgType, fields } of planned) {
      const filled = fillHeader(current, config, fields, now);
      current = filled.state;
      actions.push({ type: 'send', msgType, fields: filled.fields });
    }
  };
  for (let seq = from; seq <= to; seq++) {
    const original = lookup(seq);
    if (original) emit(plan.next(seq, original, now));
  }
  emit(plan.end(now));
  return { state: current, actions };
}
