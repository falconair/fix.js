import { APPL_VER_ID_WIRE, APPL_VER_IDS, DEFAULT_APPL_VER_ID, excerpt, FIXT11, isApplVerID, oneOf } from '../version.ts';
import type { DecodeProblem, MessageObject } from '../wire/message.ts';
import { asksForReset, disconnect, logoutAndDisconnect, problem, restarted, send, type Context } from './context.ts';
import { checkHeader, firstRejectable, possDupProblem, requestResend, seqNum } from './receive.ts';
import type { EngineConfig, ProblemCode } from './types.ts';

/**
 * The fields of the Logon an initiator sends: EncryptMethod and HeartBtInt, then whatever `logon`
 * adds or writes differently. (Under FIXT.1.1 the session fills in DefaultApplVerID: see fillLogon.)
 */
export function initiatorLogon(config: Pick<EngineConfig, 'heartbeat' | 'logon'>): Record<string, unknown> {
  return { EncryptMethod: 'None', HeartBtInt: config.heartbeat, ...config.logon };
}

/**
 * The application version a Logon we send names, as the session's own: by field name, or by tag number
 * with the wire value; FIX 5.0 SP2 when it writes none. Undefined when it is written as null (the
 * field is left out) or as something that is not a version's name or wire value.
 */
function namedApplVerID(fields: Readonly<Record<string, unknown>>): string | undefined {
  if (fields.DefaultApplVerID !== undefined) return typeof fields.DefaultApplVerID === 'string' ? fields.DefaultApplVerID : undefined;
  if (fields[1137] !== undefined) return APPL_VER_IDS.find(name => APPL_VER_ID_WIRE[name] === String(fields[1137]));
  return DEFAULT_APPL_VER_ID;
}

/** Initiator: send our Logon. Under FIXT.1.1 the application version it names is the session's from here on: every later Logon of ours names the same one. */
export function start(ctx: Context): void {
  if (ctx.config.role !== 'initiator' || ctx.state.phase !== 'connected') return;
  const fields = initiatorLogon(ctx.config);
  if (ctx.config.version === FIXT11) ctx.state = { ...ctx.state, applVerID: namedApplVerID(fields) };
  if (asksForReset(fields)) {
    ctx.state = { ...ctx.state, next: 1, expected: 1 };
    ctx.actions.push({ type: 'reset' });
  }
  send(ctx, 'Logon', fields);
  ctx.state = { ...ctx.state, phase: 'loggingOn', phaseSince: ctx.now };
}

/**
 * Why a FIXT.1.1 Logon's DefaultApplVerID (1137) cannot be taken, or undefined when it can:
 * it must be there, and name an application version fix.js reads. `value` is the field as decoded.
 *
 * `wire` is every text the Logon's frame carries for tag 1137, given where the frame is all there is
 * to go by (a server, before a session exists: no decoder's problems are looked at there). Then the
 * frame must carry the field once, as the text FIX sends for such a version (7, 8, 9 or 10).
 */
export function applVerIDProblem(value: unknown, wire?: readonly string[]): { readonly code: ProblemCode; readonly text: string } | undefined {
  if (wire && wire.length > 1) return { code: 'TagAppearsMoreThanOnce', text: 'Tag 1137 appears more than once' };
  if (value === undefined || value === '') return { code: 'RequiredTagMissing', text: 'DefaultApplVerID (1137) is required in a FIXT.1.1 Logon' };
  if (!isApplVerID(value)) return { code: 'InvalidUnsupportedAppVersion', text: `DefaultApplVerID ${excerpt(value)} is not supported; use ${oneOf(APPL_VER_IDS)}` };
  // The name itself as the frame's text is not a value of the field.
  if (wire && wire[0] !== APPL_VER_ID_WIRE[value]) {
    return { code: 'ValueIsIncorrect', text: `DefaultApplVerID (1137) has no value '${value}': ${value} is sent as ${APPL_VER_ID_WIRE[value]}` };
  }
  return undefined;
}

/** What a Logon that passed its checks says. */
export interface Logon {
  readonly seq: number;
  /** HeartBtInt, in seconds. */
  readonly heartbeat: number;
  /** ResetSeqNumFlag=Y. */
  readonly reset: boolean;
  /** DefaultApplVerID, under FIXT.1.1. */
  readonly applVerID: string | undefined;
}

/**
 * The checks every Logon we receive must pass, whether it is the first message of a connection or
 * resets the sequence numbers of a logged-on session: the header (BeginString, CompIDs, SendingTime),
 * MsgSeqNum, HeartBtInt, the dictionary's rules, EncryptMethod, that one marked as a possible
 * duplicate has a sound OrigSendingTime, that a reset comes as MsgSeqNum 1, and under FIXT.1.1 that
 * it names an application version fix.js reads. One that fails is refused with a Logout saying why
 * (after a Reject, when checkHeader sends one), and undefined is returned. The message's own fields
 * are looked at, whatever problems the caller reports.
 */
export function checkLogon(ctx: Context, message: MessageObject, problems: readonly DecodeProblem[]): Logon | undefined {
  if (!checkHeader(ctx, message)) return undefined;
  const seq = seqNum(message);
  if (seq === undefined) {
    logoutAndDisconnect(ctx, 'MissingMsgSeqNum', 'MsgSeqNum is missing or not a whole number');
    return undefined;
  }
  const refuse = (code: ProblemCode, text: string): undefined => {
    logoutAndDisconnect(ctx, code, text, seq);
    return undefined;
  };
  const heartbeat = message.HeartBtInt;
  if (heartbeat === undefined) return refuse('RequiredTagMissing', 'HeartBtInt is missing');
  // What the decoder reported for the message is the account given; the checks below word what it cannot see.
  const decodeProblem = firstRejectable(message, problems);
  if (decodeProblem) return refuse(decodeProblem.code, decodeProblem.text);
  if (heartbeat === '') return refuse('TagSpecifiedWithoutAValue', 'HeartBtInt (108) has no value');
  if (typeof heartbeat !== 'number' || !Number.isInteger(heartbeat) || heartbeat < 0) {
    return refuse('IncorrectDataFormatForValue', `HeartBtInt must be a whole number of seconds, not ${String(heartbeat)}`);
  }
  const encryptMethod = message.EncryptMethod;
  if (encryptMethod !== undefined && encryptMethod !== 'None') return refuse('ValueIsIncorrect', `EncryptMethod ${String(encryptMethod)} is not supported`);
  const dup = possDupProblem(message);
  if (dup) return refuse(dup.code, dup.text);
  const reset = message.ResetSeqNumFlag === true;
  if (reset && seq !== 1) return refuse('ValueIsIncorrect', `A Logon with ResetSeqNumFlag=Y must have MsgSeqNum 1, not ${seq}`);
  if (ctx.config.version !== FIXT11) return { seq, heartbeat, reset, applVerID: undefined };
  const version = applVerIDProblem(message.DefaultApplVerID);
  if (version) return refuse(version.code, version.text);
  return { seq, heartbeat, reset, applVerID: String(message.DefaultApplVerID) };
}

/**
 * The Logon we send in answer to one that passed checkLogon(): with the session's HeartBtInt, and
 * with ResetSeqNumFlag=Y when it answers a reset. (Under FIXT.1.1 the session fills in
 * DefaultApplVerID: see fillLogon.)
 */
export function answerLogon(ctx: Context, logon: Logon): void {
  send(ctx, 'Logon', { EncryptMethod: 'None', HeartBtInt: ctx.state.heartbeat, ...(logon.reset ? { ResetSeqNumFlag: true } : {}) });
}

/** Before logon, the only acceptable message is a Logon (theirs, or the reply to ours). */
export function receiveBeforeLogon(ctx: Context, message: MessageObject, problems: readonly DecodeProblem[]): void {
  if (message.MsgType === 'Logout' && ctx.state.phase === 'loggingOn') {
    const text = typeof message.Text === 'string' ? message.Text : undefined;
    ctx.actions.push({ type: 'deliver', message });
    problem(ctx, 'LogonRejected', text === undefined ? 'Logon rejected' : `Logon rejected: ${text}`, 'Disconnected', seqNum(message));
    disconnect(ctx, 'them', text ?? 'Logon rejected');
    return;
  }
  if (message.MsgType !== 'Logon') {
    problem(ctx, 'NotLoggedOn', `The first message must be a Logon, not ${String(message.MsgType)}`, 'Disconnected', seqNum(message));
    disconnect(ctx, 'us', 'The first message was not a Logon');
    return;
  }
  if (ctx.config.role === 'initiator' && ctx.state.phase === 'connected') {
    problem(ctx, 'NotLoggedOn', 'Received a Logon before sending ours', 'Disconnected', seqNum(message));
    disconnect(ctx, 'us', 'Received a Logon before sending ours');
    return;
  }
  const logon = checkLogon(ctx, message, problems);
  if (!logon) return;
  const { seq, heartbeat, reset } = logon;
  if (reset && ctx.config.role === 'acceptor') {
    ctx.state = { ...ctx.state, next: 1, expected: 1 };
    ctx.actions.push({ type: 'reset' });
  } else if (reset) {
    ctx.state = { ...ctx.state, expected: 1 };   // our own Logon already reset `next`
  }
  const expected = ctx.state.expected;
  if (seq < expected) {
    logoutAndDisconnect(ctx, 'SeqNumTooLow', `MsgSeqNum too low, expecting ${expected} but received ${seq}`, seq);
    return;
  }
  if (ctx.config.role === 'acceptor') {
    // An acceptor takes the counterparty's heartbeat interval and, under FIXT.1.1, answers with the application version it named.
    ctx.state = { ...ctx.state, heartbeat, applVerID: logon.applVerID };
    answerLogon(ctx, logon);
  } else if (heartbeat !== ctx.config.heartbeat) {
    problem(ctx, 'ValueIsIncorrect', `Logon reply has HeartBtInt ${heartbeat}; keeping ${ctx.config.heartbeat}`, 'Ignored', seq);
  }
  ctx.state = { ...ctx.state, phase: 'active', phaseSince: ctx.now };
  ctx.actions.push({ type: 'active' }, { type: 'deliver', message });
  if (seq > expected) requestResend(ctx, seq);
  else ctx.state = { ...ctx.state, expected: seq + 1 };
}

/**
 * We are about to send a Logon with ResetSeqNumFlag=Y on a logged-on session:
 * both sequences start again at 1, so it goes out as MsgSeqNum 1, and its reply is awaited
 * until it comes, or the counterparty begins the new sequence without one (see receive()).
 * Either way a Logon is owed for it: the next reset Logon to arrive is its reply.
 */
export function startReset(ctx: Context): void {
  ctx.state = { ...restarted(ctx.state), resetSent: true, resetRepliesOwed: ctx.state.resetRepliesOwed + 1 };
  ctx.actions.push({ type: 'reset' });
}

/** Our logout: a Logout awaiting the reply; before logon (or in manual mode) just disconnect. */
export function logout(ctx: Context, text?: string): void {
  const fields = text === undefined ? {} : { Text: text };
  if (ctx.config.manual) {
    send(ctx, 'Logout', fields);
    disconnect(ctx, 'us', text ?? 'Logged out');
    return;
  }
  if (ctx.state.phase === 'loggingOut') return;   // ours is already out, awaiting the reply
  if (ctx.state.phase !== 'active') {
    disconnect(ctx, 'us', text ?? 'Closed before logon completed');
    return;
  }
  send(ctx, 'Logout', fields);
  ctx.state = { ...ctx.state, phase: 'loggingOut', phaseSince: ctx.now };
}
