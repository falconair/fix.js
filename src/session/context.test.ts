import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictionaryFor } from '../dictionary/index.ts';
import { buildFrame } from '../wire/frame.ts';
import { fromMessage, inspectMessage } from '../wire/message.ts';
import { fillHeader, initialState, LAST_REJECT_REASON, reject, REJECT_REASONS, type Context } from './context.ts';
import { APPL_VER_ID_WIRE, APPL_VER_IDS, FIXT11, VERSIONS } from '../version.ts';
import { T0, fromThem, fromThemIn, sends, testConfig } from './fixtures.ts';

const config = testConfig();

test('a new session starts at sequence 1, waiting for its Logon', () => {
  const state = initialState(config, T0);
  assert.equal(state.phase, 'connected');
  assert.equal(state.next, 1);
  assert.equal(state.expected, 1);
  assert.equal(state.heartbeat, 30);
  assert.equal(initialState(testConfig({ manual: true }), T0).phase, 'active');
  assert.deepEqual(initialState(config, T0, { next: 5, expected: 9 }).next, 5);
});

test('fillHeader fills what is left out and uses a sequence number', () => {
  const { state, fields } = fillHeader(initialState(config, T0), config, { TestReqID: 'x' }, T0 + 5);
  assert.deepEqual(fields, {
    TestReqID: 'x', BeginString: 'FIX.4.4', SenderCompID: 'ME', TargetCompID: 'THEM',
    SendingTime: new Date(T0 + 5), MsgSeqNum: 1,
  });
  assert.equal(state.next, 2);
  assert.equal(state.lastSent, T0 + 5);
});

test('fillHeader sends what is written; an explicit MsgSeqNum does not move the counter', () => {
  const start = initialState(config, T0);
  const written = fillHeader(start, config, { MsgSeqNum: 99, SenderCompID: 'SOMEONE', SendingTime: null }, T0);
  assert.equal(written.fields.MsgSeqNum, 99);
  assert.equal(written.fields.SenderCompID, 'SOMEONE');
  assert.equal(written.fields.SendingTime, null);
  assert.equal(written.state.next, 1);
  const raw = fillHeader(start, config, { 34: '7', 52: 'garbage' }, T0);
  assert.equal(raw.fields.MsgSeqNum, undefined);
  assert.equal(raw.fields.SendingTime, undefined);
  assert.equal(raw.state.next, 1);
});

test('reject refers to the message by number, reason code and raw MsgType', () => {
  const ctx: Context = { state: initialState(config, T0), config, now: T0, actions: [] };
  const { message } = fromThem('TestRequest', 4, { TestReqID: 'x' });
  reject(ctx, message, 4, 'ValueIsIncorrect', 'bad', 112);
  const [sent] = sends(ctx.actions);
  assert.equal(sent?.msgType, 'Reject');
  assert.deepEqual({ ...sent?.fields, SendingTime: undefined }, {
    RefSeqNum: 4, Text: 'bad', 373: '5', RefTagID: 112, 372: '1',
    BeginString: 'FIX.4.4', SenderCompID: 'ME', TargetCompID: 'THEM', SendingTime: undefined, MsgSeqNum: 1,
  });
});

test('on FIX 4.2 a Reject carries SessionRejectReason only for the reasons FIX 4.2 has (0 to 11)', () => {
  const fix42 = testConfig({ version: 'FIX.4.2' });
  const ctx: Context = { state: initialState(fix42, T0), config: fix42, now: T0, actions: [] };
  const { message } = fromThem('TestRequest', 4, { TestReqID: 'x' });
  reject(ctx, message, 4, 'TagAppearsMoreThanOnce', 'Tag 112 appears more than once', 112);
  reject(ctx, message, 4, 'InvalidMsgType', 'bad', 35);
  const [later, known] = sends(ctx.actions);
  assert.deepEqual({ reason: later?.fields[373], text: later?.fields.Text, tag: later?.fields.RefTagID }, { reason: undefined, text: 'Tag 112 appears more than once', tag: 112 });
  assert.equal(known?.fields[373], '11');

  const fix44: Context = { state: initialState(config, T0), config, now: T0, actions: [] };
  reject(fix44, message, 4, 'TagAppearsMoreThanOnce', 'Tag 112 appears more than once', 112);
  assert.equal(sends(fix44.actions)[0]?.fields[373], '13');
});

test("the highest SessionRejectReason a Reject may carry in each version is the highest that version's dictionary defines", () => {
  // Every version the library speaks has an entry, and no other does.
  assert.deepEqual(Object.keys(LAST_REJECT_REASON).sort(), [...VERSIONS].sort());
  for (const [version, last] of Object.entries(LAST_REJECT_REASON)) {
    const dict = dictionaryFor(version);
    assert.equal(dict.version, version);
    // 99 is Other, which stands apart from the numbered reasons.
    const defined = (dict.fieldByTag.get(373)?.codes ?? []).map(code => Number(code.value)).filter(value => value < 99);
    assert.equal(Math.max(...defined), last, version);
  }
  // Every reason fix.js sends is one FIX 4.4 has, but for the one FIXT.1.1 adds.
  const { InvalidUnsupportedAppVersion, ...others } = REJECT_REASONS;
  assert.equal(InvalidUnsupportedAppVersion, '18');
  assert.ok(Object.values(others).every(reason => Number(reason) <= LAST_REJECT_REASON['FIX.4.4']));
});

test('reject sends routing fields back the other way round, leaving out any that came empty', () => {
  const ctx: Context = { state: initialState(config, T0), config, now: T0, actions: [] };
  const { message } = fromThem('TestRequest', 4, {
    TestReqID: 'x', OnBehalfOfCompID: 'A1', OnBehalfOfSubID: 'A2', OnBehalfOfLocationID: 'A3',
    DeliverToCompID: 'B1', DeliverToSubID: 'B2', DeliverToLocationID: 'B3',
  });
  reject(ctx, message, 4, 'ValueIsIncorrect', 'bad', 112);
  const fields = sends(ctx.actions)[0]?.fields ?? {};
  assert.deepEqual(routingFields(fields), { 128: 'A1', 129: 'A2', 145: 'A3', 115: 'B1', 116: 'B2', 144: 'B3' });

  const some: Context = { state: initialState(config, T0), config, now: T0, actions: [] };
  const partial = fromThem('TestRequest', 4, { TestReqID: 'x', OnBehalfOfCompID: 'DESK', OnBehalfOfSubID: 'CS', OnBehalfOfLocationID: '', DeliverToCompID: 'HUB' });
  reject(some, partial.message, 4, 'ValueIsIncorrect', 'bad', 112);
  assert.deepEqual(routingFields(sends(some.actions)[0]?.fields ?? {}), { 128: 'DESK', 129: 'CS', 115: 'HUB' });
});

test('reject sends a routing field back byte for byte, whatever bytes it came in', () => {
  const frame = '8=FIX.4.4|9=0|35=1|49=THEM|56=ME|115=CAF\xe9|116=\xef\xbb\xbfDESK|34=4|52=20260929-12:00:00.000|112=x|10=000';
  const fields = frame.split('|').map(pair => ({ tag: Number(pair.slice(0, pair.indexOf('='))), value: pair.slice(pair.indexOf('=') + 1) }));
  const { message } = inspectMessage(fields, dictionaryFor('FIX.4.4'));
  const ctx: Context = { state: initialState(config, T0), config, now: T0, actions: [] };
  reject(ctx, message, 4, 'ValueIsIncorrect', 'bad', 112);
  const sent = sends(ctx.actions)[0]!;
  const encoded = fromMessage('Reject', sent.fields, dictionaryFor('FIX.4.4'), { version: 'FIX.4.4', now: () => new Date(T0) });
  const wire = Buffer.from(buildFrame(encoded.fields, encoded.framing)).toString('latin1');
  assert.ok(wire.includes('\x01128=CAF\xe9\x01'), 'DeliverToCompID is the bytes that came');
  assert.ok(wire.includes('\x01129=\xef\xbb\xbfDESK\x01'), 'a byte order mark is kept');
});

test('reject turns routing fields round on a message that has no raw values', () => {
  const ctx: Context = { state: initialState(config, T0), config, now: T0, actions: [] };
  const message = { MsgType: 'TestRequest', OnBehalfOfCompID: 'DESK', OnBehalfOfLocationID: '', DeliverToSubID: 'CS' };
  reject(ctx, message, 4, 'ValueIsIncorrect', 'bad', 112);
  const fields = sends(ctx.actions)[0]?.fields ?? {};
  assert.deepEqual({ DeliverToCompID: fields.DeliverToCompID, OnBehalfOfSubID: fields.OnBehalfOfSubID, DeliverToLocationID: fields.DeliverToLocationID }, { DeliverToCompID: 'DESK', OnBehalfOfSubID: 'CS', DeliverToLocationID: undefined });
});

/** The routing fields of a sent Reject, written by tag. */
function routingFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => ['115', '116', '144', '128', '129', '145'].includes(key)));
}

test('fixtures build real decoded messages from the counterparty', () => {
  const { message, problems } = fromThem('Heartbeat', 3);
  assert.equal(message.MsgType, 'Heartbeat');
  assert.equal(message.SenderCompID, 'THEM');
  assert.equal(message.MsgSeqNum, 3);
  assert.deepEqual(message.SendingTime, new Date(T0));
  assert.deepEqual(problems, []);
});

test('a reason a version does not define is left out of its Reject, and an inherited key is not a version', () => {
  const ctx = (version: string): Context => {
    const config = testConfig({ version: version as 'FIX.4.2' });
    return { state: initialState(config, T0), config, now: T0, actions: [] };
  };
  const { message } = fromThem('TestRequest', 4, { TestReqID: 'x' });
  const reasonIn = (version: string) => {
    const c = ctx(version);
    reject(c, message, 4, 'InvalidUnsupportedAppVersion', 'bad', 1128);
    return sends(c.actions)[0]?.fields[373];
  };
  assert.equal(reasonIn('FIX.4.2'), undefined);
  assert.equal(reasonIn('FIX.4.4'), undefined);
  assert.equal(reasonIn('FIXT.1.1'), '18');
  assert.equal(reasonIn('toString'), '18');
});

test('a message from THEM can be made only in a version the library has a dictionary for', () => {
  assert.equal(typeof fromThemIn('FIXT.1.1'), 'function');
  assert.throws(() => fromThemIn('FIX.5.0'), /FIX\.5\.0/);
});

test("the wire values of the application versions are the ones FIXT.1.1's dictionary gives DefaultApplVerID and ApplVerID", () => {
  const dict = dictionaryFor(FIXT11);
  for (const tag of [1137, 1128]) {
    const codes = new Map((dict.fieldByTag.get(tag)?.codes ?? []).map(code => [code.name, code.value]));
    for (const name of APPL_VER_IDS) assert.equal(APPL_VER_ID_WIRE[name], codes.get(name), `${tag} ${name}`);
  }
});
