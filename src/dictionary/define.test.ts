import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictionaryFor } from './index.ts';
import { defineDictionary, extendDictionary, type DictionaryDef } from './define.ts';

const acme = defineDictionary({
  fields: {
    AlgoStrategy: { tag: 9702, values: { VWAP: 'V', TWAP: 'T' } },
    DeskName: { tag: 9703 },
    MinFillQty: { tag: 9704, type: 'number' },
  },
  messages: { NewOrderSingle: ['AlgoStrategy', 'DeskName', 'MinFillQty'] },
});

test('enum fields get constants', () => {
  assert.equal(acme.AlgoStrategy.VWAP, 'VWAP');
  assert.equal(acme.AlgoStrategy.TWAP, 'TWAP');
});

test('custom fields join the dictionary and the listed messages', () => {
  const dict = extendDictionary(dictionaryFor('FIX.4.4'), acme.definition);
  assert.equal(dict.fieldByName.get('AlgoStrategy')?.tag, 9702);
  assert.deepEqual(dict.fieldByTag.get(9702)?.codes, [{ name: 'VWAP', value: 'V' }, { name: 'TWAP', value: 'T' }]);
  assert.equal(dict.fieldByName.get('MinFillQty')?.type, 'float');
  const members = dict.messageByName.get('NewOrderSingle')!.members;
  assert.deepEqual(members.at(-1), { kind: 'field', tag: 9704, required: false });
  assert.equal(dictionaryFor('FIX.4.4').fieldByName.has('AlgoStrategy'), false);   // the standard dictionary is untouched
});

test('duplicate custom tags are refused at definition time', () => {
  assert.throws(() => defineDictionary({ fields: { First: { tag: 9800 }, Second: { tag: 9800 } } }), /9800/);
});

test('duplicate custom tags are refused by extendDictionary too', () => {
  assert.throws(() => extendDictionary(dictionaryFor('FIX.4.4'), { fields: { First: { tag: 9800 }, Second: { tag: 9800 } } }), /9800/);
});

test('an unknown message name in messages is refused at definition time', () => {
  assert.throws(() => defineDictionary({ fields: { X: { tag: 9801 } }, messages: { NotAMessage: ['X'] } } as DictionaryDef), /NotAMessage/);
});

test('a message listing a field that is not custom is refused at definition time', () => {
  assert.throws(() => defineDictionary({ fields: { X: { tag: 9802 } }, messages: { NewOrderSingle: ['Nope'] } }), /Nope/);
});

test('clashes with the standard dictionaries are refused at definition time', () => {
  assert.throws(() => defineDictionary({ fields: { Mine: { tag: 55 } } }), /Symbol/);
  assert.throws(() => defineDictionary({ fields: { Symbol: { tag: 9999 } } }), /Symbol/);
});

test('defineDictionary succeeds for a message that exists in only one bundled version', () => {
  const dict = defineDictionary({ fields: { CustomCrossID: { tag: 9806 } }, messages: { NewOrderCross: ['CustomCrossID'] } });
  assert.deepEqual(dict.definition.messages?.NewOrderCross, ['CustomCrossID']);
});

test('extendDictionary skips a message the base version does not have, without adding the field to any message', () => {
  const def = { fields: { CustomCrossID: { tag: 9806 } }, messages: { NewOrderCross: ['CustomCrossID'] } };
  const dict42 = extendDictionary(dictionaryFor('FIX.4.2'), def);
  assert.equal(dict42.fieldByName.get('CustomCrossID')?.tag, 9806);
  for (const message of dict42.data.messages) {
    assert.equal(message.members.some(m => m.kind === 'field' && m.tag === 9806), false, message.name);
  }
});

test('extendDictionary adds the field when the base version has the message', () => {
  const def = { fields: { CustomCrossID: { tag: 9806 } }, messages: { NewOrderCross: ['CustomCrossID'] } };
  const dict44 = extendDictionary(dictionaryFor('FIX.4.4'), def);
  const members = dict44.messageByName.get('NewOrderCross')!.members;
  assert.deepEqual(members.at(-1), { kind: 'field', tag: 9806, required: false });
});

test('a message name that exists in no bundled version still throws from defineDictionary', () => {
  assert.throws(() => defineDictionary({ fields: { X: { tag: 9807 } }, messages: { NoSuchMessage: ['X'] } } as DictionaryDef), /NoSuchMessage/);
});

test('clashes with standard fields are refused', () => {
  assert.throws(() => extendDictionary(dictionaryFor('FIX.4.4'), { fields: { Mine: { tag: 55 } } }),
    /Custom field Mine uses tag 55, which is Symbol/);
  assert.throws(() => extendDictionary(dictionaryFor('FIX.4.4'), { fields: { Symbol: { tag: 9999 } } }),
    /Custom field Symbol has the same name as a standard field/);
  assert.throws(() => extendDictionary(dictionaryFor('FIX.4.4'), { messages: { NewOrderSingle: ['Nope'] } }),
    /NewOrderSingle lists Nope, which isn't a custom field/);
});

test('a custom field named like a standard group is refused, saying which version has the group', () => {
  // Parties is a group of FIX 4.4: under one name a message could not hold both it and the field.
  assert.throws(() => defineDictionary({ fields: { Parties: { tag: 9810 } } }), { message: 'Custom field Parties has the same name as a group of FIX.4.4' });
  assert.throws(() => extendDictionary(dictionaryFor('FIX.4.4'), { fields: { Parties: { tag: 9810 } } }), { message: 'Custom field Parties has the same name as a group of FIX.4.4' });
  assert.throws(() => extendDictionary(dictionaryFor('FIXT.1.1'), { fields: { RootParties: { tag: 9810 } } }), { message: 'Custom field RootParties has the same name as a group of FIXT.1.1' });
  // FIX 4.2 has no such group, so there the name is free.
  assert.equal(extendDictionary(dictionaryFor('FIX.4.2'), { fields: { Parties: { tag: 9810 } } }).fieldByName.get('Parties')?.tag, 9810);
  // The names FIX 5.0 SP2 itself gives to both a field and a group stay, in the standard dictionary and in one extended.
  const shared = (dict: ReturnType<typeof dictionaryFor>) => [...dict.groupByName.keys()].filter(name => dict.fieldByName.has(name));
  assert.deepEqual(shared(dictionaryFor('FIXT.1.1')), ['RateSource', 'LegRateSource']);
  assert.deepEqual(shared(extendDictionary(dictionaryFor('FIXT.1.1'), { fields: { DeskName: { tag: 9703 } } })), ['RateSource', 'LegRateSource']);
});
