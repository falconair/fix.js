import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, step } from './engine.ts';
import { T0, fromThem, fromThemIn, sends, testConfig } from './fixtures.ts';
import type { EngineConfig, EngineEvent, EngineState, Step } from './types.ts';

const acceptor = testConfig();
const initiator = testConfig({ role: 'initiator', logon: { Username: 'desk7' } });
const received = (msgType: string, seq: number, fields: Record<string, unknown> = {}, now = T0): EngineEvent =>
  ({ type: 'received', ...fromThem(msgType, seq, fields, now) });
/** A received message that arrived at `arrived` (ms) and is processed later. */
const arrivedAt = (event: EngineEvent, arrived: number): EngineEvent => (event.type === 'received' ? { ...event, arrived } : event);
const types = (result: Step) => result.actions.map(a => (a.type === 'send' ? `send ${a.msgType}` : a.type));
const loggedOn = (config: EngineConfig = acceptor, overrides: Partial<EngineState> = {}): EngineState =>
  ({ ...initialState(config, T0), phase: 'active', next: 2, expected: 2, ...overrides });

test('setSeqNums moves the counters, and refuses nonsense', () => {
  const moved = step(loggedOn(), acceptor, { type: 'setSeqNums', next: 100, expected: 50 }, T0);
  assert.deepEqual({ next: moved.state.next, expected: moved.state.expected }, { next: 100, expected: 50 });
  assert.deepEqual(moved.actions, []);
  const onlyNext = step(loggedOn(), acceptor, { type: 'setSeqNums', next: 7 }, T0);
  assert.deepEqual({ next: onlyNext.state.next, expected: onlyNext.state.expected }, { next: 7, expected: 2 });
  assert.throws(() => step(loggedOn(), acceptor, { type: 'setSeqNums', next: 0 }, T0), RangeError);
  assert.throws(() => step(loggedOn(), acceptor, { type: 'setSeqNums', expected: 1.5 }, T0), RangeError);
});

test('an initiator starts by sending its Logon', () => {
  const result = step(initialState(initiator, T0), initiator, { type: 'start' }, T0);
  assert.deepEqual(types(result), ['send Logon']);
  const logon = sends(result.actions)[0]?.fields;
  assert.deepEqual({ ...logon, SendingTime: undefined }, {
    EncryptMethod: 'None', HeartBtInt: 30, Username: 'desk7',
    BeginString: 'FIX.4.4', SenderCompID: 'ME', TargetCompID: 'THEM', SendingTime: undefined, MsgSeqNum: 1,
  });
  assert.equal(result.state.phase, 'loggingOn');
});

test('ResetSeqNumFlag in our Logon starts both counters at 1', () => {
  const config = testConfig({ role: 'initiator', logon: { ResetSeqNumFlag: true } });
  const result = step(initialState(config, T0, { next: 40, expected: 50 }), config, { type: 'start' }, T0);
  assert.deepEqual(types(result), ['reset', 'send Logon']);
  assert.equal(sends(result.actions)[0]?.fields.MsgSeqNum, 1);
  assert.equal(result.state.expected, 1);
});

test('an initiator that asked for a reset is not reset again by the reply', () => {
  const config = testConfig({ role: 'initiator', logon: { ResetSeqNumFlag: true } });
  const sent = step(initialState(config, T0, { next: 40, expected: 50 }), config, { type: 'start' }, T0).state;
  const result = step(sent, config, received('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true }), T0);
  assert.deepEqual(types(result), ['active', 'deliver']);
  assert.deepEqual({ next: result.state.next, expected: result.state.expected }, { next: 2, expected: 2 });
});

test('the initiator is logged on when the reply arrives', () => {
  const sent = step(initialState(initiator, T0), initiator, { type: 'start' }, T0).state;
  const result = step(sent, initiator, received('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30 }), T0);
  assert.deepEqual(types(result), ['active', 'deliver']);
  assert.equal(result.state.phase, 'active');
  assert.equal(result.state.expected, 2);
});

test('an acceptor answers a Logon with its own and adopts the heartbeat', () => {
  const result = step(initialState(acceptor, T0), acceptor, received('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 20 }), T0);
  assert.deepEqual(types(result), ['send Logon', 'active', 'deliver']);
  assert.equal(sends(result.actions)[0]?.fields.HeartBtInt, 20);
  assert.equal(result.state.heartbeat, 20);
});

test('an acceptor honours ResetSeqNumFlag', () => {
  const state = initialState(acceptor, T0, { next: 7, expected: 9 });
  const result = step(state, acceptor, received('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true }), T0);
  assert.deepEqual(types(result), ['reset', 'send Logon', 'active', 'deliver']);
  const reply = sends(result.actions)[0]?.fields;
  assert.deepEqual({ seq: reply?.MsgSeqNum, reset: reply?.ResetSeqNumFlag }, { seq: 1, reset: true });
  assert.deepEqual({ next: result.state.next, expected: result.state.expected }, { next: 2, expected: 2 });
});

test('a Logon ahead of sequence logs on, then asks for a resend', () => {
  const result = step(initialState(acceptor, T0), acceptor, received('Logon', 4, { EncryptMethod: 'None', HeartBtInt: 30 }), T0);
  assert.deepEqual(types(result), ['send Logon', 'active', 'deliver', 'problem', 'send ResendRequest']);
});

test('the first message must be a Logon', () => {
  const result = step(initialState(acceptor, T0), acceptor, received('Heartbeat', 1), T0);
  assert.deepEqual(types(result), ['problem', 'disconnect']);
  assert.equal(result.state.phase, 'closed');
});

test('a Logon with a bad HeartBtInt is logged out', () => {
  const result = step(initialState(acceptor, T0), acceptor, received('Logon', 1, { EncryptMethod: 'None', 108: '-5' }), T0);
  assert.deepEqual(types(result), ['problem', 'send Logout', 'disconnect']);
});

test('a Logon that fails a header check is answered with a Logout alone: no Reject before logon', () => {
  const stale = step(initialState(acceptor, T0), acceptor, received('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30, SendingTime: new Date(T0 - 300_000) }), T0);
  assert.deepEqual(types(stale), ['problem', 'send Logout', 'disconnect']);
  assert.equal(sends(stale.actions)[0]?.fields.MsgSeqNum, 1);
  assert.equal(sends(stale.actions)[0]?.fields.Text, 'SendingTime is 300 s from our clock');

  const sent = step(initialState(initiator, T0), initiator, { type: 'start' }, T0).state;
  const misaddressed = step(sent, initiator, received('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30, SenderCompID: 'OTHER' }), T0);
  assert.deepEqual(types(misaddressed), ['problem', 'send Logout', 'disconnect']);
});

test('a Logon with ResetSeqNumFlag=Y on a logged-on session starts both sequences again at 1, and is answered with the same', () => {
  const state = loggedOn(acceptor, { next: 9, expected: 11, heartbeat: 20, recovering: 15, resendRequestedAt: T0, resendAttempts: 1 });
  const result = step(state, acceptor, received('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 20, ResetSeqNumFlag: true }), T0);
  assert.deepEqual(types(result), ['reset', 'send Logon', 'deliver']);
  const reply = sends(result.actions)[0]?.fields;
  assert.deepEqual({ seq: reply?.MsgSeqNum, reset: reply?.ResetSeqNumFlag, heartbeat: reply?.HeartBtInt }, { seq: 1, reset: true, heartbeat: 20 });
  assert.deepEqual(
    { next: result.state.next, expected: result.state.expected, phase: result.state.phase, recovering: result.state.recovering },
    { next: 2, expected: 2, phase: 'active', recovering: undefined },
  );
});

test('our own Logon with ResetSeqNumFlag=Y on a logged-on session resets at once; the reply to it is taken, not answered', () => {
  const ask: EngineEvent = { type: 'send', msgType: 'Logon', fields: { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true } };
  const asked = step(loggedOn(initiator, { next: 9, expected: 11 }), initiator, ask, T0);
  assert.deepEqual(types(asked), ['reset', 'send Logon']);
  assert.equal(sends(asked.actions)[0]?.fields.MsgSeqNum, 1);
  assert.deepEqual({ next: asked.state.next, expected: asked.state.expected, resetSent: asked.state.resetSent }, { next: 2, expected: 1, resetSent: true });

  const answered = step(asked.state, initiator, received('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true }), T0);
  assert.deepEqual(types(answered), ['deliver']);
  assert.deepEqual({ next: answered.state.next, expected: answered.state.expected, resetSent: answered.state.resetSent }, { next: 2, expected: 2, resetSent: false });
});

test('a second Logon with ResetSeqNumFlag=Y while one of ours awaits its reply is refused; the one reply is taken, and a later reset from them is answered', () => {
  const ask: EngineEvent = { type: 'send', msgType: 'Logon', fields: { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true } };
  const asked = step(loggedOn(initiator, { next: 9, expected: 11 }), initiator, ask, T0);
  assert.throws(() => step(asked.state, initiator, ask, T0), { name: 'FIXStateError', message: /sequence reset.*awaiting its reply/ });

  const reply = received('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true });
  const answered = step(asked.state, initiator, reply, T0);
  assert.deepEqual(types(answered), ['deliver']);
  assert.equal(answered.state.resetSent, false);

  // With nothing awaiting a reply, theirs is a request again.
  const theirs = step(answered.state, initiator, reply, T0);
  assert.deepEqual(types(theirs), ['reset', 'send Logon', 'deliver']);
  assert.equal(sends(theirs.actions)[0]?.fields.MsgSeqNum, 1);
});

test('the first message accepted in the new sequence ends the wait for a reply to our reset: a later reset of ours is sent; a reset Logon of theirs is still taken as the reply ours never had, and the one after it is answered', () => {
  const ask: EngineEvent = { type: 'send', msgType: 'Logon', fields: { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true } };
  const theirReset = received('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true });
  const asked = step(loggedOn(acceptor, { next: 9, expected: 11 }), acceptor, ask, T0);
  assert.equal(asked.state.resetSent, true);

  // A counterparty that resets without replying sends its next message as MsgSeqNum 1.
  const carriedOn = step(asked.state, acceptor, received('Heartbeat', 1), T0);
  assert.deepEqual(types(carriedOn), ['deliver']);
  assert.deepEqual({ next: carriedOn.state.next, expected: carriedOn.state.expected, resetSent: carriedOn.state.resetSent }, { next: 2, expected: 2, resetSent: false });

  const again = step(carriedOn.state, acceptor, ask, T0);
  assert.deepEqual(types(again), ['reset', 'send Logon']);
  assert.equal(sends(again.actions)[0]?.fields.MsgSeqNum, 1);
  assert.deepEqual({ next: again.state.next, expected: again.state.expected, resetSent: again.state.resetSent }, { next: 2, expected: 1, resetSent: true });

  // What ended the wait may have been a message of the old sequence, with their reply still on its way: the
  // next reset Logon is that reply, even after other messages of ours. It is taken, and not answered.
  const sentMore = step(carriedOn.state, acceptor, { type: 'send', msgType: 'Heartbeat', fields: {} }, T0);
  const late = step(sentMore.state, acceptor, theirReset, T0);
  assert.deepEqual(types(late), ['deliver']);
  assert.deepEqual({ next: late.state.next, expected: late.state.expected, resetSent: late.state.resetSent }, { next: 3, expected: 2, resetSent: false });

  // With every reset of ours paired with a Logon of theirs, the next one is theirs: reset, and answered.
  const theirs = step(late.state, acceptor, theirReset, T0);
  assert.deepEqual(types(theirs), ['reset', 'send Logon', 'deliver']);
  assert.deepEqual({ seq: sends(theirs.actions)[0]?.fields.MsgSeqNum, reset: sends(theirs.actions)[0]?.fields.ResetSeqNumFlag }, { seq: 1, reset: true });
  assert.deepEqual({ next: theirs.state.next, expected: theirs.state.expected, resetSent: theirs.state.resetSent }, { next: 2, expected: 2, resetSent: false });
});

test('a reset Logon that arrives when no reset of ours is owed a reply is a request, and is answered each time', () => {
  const theirReset = received('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true });
  let state = loggedOn(acceptor, { next: 9, expected: 11 });
  // Also right after our answer to the one before, with nothing else sent between.
  for (let request = 1; request <= 3; request++) {
    const answered = step(state, acceptor, theirReset, T0);
    assert.deepEqual(types(answered), ['reset', 'send Logon', 'deliver'], `request ${request}`);
    assert.deepEqual(counters(answered.state), { next: 2, expected: 2, resetSent: false });
    state = answered.state;
  }
});

test('every reset of ours is owed one reset Logon: after two that had none, their next two are taken as those replies, and the third is answered', () => {
  const ask: EngineEvent = { type: 'send', msgType: 'Logon', fields: { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true } };
  const theirReset = received('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true });
  let state = loggedOn(acceptor, { next: 9, expected: 11 });
  // Twice: our reset, then their MsgSeqNum 1 as another message, which lets the next reset of ours go.
  for (let reset = 1; reset <= 2; reset++) {
    state = step(state, acceptor, ask, T0).state;
    state = step(state, acceptor, received('Heartbeat', 1), T0).state;
    assert.deepEqual(counters(state), { next: 2, expected: 2, resetSent: false }, `reset ${reset}`);
  }
  state = step(state, acceptor, { type: 'send', msgType: 'Heartbeat', fields: {} }, T0).state;
  for (let reply = 1; reply <= 2; reply++) {
    const taken = step(state, acceptor, theirReset, T0);
    assert.deepEqual(types(taken), ['deliver'], `reply ${reply}`);
    assert.deepEqual(counters(taken.state), { next: 3, expected: 2, resetSent: false });
    state = taken.state;
  }
  assert.deepEqual(types(step(state, acceptor, theirReset, T0)), ['reset', 'send Logon', 'deliver']);
});

test('a Logon with ResetSeqNumFlag=Y at logon is not a mid-session reset: a reset Logon from them right after it is a request, and is answered', () => {
  const theirReset = received('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true });
  // An acceptor that answered a first Logon carrying the flag.
  const accepted = step(initialState(acceptor, T0, { next: 40, expected: 50 }), acceptor, theirReset, T0);
  assert.deepEqual(types(accepted), ['reset', 'send Logon', 'active', 'deliver']);
  assert.deepEqual(types(step(accepted.state, acceptor, theirReset, T0)), ['reset', 'send Logon', 'deliver']);

  // An initiator whose own first Logon carried it, and got its reply.
  const config = testConfig({ role: 'initiator', logon: { ResetSeqNumFlag: true } });
  const started = step(initialState(config, T0, { next: 40, expected: 50 }), config, { type: 'start' }, T0);
  const loggedOnNow = step(started.state, config, theirReset, T0);
  assert.deepEqual(types(loggedOnNow), ['active', 'deliver']);
  assert.deepEqual(types(step(loggedOnNow.state, config, theirReset, T0)), ['reset', 'send Logon', 'deliver']);
});

test('our reset still awaits its reply after a message that is not in the new sequence: the reply is taken, not answered', () => {
  const ask: EngineEvent = { type: 'send', msgType: 'Logon', fields: { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true } };
  const theirReset = received('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true });
  const asked = step(loggedOn(acceptor, { next: 9, expected: 11 }), acceptor, ask, T0);

  // Sent in the old sequence before our reset reached them: ahead of the new one.
  const inFlight = step(asked.state, acceptor, received('Heartbeat', 11), T0);
  assert.deepEqual(types(inFlight), ['problem', 'send ResendRequest']);
  assert.equal(inFlight.state.resetSent, true);
  assert.throws(() => step(inFlight.state, acceptor, ask, T0), { name: 'FIXStateError', message: /sequence reset.*awaiting its reply/ });
  const replied = step(inFlight.state, acceptor, theirReset, T0);
  assert.deepEqual(types(replied), ['deliver']);
  assert.deepEqual({ next: replied.state.next, expected: replied.state.expected, resetSent: replied.state.resetSent, recovering: replied.state.recovering }, { next: 3, expected: 2, resetSent: false, recovering: undefined });

  // A SequenceReset in reset mode is applied whatever its MsgSeqNum, so it is not one of the new sequence either.
  const moved = step(asked.state, acceptor, received('SequenceReset', 11, { NewSeqNo: 40 }), T0);
  assert.deepEqual({ expected: moved.state.expected, resetSent: moved.state.resetSent }, { expected: 40, resetSent: true });
  assert.deepEqual(types(step(moved.state, acceptor, theirReset, T0)), ['deliver']);
});

test('a resend asked for after our reset, for a message they sent before it reached them, is given up once they carry on in the new sequence', () => {
  const ask: EngineEvent = { type: 'send', msgType: 'Logon', fields: { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true } };
  const asked = step(loggedOn(acceptor, { next: 9, expected: 11 }), acceptor, ask, T0);
  const inFlight = step(asked.state, acceptor, received('Heartbeat', 11), T0);
  assert.deepEqual(types(inFlight), ['problem', 'send ResendRequest']);
  assert.deepEqual({ recovering: inFlight.state.recovering, resendAttempts: inFlight.state.resendAttempts }, { recovering: 11, resendAttempts: 1 });

  // No reply: their next message is MsgSeqNum 1 of the new sequence, so what came before it was of the old one.
  const carriedOn = step(inFlight.state, acceptor, received('Heartbeat', 1), T0);
  assert.deepEqual(types(carriedOn), ['deliver']);
  assert.deepEqual(
    { expected: carriedOn.state.expected, resetSent: carriedOn.state.resetSent, recovering: carriedOn.state.recovering, resendRequestedAt: carriedOn.state.resendRequestedAt, resendAttempts: carriedOn.state.resendAttempts },
    { expected: 2, resetSent: false, recovering: undefined, resendRequestedAt: undefined, resendAttempts: 0 },
  );
  // A heartbeat interval later nothing is asked for again.
  const later = step(carriedOn.state, acceptor, { type: 'tick' }, T0 + 30_000);
  assert.deepEqual(types(later), ['send Heartbeat']);

  // A gap in the new sequence, once it has begun, is recovered as usual.
  const gap = step(carriedOn.state, acceptor, received('Heartbeat', 5), T0);
  assert.deepEqual(types(gap), ['problem', 'send ResendRequest']);
  const filled = step(gap.state, acceptor, received('Heartbeat', 2), T0);
  assert.equal(filled.state.recovering, 5);
});

/** The fields that mark a message as a resend. */
const resent = { PossDupFlag: true, OrigSendingTime: new Date(T0) };
/** Logged on with a resend from 1 outstanding (their Logon came as MsgSeqNum 5), then our reset. */
const resetWithResendOutstanding = (config: EngineConfig = initiator): EngineState => {
  const ask: EngineEvent = { type: 'send', msgType: 'Logon', fields: { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true } };
  const asked = step(loggedOn(config, { next: 3, expected: 1, recovering: 5, resendRequestedAt: T0, resendAttempts: 1 }), config, ask, T0);
  assert.deepEqual({ next: asked.state.next, expected: asked.state.expected, resetSent: asked.state.resetSent, recovering: asked.state.recovering }, { next: 2, expected: 1, resetSent: true, recovering: undefined });
  return asked.state;
};
const theirResetLogon = () => received('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true });
const counters = (state: EngineState) => ({ next: state.next, expected: state.expected, resetSent: state.resetSent });

test('a resend of the old sequence that arrives after our reset is taken, and does not end the wait: their reply is taken, not answered', () => {
  // As a gap fill from 1, which is what an engine resends for its session messages.
  const gapFilled = step(resetWithResendOutstanding(), initiator, received('SequenceReset', 1, { ...resent, GapFillFlag: true, NewSeqNo: 6 }), T0);
  assert.deepEqual(types(gapFilled), ['deliver']);
  assert.deepEqual(counters(gapFilled.state), { next: 2, expected: 6, resetSent: true });
  const replied = step(gapFilled.state, initiator, theirResetLogon(), T0);
  assert.deepEqual(types(replied), ['deliver']);
  assert.deepEqual(counters(replied.state), { next: 2, expected: 2, resetSent: false });

  // As the messages themselves, numbered from 1.
  let state = resetWithResendOutstanding();
  for (const seq of [1, 2]) {
    const taken = step(state, initiator, received('NewOrderSingle', seq, { ...resent, ClOrdID: `old-${seq}`, Side: 'Buy', OrdType: 'Market' }), T0);
    assert.deepEqual(types(taken), ['deliver']);
    assert.deepEqual(counters(taken.state), { next: 2, expected: seq + 1, resetSent: true });
    state = taken.state;
  }
  assert.throws(() => step(state, initiator, { type: 'send', msgType: 'Logon', fields: { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true } }, T0), { name: 'FIXStateError' });
  const answered = step(state, initiator, theirResetLogon(), T0);
  assert.deepEqual(types(answered), ['deliver']);
  assert.deepEqual(counters(answered.state), { next: 2, expected: 2, resetSent: false });
});

test('only MsgSeqNum 1 sent new begins the new sequence: a message of the old one that is in sequence after an old resend or SequenceReset does not end the wait', () => {
  // The old sequence's gap fill leaves us expecting its next number, and a message they sent before our reset reached them has it.
  const gapFilled = step(resetWithResendOutstanding(), initiator, received('SequenceReset', 1, { ...resent, GapFillFlag: true, NewSeqNo: 6 }), T0);
  const oldNext = step(gapFilled.state, initiator, received('Heartbeat', 6), T0);
  assert.deepEqual(types(oldNext), ['deliver']);
  assert.deepEqual(counters(oldNext.state), { next: 2, expected: 7, resetSent: true });
  const replied = step(oldNext.state, initiator, theirResetLogon(), T0);
  assert.deepEqual(types(replied), ['deliver']);
  assert.deepEqual(counters(replied.state), { next: 2, expected: 2, resetSent: false });

  // The same after a SequenceReset in reset mode that was on its way.
  const ask: EngineEvent = { type: 'send', msgType: 'Logon', fields: { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true } };
  const asked = step(loggedOn(initiator, { next: 9, expected: 11 }), initiator, ask, T0);
  const moved = step(asked.state, initiator, received('SequenceReset', 11, { NewSeqNo: 40 }), T0);
  const at40 = step(moved.state, initiator, received('Heartbeat', 40), T0);
  assert.deepEqual(counters(at40.state), { next: 2, expected: 41, resetSent: true });
  assert.deepEqual(types(step(at40.state, initiator, theirResetLogon(), T0)), ['deliver']);
});

test('with no reply to our reset, an old gap fill from 1 that was taken leaves the new sequence too low: its first message ends the session', () => {
  // A counterparty that resets without a Logon of its own, after answering a resend request made before our reset.
  const gapFilled = step(resetWithResendOutstanding(acceptor), acceptor, received('SequenceReset', 1, { ...resent, GapFillFlag: true, NewSeqNo: 6 }), T0);
  assert.deepEqual(counters(gapFilled.state), { next: 2, expected: 6, resetSent: true });
  const first = step(gapFilled.state, acceptor, received('Heartbeat', 1), T0);
  assert.deepEqual(types(first), ['problem', 'send Logout', 'disconnect']);
  assert.deepEqual(first.actions[0], { type: 'problem', problem: { code: 'SeqNumTooLow', text: 'MsgSeqNum too low, expecting 6 but received 1', action: 'LoggedOut', refSeqNum: 1 } });
  assert.equal(first.state.phase, 'closed');
});

test('a resend in the new sequence is taken in order while our reset awaits its reply; a message sent new after it does not end the wait, and a late reply is still taken', () => {
  const ask: EngineEvent = { type: 'send', msgType: 'Logon', fields: { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true } };
  const order = (id: string) => ({ ClOrdID: id, Side: 'Buy', OrdType: 'Market' });
  let state = step(loggedOn(acceptor, { next: 9, expected: 11 }), acceptor, ask, T0).state;
  // Their 1 and 2 of the new sequence never reached us; 3 shows the gap, and we ask from 1.
  const ahead = step(state, acceptor, received('NewOrderSingle', 3, order('c')), T0);
  assert.deepEqual(types(ahead), ['problem', 'send ResendRequest']);
  assert.deepEqual({ begin: sends(ahead.actions)[0]?.fields.BeginSeqNo, recovering: ahead.state.recovering }, { begin: 1, recovering: 3 });
  state = ahead.state;
  for (const [seq, id] of [[1, 'a'], [2, 'b'], [3, 'c']] as const) {
    const taken = step(state, acceptor, received('NewOrderSingle', seq, { ...resent, ...order(id) }), T0);
    assert.deepEqual(types(taken), ['deliver'], id);
    assert.deepEqual({ expected: taken.state.expected, resetSent: taken.state.resetSent }, { expected: seq + 1, resetSent: true }, id);
    state = taken.state;
  }
  assert.equal(state.recovering, undefined);
  const fresh = step(state, acceptor, received('NewOrderSingle', 4, order('d')), T0);
  assert.deepEqual(types(fresh), ['deliver']);
  assert.deepEqual({ expected: fresh.state.expected, resetSent: fresh.state.resetSent }, { expected: 5, resetSent: true });
  assert.throws(() => step(fresh.state, acceptor, ask, T0), { name: 'FIXStateError', message: /sequence reset.*awaiting its reply/ });
  const late = step(fresh.state, acceptor, theirResetLogon(), T0);
  assert.deepEqual(types(late), ['deliver']);
  assert.deepEqual(counters(late.state), { next: 3, expected: 2, resetSent: false });
});

test('ResetSeqNumFlag=Y written by tag number resets like the named field: in a Logon sent on a logged-on session, and in the first Logon', () => {
  const ask: EngineEvent = { type: 'send', msgType: 'Logon', fields: { EncryptMethod: 'None', HeartBtInt: 30, 141: 'Y' } };
  const asked = step(loggedOn(initiator, { next: 9, expected: 11 }), initiator, ask, T0);
  assert.deepEqual(types(asked), ['reset', 'send Logon']);
  assert.deepEqual({ seq: sends(asked.actions)[0]?.fields.MsgSeqNum, flag: sends(asked.actions)[0]?.fields[141] }, { seq: 1, flag: 'Y' });
  assert.deepEqual({ next: asked.state.next, expected: asked.state.expected, resetSent: asked.state.resetSent }, { next: 2, expected: 1, resetSent: true });
  assert.throws(() => step(asked.state, initiator, ask, T0), { name: 'FIXStateError', message: /sequence reset.*awaiting its reply/ });

  const config = testConfig({ role: 'initiator', logon: { 141: 'Y' } });
  const started = step(initialState(config, T0, { next: 40, expected: 50 }), config, { type: 'start' }, T0);
  assert.deepEqual(types(started), ['reset', 'send Logon']);
  assert.equal(sends(started.actions)[0]?.fields.MsgSeqNum, 1);
  assert.deepEqual({ next: started.state.next, expected: started.state.expected }, { next: 2, expected: 1 });

  // The flag written as N, either way, asks for nothing.
  for (const fields of [{ 141: 'N' }, { ResetSeqNumFlag: false }]) {
    const plain = step(loggedOn(initiator, { next: 9, expected: 11 }), initiator, { type: 'send', msgType: 'Logon', fields: { EncryptMethod: 'None', HeartBtInt: 30, ...fields } }, T0);
    assert.deepEqual(types(plain), ['send Logon']);
    assert.equal(sends(plain.actions)[0]?.fields.MsgSeqNum, 9);
  }
});

test('a Logon with ResetSeqNumFlag=Y received while our Logout awaits its reply is answered, and the Logout reply in the new sequence still ends the session', () => {
  const loggingOut = step(loggedOn(acceptor, { next: 9, expected: 11 }), acceptor, { type: 'logout' }, T0).state;
  assert.equal(loggingOut.phase, 'loggingOut');
  const reset = step(loggingOut, acceptor, received('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true }), T0);
  assert.deepEqual(types(reset), ['reset', 'send Logon', 'deliver']);
  assert.deepEqual({ seq: sends(reset.actions)[0]?.fields.MsgSeqNum, reset: sends(reset.actions)[0]?.fields.ResetSeqNumFlag }, { seq: 1, reset: true });
  assert.deepEqual({ phase: reset.state.phase, next: reset.state.next, expected: reset.state.expected }, { phase: 'loggingOut', next: 2, expected: 2 });
  const confirmed = step(reset.state, acceptor, received('Logout', 2), T0);
  assert.deepEqual(types(confirmed), ['deliver', 'disconnect']);
  assert.equal(confirmed.state.phase, 'closed');
});

test('a mid-session Logon with ResetSeqNumFlag=Y that fails a header check is refused by the logged-on rule: a Reject, then a Logout; nothing is reset', () => {
  const state = loggedOn(acceptor, { next: 9, expected: 11 });
  const reset = { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true };
  const refusals = [
    { fields: { SenderCompID: 'OTHER' }, code: 'CompIDMismatch', reason: '9', text: 'CompIDs are OTHER to ME, expected THEM to ME' },
    { fields: { SendingTime: new Date(T0 - 300_000) }, code: 'SendingTimeAccuracy', reason: '10', text: 'SendingTime is 300 s from our clock' },
  ];
  for (const { fields, code, reason, text } of refusals) {
    const result = step(state, acceptor, received('Logon', 1, { ...reset, ...fields }), T0);
    assert.deepEqual(types(result), ['send Reject', 'problem', 'send Logout', 'disconnect'], code);
    const [reject, logout] = sends(result.actions);
    // Both go out in the sequence as it stood: the refused Logon reset nothing.
    assert.deepEqual({ seq: reject?.fields.MsgSeqNum, ref: reject?.fields.RefSeqNum, reason: reject?.fields[373], msgType: reject?.fields[372], text: reject?.fields.Text }, { seq: 9, ref: 1, reason, msgType: 'A', text });
    assert.deepEqual({ seq: logout?.fields.MsgSeqNum, text: logout?.fields.Text }, { seq: 10, text });
    assert.deepEqual(result.actions[1], { type: 'problem', problem: { code, text, action: 'LoggedOut', refSeqNum: 1 } });
    assert.deepEqual({ phase: result.state.phase, expected: result.state.expected }, { phase: 'closed', expected: 11 });
  }
  // A wrong BeginString never gets a Reject.
  const version = step(state, acceptor, received('Logon', 1, { ...reset, BeginString: 'FIX.4.2' }), T0);
  assert.deepEqual(types(version), ['problem', 'send Logout', 'disconnect']);
  assert.equal(version.actions[0]?.type === 'problem' && version.actions[0].problem.code, 'BeginStringMismatch');
});

test('a mid-session Logon with ResetSeqNumFlag=Y that has a decode problem or lacks a CompID is answered with a Logout alone; nothing is reset', () => {
  const state = loggedOn(acceptor, { next: 9, expected: 11 });
  const reset = { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true };
  const refusals = [
    { fields: { 4999: 'x' }, code: 'InvalidTagNumber', text: 'Tag 4999 is not defined in FIX.4.4' },
    { fields: { TargetCompID: null }, code: 'RequiredTagMissing', text: 'TargetCompID (56) is required' },
  ];
  for (const { fields, code, text } of refusals) {
    const result = step(state, acceptor, received('Logon', 1, { ...reset, ...fields }), T0);
    assert.deepEqual(types(result), ['problem', 'send Logout', 'disconnect'], code);
    assert.deepEqual(result.actions[0], { type: 'problem', problem: { code, text, action: 'LoggedOut', refSeqNum: 1 } });
    assert.deepEqual({ seq: sends(result.actions)[0]?.fields.MsgSeqNum, text: sends(result.actions)[0]?.fields.Text }, { seq: 9, text });
    assert.deepEqual({ phase: result.state.phase, expected: result.state.expected }, { phase: 'closed', expected: 11 });
  }
  // A user-defined tag no dictionary knows is no reason to refuse it.
  const custom = step(state, acceptor, received('Logon', 1, { ...reset, 5001: 'x' }), T0);
  assert.deepEqual(types(custom), ['reset', 'send Logon', 'deliver']);
});

test('a Logon that resets a logged-on session is held to every check a first Logon is: one that fails is answered with a Logout alone, and nothing is reset', () => {
  const state = loggedOn(acceptor, { next: 9, expected: 11 });
  const reset = { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true };
  const refusals = [
    { fields: { ...reset, EncryptMethod: 'DES' }, code: 'ValueIsIncorrect', text: 'EncryptMethod DES is not supported' },
    { fields: { ...reset, HeartBtInt: null }, code: 'RequiredTagMissing', text: 'HeartBtInt is missing' },
    { fields: { EncryptMethod: 'None', 108: '-5', ResetSeqNumFlag: true }, code: 'IncorrectDataFormatForValue', text: 'HeartBtInt must be a whole number of seconds, not -5' },
    { fields: { ...reset, PossDupFlag: true }, code: 'RequiredTagMissing', text: 'PossDupFlag=Y without OrigSendingTime' },
    { fields: { ...reset, PossDupFlag: true, OrigSendingTime: new Date(T0 + 1000) }, code: 'SendingTimeAccuracy', text: 'OrigSendingTime is later than SendingTime' },
  ];
  for (const { fields, code, text } of refusals) {
    const result = step(state, acceptor, received('Logon', 1, fields), T0);
    assert.deepEqual(types(result), ['problem', 'send Logout', 'disconnect'], text);
    assert.deepEqual(result.actions[0], { type: 'problem', problem: { code, text, action: 'LoggedOut', refSeqNum: 1 } });
    // The Logout goes out in the sequence as it stood: the refused Logon reset nothing.
    assert.deepEqual({ seq: sends(result.actions)[0]?.fields.MsgSeqNum, text: sends(result.actions)[0]?.fields.Text }, { seq: 9, text });
    assert.deepEqual({ phase: result.state.phase, expected: result.state.expected }, { phase: 'closed', expected: 11 });
    // As the first message of a connection, the same Logon is refused for the same reason.
    const first = step(initialState(acceptor, T0), acceptor, received('Logon', 1, fields), T0);
    assert.deepEqual(types(first), ['problem', 'send Logout', 'disconnect'], text);
    assert.deepEqual(first.actions[0], { type: 'problem', problem: { code, text, action: 'LoggedOut', refSeqNum: 1 } });
  }
  // The Logon's own fields are looked at, whatever the caller reports: a reset Logon without HeartBtInt, handed over with no problems listed.
  const { message } = fromThem('Logon', 1, { ...reset, HeartBtInt: null });
  const unreported = step(state, acceptor, { type: 'received', message, problems: [] }, T0);
  assert.deepEqual(types(unreported), ['problem', 'send Logout', 'disconnect']);
  assert.equal(unreported.state.expected, 11);
  // A resent Logon whose OrigSendingTime is sound passes the check.
  const resent = step(state, acceptor, received('Logon', 1, { ...reset, PossDupFlag: true, OrigSendingTime: new Date(T0 - 1000) }), T0);
  assert.deepEqual(types(resent), ['reset', 'send Logon', 'deliver']);
});

test('a Logon that resets the sequence numbers does not change the heartbeat interval: the session keeps its own, says so in its answer, and records the difference', () => {
  const reset = { EncryptMethod: 'None', HeartBtInt: 90, ResetSeqNumFlag: true };
  const difference = { type: 'problem', problem: { code: 'ValueIsIncorrect', text: 'A Logon that resets the sequence numbers has HeartBtInt 90; keeping 20', action: 'Ignored', refSeqNum: 1 } };
  // Their request: answered with the interval agreed at logon.
  const asked = step(loggedOn(acceptor, { next: 9, expected: 11, heartbeat: 20 }), acceptor, received('Logon', 1, reset), T0);
  assert.deepEqual(types(asked), ['problem', 'reset', 'send Logon', 'deliver']);
  assert.deepEqual(asked.actions[0], difference);
  assert.deepEqual({ heartbeat: sends(asked.actions)[0]?.fields.HeartBtInt, reset: sends(asked.actions)[0]?.fields.ResetSeqNumFlag }, { heartbeat: 20, reset: true });
  assert.equal(asked.state.heartbeat, 20);
  // The reply to a reset of ours: taken, with the same note.
  const owed = loggedOn(initiator, { next: 2, expected: 1, heartbeat: 20, resetSent: true, resetRepliesOwed: 1 });
  const replied = step(owed, initiator, received('Logon', 1, reset), T0);
  assert.deepEqual(types(replied), ['problem', 'deliver']);
  assert.deepEqual(replied.actions[0], difference);
  assert.deepEqual({ heartbeat: replied.state.heartbeat, owed: replied.state.resetRepliesOwed, expected: replied.state.expected }, { heartbeat: 20, owed: 0, expected: 2 });
  // The same interval: nothing to record.
  const same = step(loggedOn(acceptor, { next: 9, expected: 11, heartbeat: 90 }), acceptor, received('Logon', 1, reset), T0);
  assert.deepEqual(types(same), ['reset', 'send Logon', 'deliver']);
});

test('a Logon whose HeartBtInt the decoder has already reported is refused with the decoder\'s account; the checker words only what the decoder cannot see', () => {
  const reset = { EncryptMethod: 'None', ResetSeqNumFlag: true };
  const state = loggedOn(acceptor, { next: 9, expected: 11 });
  const cases = [
    { value: '', code: 'TagSpecifiedWithoutAValue', text: 'HeartBtInt (108) has no value' },
    { value: 'abc', code: 'IncorrectDataFormatForValue', text: "HeartBtInt (108) has a malformed value 'abc'" },
  ];
  for (const { value, code, text } of cases) {
    const refusal = { type: 'problem', problem: { code, text, action: 'LoggedOut', refSeqNum: 1 } };
    const asReset = step(state, acceptor, received('Logon', 1, { ...reset, 108: value }), T0);
    assert.deepEqual(asReset.actions[0], refusal, `reset, HeartBtInt ${JSON.stringify(value)}`);
    assert.deepEqual(types(asReset), ['problem', 'send Logout', 'disconnect']);
    const first = step(initialState(acceptor, T0), acceptor, received('Logon', 1, { EncryptMethod: 'None', 108: value }), T0);
    assert.deepEqual(first.actions[0], refusal, `first, HeartBtInt ${JSON.stringify(value)}`);
    assert.deepEqual(types(first), ['problem', 'send Logout', 'disconnect']);
  }
  // Handed over with no problems listed, the checker words them itself, and never with a text that ends in "not ".
  for (const value of ['', 'abc']) {
    const { message } = fromThem('Logon', 1, { ...reset, 108: value });
    const result = step(state, acceptor, { type: 'received', message, problems: [] }, T0);
    assert.deepEqual(types(result), ['problem', 'send Logout', 'disconnect'], JSON.stringify(value));
    const refusal = result.actions[0];
    assert.equal(refusal?.type, 'problem');
    if (refusal?.type === 'problem') assert.doesNotMatch(refusal.problem.text, /not $/, JSON.stringify(value));
  }
});

test('any other Logon on a logged-on session still ends it', () => {
  for (const fields of [{}, { ResetSeqNumFlag: false }]) {
    const plain = step(loggedOn(), acceptor, received('Logon', 2, { EncryptMethod: 'None', HeartBtInt: 30, ...fields }), T0);
    assert.deepEqual(types(plain), ['problem', 'send Logout', 'disconnect']);
  }
  // A reset must come as MsgSeqNum 1.
  const late = step(loggedOn(), acceptor, received('Logon', 2, { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true }), T0);
  assert.deepEqual(types(late), ['problem', 'send Logout', 'disconnect']);
  assert.equal(late.actions[0]?.type === 'problem' && late.actions[0].problem.code, 'UnexpectedLogon');
});

const fixtAcceptor = testConfig({ version: 'FIXT.1.1' });
const fixtInitiator = testConfig({ version: 'FIXT.1.1', role: 'initiator' });
const fromThemFixt = fromThemIn('FIXT.1.1');
const receivedFixt = (msgType: string, seq: number, fields: Record<string, unknown> = {}): EngineEvent =>
  ({ type: 'received', ...fromThemFixt(msgType, seq, fields, T0) });
const firstProblem = (result: Step) => (result.actions[0]?.type === 'problem' ? result.actions[0].problem : undefined);

test("under FIXT.1.1 an initiator's Logon names an application version: FIX 5.0 SP2, or the one `logon` names; null leaves it out", () => {
  const logonOf = (config: EngineConfig) => {
    const result = step(initialState(config, T0), config, { type: 'start' }, T0);
    return { named: sends(result.actions)[0]?.fields.DefaultApplVerID, session: result.state.applVerID };
  };
  assert.deepEqual(logonOf(fixtInitiator), { named: 'FIX50SP2', session: 'FIX50SP2' });
  assert.deepEqual(logonOf(testConfig({ version: 'FIXT.1.1', role: 'initiator', logon: { DefaultApplVerID: 'FIXLatest' } })), { named: 'FIXLatest', session: 'FIXLatest' });
  // Written as null, it is left out (to see what a counterparty does with such a Logon); by tag number, it is sent as written.
  assert.deepEqual(logonOf(testConfig({ version: 'FIXT.1.1', role: 'initiator', logon: { DefaultApplVerID: null } })), { named: null, session: undefined });
  const byTag = step(initialState(fixtInitiator, T0), testConfig({ version: 'FIXT.1.1', role: 'initiator', logon: { 1137: '8' } }), { type: 'start' }, T0);
  assert.deepEqual({ named: sends(byTag.actions)[0]?.fields.DefaultApplVerID, raw: sends(byTag.actions)[0]?.fields[1137] }, { named: undefined, raw: '8' });
  // FIX 4.4 has no such field.
  assert.equal('DefaultApplVerID' in (sends(step(initialState(initiator, T0), initiator, { type: 'start' }, T0).actions)[0]?.fields ?? {}), false);
});

test('under FIXT.1.1 an acceptor answers a Logon with the application version it named, for each of the four fix.js reads', () => {
  for (const applVerID of ['FIX50', 'FIX50SP1', 'FIX50SP2', 'FIXLatest']) {
    const result = step(initialState(fixtAcceptor, T0), fixtAcceptor, receivedFixt('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30, DefaultApplVerID: applVerID }), T0);
    assert.deepEqual(types(result), ['send Logon', 'active', 'deliver'], applVerID);
    assert.deepEqual({ named: sends(result.actions)[0]?.fields.DefaultApplVerID, session: result.state.applVerID, phase: result.state.phase }, { named: applVerID, session: applVerID, phase: 'active' });
  }
  // An initiator takes a reply that names another of the four: each side says what it will send.
  const sent = step(initialState(fixtInitiator, T0), fixtInitiator, { type: 'start' }, T0).state;
  const reply = step(sent, fixtInitiator, receivedFixt('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30, DefaultApplVerID: 'FIXLatest' }), T0);
  assert.deepEqual(types(reply), ['active', 'deliver']);
  // What the initiator sends stays what its Logon named, whatever the reply names.
  assert.equal(reply.state.applVerID, 'FIX50SP2');
});

test('an initiator whose Logon names an application version, by field name or by tag number with the wire value, names the same one in every later Logon: a reset of its own, and its answer to theirs', () => {
  const reset = { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true };
  const cases: [string, Record<string, unknown>, string, { named?: string; raw?: string | number }][] = [
    ['by name', { DefaultApplVerID: 'FIX50SP1' }, 'FIX50SP1', { named: 'FIX50SP1' }],
    ['by tag number', { 1137: '8' }, 'FIX50SP1', { raw: '8' }],
    ['by tag number, FIX Latest', { 1137: '10' }, 'FIXLatest', { raw: '10' }],
    ['by tag number, the wire value written as a number', { 1137: 8 }, 'FIX50SP1', { raw: 8 }],
    ['by tag number, FIX Latest written as a number', { 1137: 10 }, 'FIXLatest', { raw: 10 }],
    ['nothing written', {}, 'FIX50SP2', { named: 'FIX50SP2' }],
  ];
  for (const [how, written, applVerID, sentAs] of cases) {
    const config = testConfig({ version: 'FIXT.1.1', role: 'initiator', logon: written });
    const start = step(initialState(config, T0), config, { type: 'start' }, T0);
    const first = sends(start.actions)[0]?.fields;
    assert.deepEqual({ named: first?.DefaultApplVerID, raw: first?.[1137] }, { named: undefined, raw: undefined, ...sentAs }, how);
    assert.equal(start.state.applVerID, applVerID, how);
    // A reset of ours, sent with the fields any version takes.
    const active = { ...start.state, phase: 'active' as const, next: 9, expected: 11 };
    const ours = sends(step(active, config, { type: 'send', msgType: 'Logon', fields: reset }, T0).actions)[0]?.fields;
    assert.equal(ours?.DefaultApplVerID, applVerID, how);
    // Their reset, answered.
    const answer = sends(step(active, config, receivedFixt('Logon', 1, { ...reset, DefaultApplVerID: 'FIXLatest' }), T0).actions)[0]?.fields;
    assert.equal(answer?.DefaultApplVerID, applVerID, how);
  }
  // Written as null the field is left out of the first Logon and nothing is recorded: a later Logon names FIX 5.0 SP2.
  const config = testConfig({ version: 'FIXT.1.1', role: 'initiator', logon: { DefaultApplVerID: null } });
  const start = step(initialState(config, T0), config, { type: 'start' }, T0);
  assert.deepEqual({ named: sends(start.actions)[0]?.fields.DefaultApplVerID, session: start.state.applVerID }, { named: null, session: undefined });
  const ours = step({ ...start.state, phase: 'active', next: 9, expected: 11 }, config, { type: 'send', msgType: 'Logon', fields: reset }, T0);
  assert.equal(sends(ours.actions)[0]?.fields.DefaultApplVerID, 'FIX50SP2');
});

test('a FIXT.1.1 Logon that names no application version, or one fix.js does not read, is refused with a Logout saying so', () => {
  const logon = { EncryptMethod: 'None', HeartBtInt: 30 };
  const unsupported = 'DefaultApplVerID FIX44 is not supported; use FIX50, FIX50SP1, FIX50SP2 or FIXLatest';
  const refused = (result: Step, code: string, text: string) => {
    assert.deepEqual(types(result), ['problem', 'send Logout', 'disconnect'], text);
    assert.deepEqual(firstProblem(result), { code, text, action: 'LoggedOut', refSeqNum: 1 });
    assert.equal(sends(result.actions)[0]?.fields.Text, text);
    assert.equal(result.state.phase, 'closed');
  };
  // An acceptor, given the Logon as the wire layer read it.
  refused(step(initialState(fixtAcceptor, T0), fixtAcceptor, receivedFixt('Logon', 1, { ...logon, DefaultApplVerID: 'FIX44' }), T0), 'InvalidUnsupportedAppVersion', unsupported);
  refused(step(initialState(fixtAcceptor, T0), fixtAcceptor, receivedFixt('Logon', 1, { ...logon, DefaultApplVerID: null }), T0), 'RequiredTagMissing', 'DefaultApplVerID (1137) is required');
  refused(step(initialState(fixtAcceptor, T0), fixtAcceptor, receivedFixt('Logon', 1, { ...logon, 1137: '33' }), T0), 'ValueIsIncorrect', "DefaultApplVerID (1137) has no value '33'");
  // The Logon's own fields are looked at, whatever the caller reports: the same Logons handed over with no problems listed.
  const { message: none } = fromThemFixt('Logon', 1, { ...logon, DefaultApplVerID: null });
  refused(step(initialState(fixtAcceptor, T0), fixtAcceptor, { type: 'received', message: none, problems: [] }, T0), 'RequiredTagMissing', 'DefaultApplVerID (1137) is required in a FIXT.1.1 Logon');
  const { message: odd } = fromThemFixt('Logon', 1, { ...logon, 1137: '33' });
  refused(step(initialState(fixtAcceptor, T0), fixtAcceptor, { type: 'received', message: odd, problems: [] }, T0), 'InvalidUnsupportedAppVersion', 'DefaultApplVerID 33 is not supported; use FIX50, FIX50SP1, FIX50SP2 or FIXLatest');
  // A long value is quoted by its first 32 characters only.
  const { message: huge } = fromThemFixt('Logon', 1, { ...logon, 1137: 'x'.repeat(30_000) });
  refused(step(initialState(fixtAcceptor, T0), fixtAcceptor, { type: 'received', message: huge, problems: [] }, T0), 'InvalidUnsupportedAppVersion',
    `DefaultApplVerID ${'x'.repeat(32)}... is not supported; use FIX50, FIX50SP1, FIX50SP2 or FIXLatest`);
  // An initiator, given such a reply.
  const sent = step(initialState(fixtInitiator, T0), fixtInitiator, { type: 'start' }, T0).state;
  refused(step(sent, fixtInitiator, receivedFixt('Logon', 1, { ...logon, DefaultApplVerID: 'FIX44' }), T0), 'InvalidUnsupportedAppVersion', unsupported);
  // And a Logon that resets a logged-on session: refused, and nothing is reset.
  const active = loggedOn(fixtAcceptor, { next: 9, expected: 11, applVerID: 'FIX50SP2' });
  const reset = step(active, fixtAcceptor, receivedFixt('Logon', 1, { ...logon, ResetSeqNumFlag: true, DefaultApplVerID: 'FIX42' }), T0);
  assert.deepEqual(types(reset), ['problem', 'send Logout', 'disconnect']);
  assert.deepEqual({ code: firstProblem(reset)?.code, seq: sends(reset.actions)[0]?.fields.MsgSeqNum, expected: reset.state.expected }, { code: 'InvalidUnsupportedAppVersion', seq: 9, expected: 11 });
});

test('every Logon a FIXT.1.1 session sends names its application version: the answer to a reset, and a reset of our own, unless it is written', () => {
  const active = loggedOn(fixtAcceptor, { next: 9, expected: 11, applVerID: 'FIX50SP1' });
  const reset = { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true };
  // Their reset: answered with the version this session named at logon, whichever of the four theirs names now.
  const answered = step(active, fixtAcceptor, receivedFixt('Logon', 1, { ...reset, DefaultApplVerID: 'FIXLatest' }), T0);
  assert.deepEqual(types(answered), ['reset', 'send Logon', 'deliver']);
  assert.deepEqual({ named: sends(answered.actions)[0]?.fields.DefaultApplVerID, flag: sends(answered.actions)[0]?.fields.ResetSeqNumFlag, session: answered.state.applVerID }, { named: 'FIX50SP1', flag: true, session: 'FIX50SP1' });
  // Our reset, sent with the fields any version takes: the session fills the version in.
  const ours = step(active, fixtAcceptor, { type: 'send', msgType: 'Logon', fields: reset }, T0);
  assert.deepEqual(types(ours), ['reset', 'send Logon']);
  assert.deepEqual({ named: sends(ours.actions)[0]?.fields.DefaultApplVerID, seq: sends(ours.actions)[0]?.fields.MsgSeqNum }, { named: 'FIX50SP1', seq: 1 });
  // Written, it is sent as written.
  const written = step(active, fixtAcceptor, { type: 'send', msgType: 'Logon', fields: { ...reset, DefaultApplVerID: 'FIX50SP2' } }, T0);
  assert.equal(sends(written.actions)[0]?.fields.DefaultApplVerID, 'FIX50SP2');
  // No other message gains the field, and a FIX 4.4 Logon does not either.
  const heartbeat = step(active, fixtAcceptor, { type: 'send', msgType: 'Heartbeat', fields: {} }, T0);
  assert.equal('DefaultApplVerID' in (sends(heartbeat.actions)[0]?.fields ?? {}), false);
  const fix44 = step(loggedOn(acceptor), acceptor, { type: 'send', msgType: 'Logon', fields: reset }, T0);
  assert.equal('DefaultApplVerID' in (sends(fix44.actions)[0]?.fields ?? {}), false);
});

test('sending needs an active session', () => {
  const send: EngineEvent = { type: 'send', msgType: 'Heartbeat', fields: {} };
  assert.throws(() => step(initialState(acceptor, T0), acceptor, send, T0), { name: 'FIXStateError' });
  assert.throws(() => step({ ...loggedOn(), phase: 'closed' }, acceptor, send, T0), { name: 'FIXStateError' });
  assert.deepEqual(types(step(loggedOn(), acceptor, send, T0)), ['send Heartbeat']);
});

test('logout: ours is sent and awaits the reply', () => {
  const result = step(loggedOn(), acceptor, { type: 'logout', text: 'done' }, T0);
  assert.deepEqual(types(result), ['send Logout']);
  assert.equal(sends(result.actions)[0]?.fields.Text, 'done');
  assert.equal(result.state.phase, 'loggingOut');
  const reply = step(result.state, acceptor, received('Logout', 2), T0);
  assert.deepEqual(reply.actions.at(-1), { type: 'disconnect', by: 'us', text: 'Logout confirmed' });
});

test('a quiet session heartbeats', () => {
  assert.deepEqual(types(step(loggedOn(), acceptor, { type: 'tick' }, T0 + 29_999)), []);
  const result = step(loggedOn(), acceptor, { type: 'tick' }, T0 + 30_000);
  assert.deepEqual(types(result), ['send Heartbeat']);
});

test('silence brings a TestRequest, then a disconnect', () => {
  const asked = step(loggedOn(), acceptor, { type: 'tick' }, T0 + 36_000);
  assert.deepEqual(types(asked), ['send TestRequest']);
  assert.equal(sends(asked.actions)[0]?.fields.TestReqID, 'TEST-1');
  assert.deepEqual(asked.state.testRequest, { id: 'TEST-1', sentAt: T0 + 36_000 });
  const gone = step(asked.state, acceptor, { type: 'tick' }, T0 + 66_000);
  assert.deepEqual(types(gone), ['problem', 'disconnect']);
  assert.equal(gone.actions[0]?.type === 'problem' && gone.actions[0].problem.code, 'HeartbeatTimeout');
});

test('anything received answers a pending TestRequest', () => {
  const asked = step(loggedOn(), acceptor, { type: 'tick' }, T0 + 36_000).state;
  const answered = step(asked, acceptor, received('Heartbeat', 2, { TestReqID: 'TEST-1' }, T0 + 37_000), T0 + 37_000);
  assert.equal(answered.state.testRequest, undefined);
  assert.deepEqual(types(step(answered.state, acceptor, { type: 'tick' }, T0 + 66_000)), ['send Heartbeat']);
});

test('a counterparty heard, with nothing of it processed, is not silent: no TestRequest is sent until it has been silent that long again, and a TestRequest still unanswered is not held against it', () => {
  const heard = step(loggedOn(), acceptor, { type: 'heard' }, T0 + 35_000);
  assert.deepEqual([types(heard), heard.state.lastReceived], [[], T0 + 35_000]);
  assert.deepEqual(types(step(heard.state, acceptor, { type: 'tick' }, T0 + 70_999)), ['send Heartbeat'], 'its own Heartbeat, and no TestRequest: 35.999 s of silence');
  assert.deepEqual(types(step(heard.state, acceptor, { type: 'tick' }, T0 + 71_000)), ['send TestRequest']);
  const asked = step(loggedOn(), acceptor, { type: 'tick' }, T0 + 36_000).state;
  const answered = step(asked, acceptor, { type: 'heard' }, T0 + 65_000);
  assert.equal(answered.state.testRequest, undefined);
  assert.deepEqual(types(step(answered.state, acceptor, { type: 'tick' }, T0 + 66_000)), ['send Heartbeat'], 'not closed for the TestRequest of 30 s before');
  // Heard no more, it is asked again and then given up, as any silent counterparty.
  const again = step(answered.state, acceptor, { type: 'tick' }, T0 + 101_000);
  assert.deepEqual([types(again), again.state.testRequest], [['send TestRequest'], { id: 'TEST-2', sentAt: T0 + 101_000 }]);
  assert.deepEqual(types(step(again.state, acceptor, { type: 'tick' }, T0 + 131_000)), ['problem', 'disconnect']);
});

test('a message is judged by the time its bytes arrived, when the event gives one: its SendingTime may be further from the clock than maxClockSkew by the time it is processed, and one that was too far off when it arrived is still logged out', () => {
  // Sent and arrived at T0, processed 300 s later: the wait was ours.
  const late = step(loggedOn(), acceptor, arrivedAt(received('Heartbeat', 2), T0), T0 + 300_000);
  assert.deepEqual(types(late), ['deliver']);
  assert.deepEqual([late.state.expected, late.state.lastReceived], [3, T0 + 300_000], 'everything else is of the time it is processed');
  // Exactly maxClockSkew from its arrival is in; a second more is out, and the text measures from the arrival.
  const edge = step(loggedOn(), acceptor, arrivedAt(received('Heartbeat', 2, {}, T0 - 120_000), T0), T0 + 300_000);
  assert.deepEqual(types(edge), ['deliver']);
  const stale = step(loggedOn(), acceptor, arrivedAt(received('Heartbeat', 2, {}, T0 - 121_000), T0), T0 + 300_000);
  assert.deepEqual(types(stale), ['send Reject', 'problem', 'send Logout', 'disconnect']);
  assert.equal(sends(stale.actions)[1]?.fields.Text, 'SendingTime is 121 s from our clock');
  // Stamped with the time it is processed, 300 s after it arrived: the counterparty's clock is that far ahead.
  const ahead = step(loggedOn(), acceptor, arrivedAt(received('Heartbeat', 2, {}, T0 + 300_000), T0), T0 + 300_000);
  assert.equal(sends(ahead.actions)[1]?.fields.Text, 'SendingTime is -300 s from our clock');
  // With no arrival given, the time of the step is the arrival.
  const unstamped = step(loggedOn(), acceptor, received('Heartbeat', 2), T0 + 300_000);
  assert.equal(sends(unstamped.actions)[1]?.fields.Text, 'SendingTime is 300 s from our clock');
  // A Logon is judged the same way.
  const logon = step(initialState(acceptor, T0), acceptor, arrivedAt(received('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30 }), T0), T0 + 300_000);
  assert.deepEqual(types(logon), ['send Logon', 'active', 'deliver']);
});

test('a counterparty heard while a resend is awaited is not asked again for it until a heartbeat interval after it was last heard; the requests already made still count, and one that never answers is given up after three', () => {
  const gap = step(loggedOn(), acceptor, received('Heartbeat', 5), T0);
  assert.deepEqual([types(gap), gap.state.resendRequestedAt, gap.state.resendAttempts], [['problem', 'send ResendRequest'], T0, 1]);
  // Unheard, it is asked again 30 s on.
  assert.deepEqual(types(step(gap.state, acceptor, { type: 'tick' }, T0 + 30_000)), ['problem', 'send ResendRequest']);
  // Heard at 29 s and at 50 s: not asked at 30 s, nor at 59 s, nor at 79.999 s; asked at 80 s, 30 s after it was last heard.
  const heard = step(gap.state, acceptor, { type: 'heard' }, T0 + 29_000);
  assert.deepEqual([heard.actions, heard.state.resendRequestedAt, heard.state.resendAttempts, heard.state.recovering], [[], T0 + 29_000, 1, 5]);
  assert.deepEqual(types(step(heard.state, acceptor, { type: 'tick' }, T0 + 30_000)), ['send Heartbeat']);
  const again = step(heard.state, acceptor, { type: 'heard' }, T0 + 50_000);
  assert.deepEqual(types(step(again.state, acceptor, { type: 'tick' }, T0 + 59_000)), ['send Heartbeat']);
  assert.deepEqual(types(step(again.state, acceptor, { type: 'tick' }, T0 + 79_999)), ['send Heartbeat']);
  const second = step(again.state, acceptor, { type: 'tick' }, T0 + 80_000);
  assert.deepEqual([types(second).slice(0, 2), second.state.resendAttempts], [['problem', 'send ResendRequest'], 2]);
  // Heard once more, 10 s on: the two requests made still count, and the third waits 30 s from there.
  const later = step(second.state, acceptor, { type: 'heard' }, T0 + 90_000);
  assert.deepEqual([later.state.resendAttempts, later.state.resendRequestedAt], [2, T0 + 90_000]);
  assert.deepEqual(types(step(later.state, acceptor, { type: 'tick' }, T0 + 119_000)), ['send Heartbeat']);
  // From here it goes on sending other things (dropped, while the resend is awaited) and never the resend.
  const other = (at: number): EngineEvent => received('Heartbeat', 9, {}, at);
  const third = step(step(later.state, acceptor, other(T0 + 119_000), T0 + 119_000).state, acceptor, { type: 'tick' }, T0 + 120_000);
  assert.deepEqual([types(third).slice(0, 2), third.state.resendAttempts], [['problem', 'send ResendRequest'], 3]);
  const end = step(step(third.state, acceptor, other(T0 + 149_000), T0 + 149_000).state, acceptor, { type: 'tick' }, T0 + 150_000);
  assert.deepEqual(types(end), ['problem', 'send Logout', 'disconnect']);
  assert.equal(sends(end.actions)[0]?.fields.Text, 'Resend from 2 still incomplete after 3 requests');
  // With no resend awaited there is no timer to hold.
  assert.equal(step(loggedOn(), acceptor, { type: 'heard' }, T0 + 29_000).state.resendRequestedAt, undefined);
});

test('hearing a counterparty asks for nothing and ends nothing before the session is active, in manual mode, or once it is closed: the logon and the logout still time out, counted from when they began', () => {
  const connecting = initialState(acceptor, T0);
  const early = step(connecting, acceptor, { type: 'heard' }, T0 + 9_000).state;
  assert.deepEqual(early, { ...connecting, lastReceived: T0 + 9_000 }, 'when it was last heard is noted, and nothing else changes');
  assert.deepEqual(step(connecting, acceptor, { type: 'heard' }, T0 + 9_000).actions, []);
  assert.deepEqual(types(step(step(connecting, acceptor, { type: 'heard' }, T0 + 9_000).state, acceptor, { type: 'tick' }, T0 + 10_000)), ['problem', 'disconnect'], 'the logon still times out');
  const out = step(loggedOn(), acceptor, { type: 'logout' }, T0).state;
  assert.deepEqual(types(step(step(out, acceptor, { type: 'heard' }, T0 + 9_000).state, acceptor, { type: 'tick' }, T0 + 10_000)), ['problem', 'disconnect'], 'the logout still times out');
  const closed = step(loggedOn(), acceptor, { type: 'disconnected' }, T0).state;
  assert.equal(step(closed, acceptor, { type: 'heard' }, T0 + 1_000).state, closed);
  assert.deepEqual(step(out, acceptor, { type: 'heard' }, T0 + 9_000).state, { ...out, lastReceived: T0 + 9_000 });
  const manual = testConfig({ manual: true });
  const quiet = step(initialState(manual, T0), manual, { type: 'heard' }, T0 + 1_000);
  assert.deepEqual([quiet.actions, quiet.state], [[], { ...initialState(manual, T0), lastReceived: T0 + 1_000 }]);
});

test('an unanswered Logon or Logout times out', () => {
  const sent = step(initialState(initiator, T0), initiator, { type: 'start' }, T0).state;
  const logon = step(sent, initiator, { type: 'tick' }, T0 + 10_000);
  assert.equal(logon.actions[0]?.type === 'problem' && logon.actions[0].problem.code, 'LogonTimeout');
  assert.equal(logon.state.phase, 'closed');
  const out = step(loggedOn(), acceptor, { type: 'logout' }, T0).state;
  const logout = step(out, acceptor, { type: 'tick' }, T0 + 10_000);
  assert.equal(logout.actions[0]?.type === 'problem' && logout.actions[0].problem.code, 'LogoutTimeout');
});

test('garbled frames are recorded and otherwise ignored', () => {
  const result = step(loggedOn(), acceptor, { type: 'garbled', error: 'CheckSum is 000 but should be 138' }, T0);
  assert.deepEqual(types(result), ['problem']);
  assert.equal(result.state.expected, 2);
});

test('manual mode: nothing automatic', () => {
  const manual = testConfig({ manual: true, role: 'initiator' });
  const start = initialState(manual, T0);
  assert.deepEqual(types(step(start, manual, { type: 'start' }, T0)), []);
  assert.deepEqual(types(step(start, manual, { type: 'send', msgType: 'Logon', fields: { EncryptMethod: 'None', HeartBtInt: 5 } }, T0)), ['send Logon']);
  const testRequest = step(start, manual, received('TestRequest', 7, { TestReqID: 'x' }), T0);
  assert.deepEqual(types(testRequest), ['deliver']);
  assert.equal(testRequest.state.expected, 8);
  assert.deepEqual(types(step(start, manual, { type: 'tick' }, T0 + 999_999)), []);
});

test('a closed session ignores everything but refuses to send', () => {
  const closed = { ...loggedOn(), phase: 'closed' as const };
  assert.deepEqual(types(step(closed, acceptor, received('Heartbeat', 2), T0)), []);
  assert.deepEqual(types(step(closed, acceptor, { type: 'tick' }, T0 + 999_999)), []);
});

test('a stalled resend is requested again after a heartbeat interval', () => {
  const stalled = loggedOn(acceptor, { recovering: 5, resendRequestedAt: T0, resendAttempts: 1 });
  assert.deepEqual(types(step(stalled, acceptor, { type: 'tick' }, T0 + 29_999)), []);
  const again = step(stalled, acceptor, { type: 'tick' }, T0 + 30_000);
  assert.deepEqual(types(again), ['problem', 'send ResendRequest']);
  const request = sends(again.actions)[0]?.fields;
  assert.deepEqual({ from: request?.BeginSeqNo, to: request?.EndSeqNo }, { from: 2, to: 0 });
  assert.equal(again.state.resendRequestedAt, T0 + 30_000);
  assert.equal(again.state.resendAttempts, 2);
});

test('an acceptor waiting for a Logon times out', () => {
  const waiting = initialState(acceptor, T0);
  assert.deepEqual(types(step(waiting, acceptor, { type: 'tick' }, T0 + 9_999)), []);
  const result = step(waiting, acceptor, { type: 'tick' }, T0 + 10_000);
  assert.deepEqual(types(result), ['problem', 'disconnect']);
  assert.equal(result.actions[0]?.type === 'problem' && result.actions[0].problem.code, 'LogonTimeout');
  assert.equal(result.actions[0]?.type === 'problem' && result.actions[0].problem.text, 'No Logon within 10 s');
  assert.deepEqual(result.actions[1], { type: 'disconnect', by: 'us', text: 'Logon timed out' });
  assert.equal(result.state.phase, 'closed');
});

test('a Logout that rejects our Logon is reported as LogonRejected', () => {
  const sent = step(initialState(initiator, T0), initiator, { type: 'start' }, T0).state;
  const result = step(sent, initiator, received('Logout', 1, { Text: 'bad password' }), T0);
  assert.deepEqual(types(result), ['deliver', 'problem', 'disconnect']);
  assert.equal(result.actions[1]?.type === 'problem' && result.actions[1].problem.code, 'LogonRejected');
  assert.equal(result.actions[1]?.type === 'problem' && result.actions[1].problem.text, 'Logon rejected: bad password');
  assert.deepEqual(result.actions[2], { type: 'disconnect', by: 'them', text: 'bad password' });
});

test('a Logout rejecting our Logon without Text still reports LogonRejected', () => {
  const sent = step(initialState(initiator, T0), initiator, { type: 'start' }, T0).state;
  const result = step(sent, initiator, received('Logout', 1), T0);
  assert.equal(result.actions[1]?.type === 'problem' && result.actions[1].problem.text, 'Logon rejected');
  assert.deepEqual(result.actions[2], { type: 'disconnect', by: 'them', text: 'Logon rejected' });
});

test('a Logout before any Logon keeps the NotLoggedOn behaviour', () => {
  const result = step(initialState(acceptor, T0), acceptor, received('Logout', 1), T0);
  assert.deepEqual(types(result), ['problem', 'disconnect']);
  assert.equal(result.actions[0]?.type === 'problem' && result.actions[0].problem.code, 'NotLoggedOn');
  assert.deepEqual(result.actions[1], { type: 'disconnect', by: 'us', text: 'The first message was not a Logon' });
});

test('a missing HeartBtInt on Logon is RequiredTagMissing', () => {
  const result = step(initialState(acceptor, T0), acceptor, received('Logon', 1, { EncryptMethod: 'None', HeartBtInt: null }), T0);
  assert.deepEqual(types(result), ['problem', 'send Logout', 'disconnect']);
  assert.equal(result.actions[0]?.type === 'problem' && result.actions[0].problem.code, 'RequiredTagMissing');
  assert.equal(result.actions[0]?.type === 'problem' && result.actions[0].problem.text, 'HeartBtInt is missing');
});

test('an invalid HeartBtInt on Logon is IncorrectDataFormatForValue', () => {
  const result = step(initialState(acceptor, T0), acceptor, received('Logon', 1, { EncryptMethod: 'None', 108: '-5' }), T0);
  assert.deepEqual(types(result), ['problem', 'send Logout', 'disconnect']);
  assert.equal(result.actions[0]?.type === 'problem' && result.actions[0].problem.code, 'IncorrectDataFormatForValue');
});

test('ResetSeqNumFlag on a Logon requires MsgSeqNum 1', () => {
  const result = step(initialState(acceptor, T0), acceptor, received('Logon', 3, { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true }), T0);
  assert.deepEqual(types(result), ['problem', 'send Logout', 'disconnect']);
  assert.equal(result.actions[0]?.type === 'problem' && result.actions[0].problem.code, 'ValueIsIncorrect');
  assert.equal(result.actions[0]?.type === 'problem' && result.actions[0].problem.text, 'A Logon with ResetSeqNumFlag=Y must have MsgSeqNum 1, not 3');
});

test('an initiator notices when the Logon reply changes the heartbeat', () => {
  const sent = step(initialState(initiator, T0), initiator, { type: 'start' }, T0).state;
  const result = step(sent, initiator, received('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 20 }), T0);
  assert.deepEqual(types(result), ['problem', 'active', 'deliver']);
  assert.equal(result.actions[0]?.type === 'problem' && result.actions[0].problem.code, 'ValueIsIncorrect');
  assert.equal(result.actions[0]?.type === 'problem' && result.actions[0].problem.text, 'Logon reply has HeartBtInt 20; keeping 30');
  assert.equal(result.actions[0]?.type === 'problem' && result.actions[0].problem.action, 'Ignored');
  assert.equal(result.state.phase, 'active');
  assert.equal(result.state.heartbeat, 30);
});

test('manual mode ignores an out-of-range MsgSeqNum for counting purposes', () => {
  const manual = testConfig({ manual: true, role: 'initiator' });
  const start = initialState(manual, T0);
  const huge = Object.freeze({ MsgType: 'Heartbeat', MsgSeqNum: 1e300, BeginString: 'FIX.4.4', SenderCompID: 'THEM', TargetCompID: 'ME', SendingTime: new Date(T0) });
  const result = step(start, manual, { type: 'received', message: huge, problems: [] }, T0);
  assert.deepEqual(types(result), ['deliver']);
  assert.equal(result.state.expected, start.expected);
});

test('a resend still incomplete after three requests ends the session', () => {
  const stalled = loggedOn(acceptor, { recovering: 5, resendRequestedAt: T0, resendAttempts: 3 });
  const result = step(stalled, acceptor, { type: 'tick' }, T0 + 30_000);
  assert.deepEqual(types(result), ['problem', 'send Logout', 'disconnect']);
  const problem = result.actions[0]?.type === 'problem' ? result.actions[0].problem : undefined;
  assert.deepEqual({ code: problem?.code, action: problem?.action }, { code: 'SeqNumGap', action: 'LoggedOut' });
  assert.equal(sends(result.actions)[0]?.fields.Text, 'Resend from 2 still incomplete after 3 requests');
  assert.equal(result.state.phase, 'closed');
});

test('three requests in all: the first, two re-requests, then Logout', () => {
  let state = step(loggedOn(), acceptor, received('NewOrderSingle', 5, { ClOrdID: 'o1', Side: 'Buy', OrdType: 'Market' }), T0).state;
  assert.equal(state.resendAttempts, 1);
  const kinds: string[][] = [];
  for (const at of [30_000, 60_000, 90_000]) {
    const result = step(state, acceptor, { type: 'tick' }, T0 + at);
    kinds.push(sends(result.actions).map(a => a.msgType).filter(t => t === 'ResendRequest' || t === 'Logout'));
    state = { ...result.state, lastReceived: T0 + at, testRequest: undefined };
  }
  assert.deepEqual(kinds, [['ResendRequest'], ['ResendRequest'], ['Logout']]);
});

test('with heartbeat 0, a stalled resend is requested again after logonTimeout', () => {
  const stalled = loggedOn(acceptor, { heartbeat: 0, recovering: 5, resendRequestedAt: T0, resendAttempts: 1 });
  assert.deepEqual(types(step(stalled, acceptor, { type: 'tick' }, T0 + 9_999)), []);
  const again = step(stalled, acceptor, { type: 'tick' }, T0 + 10_000);
  assert.deepEqual(types(again), ['problem', 'send ResendRequest']);
  assert.equal(again.state.resendAttempts, 2);
});

test('a Logon with a rejectable decode problem is logged out', () => {
  const result = step(initialState(acceptor, T0), acceptor, received('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30, 150: '0' }), T0);
  assert.deepEqual(types(result), ['problem', 'send Logout', 'disconnect']);
  const problem = result.actions[0]?.type === 'problem' ? result.actions[0].problem : undefined;
  assert.deepEqual(problem, { code: 'TagNotDefinedForThisMessageType', text: 'ExecType (150) is not defined for this message type', action: 'LoggedOut', refSeqNum: 1 });
  assert.equal(sends(result.actions)[0]?.fields.Text, 'ExecType (150) is not defined for this message type');
  assert.equal(result.state.phase, 'closed');
});

test('a Logon reply with a missing or empty CompID is logged out, even when the caller reports no problems', () => {
  const sent = step(initialState(initiator, T0), initiator, { type: 'start' }, T0).state;
  const logon = { EncryptMethod: 'None', HeartBtInt: 30 };
  for (const [name, fields, code, text] of [
    ['SenderCompID', { SenderCompID: undefined }, 'RequiredTagMissing', 'SenderCompID (49) is required'],
    ['TargetCompID', { TargetCompID: '' }, 'TagSpecifiedWithoutAValue', 'TargetCompID (56) has no value'],
  ] as const) {
    const { message } = fromThem('Logon', 1, logon);
    const result = step(sent, initiator, { type: 'received', message: Object.freeze({ ...message, ...fields }), problems: [] }, T0);
    assert.deepEqual(types(result), ['problem', 'send Logout', 'disconnect'], name);
    const problem = result.actions[0]?.type === 'problem' ? result.actions[0].problem : undefined;
    assert.deepEqual({ code: problem?.code, text: problem?.text }, { code, text }, name);
    assert.equal(sends(result.actions)[0]?.fields.Text, text, name);
    assert.equal(result.state.phase, 'closed', name);
  }
});

test('a Logon with an unknown EncryptMethod code is logged out', () => {
  const result = step(initialState(acceptor, T0), acceptor, received('Logon', 1, { 98: '7', HeartBtInt: 30 }), T0);
  assert.deepEqual(types(result), ['problem', 'send Logout', 'disconnect']);
  assert.equal(result.actions[0]?.type === 'problem' && result.actions[0].problem.code, 'ValueIsIncorrect');
});

test('a Logon asking for encryption is logged out', () => {
  const result = step(initialState(acceptor, T0), acceptor, received('Logon', 1, { EncryptMethod: 'DES', HeartBtInt: 30 }), T0);
  assert.deepEqual(types(result), ['problem', 'send Logout', 'disconnect']);
  const problem = result.actions[0]?.type === 'problem' ? result.actions[0].problem : undefined;
  assert.deepEqual({ code: problem?.code, text: problem?.text }, { code: 'ValueIsIncorrect', text: 'EncryptMethod DES is not supported' });
  assert.equal(result.state.phase, 'closed');
});

test('a second logout while logging out is ignored', () => {
  const out = step(loggedOn(), acceptor, { type: 'logout', text: 'done' }, T0).state;
  const again = step(out, acceptor, { type: 'logout', text: 'again' }, T0 + 1_000);
  assert.deepEqual(again.actions, []);
  assert.deepEqual(again.state, out);
});

test('an initiator that has not sent its Logon treats a Logon as NotLoggedOn', () => {
  const result = step(initialState(initiator, T0), initiator, received('Logon', 1, { EncryptMethod: 'None', HeartBtInt: 30 }), T0);
  assert.deepEqual(types(result), ['problem', 'disconnect']);
  assert.equal(result.actions[0]?.type === 'problem' && result.actions[0].problem.code, 'NotLoggedOn');
  assert.equal(result.state.phase, 'closed');
});
