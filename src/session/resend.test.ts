import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MessageObject } from '../wire/message.ts';
import { initialState } from './context.ts';
import { T0, fromThem, resendAll, sends, testConfig } from './fixtures.ts';
import { resendPlan, type PlannedSend } from './resend.ts';

const config = testConfig();
// What "we" sent, reusing fromThem to build real decoded messages.
const history = new Map([
  [1, fromThem('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30 }).message],
  [2, fromThem('NewOrderSingle', 2, { ClOrdID: 'o2', Side: 'Buy', OrdType: 'Market' }, T0 - 5000).message],
  [3, fromThem('Heartbeat', 3).message],
  [4, fromThem('Heartbeat', 4).message],
  [6, fromThem('NewOrderSingle', 6, { ClOrdID: 'o6', Side: 'Sell', OrdType: 'Market' }).message],
]);

test('the whole answer, each header filled: application messages are resent as possible duplicates, the rest become gap fills, and no sequence number is used', () => {
  const state = { ...initialState(config, T0), phase: 'active' as const, next: 7 };
  const result = resendAll(state, config, seq => history.get(seq), 1, 6, T0 + 1000);
  const summary = sends(result.actions).map(({ msgType, fields }) =>
    msgType === 'SequenceReset' ? `gap ${String(fields.MsgSeqNum)}→${String(fields.NewSeqNo)}` : `${msgType} ${String(fields.MsgSeqNum)}`);
  assert.deepEqual(summary, ['gap 1→2', 'NewOrderSingle 2', 'gap 3→6', 'NewOrderSingle 6']);
  const resent = sends(result.actions)[1]?.fields;
  assert.equal(resent?.PossDupFlag, true);
  assert.deepEqual(resent?.OrigSendingTime, new Date(T0 - 5000));
  assert.deepEqual(resent?.SendingTime, new Date(T0 + 1000));
  assert.equal(resent?.ClOrdID, 'o2');
  assert.equal(sends(result.actions)[0]?.fields.GapFillFlag, true);
  assert.equal(result.state.next, 7);        // resending uses no new sequence numbers
});

test('a range ending in session messages ends with a gap fill to the next number', () => {
  const state = { ...initialState(config, T0), phase: 'active' as const, next: 5 };
  const result = resendAll(state, config, seq => history.get(seq), 3, 4, T0);
  assert.deepEqual(sends(result.actions).map(s => [s.fields.MsgSeqNum, s.fields.NewSeqNo]), [[3, 5]]);
});

/** The answer to a ResendRequest for from..to, planned from `history` an original at a time, as a session reads them from its store. */
function planned(from: number, to: number, now: number, kept: ReadonlyMap<number, MessageObject> = history): PlannedSend[] {
  const plan = resendPlan(from, to);
  const out: PlannedSend[] = [];
  for (const seq of [...kept.keys()].filter(each => each >= from && each <= to).sort((a, b) => a - b)) out.push(...plan.next(seq, kept.get(seq)!, now));
  out.push(...plan.end(now));
  return out;
}

const brief = ({ msgType, fields }: PlannedSend) =>
  (msgType === 'SequenceReset' ? `gap ${String(fields.MsgSeqNum)}-${String(fields.NewSeqNo)}` : `${msgType} ${String(fields.MsgSeqNum)}`);

test('a plan fed one original at a time: application messages go again as possible duplicates, the rest become gap fills', () => {
  const sent = planned(1, 6, T0 + 1000);
  assert.deepEqual(sent.map(brief), ['gap 1-2', 'NewOrderSingle 2', 'gap 3-6', 'NewOrderSingle 6']);
  const resent = sent[1]!.fields;
  assert.equal(resent.PossDupFlag, true);
  assert.deepEqual(resent.OrigSendingTime, new Date(T0 - 5000));
  assert.equal(resent.SendingTime, undefined);      // the session fills the header as it sends each one
  assert.equal(resent.ClOrdID, 'o2');
  assert.equal(sent[0]!.fields.GapFillFlag, true);
  assert.equal(sent[0]!.fields.PossDupFlag, true);
});

test('a plan gives each message as soon as it can: nothing waits for the end of the range', () => {
  const plan = resendPlan(1, 6);
  assert.deepEqual(plan.next(1, history.get(1)!, T0).map(brief), []);
  assert.deepEqual(plan.next(2, history.get(2)!, T0).map(brief), ['gap 1-2', 'NewOrderSingle 2']);
  assert.deepEqual(plan.next(3, history.get(3)!, T0).map(brief), []);
  assert.deepEqual(plan.next(4, history.get(4)!, T0).map(brief), []);
  assert.deepEqual(plan.next(6, history.get(6)!, T0).map(brief), ['gap 3-6', 'NewOrderSingle 6']);
  assert.deepEqual(plan.end(T0).map(brief), []);
});

test('a plan for a range ending in session messages ends with a gap fill to the next number', () => {
  assert.deepEqual(planned(3, 4, T0).map(({ fields }) => [fields.MsgSeqNum, fields.NewSeqNo]), [[3, 5]]);
});

test('a plan with no original at all is one gap fill over the whole range', () => {
  const sent = planned(7, 9, T0 + 2000, new Map());
  assert.deepEqual(sent.map(brief), ['gap 7-10']);
  assert.deepEqual(sent[0]!.fields.OrigSendingTime, new Date(T0 + 2000));
});

test("a gap fill's OrigSendingTime is the first session message's own when the gap begins with one, and the time it is planned when it begins with a missing message", () => {
  // 3 and 4 are Heartbeats sent at T0; 5 is missing.
  assert.deepEqual(planned(3, 6, T0 + 1000)[0]!.fields.OrigSendingTime, new Date(T0));
  assert.deepEqual(planned(5, 6, T0 + 1000)[0]!.fields.OrigSendingTime, new Date(T0 + 1000));
});

test('a plan ignores an original it has passed, or one outside its range', () => {
  const plan = resendPlan(2, 4);
  assert.deepEqual(plan.next(1, history.get(2)!, T0).map(brief), []);
  assert.deepEqual(plan.next(2, history.get(2)!, T0).map(brief), ['NewOrderSingle 2']);
  assert.deepEqual(plan.next(2, history.get(6)!, T0).map(brief), []);
  assert.deepEqual(plan.next(6, history.get(6)!, T0).map(brief), []);
  assert.deepEqual(plan.end(T0).map(brief), ['gap 3-5']);
});

test('a gap that begins with missing numbers and then holds a session message begins at the first missing number, with the time it is planned as its OrigSendingTime', () => {
  // 1 and 2 are missing, 3 is a Heartbeat sent at T0, 6 is an application message.
  const kept = new Map([[3, history.get(3)!], [6, history.get(6)!]]);
  const plan = resendPlan(1, 6);
  assert.deepEqual(plan.next(3, kept.get(3)!, T0 + 1000), []);
  const sent = plan.next(6, kept.get(6)!, T0 + 2000);
  assert.deepEqual(sent.map(brief), ['gap 1-6', 'NewOrderSingle 6']);
  assert.deepEqual(sent[0]!.fields.OrigSendingTime, new Date(T0 + 2000));   // not the Heartbeat's own T0: the gap does not begin with it
  // The same when nothing follows the session message.
  const toTheEnd = planned(1, 4, T0 + 3000, kept);
  assert.deepEqual(toTheEnd.map(brief), ['gap 1-5']);
  assert.deepEqual(toTheEnd[0]!.fields.OrigSendingTime, new Date(T0 + 3000));
});

test("a later gap that begins with a missing number does not carry an earlier gap's OrigSendingTime", () => {
  // 1 is a Logon sent at T0, 2 an application message, 3 to 5 are missing, 6 an application message.
  const kept = new Map([[1, history.get(1)!], [2, history.get(2)!], [6, history.get(6)!]]);
  const sent = planned(1, 6, T0 + 4000, kept);
  assert.deepEqual(sent.map(brief), ['gap 1-2', 'NewOrderSingle 2', 'gap 3-6', 'NewOrderSingle 6']);
  assert.deepEqual(sent[0]!.fields.OrigSendingTime, new Date(T0));
  assert.deepEqual(sent[2]!.fields.OrigSendingTime, new Date(T0 + 4000));
  // And when the later gap runs to the end of the range.
  const toTheEnd = planned(1, 5, T0 + 5000, kept);
  assert.deepEqual(toTheEnd.map(brief), ['gap 1-2', 'NewOrderSingle 2', 'gap 3-6']);
  assert.deepEqual(toTheEnd[2]!.fields.OrigSendingTime, new Date(T0 + 5000));
});
