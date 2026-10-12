// Two engines, a client and an exchange, talking through the real wire layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictionaryFor } from '../dictionary/index.ts';
import { buildFrame, parseFrame } from '../wire/frame.ts';
import { fromMessage, inspectMessage, type MessageObject } from '../wire/message.ts';
import { initialState, step } from './engine.ts';
import { resendAll, T0 } from './fixtures.ts';
import { engineConfig, type Action, type EngineConfig, type EngineEvent, type EngineState, type Role } from './types.ts';

const dict = dictionaryFor('FIX.4.4');

interface Side {
  readonly config: EngineConfig;
  state: EngineState;
  /** What this side sent, by MsgSeqNum (originals only), for answering resends. */
  readonly sent: Map<number, MessageObject>;
  readonly delivered: MessageObject[];
  readonly problems: string[];
  readonly inbox: Uint8Array[];
  closed: { by: string; text: string } | undefined;
  /** Lose outgoing messages that match. */
  drop: (message: MessageObject) => boolean;
}

function side(sender: string, target: string, role: Role): Side {
  const config = engineConfig({ version: 'FIX.4.4', sender, target, role });
  return { config, state: initialState(config, T0), sent: new Map(), delivered: [], problems: [], inbox: [], closed: undefined, drop: () => false };
}

function run(me: Side, peer: Side, event: EngineEvent, now: number): void {
  const result = step(me.state, me.config, event, now);
  me.state = result.state;
  carryOut(me, peer, result.actions, now);
}

function carryOut(me: Side, peer: Side, actions: readonly Action[], now: number): void {
  for (const action of actions) {
    switch (action.type) {
      case 'send': {
        const { fields, framing } = fromMessage(action.msgType, action.fields, dict, { version: 'FIX.4.4', now: () => new Date(now) });
        const bytes = buildFrame(fields, framing);
        const message = inspectMessage(parseFrame(bytes).fields, dict).message;
        const seq = message.MsgSeqNum;
        if (typeof seq === 'number' && message.PossDupFlag !== true) me.sent.set(seq, message);
        if (!me.drop(message)) peer.inbox.push(bytes);
        break;
      }
      case 'resend': {
        const result = resendAll(me.state, me.config, seq => me.sent.get(seq), action.from, action.to, now);
        me.state = result.state;
        carryOut(me, peer, result.actions, now);
        break;
      }
      case 'deliver': me.delivered.push(action.message); break;
      case 'problem': me.problems.push(action.problem.code); break;
      case 'disconnect': me.closed = { by: action.by, text: action.text }; break;
      case 'active': break;
    }
  }
}

/** Deliver queued bytes both ways until nothing is left. */
function pump(a: Side, b: Side, now: number): void {
  for (let rounds = 0; rounds < 1000 && (a.inbox.length > 0 || b.inbox.length > 0); rounds++) {
    for (const [me, peer] of [[a, b], [b, a]] as const) {
      const bytes = me.inbox.shift();
      if (!bytes) continue;
      const frame = parseFrame(bytes, { dataTags: dict.dataTags });
      const event: EngineEvent = frame.errors.length > 0
        ? { type: 'garbled', error: frame.errors.join('; ') }
        : { type: 'received', ...inspectMessage(frame.fields, dict) };
      run(me, peer, event, now);
    }
  }
}

function loggedOn(): { client: Side; exchange: Side } {
  const client = side('CLIENT', 'EXCHANGE', 'initiator');
  const exchange = side('EXCHANGE', 'CLIENT', 'acceptor');
  run(client, exchange, { type: 'start' }, T0);
  pump(client, exchange, T0);
  return { client, exchange };
}

const order = (id: string): EngineEvent => ({ type: 'send', msgType: 'NewOrderSingle', fields: { ClOrdID: id, Side: 'Buy', OrdType: 'Market' } });
const orders = (s: Side) => s.delivered.filter(m => m.MsgType === 'NewOrderSingle').map(m => `${String(m.ClOrdID)}${m.PossDupFlag === true ? ' (resent)' : ''}`);

test('logon handshake', () => {
  const { client, exchange } = loggedOn();
  assert.deepEqual([client.state.phase, exchange.state.phase], ['active', 'active']);
  assert.deepEqual([client.state.next, client.state.expected, exchange.state.next, exchange.state.expected], [2, 2, 2, 2]);
  assert.equal(exchange.delivered[0]?.MsgType, 'Logon');
});

test('orders flow and are counted', () => {
  const { client, exchange } = loggedOn();
  run(client, exchange, order('o1'), T0);
  pump(client, exchange, T0);
  assert.deepEqual(orders(exchange), ['o1']);
  assert.equal(exchange.state.expected, 3);
});

test('a lost order is recovered by a resend', () => {
  const { client, exchange } = loggedOn();
  client.drop = m => m.ClOrdID === 'o1' && m.PossDupFlag !== true;
  run(client, exchange, order('o1'), T0);
  run(client, exchange, order('o2'), T0);
  pump(client, exchange, T0);
  assert.deepEqual(orders(exchange), ['o1 (resent)', 'o2 (resent)']);
  assert.ok(exchange.problems.includes('SeqNumGap'));
  assert.equal(exchange.state.expected, client.state.next);
  assert.equal(exchange.state.recovering, undefined);
});

test('lost session messages are covered by a gap fill', () => {
  const { client, exchange } = loggedOn();
  client.drop = m => m.MsgType === 'TestRequest';
  run(client, exchange, { type: 'send', msgType: 'TestRequest', fields: { TestReqID: 'lost' } }, T0);
  run(client, exchange, order('o3'), T0);
  pump(client, exchange, T0);
  assert.deepEqual(exchange.delivered.map(m => m.MsgType).slice(1), ['SequenceReset', 'NewOrderSingle']);
  assert.equal(exchange.state.expected, 4);
});

test('an idle session stays up on heartbeats', () => {
  const { client, exchange } = loggedOn();
  for (const now of [T0 + 30_000, T0 + 60_000, T0 + 90_000]) {
    run(client, exchange, { type: 'tick' }, now);
    run(exchange, client, { type: 'tick' }, now);
    pump(client, exchange, now);
  }
  assert.deepEqual([client.closed, exchange.closed], [undefined, undefined]);
  assert.ok(exchange.delivered.filter(m => m.MsgType === 'Heartbeat').length >= 3);
});

test('a peer that goes silent is disconnected', () => {
  const { client, exchange } = loggedOn();
  client.drop = () => true;
  for (const now of [T0 + 36_000, T0 + 66_000]) {
    run(exchange, client, { type: 'tick' }, now);
    pump(client, exchange, now);
  }
  assert.deepEqual(exchange.closed, { by: 'us', text: 'Heartbeat timeout' });
  assert.ok(exchange.problems.includes('HeartbeatTimeout'));
});

test('logout handshake', () => {
  const { client, exchange } = loggedOn();
  run(client, exchange, { type: 'logout', text: 'done for the day' }, T0);
  pump(client, exchange, T0);
  assert.deepEqual(client.closed, { by: 'us', text: 'Logout confirmed' });
  assert.deepEqual(exchange.closed, { by: 'them', text: 'done for the day' });
});

test('garbled bytes are recorded and ignored', () => {
  const { client, exchange } = loggedOn();
  exchange.inbox.push(Buffer.from('8=FIX.4.4\x019=5\x0135=0\x0110=000\x01', 'latin1'));
  pump(client, exchange, T0);
  assert.deepEqual(exchange.problems, ['Garbled']);
  assert.equal(exchange.state.phase, 'active');
  assert.equal(exchange.state.expected, 2);
});
