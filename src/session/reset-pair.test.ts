// Mid-session sequence resets between an engine and a counterparty, through the real wire layer:
// another engine, or a stand-in that answers every reset Logon, or one that never replies to one.
// However the two sides' messages cross, the reset Logons that go each way are few, and the exchange ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictionaryFor } from '../dictionary/index.ts';
import { buildFrame, parseFrame } from '../wire/frame.ts';
import { fromMessage, inspectMessage, type MessageObject } from '../wire/message.ts';
import { initialState, step } from './engine.ts';
import { resendAll, T0 } from './fixtures.ts';
import { engineConfig, type Action, type EngineEvent, type EngineState } from './types.ts';

const dict = dictionaryFor('FIX.4.4');
const RESET = { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true } as const;
const ORDER = { Side: 'Buy', OrdType: 'Market' } as const;
type Name = 'A' | 'B';
const other = (name: Name): Name => (name === 'A' ? 'B' : 'A');

/** A message from `from` to the other side, as bytes; every header field can be given. */
function frame(from: Name, msgType: string, seq: number, fields: Record<string, unknown> = {}): Uint8Array {
  const input = { SenderCompID: from, TargetCompID: other(from), MsgSeqNum: seq, SendingTime: new Date(T0), ...fields };
  const encoded = fromMessage(msgType, input, dict, { version: 'FIX.4.4', now: () => new Date(T0) });
  return buildFrame(encoded.fields, encoded.framing);
}

/** One end of the wire. */
interface End {
  readonly name: Name;
  readonly inbox: Uint8Array[];
  /** Logons with ResetSeqNumFlag=Y this end has sent. */
  resetLogons: number;
  peer: End;
  receive(bytes: Uint8Array): void;
  /** Start a reset. False when this end refuses to (an engine whose last reset still awaits its reply). */
  reset(): boolean;
  /** Send a message of its own: an order, numbered next. */
  say(clOrdID: string): void;
  seqNums(): { next: number; expected: number };
  ended(): boolean;
}

/** An engine end: the session engine itself. */
interface EngineEnd extends End {
  state: EngineState;
  /** Sequence resets carried out (each begins a store epoch). */
  resets: number;
  /** Resets this end started. */
  asked: number;
  /** Logons with ResetSeqNumFlag=Y this end has been given. */
  resetLogonsReceived: number;
  readonly delivered: MessageObject[];
  /** The once-a-second timer, at this time. */
  tick(at: number): void;
}

function engineEnd(name: Name, seqNums: { next: number; expected: number }, overrides: Partial<EngineState> = {}): EngineEnd {
  const config = engineConfig({ version: 'FIX.4.4', sender: name, target: other(name), role: name === 'A' ? 'initiator' : 'acceptor' });
  const sent = new Map<number, MessageObject>();
  const carryOut = (actions: readonly Action[]): void => {
    for (const action of actions) {
      if (action.type === 'reset') {
        end.resets++;
        sent.clear();
      } else if (action.type === 'send') {
        const encoded = fromMessage(action.msgType, action.fields, dict, { version: 'FIX.4.4', now: () => new Date(T0) });
        const bytes = buildFrame(encoded.fields, encoded.framing);
        const message = inspectMessage(parseFrame(bytes).fields, dict).message;
        if (message.MsgType === 'Logon' && message.ResetSeqNumFlag === true) end.resetLogons++;
        if (typeof message.MsgSeqNum === 'number' && message.PossDupFlag !== true) sent.set(message.MsgSeqNum, message);
        end.peer.inbox.push(bytes);
      } else if (action.type === 'resend') {
        const result = resendAll(end.state, config, seq => sent.get(seq), action.from, action.to, T0);
        end.state = result.state;
        carryOut(result.actions);
      } else if (action.type === 'deliver') {
        end.delivered.push(action.message);
      }
    }
  };
  const run = (event: EngineEvent, at: number = T0): void => {
    const result = step(end.state, config, event, at);
    end.state = result.state;
    carryOut(result.actions);
  };
  const end: EngineEnd = {
    name, inbox: [], resetLogons: 0, resets: 0, asked: 0, resetLogonsReceived: 0, delivered: [],
    peer: undefined as unknown as End,
    state: { ...initialState(config, T0), phase: 'active', ...seqNums, ...overrides },
    receive(bytes) {
      const parsed = parseFrame(bytes, { dataTags: dict.dataTags });
      if (parsed.errors.length > 0) return run({ type: 'garbled', error: parsed.errors.join('; ') });
      const inspected = inspectMessage(parsed.fields, dict);
      if (inspected.message.MsgType === 'Logon' && inspected.message.ResetSeqNumFlag === true) end.resetLogonsReceived++;
      run({ type: 'received', ...inspected });
    },
    reset() {
      try {
        run({ type: 'send', msgType: 'Logon', fields: RESET });
        end.asked++;
        return true;
      } catch (error) {
        assert.equal((error as Error).name, 'FIXStateError');
        return false;
      }
    },
    say(clOrdID) {
      if (end.state.phase === 'active') run({ type: 'send', msgType: 'NewOrderSingle', fields: { ...ORDER, ClOrdID: clOrdID } });
    },
    seqNums: () => ({ next: end.state.next, expected: end.state.expected }),
    ended: () => end.state.phase === 'closed',
    tick: at => run({ type: 'tick' }, at),
  };
  return end;
}

/**
 * A stand-in for another engine. On a reset Logon it starts both its sequences again; `answers`
 * sends one back every time, whatever came before, and `silent` never does (its next message is
 * simply MsgSeqNum 1). It checks nothing and sends nothing else on its own.
 */
function standIn(kind: 'answers' | 'silent', name: Name, seqNums: { next: number; expected: number }): End {
  let { next, expected } = seqNums;
  const send = (msgType: string, fields: Record<string, unknown> = {}): void => {
    end.peer.inbox.push(frame(name, msgType, next++, fields));
  };
  const end: End = {
    name, inbox: [], resetLogons: 0,
    peer: undefined as unknown as End,
    receive(bytes) {
      const tags = new Map(parseFrame(bytes).fields.map(field => [field.tag, field.value] as const));
      if (tags.get(35) === 'A' && tags.get(141) === 'Y') {
        next = 1;
        expected = 2;
        if (kind === 'answers') {
          end.resetLogons++;
          send('Logon', RESET);
        }
      } else {
        expected = Number(tags.get(34)) + 1;
      }
    },
    reset() {
      next = 1;
      expected = 1;
      end.resetLogons++;
      send('Logon', RESET);
      return true;
    },
    say(clOrdID) { send('NewOrderSingle', { ...ORDER, ClOrdID: clOrdID }); },
    seqNums: () => ({ next, expected }),
    ended: () => false,
  };
  return end;
}

function link(a: End, b: End): void {
  a.peer = b;
  b.peer = a;
}

/** Most messages a run may deliver before it is taken for an exchange that does not end. */
const DELIVERY_LIMIT = 500;

/** Deliver what is queued, a message each way in turn, until nothing is left. False when it did not end. */
function pump(a: End, b: End): boolean {
  for (let delivered = 0; a.inbox.length > 0 || b.inbox.length > 0; ) {
    for (const end of [b, a]) {
      const bytes = end.inbox.shift();
      if (!bytes) continue;
      if (++delivered > DELIVERY_LIMIT) return false;
      if (!end.ended()) end.receive(bytes);
    }
  }
  return true;
}

type Counterparty = 'engine' | 'answers' | 'silent';
const counterparty = (kind: Counterparty, seqNums: { next: number; expected: number }): End =>
  (kind === 'engine' ? engineEnd('B', seqNums) : standIn(kind, 'B', seqNums));

/** A, logged on with a resend from 1 asked for (the counterparty's Logon came as MsgSeqNum 5), and that counterparty. */
function withResendOutstanding(kind: Counterparty): { a: EngineEnd; b: End } {
  const a = engineEnd('A', { next: 3, expected: 1 }, { recovering: 5, resendRequestedAt: T0, resendAttempts: 1 });
  const b = counterparty(kind, { next: 6, expected: 3 });
  link(a, b);
  return { a, b };
}

for (const kind of ['engine', 'answers'] as const) {
  const who = kind === 'engine' ? 'another engine' : 'a counterparty that answers every reset Logon';

  test(`against ${who}: a gap fill of the old sequence from 1, not marked as resent, arrives after our reset: one reset Logon each way`, () => {
    const { a, b } = withResendOutstanding(kind);
    a.inbox.push(frame('B', 'SequenceReset', 1, { GapFillFlag: true, NewSeqNo: 6 }));
    assert.equal(a.reset(), true);
    assert.equal(pump(a, b), true, 'the exchange ends');
    assert.deepEqual([a.resetLogons, b.resetLogons], [1, 1]);
    assert.deepEqual([a.seqNums(), b.seqNums()], [{ next: 2, expected: 2 }, { next: 2, expected: 2 }]);
    assert.equal(a.resets, 1);
  });

  test(`against ${who}: an order of the old sequence numbered 1, not marked as resent, arrives after our reset: one reset Logon each way`, () => {
    const { a, b } = withResendOutstanding(kind);
    a.inbox.push(frame('B', 'NewOrderSingle', 1, { ...ORDER, ClOrdID: 'old' }));
    assert.equal(a.reset(), true);
    assert.equal(pump(a, b), true, 'the exchange ends');
    assert.deepEqual([a.resetLogons, b.resetLogons], [1, 1]);
    assert.deepEqual([a.seqNums(), b.seqNums()], [{ next: 2, expected: 2 }, { next: 2, expected: 2 }]);
    assert.equal(a.resets, 1);
  });

  test(`against ${who} whose old sequence stood at 1: its MsgSeqNum 1 arrives after our reset: one reset Logon each way`, () => {
    const a = engineEnd('A', { next: 9, expected: 1 });
    const b = counterparty(kind, { next: 1, expected: 9 });
    link(a, b);
    b.say('old');
    assert.equal(a.reset(), true);
    assert.equal(pump(a, b), true, 'the exchange ends');
    assert.deepEqual([a.resetLogons, b.resetLogons], [1, 1]);
    assert.deepEqual([a.seqNums(), b.seqNums()], [{ next: 2, expected: 2 }, { next: 2, expected: 2 }]);
    assert.equal(a.resets, 1);
  });

  test(`against ${who}: a message of ours sent between our reset and its late reply changes nothing: one reset Logon each way, and the message is taken once`, () => {
    const { a, b } = withResendOutstanding(kind);
    a.inbox.push(frame('B', 'SequenceReset', 1, { GapFillFlag: true, NewSeqNo: 6 }));
    assert.equal(a.reset(), true);
    // The old gap fill reaches us first, and ends the wait for a reply; then we send an order; then their reply comes.
    a.receive(a.inbox.shift()!);
    assert.equal(a.state.resetSent, false);
    a.say('between');
    assert.equal(pump(a, b), true, 'the exchange ends');
    assert.deepEqual([a.resetLogons, b.resetLogons], [1, 1]);
    assert.deepEqual([a.seqNums(), b.seqNums()], [{ next: 3, expected: 2 }, { next: 2, expected: 3 }]);
    assert.equal(a.resets, 1);
    if (kind === 'engine') assert.deepEqual((b as EngineEnd).delivered.flatMap(message => (message.MsgType === 'NewOrderSingle' ? [message.ClOrdID] : [])), ['between']);
  });
}

for (const kind of ['engine', 'answers'] as const) {
  test(`against ${kind === 'engine' ? 'another engine' : 'a counterparty that answers every reset Logon'}: orders both ways while the reply to our reset is on its way, after the wait for it ended early: still one reset Logon each way`, () => {
    const { a, b } = withResendOutstanding(kind);
    a.inbox.push(frame('B', 'SequenceReset', 1, { GapFillFlag: true, NewSeqNo: 6 }));
    assert.equal(a.reset(), true);
    a.receive(a.inbox.shift()!);
    assert.equal(a.state.resetSent, false);
    // B answers; before its reply reaches us, twenty orders go each way (B's are numbered on from its reply).
    b.receive(b.inbox.shift()!);
    assert.deepEqual([b.resetLogons, a.inbox.length], [1, 1]);
    for (let n = 1; n <= 20; n++) {
      a.say(`a${n}`);
      b.say(`b${n}`);
    }
    assert.equal(pump(a, b), true, 'the exchange ends');
    assert.deepEqual([a.resetLogons, b.resetLogons, a.resets], [1, 1, 1]);
    assert.deepEqual([a.seqNums(), b.seqNums()], [{ next: 22, expected: 22 }, { next: 22, expected: 22 }]);
    assert.equal(a.delivered.filter(message => message.MsgType === 'NewOrderSingle').length, 20);
  });
}

test('a reply that comes a heartbeat interval late, after the wait for it ended early and a Heartbeat went each way, is still taken: one reset Logon each way', () => {
  const a = engineEnd('A', { next: 3, expected: 1 }, { recovering: 5, resendRequestedAt: T0, resendAttempts: 1 });
  const b = engineEnd('B', { next: 6, expected: 3 });
  link(a, b);
  a.inbox.push(frame('B', 'SequenceReset', 1, { GapFillFlag: true, NewSeqNo: 6 }));
  assert.equal(a.reset(), true);
  a.receive(a.inbox.shift()!);
  assert.equal(a.state.resetSent, false);
  b.receive(b.inbox.shift()!);
  assert.deepEqual([b.resetLogons, a.inbox.length], [1, 1]);
  // B's reply is still on its way when each side's timer sends a Heartbeat.
  a.tick(T0 + 30_000);
  b.tick(T0 + 30_000);
  assert.equal(pump(a, b), true, 'the exchange ends');
  assert.deepEqual([a.resetLogons, b.resetLogons, a.resets, b.resets], [1, 1, 1, 1]);
  assert.deepEqual([a.seqNums(), b.seqNums()], [{ next: 3, expected: 3 }, { next: 3, expected: 3 }]);
});

test('each side resets in turn with nothing else sent between: each request is answered once', () => {
  const a = engineEnd('A', { next: 5, expected: 5 });
  const b = engineEnd('B', { next: 5, expected: 5 });
  link(a, b);
  assert.equal(a.reset(), true);
  assert.equal(pump(a, b), true);
  assert.equal(b.reset(), true);
  assert.equal(pump(a, b), true);
  assert.deepEqual([a.resetLogons, b.resetLogons, a.resets, b.resets], [2, 2, 2, 2]);
  assert.deepEqual([a.seqNums(), b.seqNums()], [{ next: 2, expected: 2 }, { next: 2, expected: 2 }]);
  assert.deepEqual([a.state.resetSent, b.state.resetSent], [false, false]);
});

test('the same side asks twice with nothing else sent between: both requests are answered, and either side can reset again afterwards', () => {
  const a = engineEnd('A', { next: 5, expected: 5 });
  const b = engineEnd('B', { next: 5, expected: 5 });
  link(a, b);
  for (const round of [1, 2]) {
    assert.equal(a.reset(), true);
    assert.equal(pump(a, b), true);
    assert.deepEqual([a.resetLogons, b.resetLogons, a.resets, b.resets], [round, round, round, round]);
    assert.deepEqual([a.seqNums(), b.seqNums()], [{ next: 2, expected: 2 }, { next: 2, expected: 2 }]);
    assert.deepEqual([a.state.resetSent, b.state.resetSent], [false, false]);
  }
  // In step: an order each way is taken as MsgSeqNum 2.
  a.say('a1');
  b.say('b1');
  assert.equal(pump(a, b), true);
  assert.deepEqual([a.seqNums(), b.seqNums()], [{ next: 3, expected: 3 }, { next: 3, expected: 3 }]);
  assert.deepEqual([a.delivered.at(-1)?.ClOrdID, b.delivered.at(-1)?.ClOrdID], ['b1', 'a1']);
  // And each side can reset again.
  assert.equal(b.reset(), true);
  assert.equal(pump(a, b), true);
  assert.equal(a.reset(), true);
  assert.equal(pump(a, b), true);
  assert.deepEqual([a.resetLogons, b.resetLogons], [4, 4]);
  assert.deepEqual([a.seqNums(), b.seqNums()], [{ next: 2, expected: 2 }, { next: 2, expected: 2 }]);
});

test('a reset of ours whose reply never arrived: their own request, later, is taken as that reply and gets no answer; their resend request brings our messages again, and their next reset is refused', () => {
  const a = engineEnd('A', { next: 5, expected: 5 });
  const b = engineEnd('B', { next: 5, expected: 5 });
  link(a, b);
  assert.equal(a.reset(), true);
  b.receive(b.inbox.shift()!);
  assert.deepEqual([b.resetLogons, a.inbox.length], [1, 1]);
  a.inbox.length = 0;                                   // B's reply is lost on the way
  // B's next message is ahead of the 1 A still expects: A asks for a resend, takes it, and the two are in step.
  b.say('b1');
  a.say('a1');
  a.say('a2');
  assert.equal(pump(a, b), true);
  assert.deepEqual([a.seqNums(), b.seqNums()], [{ next: 5, expected: 3 }, { next: 3, expected: 5 }]);
  assert.deepEqual([a.state.resetSent, a.state.resetRepliesOwed], [true, 1]);
  assert.equal(a.reset(), false);

  // B asks for a reset of its own. A is still owed a reset Logon, so this one is that reply: no answer, A's numbers stay.
  assert.equal(b.reset(), true);
  assert.equal(pump(a, b), true);
  assert.deepEqual([a.resetLogons, b.resetLogons, a.resets, b.resets], [1, 2, 1, 2]);
  assert.deepEqual([a.seqNums(), b.seqNums()], [{ next: 5, expected: 2 }, { next: 2, expected: 1 }]);
  assert.deepEqual([a.state.resetSent, a.state.resetRepliesOwed, b.state.resetSent, b.state.resetRepliesOwed], [false, 0, true, 1]);

  // A's next message is MsgSeqNum 5 where B expects 1: B asks for a resend from 1, and A's orders of its current sequence come again, marked as resent.
  a.say('a3');
  assert.equal(pump(a, b), true);
  const orders = (end: EngineEnd) => end.delivered.flatMap(message => (message.MsgType === 'NewOrderSingle' ? [`${String(message.ClOrdID)}${message.PossDupFlag === true ? ' (resent)' : ''}`] : []));
  assert.deepEqual(orders(b), ['a1', 'a2', 'a1 (resent)', 'a2 (resent)', 'a3 (resent)']);
  assert.deepEqual([a.seqNums(), b.seqNums()], [{ next: 6, expected: 3 }, { next: 3, expected: 6 }]);
  assert.deepEqual([a.ended(), b.ended()], [false, false]);
  // B had no reset Logon in reply, so its next reset is refused; A's goes out, and B takes it as the reply it is owed.
  assert.equal(b.reset(), false);
  assert.equal(a.reset(), true);
  assert.equal(pump(a, b), true);
  assert.deepEqual([a.resetLogons, b.resetLogons], [2, 2]);
  assert.deepEqual([b.state.resetSent, b.state.resetRepliesOwed, a.state.resetRepliesOwed], [false, 0, 1]);
});

test('a counterparty that sends reset Logons nobody asked for is answered each time: one that answers the reply to its own request goes on for as long as it does', () => {
  const a = engineEnd('A', { next: 5, expected: 5 });
  const b = standIn('answers', 'B', { next: 5, expected: 5 });
  link(a, b);
  assert.equal(b.reset(), true);
  // Five messages each way, and no more: this exchange does not end by itself.
  for (let round = 1; round <= 5; round++) {
    a.receive(a.inbox.shift()!);
    b.receive(b.inbox.shift()!);
  }
  assert.deepEqual([a.resetLogonsReceived, a.resetLogons, a.resets, b.resetLogons], [5, 5, 5, 6]);
  assert.deepEqual([a.inbox.length, b.inbox.length], [1, 0]);
});

// ─── Random runs ────────────────────────────────────────────────────────────

/** A small seeded generator (mulberry32): the same seed gives the same run. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Outcome {
  readonly kind: Counterparty;
  readonly steps: readonly string[];
  /** Resets either side started. */
  readonly started: number;
  /** Messages of the old sequence that arrived late. */
  readonly late: number;
  readonly ended: boolean;
  readonly a: EngineEnd;
  readonly b: End;
}

/**
 * One run: A is an engine; B is another engine, or a stand-in that answers every reset Logon it
 * is sent, or one that never replies. Around one or two resets, started by either side at random
 * points (the answering stand-in starts none: it would then answer the reply to its own request,
 * and be answered, for ever), messages of the old sequence arrive late: numbered 1 or what the
 * receiver expects just then, marked as resent or not; gap fills, orders and Heartbeats. Either
 * side may also send an order of its own, and messages are delivered a few at a time, so
 * everything crosses everything.
 */
function randomRun(seed: number): Outcome {
  const random = generator(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const kind = pick(['engine', 'answers', 'silent'] as const);
  const numbers = pick([{ a: 5, b: 7 }, { a: 2, b: 2 }, { a: 9, b: 1 }]);
  const recovering = random() < 0.4;
  const a = engineEnd('A', { next: numbers.a, expected: recovering ? 1 : numbers.b },
    recovering ? { recovering: numbers.b, resendRequestedAt: T0, resendAttempts: 1 } : {});
  const b = counterparty(kind, { next: numbers.b, expected: numbers.a });
  link(a, b);
  const steps: string[] = [`B is ${kind}; A ${JSON.stringify(a.seqNums())}${recovering ? ' with a resend from 1 outstanding' : ''}; B ${JSON.stringify(b.seqNums())}`];
  let started = 0;
  let late = 0;
  let orders = 0;
  const resets = 1 + Math.floor(random() * 2);
  const plan: string[] = [...Array.from({ length: resets }, () => 'reset'), ...Array.from({ length: Math.floor(random() * 4) }, () => 'late'),
    ...Array.from({ length: Math.floor(random() * 3) }, () => 'order'), ...Array.from({ length: 2 + Math.floor(random() * 4) }, () => 'deliver')];
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [plan[i], plan[j]] = [plan[j]!, plan[i]!];
  }
  const deliver = (count: number): void => {
    for (let n = 0; n < count; n++) {
      const end = pick([a, b]);
      const bytes = end.inbox.shift();
      if (bytes && !end.ended()) end.receive(bytes);
    }
  };
  for (const what of plan) {
    if (what === 'reset') {
      const end = kind === 'answers' ? a : pick([a, b]);
      const sent = !end.ended() && end.reset();
      if (sent) started++;
      steps.push(`${end.name} resets${sent ? '' : ' (refused)'}`);
    } else if (what === 'order') {
      const end = pick([a, b]);
      end.say(`new-${++orders}`);
      steps.push(`${end.name} sends an order`);
    } else if (what === 'deliver') {
      const count = 1 + Math.floor(random() * 3);
      deliver(count);
      steps.push(`deliver up to ${count}`);
    } else {
      // To an engine: A always is one, B only sometimes.
      const to = kind === 'engine' ? pick([a, b]) : a;
      const seq = pick([1, to.seqNums().expected]);
      const marked = random() < 0.5 ? { PossDupFlag: true, OrigSendingTime: new Date(T0) } : {};
      const [msgType, fields] = pick([
        ['SequenceReset', { GapFillFlag: true, NewSeqNo: seq + 1 + Math.floor(random() * 5) }],
        ['NewOrderSingle', { ...ORDER, ClOrdID: 'old' }],
        ['Heartbeat', {}],
      ] as const);
      to.inbox.push(frame(other(to.name), msgType, seq, { ...fields, ...marked }));
      late++;
      steps.push(`late to ${to.name}: ${msgType} ${seq}${'PossDupFlag' in marked ? ' marked as resent' : ''}`);
    }
  }
  const ended = pump(a, b);
  return { kind, steps, started, late, ended, a, b };
}

test('random runs of resets with late messages of the old sequence: every run ends, a reset Logon is answered only when none of ours is owed a reply, and no engine sends more than one for each reset started', () => {
  const FIRST_SEED = 20261002;
  const RUNS = 400;
  for (let seed = FIRST_SEED; seed < FIRST_SEED + RUNS; seed++) {
    const { kind, steps, started, late, ended, a, b } = randomRun(seed);
    const told = `seed ${seed}:\n  ${steps.join('\n  ')}\n  reset Logons sent: A ${a.resetLogons}, B ${b.resetLogons}`;
    assert.equal(ended, true, `the exchange did not end within ${DELIVERY_LIMIT} messages; ${told}`);
    const engines = [a, ...('resets' in b ? [b as EngineEnd] : [])];
    for (const engine of engines) {
      // The pairing: every reset Logon an engine is given either is the reply to a reset it started, or is
      // answered with one. So what it sent is what it was given, plus its own requests still owed a reply.
      assert.equal(engine.resetLogons, engine.resetLogonsReceived + engine.state.resetRepliesOwed, `${engine.name} did not pair its reset Logons; ${told}`);
      // No counterparty here sends a reset Logon nobody asked for, so an engine answers only requests: it
      // sends one reset Logon for each reset started, its request or its answer. At most two in a run.
      assert.ok(engine.resetLogons <= started && engine.resets <= started, `${engine.name} sent more reset Logons than the ${started} resets started; ${told}`);
    }
    // A stand-in sends its own requests (the silent one), or one answer to each reset Logon of ours.
    if (kind !== 'engine') assert.ok(b.resetLogons <= started, `B sent more reset Logons than the ${started} resets started; ${told}`);
    // Two engines that only crossed real messages end in step. (A late message is made up, not sent by the
    // other engine, and one that is taken leaves its receiver a number ahead.)
    if (kind === 'engine' && late === 0 && !a.ended() && !b.ended()) {
      assert.deepEqual([a.seqNums().next, b.seqNums().next], [b.seqNums().expected, a.seqNums().expected], `the two engines are not in step; ${told}`);
    }
  }
});
