import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, type Context } from './context.ts';
import { T0, fromThem, fromThemIn, sends, testConfig } from './fixtures.ts';
import { answerResend, receive, seqNum } from './receive.ts';
import type { EngineState } from './types.ts';
import { fromMessage, inspectMessage, type DecodeProblem, type MessageObject } from '../wire/message.ts';
import { buildFrame } from '../wire/frame.ts';
import { dictionaryFor } from '../dictionary/index.ts';

const config = testConfig();
const active = (overrides: Partial<EngineState> = {}): EngineState =>
  ({ ...initialState(config, T0), phase: 'active', ...overrides });

function run(state: EngineState, msgType: string, seq: number, fields: Record<string, unknown> = {}, now = T0): Context {
  const ctx: Context = { state, config, now, actions: [] };
  const { message, problems } = fromThem(msgType, seq, fields, now);
  receive(ctx, message, problems);
  return ctx;
}

/** A MessageObject built directly, bypassing the wire layer, for values the dictionary encoder won't carry
 *  as-is (e.g. an out-of-safe-range MsgSeqNum/NewSeqNo/BeginSeqNo/EndSeqNo). */
function directMessage(msgType: string, seq: number, fields: Record<string, unknown> = {}, now = T0): MessageObject {
  return Object.freeze({
    BeginString: 'FIX.4.4',
    MsgType: msgType,
    SenderCompID: 'THEM',
    TargetCompID: 'ME',
    MsgSeqNum: seq,
    SendingTime: new Date(now),
    ...fields,
  });
}

function runRaw(state: EngineState, message: MessageObject, problems: readonly DecodeProblem[] = []): Context {
  const ctx: Context = { state, config, now: T0, actions: [] };
  receive(ctx, message, problems);
  return ctx;
}

const types = (ctx: Context) => ctx.actions.map(a => (a.type === 'send' ? `send ${a.msgType}` : a.type));
const problemCodes = (ctx: Context) => ctx.actions.flatMap(a => (a.type === 'problem' ? [a.problem.code] : []));
const order = { ClOrdID: 'o1', Side: 'Buy', OrdType: 'Market' };

test('an in-sequence message is delivered and counted', () => {
  const ctx = run(active(), 'NewOrderSingle', 1, order);
  assert.deepEqual(types(ctx), ['deliver']);
  assert.equal(ctx.state.expected, 2);
});

test('a TestRequest is answered with its TestReqID', () => {
  const ctx = run(active(), 'TestRequest', 1, { TestReqID: 'ping' });
  assert.deepEqual(types(ctx), ['deliver', 'send Heartbeat']);
  assert.equal(sends(ctx.actions)[0]?.fields['112'], 'ping');
});

test('a gap requests a resend once, and the early message waits for it', () => {
  const first = run(active(), 'NewOrderSingle', 5, order);
  assert.deepEqual(types(first), ['problem', 'send ResendRequest']);
  assert.deepEqual(problemCodes(first), ['SeqNumGap']);
  assert.deepEqual({ from: sends(first.actions)[0]?.fields.BeginSeqNo, to: sends(first.actions)[0]?.fields.EndSeqNo }, { from: 1, to: 0 });
  assert.equal(first.state.expected, 1);
  assert.equal(first.state.recovering, 5);
  assert.equal(first.state.resendRequestedAt, T0);
  assert.equal(first.state.resendAttempts, 1);
  const second = run(first.state, 'NewOrderSingle', 6, order);
  assert.deepEqual(types(second), ['problem']);
  assert.deepEqual(problemCodes(second), ['SeqNumGap']);
  assert.equal(second.state.recovering, 6);
});

test('recovery ends once the gap is filled', () => {
  let state = active({ recovering: 2 });
  state = run(state, 'NewOrderSingle', 1, order).state;
  assert.equal(state.recovering, 2);
  state = run(state, 'NewOrderSingle', 2, order).state;
  assert.equal(state.recovering, undefined);
  assert.equal(state.expected, 3);
});

test('too low without PossDupFlag: Logout and disconnect', () => {
  const ctx = run(active({ expected: 5 }), 'Heartbeat', 3);
  assert.deepEqual(types(ctx), ['problem', 'send Logout', 'disconnect']);
  assert.equal(sends(ctx.actions)[0]?.fields.Text, 'MsgSeqNum too low, expecting 5 but received 3');
  assert.equal(ctx.state.phase, 'closed');
});

test('too low with PossDupFlag: ignored, or rejected without OrigSendingTime', () => {
  const dup = run(active({ expected: 5 }), 'NewOrderSingle', 3, { ...order, PossDupFlag: true, OrigSendingTime: new Date(T0 - 1000) });
  assert.deepEqual(types(dup), ['problem']);
  assert.equal(dup.actions[0]?.type === 'problem' && dup.actions[0].problem.action, 'Ignored');
  const bare = run(active({ expected: 5 }), 'NewOrderSingle', 3, { ...order, PossDupFlag: true });
  assert.deepEqual(types(bare), ['problem', 'send Reject']);
  assert.equal(sends(bare.actions)[0]?.fields.RefTagID, 122);
});

test('SequenceReset in reset mode moves the counter forward, never back', () => {
  const forward = run(active({ expected: 3 }), 'SequenceReset', 1, { NewSeqNo: 10 });
  assert.equal(forward.state.expected, 10);
  const back = run(active({ expected: 20 }), 'SequenceReset', 1, { NewSeqNo: 10 });
  assert.deepEqual(types(back), ['problem', 'send Reject']);
  assert.equal(sends(back.actions)[0]?.fields[373], '5');
  assert.equal(back.state.expected, 20);
});

test('SequenceReset in reset mode is applied whatever its own MsgSeqNum is, even 0', () => {
  const forward = run(active({ expected: 3 }), 'SequenceReset', 0, { NewSeqNo: 25 });
  assert.deepEqual(types(forward), ['deliver']);
  assert.equal(forward.state.expected, 25);

  const back = run(active({ expected: 3 }), 'SequenceReset', 0, { GapFillFlag: false, NewSeqNo: 1 });
  assert.deepEqual(types(back), ['problem', 'send Reject']);
  const fields = sends(back.actions)[0]?.fields;
  assert.deepEqual({ reason: fields?.[373], tag: fields?.RefTagID, ref: fields?.RefSeqNum }, { reason: '5', tag: 36, ref: 0 });
  assert.equal(back.state.expected, 3);

  // A gap fill is an ordinary message: its MsgSeqNum counts.
  const gapFill = run(active({ expected: 3 }), 'SequenceReset', 0, { GapFillFlag: true, NewSeqNo: 25 });
  assert.deepEqual(problemCodes(gapFill), ['MissingMsgSeqNum']);
  assert.equal(gapFill.state.phase, 'closed');
});

test('SequenceReset in reset mode without a MsgSeqNum ends the session', () => {
  const { message, problems } = fromThem('SequenceReset', 1, { MsgSeqNum: null, NewSeqNo: 25 });
  const missing = runRaw(active({ expected: 3 }), message, problems);
  assert.deepEqual(problemCodes(missing), ['MissingMsgSeqNum']);
  assert.equal(missing.state.phase, 'closed');
  assert.equal(missing.state.expected, 3);
});

test('SequenceReset in reset mode with a negative MsgSeqNum ends the session', () => {
  const negative = runRaw(active({ expected: 3 }), directMessage('SequenceReset', -1, { NewSeqNo: 25 }));
  assert.deepEqual(problemCodes(negative), ['MissingMsgSeqNum']);
  assert.equal(negative.state.phase, 'closed');
  assert.equal(negative.state.expected, 3);
});

test('a gap fill skips to NewSeqNo; a backwards one is rejected', () => {
  const fill = run(active(), 'SequenceReset', 1, { GapFillFlag: true, NewSeqNo: 5 });
  assert.deepEqual(types(fill), ['deliver']);
  assert.equal(fill.state.expected, 5);
  const bad = run(active(), 'SequenceReset', 1, { GapFillFlag: true, NewSeqNo: 1 });
  assert.deepEqual(types(bad), ['problem', 'send Reject']);
  assert.equal(sends(bad.actions)[0]?.fields.RefTagID, 36);
});

test('a message that breaks the dictionary is rejected, not delivered, and its number is used', () => {
  const ctx = run(active(), 'NewOrderSingle', 1, { ClOrdID: 'o1', OrdType: 'Market', 54: 'Z' });   // Side sent raw, as an invalid code
  assert.deepEqual(types(ctx), ['problem', 'send Reject']);
  const fields = sends(ctx.actions)[0]?.fields;
  assert.deepEqual({ reason: fields?.[373], tag: fields?.RefTagID, msgType: fields?.[372], ref: fields?.RefSeqNum }, { reason: '5', tag: 54, msgType: 'D', ref: 1 });
  assert.equal(ctx.state.expected, 2);
});

test('user-defined tags (5000+) are never rejected; unknown standard tags are', () => {
  assert.deepEqual(types(run(active(), 'NewOrderSingle', 1, { ...order, 9702: 'x' })), ['deliver']);
  assert.deepEqual(types(run(active(), 'TestRequest', 1, { TestReqID: 'x', 150: '0' })), ['problem', 'send Reject']);
});

test('a tag the dictionary does not have is rejected as an invalid tag number', () => {
  const ctx = run(active(), 'TestRequest', 1, { TestReqID: 'x', 999: 'HI' });
  assert.deepEqual(types(ctx), ['problem', 'send Reject']);
  assert.deepEqual(problemCodes(ctx), ['InvalidTagNumber']);
  const fields = sends(ctx.actions)[0]?.fields;
  assert.deepEqual({ reason: fields?.[373], tag: fields?.RefTagID, text: fields?.Text }, { reason: '0', tag: 999, text: 'Tag 999 is not defined in FIX.4.4' });
});

test('fields out of order are rejected with the reason FIX gives each', () => {
  const reasonAndTag = (ctx: Context) => {
    const fields = sends(ctx.actions)[0]?.fields;
    return { reason: fields?.[373], tag: fields?.RefTagID };
  };
  const message = directMessage('NewOrderSingle', 1, order);
  const header = runRaw(active(), message, [{ code: 'TagSpecifiedOutOfRequiredOrder', tag: 49, text: 'out of order' }]);
  assert.deepEqual(types(header), ['problem', 'send Reject']);
  assert.deepEqual(reasonAndTag(header), { reason: '14', tag: 49 });
  const group = runRaw(active(), message, [{ code: 'RepeatingGroupFieldsOutOfOrder', tag: 447, text: 'out of order' }]);
  assert.deepEqual(reasonAndTag(group), { reason: '15', tag: 447 });
  assert.equal(group.state.expected, 2);
});

test('a user-defined tag among the header fields does not get the message rejected', () => {
  for (const version of ['FIX.4.4', 'FIX.4.2']) {
    const fields = `8=${version}|9=0|35=D|49=THEM|56=ME|5001=x|34=1|52=20260929-12:00:00.000|11=o1|21=1|55=IBM|54=1|60=20260929-12:00:00.000|40=1|10=000`
      .split('|').map(pair => ({ tag: Number(pair.slice(0, pair.indexOf('='))), value: pair.slice(pair.indexOf('=') + 1) }));
    const { message, problems } = inspectMessage(fields, dictionaryFor(version));
    const versionConfig = testConfig({ version });
    const ctx: Context = { state: { ...initialState(versionConfig, T0), phase: 'active' }, config: versionConfig, now: T0, actions: [] };
    receive(ctx, message, problems);
    assert.deepEqual(types(ctx), ['deliver'], version);
    assert.equal(ctx.state.expected, 2, version);
  }
});

test('a message with a user-defined tag in the middle of a header Hop entry is rejected for the Hop field left outside the entry, and for nothing else', () => {
  const stamp = '20260929-12:00:00.000';
  const fields = `8=FIX.4.4|9=0|35=D|49=THEM|56=ME|627=1|628=HOP|5001=x|629=${stamp}|34=1|52=${stamp}|11=o1|55=IBM|54=1|60=${stamp}|40=1|10=000`
    .split('|').map(pair => ({ tag: Number(pair.slice(0, pair.indexOf('='))), value: pair.slice(pair.indexOf('=') + 1) }));
  const { message, problems } = inspectMessage(fields, dictionaryFor('FIX.4.4'));
  assert.deepEqual(problems.map(found => `${found.code}:${found.tag}`), ['InvalidTagNumber:5001', 'TagNotDefinedForThisMessageType:629']);
  const ctx = runRaw(active(), message, problems);
  assert.deepEqual(types(ctx), ['problem', 'send Reject']);
  const reject = sends(ctx.actions)[0]?.fields;
  assert.deepEqual(
    { ref: reject?.RefSeqNum, reason: reject?.[373], tag: reject?.RefTagID, msgType: reject?.[372], text: reject?.Text },
    { ref: 1, reason: '2', tag: 629, msgType: 'D', text: 'HopSendingTime (629) is not defined for this message type' },
  );
});

test('wrong CompIDs: Reject, Logout, disconnect', () => {
  const ctx = run(active(), 'Heartbeat', 1, { SenderCompID: 'OTHER' });
  assert.deepEqual(types(ctx), ['send Reject', 'problem', 'send Logout', 'disconnect']);
  assert.equal(sends(ctx.actions)[0]?.fields[373], '9');
  assert.deepEqual(problemCodes(ctx), ['CompIDMismatch']);
});

test('the texts sent for wrong CompIDs are plain ASCII', () => {
  const ctx = run(active(), 'Heartbeat', 1, { SenderCompID: 'OTHER' });
  const texts = sends(ctx.actions).map(action => action.fields.Text);
  assert.deepEqual(texts, ['CompIDs are OTHER to ME, expected THEM to ME', 'CompIDs are OTHER to ME, expected THEM to ME']);
  for (const text of texts) assert.match(String(text), /^[\x20-\x7e]+$/);
});

test('a missing or empty CompID is rejected as the field problem it is, and the session carries on', () => {
  const missing = run(active(), 'Heartbeat', 1, { TargetCompID: null });
  assert.deepEqual(types(missing), ['problem', 'send Reject']);
  const rejected = sends(missing.actions)[0]?.fields;
  assert.deepEqual({ reason: rejected?.[373], tag: rejected?.RefTagID, text: rejected?.Text }, { reason: '1', tag: 56, text: 'TargetCompID (56) is required' });
  assert.deepEqual(problemCodes(missing), ['RequiredTagMissing']);
  assert.deepEqual({ phase: missing.state.phase, expected: missing.state.expected }, { phase: 'active', expected: 2 });

  const empty = run(active(), 'Heartbeat', 1, { SenderCompID: undefined, 49: '' });
  assert.deepEqual(types(empty), ['problem', 'send Reject']);
  const fields = sends(empty.actions)[0]?.fields;
  assert.deepEqual({ reason: fields?.[373], tag: fields?.RefTagID, text: fields?.Text }, { reason: '4', tag: 49, text: 'SenderCompID (49) has no value' });
  assert.equal(empty.state.phase, 'active');
});

test('a missing or empty CompID is rejected for that field even when the caller reports no problems', () => {
  const missing = runRaw(active(), directMessage('Heartbeat', 1, { TargetCompID: undefined }), []);
  assert.deepEqual(types(missing), ['problem', 'send Reject']);
  const rejected = sends(missing.actions)[0]?.fields;
  assert.deepEqual(
    { reason: rejected?.[373], tag: rejected?.RefTagID, seq: rejected?.RefSeqNum, text: rejected?.Text },
    { reason: '1', tag: 56, seq: 1, text: 'TargetCompID (56) is required' },
  );
  assert.deepEqual(problemCodes(missing), ['RequiredTagMissing']);
  assert.deepEqual({ phase: missing.state.phase, expected: missing.state.expected }, { phase: 'active', expected: 2 });

  const empty = runRaw(active(), directMessage('Heartbeat', 1, { SenderCompID: '' }), []);
  assert.deepEqual(types(empty), ['problem', 'send Reject']);
  const fields = sends(empty.actions)[0]?.fields;
  assert.deepEqual(
    { reason: fields?.[373], tag: fields?.RefTagID, seq: fields?.RefSeqNum, text: fields?.Text },
    { reason: '4', tag: 49, seq: 1, text: 'SenderCompID (49) has no value' },
  );
  assert.deepEqual(problemCodes(empty), ['TagSpecifiedWithoutAValue']);
  assert.deepEqual({ phase: empty.state.phase, expected: empty.state.expected }, { phase: 'active', expected: 2 });

  const both = runRaw(active(), directMessage('Heartbeat', 1, { SenderCompID: undefined, TargetCompID: undefined }), []);
  assert.deepEqual(sends(both.actions).map(action => action.fields.RefTagID), [49]);
});

test('wrong BeginString: Logout, disconnect', () => {
  const ctx = run(active(), 'Heartbeat', 1, { BeginString: 'FIX.4.2' });
  assert.deepEqual(types(ctx), ['problem', 'send Logout', 'disconnect']);
  assert.deepEqual(problemCodes(ctx), ['BeginStringMismatch']);
});

test('SendingTime too far from our clock: Reject, Logout, disconnect', () => {
  const ctx = run(active(), 'Heartbeat', 1, { SendingTime: new Date(T0 - 300_000) });
  assert.deepEqual(types(ctx), ['send Reject', 'problem', 'send Logout', 'disconnect']);
  assert.equal(sends(ctx.actions)[0]?.fields[373], '10');
});

test('their Logout is answered; the reply to ours ends the session', () => {
  const theirs = run(active(), 'Logout', 1);
  assert.deepEqual(types(theirs), ['deliver', 'send Logout', 'disconnect']);
  assert.deepEqual(theirs.actions.at(-1), { type: 'disconnect', by: 'them', text: 'Counterparty logged out' });
  const withText = run(active(), 'Logout', 1, { Text: 'end of day' });
  assert.deepEqual(withText.actions.at(-1), { type: 'disconnect', by: 'them', text: 'end of day' });
  const reply = run(active({ phase: 'loggingOut' }), 'Logout', 1);
  assert.deepEqual(types(reply), ['deliver', 'disconnect']);
  assert.deepEqual(reply.actions.at(-1), { type: 'disconnect', by: 'us', text: 'Logout confirmed' });
});

test('a ResendRequest asks for a resend of what we sent', () => {
  const all = run(active({ next: 5 }), 'ResendRequest', 1, { BeginSeqNo: 2, EndSeqNo: 0 });
  assert.deepEqual(all.actions.filter(a => a.type === 'resend'), [{ type: 'resend', from: 2, to: 4 }]);
  const some = run(active({ next: 5 }), 'ResendRequest', 1, { BeginSeqNo: 2, EndSeqNo: 3 });
  assert.deepEqual(some.actions.filter(a => a.type === 'resend'), [{ type: 'resend', from: 2, to: 3 }]);
});

test('a Logon on a logged-on session ends it', () => {
  const ctx = run(active(), 'Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30 });
  assert.deepEqual(problemCodes(ctx), ['UnexpectedLogon']);
  assert.equal(ctx.state.phase, 'closed');
});

test('recovery clears resendRequestedAt and resendAttempts once the gap is filled', () => {
  let state = active({ recovering: 2, resendRequestedAt: T0, resendAttempts: 2 });
  state = run(state, 'NewOrderSingle', 1, order).state;
  assert.equal(state.resendRequestedAt, T0);
  assert.equal(state.resendAttempts, 2);
  state = run(state, 'NewOrderSingle', 2, order).state;
  assert.equal(state.recovering, undefined);
  assert.equal(state.resendRequestedAt, undefined);
  assert.equal(state.resendAttempts, 0);
});

test('a message with no valid MsgSeqNum: MissingMsgSeqNum, Logout, disconnect', () => {
  const { message, problems } = fromThem('Heartbeat', 1, { MsgSeqNum: null });
  assert.equal(seqNum(message), undefined);
  const ctx = runRaw(active(), message, problems);
  assert.deepEqual(types(ctx), ['problem', 'send Logout', 'disconnect']);
  assert.deepEqual(problemCodes(ctx), ['MissingMsgSeqNum']);
  assert.equal(ctx.state.phase, 'closed');
});

test('a ResendRequest ahead of sequence is still answered, and also triggers our own resend request', () => {
  const ctx = run(active({ next: 5 }), 'ResendRequest', 3, { BeginSeqNo: 1, EndSeqNo: 0 });
  assert.deepEqual(ctx.actions.filter(a => a.type === 'resend'), [{ type: 'resend', from: 1, to: 4 }]);
  assert.deepEqual(types(ctx), ['resend', 'problem', 'send ResendRequest']);
  assert.equal(ctx.state.recovering, 3);
  assert.equal(ctx.state.resendRequestedAt, T0);
});

test('an in-sequence gap fill completes recovery', () => {
  const state = active({ recovering: 5, expected: 3 });
  const ctx = run(state, 'SequenceReset', 3, { GapFillFlag: true, NewSeqNo: 6 });
  assert.deepEqual(types(ctx), ['deliver']);
  assert.equal(ctx.state.expected, 6);
  assert.equal(ctx.state.recovering, undefined);
});

test('a rejected in-sequence message that fills the gap clears recovering', () => {
  const state = active({ recovering: 3, expected: 3 });
  const ctx = run(state, 'NewOrderSingle', 3, { ClOrdID: 'o1', OrdType: 'Market', 54: 'Z' });
  assert.deepEqual(types(ctx), ['problem', 'send Reject']);
  assert.equal(ctx.state.expected, 4);
  assert.equal(ctx.state.recovering, undefined);
});

test('a bad resend range is rejected, not answered', () => {
  const badBegin = run(active({ next: 5 }), 'ResendRequest', 1, { BeginSeqNo: 0, EndSeqNo: 0 });
  assert.deepEqual(badBegin.actions.filter(a => a.type === 'resend'), []);
  assert.deepEqual(types(badBegin), ['deliver', 'problem', 'send Reject']);
  assert.equal(sends(badBegin.actions)[0]?.fields.RefTagID, 7);
  assert.deepEqual(problemCodes(badBegin), ['ValueIsIncorrect']);

  const badEnd = run(active({ next: 5 }), 'ResendRequest', 1, { BeginSeqNo: 3, EndSeqNo: 2 });
  assert.deepEqual(badEnd.actions.filter(a => a.type === 'resend'), []);
  assert.deepEqual(types(badEnd), ['deliver', 'problem', 'send Reject']);
  assert.equal(sends(badEnd.actions)[0]?.fields.RefTagID, 16);
});

test('answerResend records a problem without a Reject when MsgSeqNum is invalid', () => {
  const message = directMessage('ResendRequest', 1, { BeginSeqNo: 0, EndSeqNo: 0, MsgSeqNum: null });
  const ctx: Context = { state: active({ next: 5 }), config, now: T0, actions: [] };
  answerResend(ctx, message);
  assert.deepEqual(types(ctx), ['problem']);
  assert.deepEqual(problemCodes(ctx), ['ValueIsIncorrect']);
});

test('PossDupFlag in sequence without OrigSendingTime is rejected, not delivered', () => {
  const ctx = run(active(), 'NewOrderSingle', 1, { ...order, PossDupFlag: true });
  assert.deepEqual(types(ctx), ['problem', 'send Reject']);
  assert.equal(sends(ctx.actions)[0]?.fields.RefTagID, 122);
  assert.deepEqual(problemCodes(ctx), ['RequiredTagMissing']);
  assert.equal(ctx.state.expected, 2);
});

test('PossDupFlag with OrigSendingTime later than SendingTime is rejected, in sequence or too low', () => {
  const late = new Date(T0 + 1000);
  const inSeq = run(active(), 'NewOrderSingle', 1, { ...order, PossDupFlag: true, OrigSendingTime: late });
  assert.deepEqual(types(inSeq), ['problem', 'send Reject']);
  assert.equal(sends(inSeq.actions)[0]?.fields.RefTagID, 122);
  assert.deepEqual(problemCodes(inSeq), ['SendingTimeAccuracy']);
  assert.equal(inSeq.state.expected, 2);

  const tooLow = run(active({ expected: 5 }), 'NewOrderSingle', 3, { ...order, PossDupFlag: true, OrigSendingTime: late });
  assert.deepEqual(types(tooLow), ['problem', 'send Reject']);
  assert.equal(sends(tooLow.actions)[0]?.fields.RefTagID, 122);
  assert.deepEqual(problemCodes(tooLow), ['SendingTimeAccuracy']);
  assert.equal(tooLow.state.expected, 5);
  assert.notEqual(tooLow.state.phase, 'closed');
});

test('an in-sequence message without a string MsgType is rejected, not delivered', () => {
  const { message, problems } = fromThem('Heartbeat', 1, { 35: null });
  assert.equal(typeof message.MsgType, 'undefined');
  const ctx = runRaw(active(), message, problems);
  assert.deepEqual(types(ctx), ['problem', 'send Reject']);
  assert.equal(sends(ctx.actions)[0]?.fields.RefTagID, 35);
  assert.deepEqual(problemCodes(ctx), ['RequiredTagMissing']);
  assert.equal(ctx.state.expected, 2);
});

test('seqNum rejects unsafe integers', () => {
  assert.equal(seqNum(Object.freeze({ MsgSeqNum: Number.MAX_SAFE_INTEGER + 2 })), undefined);
  assert.equal(seqNum(Object.freeze({ MsgSeqNum: 5 })), 5);
});

test('SequenceReset NewSeqNo must be a safe integer, in reset mode or gap-fill', () => {
  const reset = runRaw(active({ expected: 3 }), directMessage('SequenceReset', 1, { NewSeqNo: Number.MAX_SAFE_INTEGER + 2 }));
  assert.deepEqual(types(reset), ['problem', 'send Reject']);
  assert.equal(sends(reset.actions)[0]?.fields.RefTagID, 36);

  const gapFill = runRaw(active(), directMessage('SequenceReset', 1, { GapFillFlag: true, NewSeqNo: Number.MAX_SAFE_INTEGER + 2 }));
  assert.deepEqual(types(gapFill), ['problem', 'send Reject']);
  assert.equal(sends(gapFill.actions)[0]?.fields.RefTagID, 36);
});

test('ResendRequest with an unsafe BeginSeqNo or EndSeqNo is rejected, not answered', () => {
  const badBegin = runRaw(active({ next: 5 }), directMessage('ResendRequest', 1, { BeginSeqNo: Number.MAX_SAFE_INTEGER + 2, EndSeqNo: 0 }));
  assert.deepEqual(badBegin.actions.filter(a => a.type === 'resend'), []);
  assert.deepEqual(types(badBegin), ['deliver', 'problem', 'send Reject']);
  assert.equal(sends(badBegin.actions)[0]?.fields.RefTagID, 7);

  const badEnd = runRaw(active({ next: 5 }), directMessage('ResendRequest', 1, { BeginSeqNo: 1, EndSeqNo: Number.MAX_SAFE_INTEGER + 2 }));
  assert.deepEqual(badEnd.actions.filter(a => a.type === 'resend'), []);
  assert.deepEqual(types(badEnd), ['deliver', 'problem', 'send Reject']);
  assert.equal(sends(badEnd.actions)[0]?.fields.RefTagID, 16);
});

test('a SequenceReset with a malformed GapFillFlag is rejected, not applied as a reset', () => {
  const ctx = run(active({ expected: 2 }), 'SequenceReset', 2, { 123: 'X', NewSeqNo: 50 });
  assert.deepEqual(types(ctx), ['problem', 'send Reject']);
  const fields = sends(ctx.actions)[0]?.fields;
  assert.deepEqual({ reason: fields?.[373], tag: fields?.RefTagID, ref: fields?.RefSeqNum }, { reason: '6', tag: 123, ref: 2 });
  assert.equal(ctx.actions[0]?.type === 'problem' && ctx.actions[0].problem.code, 'IncorrectDataFormatForValue');
  assert.equal(ctx.actions[0]?.type === 'problem' && ctx.actions[0].problem.action, 'Rejected');
  // Not reset mode, so it is an in-sequence message: its own number is used up, but NewSeqNo 50 is not applied.
  assert.equal(ctx.state.expected, 3);
});

test('a reset-mode SequenceReset with an unknown standard tag is rejected, not applied', () => {
  const ctx = run(active({ expected: 3 }), 'SequenceReset', 1, { NewSeqNo: 10, 150: '0' });
  assert.deepEqual(types(ctx), ['problem', 'send Reject']);
  const fields = sends(ctx.actions)[0]?.fields;
  assert.deepEqual({ tag: fields?.RefTagID, ref: fields?.RefSeqNum }, { tag: 150, ref: 1 });
  assert.equal(ctx.state.expected, 3);
});

test('a SequenceReset-Reset during recovery ends it, even short of the recovery target', () => {
  const ctx = run(active({ expected: 3, recovering: 10, resendRequestedAt: T0, resendAttempts: 2 }), 'SequenceReset', 1, { NewSeqNo: 5 });
  assert.deepEqual(types(ctx), ['deliver']);
  assert.equal(ctx.state.expected, 5);
  assert.deepEqual(
    { recovering: ctx.state.recovering, at: ctx.state.resendRequestedAt, attempts: ctx.state.resendAttempts },
    { recovering: undefined, at: undefined, attempts: 0 },
  );
});

test('a TestRequest is answered with its TestReqID byte for byte', () => {
  const ctx = run(active(), 'TestRequest', 1, { 112: 'caf\xe9' });   // not valid UTF-8
  assert.deepEqual(types(ctx), ['deliver', 'send Heartbeat']);
  const heartbeat = sends(ctx.actions)[0]!;
  assert.equal(heartbeat.fields['112'], 'caf\xe9');
  const dict = dictionaryFor('FIX.4.4');
  const { fields, framing } = fromMessage('Heartbeat', heartbeat.fields, dict, { version: 'FIX.4.4', now: () => new Date(T0) });
  const wire = Buffer.from(buildFrame(fields, framing)).toString('latin1');
  assert.ok(wire.includes('\x01112=caf\xe9\x01'), wire);
});

test('a TestRequest without TestReqID is answered with a Heartbeat without one', () => {
  // Built directly: through the wire layer a missing TestReqID is a RequiredTagMissing Reject instead.
  const ctx = runRaw(active(), directMessage('TestRequest', 1));
  assert.deepEqual(types(ctx), ['deliver', 'send Heartbeat']);
  const heartbeat = sends(ctx.actions).find(a => a.msgType === 'Heartbeat');
  assert.ok(heartbeat);
  assert.equal('112' in heartbeat.fields || 'TestReqID' in heartbeat.fields, false);
});

test('a FIX 4.2 message rejected for a reason FIX 4.2 does not have gets a Reject without SessionRejectReason; the same message in FIX 4.4 gets one with it', () => {
  // NoAllocs (78) says two entries, and one follows: SessionRejectReason 16, which FIX 4.2 lacks.
  const order = { ClOrdID: 'A1', Symbol: 'IBM', Side: 'Buy', OrdType: 'Market', 78: '2', 79: 'ACCOUNT-1' };
  const rejectFor = (version: string, fields: Record<string, unknown>) => {
    const versioned = testConfig({ version });
    const ctx: Context = { state: { ...initialState(versioned, T0), phase: 'active' }, config: versioned, now: T0, actions: [] };
    const { message, problems } = fromThemIn(version)('NewOrderSingle', 1, fields);
    assert.equal(message.BeginString, version);
    receive(ctx, message, problems);
    assert.deepEqual(ctx.actions.map(action => action.type), ['problem', 'send']);
    const [sent] = sends(ctx.actions);
    return { msgType: sent?.msgType, begin: sent?.fields.BeginString, reason: sent?.fields[373], tag: sent?.fields.RefTagID, text: sent?.fields.Text };
  };
  const text = 'NoAllocs (78) says 2 but 1 PreAllocGrp entries follow';
  assert.deepEqual(rejectFor('FIX.4.2', { ...order, HandlInst: 'AutomatedExecutionNoIntervention' }),
    { msgType: 'Reject', begin: 'FIX.4.2', reason: undefined, tag: 78, text });
  assert.deepEqual(rejectFor('FIX.4.4', order), { msgType: 'Reject', begin: 'FIX.4.4', reason: '16', tag: 78, text });
});


test('under FIXT.1.1 an application message naming an application version fix.js does not read is rejected with SessionRejectReason 18, and the session carries on; a session message is not held to it', () => {
  const fixt = testConfig({ version: 'FIXT.1.1' });
  const fromThemFixt = fromThemIn('FIXT.1.1');
  const order = { ClOrdID: 'A1', Symbol: 'IBM', Side: 'Buy', OrdType: 'Market' };
  const take = (msgType: string, fields: Record<string, unknown>): Context => {
    const ctx: Context = { state: { ...initialState(fixt, T0), phase: 'active', expected: 5 }, config: fixt, now: T0, actions: [] };
    const { message, problems } = fromThemFixt(msgType, 5, fields);
    receive(ctx, message, problems);
    return ctx;
  };
  const kinds = (ctx: Context) => ctx.actions.map(action => action.type);

  const refused = take('NewOrderSingle', { ...order, ApplVerID: 'FIX44' });
  const text = 'ApplVerID FIX44 is not supported; use FIX50, FIX50SP1, FIX50SP2 or FIXLatest';
  assert.deepEqual(refused.actions[0], { type: 'problem', problem: { code: 'InvalidUnsupportedAppVersion', text, action: 'Rejected', refSeqNum: 5 } });
  const [reject] = sends(refused.actions);
  assert.deepEqual({ msgType: reject?.msgType, ref: reject?.fields.RefSeqNum, reason: reject?.fields[373], tag: reject?.fields.RefTagID, refMsgType: reject?.fields[372], text: reject?.fields.Text },
    { msgType: 'Reject', ref: 5, reason: '18', tag: 1128, refMsgType: 'D', text });
  assert.deepEqual(kinds(refused), ['problem', 'send']);
  assert.deepEqual({ phase: refused.state.phase, expected: refused.state.expected }, { phase: 'active', expected: 6 });
  // A value FIX does not have at all is refused the same way.
  const odd = take('NewOrderSingle', { ...order, 1128: '33' });
  assert.deepEqual({ reason: sends(odd.actions)[0]?.fields[373], text: sends(odd.actions)[0]?.fields.Text }, { reason: '18', text: 'ApplVerID 33 is not supported; use FIX50, FIX50SP1, FIX50SP2 or FIXLatest' });

  // A long value is quoted by its first 32 characters only.
  const long = take('NewOrderSingle', { ...order, 1128: 'x'.repeat(30_000) });
  assert.equal(sends(long.actions)[0]?.fields.Text, `ApplVerID ${'x'.repeat(32)}... is not supported; use FIX50, FIX50SP1, FIX50SP2 or FIXLatest`);
  // Control characters and bytes that are not ASCII are not echoed.
  const control = take('NewOrderSingle', { ...order, 1128: 'a\x1b[2J\r\nb\xffc' });
  assert.equal(sends(control.actions)[0]?.fields.Text, 'ApplVerID a?[2J??b?c is not supported; use FIX50, FIX50SP1, FIX50SP2 or FIXLatest');
  const exact = take('NewOrderSingle', { ...order, 1128: 'y'.repeat(32) });
  assert.equal(sends(exact.actions)[0]?.fields.Text, `ApplVerID ${'y'.repeat(32)} is not supported; use FIX50, FIX50SP1, FIX50SP2 or FIXLatest`);

  // One of the four, or none (the session's default applies), is delivered.
  for (const fields of [order, { ...order, ApplVerID: 'FIX50' }, { ...order, ApplVerID: 'FIXLatest' }]) assert.deepEqual(kinds(take('NewOrderSingle', fields)), ['deliver']);
  // A session message is read by the session layer, whatever application version it names.
  assert.deepEqual(kinds(take('Heartbeat', { ApplVerID: 'FIX44' })), ['deliver']);
  assert.deepEqual(kinds(take('TestRequest', { TestReqID: 'T', ApplVerID: 'FIX44' })), ['deliver', 'send']);
  const sessionMessages: [string, Record<string, unknown>][] = [
    ['ResendRequest', { BeginSeqNo: 1, EndSeqNo: 0 }],
    ['Reject', { RefSeqNum: 2 }],
    ['SequenceReset', { GapFillFlag: true, NewSeqNo: 8 }],
    ['SequenceReset', { NewSeqNo: 8 }],
    ['Logout', {}],
  ];
  for (const [msgType, fields] of sessionMessages) {
    const ctx = take(msgType, { ...fields, ApplVerID: 'FIX44' });
    assert.ok(!ctx.actions.some(action => action.type === 'problem' && action.problem.code === 'InvalidUnsupportedAppVersion'), msgType);
    assert.ok(!sends(ctx.actions).some(sent => sent.fields[373] === '18'), msgType);
  }

  // An empty ApplVerID is an empty field like any other, reported as the decoder words it; reason 18 is for a value that is there.
  const empty = take('NewOrderSingle', { ...order, 1128: '' });
  assert.equal(empty.actions[0]?.type === 'problem' ? empty.actions[0].problem.code : undefined, 'TagSpecifiedWithoutAValue');
  assert.deepEqual({ reason: sends(empty.actions)[0]?.fields[373], tag: sends(empty.actions)[0]?.fields.RefTagID }, { reason: '4', tag: 1128 });
  assert.ok(!String(sends(empty.actions)[0]?.fields.Text).includes('is not supported'));

  // Under FIX 4.4 a field of a custom dictionary that is named ApplVerID is only a field.
  const custom = directMessage('NewOrderSingle', 5, { ...order, ApplVerID: 'desk-7' });
  assert.deepEqual(runRaw(active({ expected: 5 }), custom).actions.map(action => action.type), ['deliver']);
});
