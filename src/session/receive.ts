import { APPL_VER_IDS, excerpt, FIXT11, isApplVerID, oneOf } from '../version.ts';
import { FIRST_USER_DEFINED_TAG, rawValue, type DecodeProblem, type MessageObject } from '../wire/message.ts';
import { disconnect, logoutAndDisconnect, problem, reject, restarted, send, type Context, type RejectReason } from './context.ts';
import { answerLogon, checkLogon } from './handshake.ts';
import type { ProblemCode } from './types.ts';

/** A message on a logged-on session: validate it, keep the sequence, answer it, deliver it. */
export function receive(ctx: Context, message: MessageObject, problems: readonly DecodeProblem[]): void {
  const msgType = message.MsgType;
  const seq = seqNum(message);
  if (msgType === 'Logon') {
    if (message.ResetSeqNumFlag === true && seq === 1) resetReceived(ctx, message, problems);
    else logoutAndDisconnect(ctx, 'UnexpectedLogon', 'Logon received on a session that is already logged on', seq);
    return;
  }
  if (!checkHeader(ctx, message)) return;
  if (msgType === 'SequenceReset' && (message.GapFillFlag === undefined || message.GapFillFlag === false)) {
    // In reset mode its own MsgSeqNum is not checked, so 0 will do; it must still be there, as a whole number.
    const own = message.MsgSeqNum;
    if (typeof own === 'number' && Number.isSafeInteger(own) && own >= 0) {
      sequenceReset(ctx, message, own, problems);
      return;
    }
  }
  if (seq === undefined) {
    logoutAndDisconnect(ctx, 'MissingMsgSeqNum', 'MsgSeqNum is missing or not a whole number');
    return;
  }

  const expected = ctx.state.expected;
  if (seq < expected) {
    tooLow(ctx, message, seq, expected);
    return;
  }
  if (seq > expected) {
    if (msgType === 'ResendRequest') answerResend(ctx, message);
    requestResend(ctx, seq);
    if (msgType === 'Logout') logoutReceived(ctx, message);
    return;
  }

  advanceTo(ctx, seq + 1);
  if (ctx.state.resetSent && seq === 1 && (message.PossDupFlag === undefined || message.PossDupFlag === false)) {
    // Their MsgSeqNum 1, sent new: the counterparty's new sequence has begun, so a reset of ours no longer
    // awaits a reply (not every engine sends one), and another may be sent. Nothing else says so: a resent
    // message, and a message that is in sequence only because a resend or SequenceReset of the old
    // sequence moved what we expect, may have been sent before the reset reached them. Even this message
    // may have been (a resend that is not marked as one), so their reply may still come: it is taken as the
    // reply whenever it does (see resetReceived). Whatever came ahead of this message was sent in the old
    // sequence, so the resend asked for then has nothing to wait for.
    ctx.state = { ...ctx.state, resetSent: false };
    endRecovery(ctx);
  }

  if (typeof msgType !== 'string') {
    const text = 'MsgType is missing or not a string';
    problem(ctx, 'RequiredTagMissing', text, 'Rejected', seq);
    reject(ctx, message, seq, 'RequiredTagMissing', text, 35);
    return;
  }

  const dup = possDupProblem(message);
  if (dup) {
    problem(ctx, dup.code, dup.text, 'Rejected', seq);
    reject(ctx, message, seq, dup.reason, dup.text, 122);
    return;
  }

  const version = applVerIDText(ctx, message);
  if (version !== undefined) {
    problem(ctx, 'InvalidUnsupportedAppVersion', version, 'Rejected', seq);
    reject(ctx, message, seq, 'InvalidUnsupportedAppVersion', version, 1128);
    return;
  }

  if (rejectDecodeProblem(ctx, message, seq, problems)) return;
  if (msgType === 'SequenceReset') {
    gapFill(ctx, message, seq);
    return;
  }
  ctx.actions.push({ type: 'deliver', message });
  switch (msgType) {
    case 'TestRequest':
      answerTestRequest(ctx, message);
      break;
    case 'ResendRequest':
      answerResend(ctx, message);
      break;
    case 'Logout':
      logoutReceived(ctx, message);
      break;
  }
}

/**
 * A Logon with ResetSeqNumFlag=Y and MsgSeqNum 1 on a logged-on session. Theirs
 * starts both sequences again at 1 and is answered with the same. Every reset
 * we start (see startReset) is owed one such Logon in reply: one that arrives
 * while a reply is owed is that reply, however late it comes and whatever ended
 * the wait for it, and is taken without an answer, so that a reply is never
 * answered as a request. Any other is a request, and is answered.
 */
function resetReceived(ctx: Context, message: MessageObject, problems: readonly DecodeProblem[]): void {
  const logon = checkLogon(ctx, message, problems);
  if (!logon) return;
  // A reset starts the sequence numbers again and nothing else: the heartbeat interval agreed at logon stays.
  if (logon.heartbeat !== ctx.state.heartbeat) {
    problem(ctx, 'ValueIsIncorrect', `A Logon that resets the sequence numbers has HeartBtInt ${logon.heartbeat}; keeping ${ctx.state.heartbeat}`, 'Ignored', logon.seq);
  }
  const owed = ctx.state.resetRepliesOwed;
  if (owed > 0) {
    // The reply to a reset of ours: our own sequence started again when we asked, and stays as it is.
    ctx.state = { ...restarted(ctx.state), next: ctx.state.next, resetSent: false, resetRepliesOwed: owed - 1 };
  } else {
    ctx.state = restarted(ctx.state);
    ctx.actions.push({ type: 'reset' });
    answerLogon(ctx, logon);
  }
  ctx.state = { ...ctx.state, expected: 2 };
  ctx.actions.push({ type: 'deliver', message });
}

/** A Heartbeat echoing the TestReqID exactly as it arrived on the wire (numeric key = raw text). */
function answerTestRequest(ctx: Context, message: MessageObject): void {
  const id = rawValue(message, 112) ?? message.TestReqID;
  send(ctx, 'Heartbeat', id === undefined ? {} : { 112: id });
}

/** A positive whole MsgSeqNum, or undefined. */
export function seqNum(message: MessageObject): number | undefined {
  const seq = message.MsgSeqNum;
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0 ? seq : undefined;
}

/**
 * BeginString, CompIDs and SendingTime, the last against the time the message arrived: how long it
 * then waited to be processed is not the counterparty's clock. On failure the session is logged out; returns false.
 * A Reject goes first only once logged on: a Logon that fails is answered with the Logout alone.
 * A CompID that is missing or empty passes here: it is rejected as a field problem instead.
 */
export function checkHeader(ctx: Context, message: MessageObject): boolean {
  const { config } = ctx;
  const arrived = ctx.arrived ?? ctx.now;
  const seq = seqNum(message);
  const rejectable = seq !== undefined && (ctx.state.phase === 'active' || ctx.state.phase === 'loggingOut');
  if (message.BeginString !== config.version) {
    logoutAndDisconnect(ctx, 'BeginStringMismatch', `BeginString is ${String(message.BeginString)}, expected ${config.version}`, seq);
    return false;
  }
  if (differs(message.SenderCompID, config.target) || differs(message.TargetCompID, config.sender)) {
    const text = `CompIDs are ${String(message.SenderCompID)} to ${String(message.TargetCompID)}, expected ${config.target} to ${config.sender}`;
    if (rejectable) reject(ctx, message, seq, 'CompIDProblem', text);
    logoutAndDisconnect(ctx, 'CompIDMismatch', text, seq);
    return false;
  }
  const sendingTime = message.SendingTime;
  if (!(sendingTime instanceof Date) || Math.abs(arrived - sendingTime.getTime()) > config.maxClockSkew * 1000) {
    const text = sendingTime instanceof Date
      ? `SendingTime is ${Math.round((arrived - sendingTime.getTime()) / 1000)} s from our clock`
      : 'SendingTime is missing or malformed';
    if (rejectable) reject(ctx, message, seq, 'SendingTimeAccuracyProblem', text, 52);
    logoutAndDisconnect(ctx, 'SendingTimeAccuracy', text, seq);
    return false;
  }
  return true;
}

/** A CompID that is there and isn't the one expected. */
function differs(compID: unknown, expected: string): boolean {
  return compID !== undefined && compID !== '' && compID !== expected;
}

/** Expect `expected` next; a resend is complete once we're past what it covers. */
export function advanceTo(ctx: Context, expected: number): void {
  const recovering = ctx.state.recovering;
  const cleared = recovering !== undefined && expected > recovering;
  ctx.state = {
    ...ctx.state,
    expected,
    recovering: cleared ? undefined : recovering,
    resendRequestedAt: cleared ? undefined : ctx.state.resendRequestedAt,
    resendAttempts: cleared ? 0 : ctx.state.resendAttempts,
  };
}

/** The counterparty declared the gap closed: nothing more to wait for. */
function endRecovery(ctx: Context): void {
  ctx.state = { ...ctx.state, recovering: undefined, resendRequestedAt: undefined, resendAttempts: 0 };
}

/** A message arrived ahead of sequence: ask for everything from what we expect, once per gap. */
export function requestResend(ctx: Context, seq: number): void {
  const { expected, recovering } = ctx.state;
  if (recovering !== undefined) {
    problem(ctx, 'SeqNumGap', `Dropped MsgSeqNum ${seq} while waiting for a resend from ${expected}`, 'Ignored', seq);
    if (seq > recovering) ctx.state = { ...ctx.state, recovering: seq };
    return;
  }
  problem(ctx, 'SeqNumGap', `Received MsgSeqNum ${seq} while expecting ${expected}; requested a resend`, 'ResendRequested', seq);
  send(ctx, 'ResendRequest', { BeginSeqNo: expected, EndSeqNo: 0 });
  ctx.state = { ...ctx.state, recovering: seq, resendRequestedAt: ctx.now, resendAttempts: 1 };
}

/** Their ResendRequest: replay what we sent in the range (EndSeqNo 0 = everything). */
export function answerResend(ctx: Context, message: MessageObject): void {
  const from = message.BeginSeqNo;
  const end = message.EndSeqNo;
  const seq = seqNum(message);

  if (typeof from !== 'number' || !Number.isSafeInteger(from) || from < 1) {
    rejectBadRange(ctx, message, seq, 'BeginSeqNo', from, 7);
    return;
  }
  if (typeof end !== 'number' || !Number.isSafeInteger(end) || (end !== 0 && end < from)) {
    rejectBadRange(ctx, message, seq, 'EndSeqNo', end, 16);
    return;
  }
  const last = ctx.state.next - 1;
  const to = end === 0 ? last : Math.min(end, last);
  if (from <= to) ctx.actions.push({ type: 'resend', from, to });
}

/** A bad ResendRequest range: record the problem, and Reject it too when we know its MsgSeqNum. */
function rejectBadRange(ctx: Context, message: MessageObject, seq: number | undefined, field: string, value: unknown, tag: number): void {
  const text = `ResendRequest ${field} ${String(value)} is invalid`;
  problem(ctx, 'ValueIsIncorrect', text, 'Rejected', seq);
  if (seq !== undefined) reject(ctx, message, seq, 'ValueIsIncorrect', text, tag);
}

/** A Logout: the reply to ours ends the session; theirs is answered first, and its Text (when it has one) is the reason. */
export function logoutReceived(ctx: Context, message: MessageObject): void {
  if (ctx.state.phase === 'loggingOut') {
    disconnect(ctx, 'us', 'Logout confirmed');
    return;
  }
  send(ctx, 'Logout');
  const text = typeof message.Text === 'string' && message.Text !== '' ? message.Text : 'Counterparty logged out';
  disconnect(ctx, 'them', text);
}

function tooLow(ctx: Context, message: MessageObject, seq: number, expected: number): void {
  if (message.PossDupFlag !== true) {
    logoutAndDisconnect(ctx, 'SeqNumTooLow', `MsgSeqNum too low, expecting ${expected} but received ${seq}`, seq);
    return;
  }
  const dup = possDupProblem(message);
  if (dup) {
    problem(ctx, dup.code, dup.text, 'Rejected', seq);
    reject(ctx, message, seq, dup.reason, dup.text, 122);
    return;
  }
  problem(ctx, 'SeqNumTooLow', `Ignored possible duplicate ${seq}; expecting ${expected}`, 'Ignored', seq);
}

/** The session messages: every other message is an application message, read as the application version it names. */
const SESSION_MESSAGES: ReadonlySet<unknown> = new Set(['Heartbeat', 'TestRequest', 'ResendRequest', 'Reject', 'SequenceReset', 'Logout', 'Logon']);

/**
 * Under FIXT.1.1, why an application message's ApplVerID (1128) cannot be taken: it names an
 * application version fix.js does not read. Undefined when it can be, or the message has none
 * (the session's default applies). On a session message ApplVerID is not looked at.
 */
function applVerIDText(ctx: Context, message: MessageObject): string | undefined {
  if (ctx.config.version !== FIXT11 || SESSION_MESSAGES.has(message.MsgType)) return undefined;
  const applVerID = message.ApplVerID;
  // An empty one is an empty field, which the decoder reports; this is for a value that is there.
  if (applVerID === undefined || applVerID === '' || isApplVerID(applVerID)) return undefined;
  return `ApplVerID ${excerpt(applVerID)} is not supported; use ${oneOf(APPL_VER_IDS)}`;
}

/** PossDupFlag=Y requires a sane OrigSendingTime; checked wherever a duplicate can arrive, a Logon included. */
export function possDupProblem(message: MessageObject): { reason: RejectReason; code: ProblemCode; text: string } | undefined {
  if (message.PossDupFlag !== true) return undefined;
  const orig = message.OrigSendingTime;
  if (!(orig instanceof Date)) {
    return { reason: 'RequiredTagMissing', code: 'RequiredTagMissing', text: 'PossDupFlag=Y without OrigSendingTime' };
  }
  const sendingTime = message.SendingTime;
  if (sendingTime instanceof Date && orig.getTime() > sendingTime.getTime()) {
    return { reason: 'SendingTimeAccuracyProblem', code: 'SendingTimeAccuracy', text: 'OrigSendingTime is later than SendingTime' };
  }
  return undefined;
}

/**
 * The first problem that fails a message: the first rejectable one reported for it, or else
 * the one a missing or empty SenderCompID or TargetCompID amounts to, whether or not the
 * caller's list says so.
 */
export function firstRejectable(message: MessageObject, problems: readonly DecodeProblem[]): DecodeProblem | undefined {
  return problems.find(isRejectable) ?? compIDProblem(message);
}

/** A missing or empty SenderCompID (49) or TargetCompID (56), worded as the decoder words it; SenderCompID first. */
function compIDProblem(message: MessageObject): DecodeProblem | undefined {
  for (const [name, tag] of [['SenderCompID', 49], ['TargetCompID', 56]] as const) {
    const value = message[name];
    if (value === undefined) return { code: 'RequiredTagMissing', tag, text: `${name} (${tag}) is required` };
    if (value === '') return { code: 'TagSpecifiedWithoutAValue', tag, text: `${name} (${tag}) has no value` };
  }
  return undefined;
}

/** Reject the message for its first rejectable decode problem, if it has one; returns whether it did. */
function rejectDecodeProblem(ctx: Context, message: MessageObject, seq: number, problems: readonly DecodeProblem[]): boolean {
  const rejection = firstRejectable(message, problems);
  if (!rejection) return false;
  problem(ctx, rejection.code, rejection.text, 'Rejected', seq);
  reject(ctx, message, seq, rejection.code, rejection.text, rejection.tag);
  return true;
}

/** SequenceReset in reset mode: applies whatever its MsgSeqNum, but may not go backwards; a malformed one is rejected. */
function sequenceReset(ctx: Context, message: MessageObject, seq: number, problems: readonly DecodeProblem[]): void {
  if (rejectDecodeProblem(ctx, message, seq, problems)) return;
  const newSeqNo = message.NewSeqNo;
  const expected = ctx.state.expected;
  if (typeof newSeqNo !== 'number' || !Number.isSafeInteger(newSeqNo)) {
    problem(ctx, 'RequiredTagMissing', 'SequenceReset without NewSeqNo', 'Rejected', seq);
    reject(ctx, message, seq, 'RequiredTagMissing', 'SequenceReset without NewSeqNo', 36);
    return;
  }
  if (newSeqNo < expected) {
    const text = `SequenceReset may not lower the expected MsgSeqNum from ${expected} to ${newSeqNo}`;
    problem(ctx, 'ValueIsIncorrect', text, 'Rejected', seq);
    reject(ctx, message, seq, 'ValueIsIncorrect', text, 36);
    return;
  }
  advanceTo(ctx, newSeqNo);
  endRecovery(ctx);
  ctx.actions.push({ type: 'deliver', message });
}

/** SequenceReset-GapFill in sequence: skip to NewSeqNo, which must be ahead of it. */
function gapFill(ctx: Context, message: MessageObject, seq: number): void {
  const newSeqNo = message.NewSeqNo;
  if (typeof newSeqNo !== 'number' || !Number.isSafeInteger(newSeqNo) || newSeqNo <= seq) {
    const text = `Gap fill NewSeqNo ${String(newSeqNo)} must be greater than its MsgSeqNum ${seq}`;
    problem(ctx, 'ValueIsIncorrect', text, 'Rejected', seq);
    reject(ctx, message, seq, 'ValueIsIncorrect', text, 36);
    return;
  }
  advanceTo(ctx, newSeqNo);
  ctx.actions.push({ type: 'deliver', message });
}

/** An unknown user-defined tag is never rejected. */
function isRejectable(problem: DecodeProblem): boolean {
  const unknownTag = problem.code === 'InvalidTagNumber' || problem.code === 'TagNotDefinedForThisMessageType';
  return !(unknownTag && problem.tag !== undefined && problem.tag >= FIRST_USER_DEFINED_TAG);
}
