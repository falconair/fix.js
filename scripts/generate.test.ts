import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DictionaryData } from '../src/dictionary/model.ts';
import { composeDictionary, generateData, generateJson, generateTypes, sessionLayerAlone } from './generate.ts';
import { decodeValue, encodeValue } from '../src/wire/values.ts';

const fixture: DictionaryData = {
  version: 'FIX.9.9',
  fields: [
    { tag: 8, name: 'BeginString', type: 'String' },
    { tag: 9, name: 'BodyLength', type: 'Length' },
    { tag: 35, name: 'MsgType', type: 'String', codes: [{ name: 'Heartbeat', value: '0' }, { name: 'NewOrderSingle', value: 'D' }] },
    { tag: 10, name: 'CheckSum', type: 'String' },
    { tag: 43, name: 'PossDupFlag', type: 'Boolean', codes: [{ name: 'PossibleDuplicate', value: 'Y' }, { name: 'OriginalTransmission', value: 'N' }] },
    { tag: 54, name: 'Side', type: 'char', codes: [{ name: 'Buy', value: '1' }, { name: 'Sell', value: '2' }] },
    { tag: 18, name: 'ExecInst', type: 'MultipleValueString', codes: [{ name: 'NotHeld', value: '1' }] },
    { tag: 38, name: 'OrderQty', type: 'Qty' },
    { tag: 60, name: 'TransactTime', type: 'UTCTimestamp' },
    { tag: 448, name: 'PartyID', type: 'String' },
    { tag: 453, name: 'NoPartyIDs', type: 'NumInGroup' },
  ],
  groups: [{ name: 'Parties', countTag: 453, members: [{ kind: 'field', tag: 448, required: false }] }],
  messages: [
    { name: 'Heartbeat', msgType: '0', admin: true, members: [] },
    {
      name: 'NewOrderSingle', msgType: 'D', admin: false, members: [
        { kind: 'field', tag: 54, required: true },
        { kind: 'field', tag: 18, required: false },
        { kind: 'field', tag: 38, required: false },
        { kind: 'field', tag: 60, required: true },
        { kind: 'group', name: 'Parties', required: false },
      ],
    },
  ],
  header: [
    { kind: 'field', tag: 8, required: true },
    { kind: 'field', tag: 9, required: true },
    { kind: 'field', tag: 35, required: true },
    { kind: 'field', tag: 43, required: false },
  ],
  trailer: [{ kind: 'field', tag: 10, required: true }],
};

const types = generateTypes(fixture);

test('enum fields become a type and a constant of the same name', () => {
  assert.ok(types.includes("export type Side = 'Buy' | 'Sell';"));
  assert.ok(types.includes("export const Side = { Buy: 'Buy', Sell: 'Sell' } as const;"));
  assert.ok(types.includes("export const MsgType = { Heartbeat: 'Heartbeat', NewOrderSingle: 'NewOrderSingle' } as const;"));
});

test('Y/N fields are booleans, not enums', () => {
  assert.ok(!types.includes('export type PossDupFlag'));
  assert.ok(types.includes('  PossDupFlag?: boolean;'));
});

test('the header leaves out BodyLength, MsgType and CheckSum', () => {
  const header = types.slice(types.indexOf('export interface Header {'), types.indexOf('export interface Framing'));
  assert.ok(header.includes('  BeginString: string;'));
  assert.ok(!header.includes('BodyLength') && !header.includes('MsgType') && !header.includes('CheckSum'));
  assert.ok(types.includes('export interface Framing {\n  BodyLength: number;\n  CheckSum: string;\n}'));
});

test('messages and groups', () => {
  assert.ok(types.includes('export interface PartiesGroup {\n  PartyID?: string;\n}'));
  for (const line of [
    '    Side: Side;',
    '    ExecInst?: readonly ExecInst[];',
    '    OrderQty?: number;',
    '    TransactTime: Date;',
    '    Parties?: readonly PartiesGroup[];',
  ]) assert.ok(types.includes(line), line);
  assert.ok(types.includes("export type AdminMsgType = 'Heartbeat';"));
  assert.ok(types.includes('export type MsgTypeName = keyof Messages;'));
});

test('refuses names that would collide or shadow a global', () => {
  const clash = { ...fixture, fields: [...fixture.fields, { tag: 9000, name: 'PartiesGroup', type: 'char', codes: [{ name: 'A', value: 'A' }] }] };
  assert.throws(() => generateTypes(clash), /PartiesGroup/);
  const shadow = { ...fixture, fields: [...fixture.fields, { tag: 9001, name: 'Date', type: 'char', codes: [{ name: 'A', value: 'A' }] }] };
  assert.throws(() => generateTypes(shadow), /Date/);
});

test('data is a typed constant', () => {
  const data = generateData(fixture);
  assert.ok(data.startsWith("import type { DictionaryData } from './model.ts';\n\nexport const data: DictionaryData = {"));
  assert.ok(data.includes('"version": "FIX.9.9"'));
});

test('an open code set is typed as its names and the form it is open to', () => {
  const open = (union: 'Reserved100Plus' | 'Reserved1000Plus' | 'Reserved4000Plus' | 'Qty' | 'Tenor') => generateTypes({
    ...fixture,
    fields: [...fixture.fields, { tag: 9001, name: 'Kind', type: 'int', codes: [{ name: 'First', value: '1' }], union }],
  });
  for (const union of ['Reserved100Plus', 'Reserved1000Plus', 'Reserved4000Plus', 'Qty'] as const) {
    assert.ok(open(union).includes("export type Kind = 'First' | `${number}`;"), union);
  }
  assert.ok(open('Tenor').includes("export type Kind = 'First' | `${'D' | 'M' | 'W' | 'Y'}${number}`;"));
  // The constants stay the names alone.
  assert.ok(open('Qty').includes("export const Kind = { First: 'First' } as const;"));
  assert.ok(types.includes("export type Side = 'Buy' | 'Sell';"));
});

test('refuses an open code set with a code named like the form it is open to', () => {
  const open = (name: string, value: string) => ({
    ...fixture,
    fields: [...fixture.fields, { tag: 9001, name: 'Kind', type: 'String', codes: [{ name, value }], union: 'Qty' as const }],
  });
  assert.doesNotThrow(() => generateData(open('Small', 'S')));
  assert.throws(() => generateData(open('5', 'S')), /Kind \(9001\) is open to a number, and its code 5 \(S\) has a name that is one/);
});

test('the tables as JSON refuse it too: they are the only tables the composed dictionary has', () => {
  const open = (name: string, value: string) => ({
    ...fixture,
    fields: [...fixture.fields, { tag: 9001, name: 'Kind', type: 'String', codes: [{ name, value }], union: 'Qty' as const }],
  });
  assert.doesNotThrow(() => generateJson(open('Small', 'S')));
  assert.throws(() => generateJson(open('5', 'S')), /Kind \(9001\) is open to a number, and its code 5 \(S\) has a name that is one/);
});

test('a listed code whose value is inside the form the set is open to is accepted, and round-trips', () => {
  const kind = { tag: 9001, name: 'Kind', type: 'int', codes: [{ name: 'Custom', value: '100' }], union: 'Reserved100Plus' as const };
  assert.doesNotThrow(() => generateData({ ...fixture, fields: [...fixture.fields, kind] }));
  assert.equal(decodeValue(kind, '100'), 'Custom');
  assert.equal(encodeValue(kind, 'Custom'), '100');
  assert.equal(decodeValue(kind, '150'), '150');
  assert.equal(encodeValue(kind, '150'), '150');
});

/** A session layer for the fixture above to be carried by. */
const sessionLayer: DictionaryData = {
  version: 'FIXT.9.9',
  fields: [
    { tag: 8, name: 'BeginString', type: 'String' },
    { tag: 9, name: 'BodyLength', type: 'Length' },
    { tag: 35, name: 'MsgType', type: 'String', codes: [{ name: 'Heartbeat', value: '0' }, { name: 'Logon', value: 'A' }] },
    { tag: 372, name: 'RefMsgType', type: 'String', codes: [{ name: 'Heartbeat', value: '0' }, { name: 'Logon', value: 'A' }] },
    { tag: 10, name: 'CheckSum', type: 'String' },
    { tag: 43, name: 'PossDupFlag', type: 'Boolean' },
    { tag: 1128, name: 'ApplVerID', type: 'String', codes: [{ name: 'FIX50SP2', value: '9' }] },
    { tag: 1137, name: 'DefaultApplVerID', type: 'String', codes: [{ name: 'FIX50SP2', value: '9' }] },
    { tag: 627, name: 'NoHops', type: 'NumInGroup' },
    { tag: 628, name: 'HopCompID', type: 'String' },
  ],
  groups: [{ name: 'HopGrp', countTag: 627, members: [{ kind: 'field', tag: 628, required: false }] }],
  messages: [
    { name: 'Heartbeat', msgType: '0', admin: true, members: [] },
    { name: 'Logon', msgType: 'A', admin: true, members: [{ kind: 'field', tag: 1137, required: true }] },
  ],
  header: [
    { kind: 'field', tag: 8, required: true },
    { kind: 'field', tag: 9, required: true },
    { kind: 'field', tag: 35, required: true },
    { kind: 'field', tag: 1128, required: false },
    { kind: 'group', name: 'HopGrp', required: false },
  ],
  trailer: [{ kind: 'field', tag: 10, required: true }],
};

/** The fixture as an application layer: its BeginString has a code set, and its PossDupFlag one the session layer lacks. */
const applicationLayer: DictionaryData = {
  ...fixture,
  fields: fixture.fields.map(field => (field.tag === 8 ? { ...field, codes: [{ name: 'FIXT99', value: 'FIXT.9.9' }] } : field)),
};

test('a session layer and the application layer it carries make one dictionary', () => {
  const composed = composeDictionary(sessionLayer, applicationLayer);
  assert.equal(composed.version, 'FIXT.9.9');
  // The header, the trailer and the session messages are the session layer's; the application layer's own Heartbeat is left out.
  assert.deepEqual(composed.header, sessionLayer.header);
  assert.deepEqual(composed.trailer, sessionLayer.trailer);
  assert.deepEqual(composed.messages.map(message => message.name), ['Heartbeat', 'Logon', 'NewOrderSingle']);
  assert.ok(composed.messages[0] === sessionLayer.messages[0]);
  // A field both define is the session layer's (PossDupFlag has no codes there); the others are added, each tag once.
  const byTag = new Map(composed.fields.map(field => [field.tag, field]));
  assert.equal(byTag.size, composed.fields.length);
  assert.deepEqual(byTag.get(43), { tag: 43, name: 'PossDupFlag', type: 'Boolean' });
  assert.equal(byTag.get(54)?.name, 'Side');
  assert.equal(byTag.get(1137)?.name, 'DefaultApplVerID');
  // MsgType and RefMsgType: one value for each message of the result.
  const types = [{ name: 'Heartbeat', value: '0' }, { name: 'Logon', value: 'A' }, { name: 'NewOrderSingle', value: 'D' }];
  assert.deepEqual(byTag.get(35)?.codes, types);
  assert.deepEqual(byTag.get(372)?.codes, types);
  // BeginString is plain text, whatever either layer says.
  assert.deepEqual(byTag.get(8), { tag: 8, name: 'BeginString', type: 'String' });
  const coded = composeDictionary({ ...sessionLayer, fields: sessionLayer.fields.map(field => (field.tag === 8 ? { ...field, codes: [{ name: 'FIXT99', value: 'FIXT.9.9' }] } : field)) }, applicationLayer);
  assert.equal(coded.fields.find(field => field.tag === 8)?.codes, undefined);
  // Groups of both layers, each once.
  assert.deepEqual(composed.groups.map(group => group.name), ['HopGrp', 'Parties']);
  // The types generated from it name every message.
  assert.ok(generateTypes(composed).includes("export const MsgType = { Heartbeat: 'Heartbeat', Logon: 'Logon', NewOrderSingle: 'NewOrderSingle' } as const;"));
});

test('the session layer on its own names every message a Logon may list: its RefMsgType takes the values of the composed dictionary, and nothing else changes', () => {
  const composed = composeDictionary(sessionLayer, applicationLayer);
  const alone = sessionLayerAlone(sessionLayer, composed);
  const types = [{ name: 'Heartbeat', value: '0' }, { name: 'Logon', value: 'A' }, { name: 'NewOrderSingle', value: 'D' }];
  assert.deepEqual(alone.fields.find(field => field.tag === 372), { tag: 372, name: 'RefMsgType', type: 'String', codes: types });
  // MsgType stays the session messages': on its own the layer reads no other message.
  assert.deepEqual(alone.fields.find(field => field.tag === 35)?.codes, [{ name: 'Heartbeat', value: '0' }, { name: 'Logon', value: 'A' }]);
  const but372 = (data: DictionaryData) => ({ ...data, fields: data.fields.filter(field => field.tag !== 372) });
  assert.deepEqual(but372(alone), but372(sessionLayer));
  assert.deepEqual(alone.fields.map(field => field.tag), sessionLayer.fields.map(field => field.tag));
  // The composed dictionary is the same from either.
  assert.deepEqual(composeDictionary(alone, applicationLayer), composed);
});

test('layers that cannot be told apart safely stop the generator', () => {
  const hop = sessionLayer.groups[0]!;
  const sameGroup = { ...applicationLayer, groups: [...applicationLayer.groups, hop] };
  assert.deepEqual(composeDictionary(sessionLayer, sameGroup).groups.map(group => group.name), ['HopGrp', 'Parties']);
  const otherGroup = { ...applicationLayer, groups: [...applicationLayer.groups, { ...hop, members: [] }] };
  assert.throws(() => composeDictionary(sessionLayer, otherGroup), /Group HopGrp differs between the session layer and the application layer/);
  const sameName = { ...applicationLayer, fields: [...applicationLayer.fields, { tag: 9002, name: 'HopCompID', type: 'String' }] };
  assert.throws(() => composeDictionary(sessionLayer, sameName), /Fields 628 and 9002 are both named HopCompID/);
  const logon = { name: 'Logon', msgType: 'A', admin: false, members: [] };
  assert.throws(() => composeDictionary(sessionLayer, { ...applicationLayer, messages: [...applicationLayer.messages, logon] }), /Application message Logon \(A\) is also a session message/);
});

test('the tables as JSON hold the same data, one field, group or message to a line', () => {
  const json = generateJson(fixture);
  assert.deepEqual(JSON.parse(json), fixture);
  assert.equal(json.split('\n').length, fixture.fields.length + fixture.groups.length + fixture.messages.length + 10);
  assert.ok(json.includes('\n{"tag":54,"name":"Side","type":"char","codes":[{"name":"Buy","value":"1"},{"name":"Sell","value":"2"}]},\n'));
  assert.ok(json.endsWith('}\n'));
});
