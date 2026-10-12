import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineDictionary } from '../dictionary/define.ts';
import { dictionaryFor } from '../dictionary/index.ts';
import { resolveDictionary } from '../dictionary/resolve.ts';
import { buildFrame, parseFrame } from '../wire/frame.ts';
import { fromMessage, inspectMessage, type MessageObject } from '../wire/message.ts';
import { entryFromJSON, entryToJSON } from './json.ts';
import type { ConnectionEntry, Entry } from './types.ts';

const at = new Date('2026-10-01T09:30:00.123Z');
const peer = { address: '203.0.113.24', port: 51234 };
const logon = { BeginString: 'FIX.4.4', SenderCompID: 'CLIENT', TargetCompID: 'EXCHANGE' };

/** A message as it arrives: encoded, then decoded, with its wire bytes. */
function received(msgType: string, fields: Record<string, unknown>, dict = dictionaryFor('FIX.4.4')): { message: MessageObject; bytes: Buffer } {
  const { fields: raw, framing } = fromMessage(msgType, { SenderCompID: 'CLIENT', TargetCompID: 'EXCHANGE', MsgSeqNum: 2, SendingTime: at, ...fields }, dict, { version: 'FIX.4.4' });
  const bytes = Buffer.from(buildFrame(raw, framing));
  return { message: inspectMessage(parseFrame(bytes).fields, dict).message, bytes };
}

/** Through JSON text and back, the way a log file or a browser would carry it. */
const roundTrip = (entry: Entry | ConnectionEntry, dictionary?: Parameters<typeof entryFromJSON>[1]) =>
  entryFromJSON(JSON.parse(JSON.stringify(entryToJSON(entry))), dictionary);

const report = received('ExecutionReport', {
  OrderID: 'O1', ExecID: 'E1', ExecType: 'Trade', OrdStatus: 'Filled', Side: 'Buy', Symbol: 'ACME',
  LeavesQty: 0, CumQty: 100, AvgPx: 10.5, TransactTime: at,
  ContraGrp: [{ ContraBroker: 'B1', ContraTradeTime: at }],
});

const entries: [string, Entry | ConnectionEntry][] = [
  ['a received message, with its bytes', { kind: 'message', direction: 'in', ...report, at }],
  ['a sent message a route dropped, without bytes', { kind: 'message', direction: 'out', at, message: report.message }],
  ['a problem', { kind: 'problem', direction: 'in', at, problem: { code: 'SeqNumGap', text: 'Expected 3, got 5', action: 'ResendRequested', refSeqNum: 5 } }],
  ['an error', { kind: 'error', at, text: 'handler bug', stack: 'Error: handler bug\n    at handler', during: { MsgType: 'NewOrderSingle', MsgSeqNum: 2, ClOrdID: 'o1' } }],
  ['an opened connection', { kind: 'connection', event: 'opened', connectionId: 'c1', peer, at }],
  ['bytes received before a session', { kind: 'connection', event: 'received', connectionId: 'c1', peer, at, bytes: Buffer.from('8=FIX.4.4\x019=5\x01') }],
  ['a rejected connection', { kind: 'connection', event: 'rejected', connectionId: 'c1', peer, at, problem: { code: 'LogonRefused', text: 'bad password', action: 'LoggedOut' }, logon }],
  ['a logged-on connection', { kind: 'connection', event: 'loggedOn', connectionId: 'c1', peer, at, logon, sessionKey: 'FIX.4.4:EXCHANGE:CLIENT' }],
  ['a closed connection', { kind: 'connection', event: 'closed', connectionId: 'c1', peer, at, sessionKey: 'FIX.4.4:EXCHANGE:CLIENT' }],
  ['an error on a connection', { kind: 'connection', event: 'error', connectionId: 'c1', peer, at, error: { text: 'db down', stack: 'Error: db down' } }],
  ['an error on the listening socket', { kind: 'connection', event: 'error', at, error: { text: 'EMFILE' } }],
];

// ─── Round trips ────────────────────────────────────────────────────────────

for (const [name, entry] of entries) {
  test(`${name} survives entryToJSON, JSON text and entryFromJSON`, () => {
    assert.deepEqual(roundTrip(entry), entry);
  });
}

test('an entry as JSON keeps its field names, with times as ISO 8601 text and bytes as base64', () => {
  const json = entryToJSON({ kind: 'message', direction: 'in', ...report, at });
  assert.equal(json.at, '2026-10-01T09:30:00.123Z');
  assert.equal(json.bytes, report.bytes.toString('base64'));
  const message = json.message as Record<string, unknown>;
  assert.equal(message.SendingTime, '2026-10-01T09:30:00.123Z');
  assert.equal(message.Symbol, 'ACME');
  assert.deepEqual(message.ContraGrp, [{ ContraBroker: 'B1', ContraTradeTime: '2026-10-01T09:30:00.123Z' }]);
});

test("a custom timestamp field becomes a Date again only with the session's dictionary", () => {
  const acme = defineDictionary({ fields: { DeskTime: { tag: 9801, type: 'timestamp' } }, messages: { NewOrderSingle: ['DeskTime'] } });
  const order = received('NewOrderSingle', { ClOrdID: 'o1', Side: 'Buy', OrdType: 'Market', Symbol: 'ACME', TransactTime: at, OrderQty: 100, DeskTime: at }, resolveDictionary('FIX.4.4', acme));
  const entry: Entry = { kind: 'message', direction: 'in', at, ...order };
  const plain = roundTrip(entry);
  assert.equal(plain.kind === 'message' && plain.message.DeskTime, at.toISOString());
  assert.deepEqual(roundTrip(entry, acme), entry);
});

test('a connection entry rejected as TLSMismatch goes to JSON and back', () => {
  const entry: ConnectionEntry = {
    kind: 'connection', event: 'rejected', connectionId: 'c1', peer: { address: '127.0.0.1', port: 5000 }, at,
    problem: { code: 'TLSMismatch', text: 'TLS on the plain port: this port does not use TLS', action: 'Disconnected' },
  };
  assert.deepEqual(entryFromJSON(JSON.parse(JSON.stringify(entryToJSON(entry)))), entry);
});

// ─── What entryFromJSON refuses ─────────────────────────────────────────────

test("a message's __proto__ key is left out, not made its prototype", () => {
  const json = JSON.parse(`{"kind":"message","direction":"in","at":"${at.toISOString()}","message":{"MsgType":"Heartbeat","__proto__":{"polluted":true}}}`);
  const entry = entryFromJSON(json);
  assert.ok(entry.kind === 'message');
  assert.equal(Object.getPrototypeOf(entry.message), Object.prototype);
  assert.equal((entry.message as { polluted?: unknown }).polluted, undefined);
});

test('entryFromJSON refuses what is not an entry, saying what is wrong', () => {
  const good = entryToJSON({ kind: 'problem', direction: 'in', at, problem: { code: 'Garbled', text: 'bad', action: 'Ignored' } });
  assert.throws(() => entryFromJSON('{"kind":"error"}'), /entryFromJSON: an entry must be an object, got '\{"kind":"error"\}'/);
  assert.throws(() => entryFromJSON({ ...good, kind: 'fault' }), /kind must be 'message', 'problem', 'error' or 'connection', got 'fault'/);
  assert.throws(() => entryFromJSON({ ...good, at: 'yesterday' }), /at must be an ISO 8601 time, got 'yesterday'/);
  assert.throws(() => entryFromJSON({ kind: 'connection', event: 'received', at: good.at, bytes: 'not base64!' }), /bytes must be base64/);
  assert.throws(() => entryFromJSON({ kind: 'message', direction: 'sideways', at: good.at, message: {} }), /direction must be 'in' or 'out', got 'sideways'/);
  assert.throws(() => entryFromJSON({ kind: 'connection', event: 'opened', at: good.at, peer: { address: 'a', port: '80' } }), /peer.port must be an integer from 0 to 65535, got '80'/);
});

test('at, and every timestamp field in a message, must be ISO 8601 text with an explicit zone, not whatever Date can parse', () => {
  const at8 = at.toISOString();
  const base = entryToJSON({ kind: 'message', direction: 'in', at, message: report.message }) as Record<string, unknown>;
  for (const bad of ['1', 'Tue, 01 Oct 2026', '2026-10-01T09:30:00', '2026-10-01', 'not a date', '2026-13-45T99:99:99Z']) {
    assert.throws(() => entryFromJSON({ ...base, at: bad }), /at must be an ISO 8601 time/, `at: ${bad}`);
  }
  const message = base.message as Record<string, unknown>;
  assert.throws(() => entryFromJSON({ ...base, message: { ...message, SendingTime: '2' } }), /message.SendingTime must be an ISO 8601 time, got '2'/);
  assert.throws(() => entryFromJSON({ ...base, message: { ...message, SendingTime: '1' } }), /message.SendingTime must be an ISO 8601 time, got '1'/);
  // a zone offset other than Z is still accepted, since entryToJSON only ever writes Z
  assert.doesNotThrow(() => entryFromJSON({ ...base, at: '2026-10-01T09:30:00.123+00:00' }));
});

test('a message field value must be a string, a finite number, a boolean or an array of strings; a bare object is refused even outside a group, closing the __proto__-as-field-value route', () => {
  const base = entryToJSON({ kind: 'message', direction: 'in', at, message: report.message }) as Record<string, unknown>;
  const message = base.message as Record<string, unknown>;
  assert.throws(
    () => entryFromJSON({ ...base, message: { ...message, Price: {} } }),
    /message.Price must be a string, a finite number, a boolean or an array of strings, got an object/,
  );
  const polluting = JSON.parse(JSON.stringify({ ...base, message: { ...message } }));
  polluting.message.Text = JSON.parse('{"__proto__":{"isAdmin":true}}');
  assert.throws(() => entryFromJSON(polluting), /message.Text must be a string, a finite number, a boolean or an array of strings, got an object/);
  assert.equal(({} as { isAdmin?: unknown }).isAdmin, undefined, 'the rejected field must never reach Object.prototype');
  // shape only, never the FIX type: a number, a boolean or an array of strings are all accepted regardless of the field's real type
  const odd = entryFromJSON({ ...base, message: { ...message, Side: 42, LocateReqd: true, Symbol: ['A', 'B'] } });
  assert.ok(odd.kind === 'message');
  assert.deepEqual({ Side: odd.message.Side, LocateReqd: odd.message.LocateReqd, Symbol: odd.message.Symbol }, { Side: 42, LocateReqd: true, Symbol: ['A', 'B'] });
});

test('during is rebuilt from MsgType, MsgSeqNum and ClOrdID only: anything else is dropped, and a wrong type for a known field is refused', () => {
  const json = JSON.parse(`{"kind":"error","at":"${at.toISOString()}","text":"x","during":{"MsgType":"D","MsgSeqNum":5,"ClOrdID":"o1","__proto__":{"isAdmin":true},"extra":"junk","deep":{"a":[1,2,3]}}}`);
  const entry = entryFromJSON(json);
  assert.ok(entry.kind === 'error');
  assert.deepEqual(entry.during, { MsgType: 'D', MsgSeqNum: 5, ClOrdID: 'o1' });
  assert.equal(({} as { isAdmin?: unknown }).isAdmin, undefined);
  assert.throws(
    () => entryFromJSON({ kind: 'error', at: at.toISOString(), text: 'x', during: { MsgSeqNum: 'seven' } }),
    /during.MsgSeqNum must be a finite number, got 'seven'/,
  );
});

test('problem.code and problem.action must be one of the known names', () => {
  assert.throws(
    () => entryFromJSON({ kind: 'problem', direction: 'in', at: at.toISOString(), problem: { code: 'Whatever', text: 't', action: 'Ignored' } }),
    /problem.code must be a known problem code, got 'Whatever'/,
  );
  assert.throws(
    () => entryFromJSON({ kind: 'problem', direction: 'in', at: at.toISOString(), problem: { code: 'Garbled', text: 't', action: 'Explode' } }),
    /problem.action must be a known action, got 'Explode'/,
  );
  // a code only DecodeProblemCode carries, and every real action, are both accepted
  assert.doesNotThrow(() => entryFromJSON({ kind: 'problem', direction: 'in', at: at.toISOString(), problem: { code: 'InvalidTagNumber', text: 't', action: 'Rejected' } }));
});

test('peer.port must be an integer from 0 to 65535', () => {
  for (const bad of [-5.5, -1, 65536, 1.5, Number.NaN]) {
    assert.throws(
      () => entryFromJSON({ kind: 'connection', event: 'opened', at: at.toISOString(), peer: { address: 'a', port: bad } }),
      /peer.port must be an integer from 0 to 65535/,
      `port: ${bad}`,
    );
  }
  assert.doesNotThrow(() => entryFromJSON({ kind: 'connection', event: 'opened', at: at.toISOString(), peer: { address: 'a', port: 0 } }));
  assert.doesNotThrow(() => entryFromJSON({ kind: 'connection', event: 'opened', at: at.toISOString(), peer: { address: 'a', port: 65535 } }));
});

test('a message needs MsgType, and BeginString, when present, must be a supported version', () => {
  assert.throws(
    () => entryFromJSON({ kind: 'message', direction: 'in', at: at.toISOString(), message: { ClOrdID: 'x' } }),
    /message.MsgType must be text, got undefined/,
  );
  assert.throws(
    () => entryFromJSON({ kind: 'message', direction: 'in', at: at.toISOString(), message: { MsgType: '' } }),
    /message.MsgType must be text, got ''/,
  );
  assert.throws(
    () => entryFromJSON({ kind: 'message', direction: 'in', at: at.toISOString(), message: { MsgType: 'D', BeginString: 'FIX.9.9' } }),
    /message.BeginString must be a supported version.*got 'FIX.9.9'/,
  );
  assert.doesNotThrow(() => entryFromJSON({ kind: 'message', direction: 'in', at: at.toISOString(), message: { MsgType: 'Heartbeat' } }));
});

test('bytes must be strict, canonical base64: correct length, no characters outside the alphabet, and the decoded bytes re-encode to the same text', () => {
  const at8 = at.toISOString();
  assert.throws(() => entryFromJSON({ kind: 'connection', event: 'received', at: at8, bytes: 'A' }), /bytes must be base64, got 'A'/);
  assert.throws(() => entryFromJSON({ kind: 'connection', event: 'received', at: at8, bytes: 'ab-_' }), /bytes must be base64/);
  assert.throws(() => entryFromJSON({ kind: 'connection', event: 'received', at: at8, bytes: 'aGVs=G8=' }), /bytes must be base64/);   // '=' only valid as trailing padding
  const entry = entryFromJSON({ kind: 'connection', event: 'received', at: at8, bytes: 'aGVsbG8=' });
  assert.ok(entry.kind === 'connection' && entry.event === 'received');
  assert.equal(entry.kind === 'connection' && entry.event === 'received' && Buffer.from(entry.bytes).toString(), 'hello');
  // a large but valid payload is still handled in linear time: not a regex-engine hazard
  const t0 = performance.now();
  assert.doesNotThrow(() => entryFromJSON({ kind: 'connection', event: 'received', at: at8, bytes: 'A'.repeat(4 * 1024 * 1024) }));
  assert.ok(performance.now() - t0 < 2_000, 'a 4 MiB base64 payload must validate in well under 2 s');
});

test('a message group nests at most 32 levels deep; any deeper is a RangeError, not a native stack overflow', () => {
  // Parties is a repeating group fix.js's dictionary knows; nesting it inside itself (not a real FIX
  // shape) is the simplest way to drive the generic, dictionary-name-only recursion in fields().
  const nested = (depth: number): unknown => depth <= 0 ? { PartyID: 'x' } : { PartyID: 'x', Parties: [nested(depth - 1)] };
  const build = (depth: number) => ({ kind: 'message', direction: 'in', at: at.toISOString(), message: { MsgType: 'NewOrderSingle', Parties: [nested(depth)] } });
  assert.doesNotThrow(() => entryFromJSON(build(31)));
  assert.throws(() => entryFromJSON(build(32)), /entryFromJSON: message groups must not nest more than 32 levels deep/);
});

test('entryFromJSON() refuses a custom dictionary that cannot extend the dictionary of the version the entry names, with a RangeError saying which', () => {
  // RateSource is a field of FIX 5.0 SP2 and of neither FIX 4 version.
  const clash = defineDictionary({ fields: { RateSource: { tag: 9801 } } });
  const entry = { kind: 'message', direction: 'in', at: at.toISOString(), message: { BeginString: 'FIX.4.4', MsgType: 'Heartbeat', RateSource: 'Bloomberg' } };
  const back = entryFromJSON(entry, clash);
  assert.ok(back.kind === 'message' && back.message.RateSource === 'Bloomberg');
  assert.throws(() => entryFromJSON({ ...entry, message: { ...entry.message, BeginString: 'FIXT.1.1' } }, clash), {
    name: 'RangeError', message: "entryFromJSON: dictionary can't be used with FIXT.1.1: Custom field RateSource has the same name as a standard field",
  });
});
