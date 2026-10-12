import { DEFAULT_APPL_VER_ID, FIXT11, type Version } from '../version.ts';
import { rawValue, type MessageObject } from '../wire/message.ts';
import type { Action, EngineConfig, EngineState, Problem, ProblemCode } from './types.ts';

/** One step's working state: the state so far and the actions produced. */
export interface Context {
  state: EngineState;
  readonly config: EngineConfig;
  readonly now: number;
  /** When the message this step is about arrived (ms), when its event says it arrived before `now`. */
  readonly arrived?: number;
  readonly actions: Action[];
}

type Fields = Readonly<Record<string, unknown>>;

/** A new session's state. `seqNums` restores counters from a store. */
export function initialState(config: EngineConfig, now: number, seqNums: { next: number; expected: number } = { next: 1, expected: 1 }): EngineState {
  return {
    phase: config.manual ? 'active' : 'connected',
    next: seqNums.next,
    expected: seqNums.expected,
    heartbeat: config.heartbeat,
    lastSent: now,
    lastReceived: now,
    phaseSince: now,
    testRequest: undefined,
    testRequests: 0,
    recovering: undefined,
    resendRequestedAt: undefined,
    resendAttempts: 0,
    resetSent: false,
    resetRepliesOwed: 0,
    applVerID: undefined,
  };
}

/** Both sequences start again at 1, and whatever was being recovered is forgotten. */
export function restarted(state: EngineState): EngineState {
  return { ...state, next: 1, expected: 1, recovering: undefined, resendRequestedAt: undefined, resendAttempts: 0 };
}

/** A header field counts as written if its name or its tag number is present (null included). */
function written(fields: Fields, name: string, tag: number): boolean {
  return fields[name] !== undefined || fields[String(tag)] !== undefined;
}

/** Whether fields to be sent carry ResetSeqNumFlag=Y: written by name as true, or by tag number as the wire text. */
export function asksForReset(fields: Fields): boolean {
  return fields.ResetSeqNumFlag === true || fields['141'] === 'Y';
}

/**
 * The auto-fill rule for the session header: BeginString, SenderCompID,
 * TargetCompID, SendingTime and MsgSeqNum are filled unless written. Only a
 * filled MsgSeqNum uses up a sequence number.
 */
export function fillHeader(state: EngineState, config: EngineConfig, fields: Fields, now: number): { state: EngineState; fields: Record<string, unknown> } {
  const out: Record<string, unknown> = { ...fields };
  if (!written(out, 'BeginString', 8)) out.BeginString = config.version;
  if (!written(out, 'SenderCompID', 49)) out.SenderCompID = config.sender;
  if (!written(out, 'TargetCompID', 56)) out.TargetCompID = config.target;
  if (!written(out, 'SendingTime', 52)) out.SendingTime = new Date(now);
  let next = state.next;
  if (!written(out, 'MsgSeqNum', 34)) {
    out.MsgSeqNum = next;
    next += 1;
  }
  return { state: { ...state, next, lastSent: now }, fields: out };
}

/**
 * A Logon's fields with DefaultApplVerID (1137) filled in under FIXT.1.1, where FIX requires it,
 * unless it is written: `applVerID`, or FIX 5.0 SP2 when the session has named none yet.
 */
export function fillLogon(version: string, fields: Fields, applVerID: string | undefined): Fields {
  if (version !== FIXT11 || written(fields, 'DefaultApplVerID', 1137)) return fields;
  return { ...fields, DefaultApplVerID: applVerID ?? DEFAULT_APPL_VER_ID };
}

/**
 * The auto-fill rule for a message the session sends: the header (see fillHeader), and on a Logon
 * under FIXT.1.1 the application version the session names (see fillLogon).
 */
export function fillMessage(state: EngineState, config: EngineConfig, msgType: string, fields: Fields, now: number): { state: EngineState; fields: Record<string, unknown> } {
  return fillHeader(state, config, msgType === 'Logon' ? fillLogon(config.version, fields, state.applVerID) : fields, now);
}

export function send(ctx: Context, msgType: string, fields: Fields = {}): void {
  const filled = fillMessage(ctx.state, ctx.config, msgType, fields, ctx.now);
  ctx.state = filled.state;
  ctx.actions.push({ type: 'send', msgType, fields: filled.fields });
}

export function problem(ctx: Context, code: ProblemCode, text: string, action: Problem['action'], refSeqNum?: number): void {
  ctx.actions.push({ type: 'problem', problem: refSeqNum === undefined ? { code, text, action } : { code, text, action, refSeqNum } });
}

export function disconnect(ctx: Context, by: 'us' | 'them', text: string): void {
  ctx.state = { ...ctx.state, phase: 'closed', phaseSince: ctx.now };
  ctx.actions.push({ type: 'disconnect', by, text });
}

/** Record the problem, send a Logout explaining it, and disconnect. */
export function logoutAndDisconnect(ctx: Context, code: ProblemCode, text: string, refSeqNum?: number): void {
  problem(ctx, code, text, 'LoggedOut', refSeqNum);
  send(ctx, 'Logout', { Text: text });
  disconnect(ctx, 'us', text);
}

/**
 * The highest SessionRejectReason each version defines (99, Other, stands apart). A later one is
 * not a value a counterparty of that version knows, so reject() leaves it out there.
 */
export const LAST_REJECT_REASON: Readonly<Record<Version, number>> = { 'FIX.4.2': 11, 'FIX.4.4': 17, 'FIXT.1.1': 18 };

/** The highest SessionRejectReason a version defines; no limit for one that is not in the table. */
function lastRejectReason(version: string): number {
  return Object.hasOwn(LAST_REJECT_REASON, version) ? LAST_REJECT_REASON[version as Version] : Infinity;
}

/** SessionRejectReason wire values, written by tag number so that no dictionary has to name them. */
export const REJECT_REASONS = {
  InvalidTagNumber: '0',
  RequiredTagMissing: '1',
  TagNotDefinedForThisMessageType: '2',
  TagSpecifiedWithoutAValue: '4',
  ValueIsIncorrect: '5',
  IncorrectDataFormatForValue: '6',
  CompIDProblem: '9',
  SendingTimeAccuracyProblem: '10',
  InvalidMsgType: '11',
  TagAppearsMoreThanOnce: '13',
  TagSpecifiedOutOfRequiredOrder: '14',
  RepeatingGroupFieldsOutOfOrder: '15',
  IncorrectNumInGroupCountForRepeatingGroup: '16',
  InvalidUnsupportedAppVersion: '18',
} as const;

export type RejectReason = keyof typeof REJECT_REASONS;

/** The routing fields a message can carry for a third party: each received field's tag and name, and the tag and name of the field it goes back in. */
const REVERSE_ROUTE: readonly { readonly received: readonly [tag: number, name: string]; readonly sent: readonly [tag: number, name: string] }[] = [
  { received: [115, 'OnBehalfOfCompID'], sent: [128, 'DeliverToCompID'] },
  { received: [116, 'OnBehalfOfSubID'], sent: [129, 'DeliverToSubID'] },
  { received: [144, 'OnBehalfOfLocationID'], sent: [145, 'DeliverToLocationID'] },
  { received: [128, 'DeliverToCompID'], sent: [115, 'OnBehalfOfCompID'] },
  { received: [129, 'DeliverToSubID'], sent: [116, 'OnBehalfOfSubID'] },
  { received: [145, 'DeliverToLocationID'], sent: [144, 'OnBehalfOfLocationID'] },
];

/**
 * Send a session-level Reject for a received message. Its routing fields go
 * back the other way round (OnBehalfOfCompID as DeliverToCompID, and so on), as
 * the exact text that came, so a hub between the two sides can pass the Reject
 * on to whoever sent the message. A routing field that came empty is left out.
 */
export function reject(ctx: Context, message: MessageObject, refSeqNum: number, reason: RejectReason, text: string, refTagID?: number): void {
  const fields: Record<string, unknown> = { RefSeqNum: refSeqNum, Text: text };
  for (const { received, sent } of REVERSE_ROUTE) {
    const raw = rawValue(message, received[0]);
    if (raw !== undefined) {
      if (raw !== '') fields[sent[0]] = raw;
    } else {
      const value = message[received[1]];
      if (typeof value === 'string' && value !== '') fields[sent[1]] = value;
    }
  }
  const code = REJECT_REASONS[reason];
  // A reason the session's version does not define (FIX 4.2 has 0 to 11 only) is said by the Text alone.
  if (Number(code) <= lastRejectReason(ctx.config.version)) fields[373] = code;
  if (refTagID !== undefined) fields.RefTagID = refTagID;
  const msgType = rawValue(message, 35);
  if (msgType !== undefined) fields[372] = msgType;
  send(ctx, 'Reject', fields);
}
