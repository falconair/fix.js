import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineDictionary } from './define.ts';
import { dictionaryFor, sessionLayerFor, SESSION_DATA_TAGS } from './index.ts';
import { resolveDictionary, resolveSessionLayer } from './resolve.ts';

test('standard dictionaries by version', () => {
  assert.equal(resolveDictionary('FIX.4.4'), dictionaryFor('FIX.4.4'));
  assert.equal(resolveDictionary('FIX.4.2').version, 'FIX.4.2');
});

test('custom dictionaries are extended once per version and cached', () => {
  const acme = defineDictionary({ fields: { AlgoStrategy: { tag: 9702, values: { VWAP: 'V' } } }, messages: { NewOrderSingle: ['AlgoStrategy'] } });
  const first = resolveDictionary('FIX.4.4', acme);
  assert.equal(first.fieldByName.get('AlgoStrategy')?.tag, 9702);
  assert.equal(resolveDictionary('FIX.4.4', acme), first);
  assert.notEqual(resolveDictionary('FIX.4.2', acme), first);
});

test('the session layer of a FIX 4 version is its one dictionary, extended and cached like it', () => {
  assert.equal(sessionLayerFor('FIX.4.2'), dictionaryFor('FIX.4.2'));
  assert.equal(sessionLayerFor('FIX.4.4'), dictionaryFor('FIX.4.4'));
  assert.equal(sessionLayerFor('FIX.9.9').version, 'FIX.4.4');
  assert.equal(resolveSessionLayer('FIX.4.2'), dictionaryFor('FIX.4.2'));
  const acme = defineDictionary({ fields: { LogonToken: { tag: 9710 } }, messages: { Logon: ['LogonToken'] } });
  const layer = resolveSessionLayer('FIX.4.4', acme);
  assert.equal(layer.fieldByName.get('LogonToken')?.tag, 9710);
  assert.equal(resolveSessionLayer('FIX.4.4', acme), layer);
  assert.equal(resolveDictionary('FIX.4.4', acme), layer);
});

test("the data tags of a first frame are every session layer's together", () => {
  for (const version of ['FIX.4.2', 'FIX.4.4']) {
    for (const tag of sessionLayerFor(version).dataTags) assert.ok(SESSION_DATA_TAGS.has(tag), `${version} data tag ${tag}`);
  }
  assert.ok(SESSION_DATA_TAGS.has(96));    // RawData
  assert.ok(!SESSION_DATA_TAGS.has(95));   // RawDataLength is a length, not data
});

test('a custom dictionary extends each FIXT.1.1 dictionary, the session layer with its session fields only', () => {
  const acme = defineDictionary({
    fields: { LogonToken: { tag: 9710 }, AlgoStrategy: { tag: 9702, values: { VWAP: 'V' } } },
    messages: { Logon: ['LogonToken'], NewOrderSingle: ['AlgoStrategy'] },
  });
  const layer = resolveSessionLayer('FIXT.1.1', acme);
  assert.deepEqual(layer.messageByName.get('Logon')?.members.at(-1), { kind: 'field', tag: 9710, required: false });
  assert.equal(layer.messageByName.has('NewOrderSingle'), false);
  const dict = resolveDictionary('FIXT.1.1', acme);
  assert.ok(dict !== layer);
  assert.deepEqual(dict.messageByName.get('NewOrderSingle')?.members.at(-1), { kind: 'field', tag: 9702, required: false });
  assert.deepEqual(dict.messageByName.get('Logon')?.members.at(-1), { kind: 'field', tag: 9710, required: false });
  assert.ok(resolveDictionary('FIXT.1.1', acme) === dict);
  assert.ok(resolveDictionary('FIXT.1.1') === dictionaryFor('FIXT.1.1'));
});
