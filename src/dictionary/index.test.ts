import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dictionaryFor, DEFAULT_VERSION, sessionLayerFor, SESSION_DATA_TAGS } from './index.ts';
import { Side, MsgType } from './fix44.ts';

test('looks fields and messages up by tag, name and MsgType', () => {
  const dict = dictionaryFor('FIX.4.4');
  assert.equal(dict.fieldByName.get('Side')?.tag, 54);
  assert.equal(dict.fieldByTag.get(55)?.name, 'Symbol');
  assert.equal(dict.messageByMsgType.get('D')?.name, 'NewOrderSingle');
  assert.equal(dict.messageByName.get('Logon')?.msgType, 'A');
  assert.equal(dict.groupByName.get('Parties')?.countTag, 453);
  assert.ok(dict.dataTags.has(96));    // RawData
});

test('versions', () => {
  assert.equal(DEFAULT_VERSION, 'FIX.4.4');
  assert.equal(dictionaryFor('FIX.4.2').version, 'FIX.4.2');
  assert.equal(dictionaryFor().version, 'FIX.4.4');
  assert.equal(dictionaryFor('FIX.9.9').version, 'FIX.4.4');
});

test('generated constants are their own names', () => {
  assert.equal(Side.Buy, 'Buy');
  assert.equal(MsgType.NewOrderSingle, 'NewOrderSingle');
});

test('FIXT.1.1 has two dictionaries: the session layer on its own, and with the application messages it carries', () => {
  const layer = sessionLayerFor('FIXT.1.1');
  const dict = dictionaryFor('FIXT.1.1');
  assert.deepEqual([layer.version, dict.version], ['FIXT.1.1', 'FIXT.1.1']);
  // The session layer: the header, the trailer and the session messages, and nothing of the application.
  assert.deepEqual([...layer.messageByName.keys()], ['Heartbeat', 'TestRequest', 'ResendRequest', 'Reject', 'SequenceReset', 'Logout', 'Logon', 'XMLnonFIX']);
  assert.equal(layer.fieldByName.has('Symbol'), false);
  // With the application layer: the same header, trailer and session messages, and FIX 5.0 SP2's messages.
  assert.deepEqual(dict.data.header, layer.data.header);
  assert.deepEqual(dict.data.trailer, layer.data.trailer);
  assert.deepEqual(dict.messageByName.get('Logon'), layer.messageByName.get('Logon'));
  assert.deepEqual([dict.data.fields.length, dict.data.messages.length, dict.data.groups.length], [6203, 181, 580]);
  assert.equal(dict.messageByMsgType.get('D')?.name, 'NewOrderSingle');
  assert.equal(dict.messageByMsgType.get('D')?.admin, false);
  assert.equal(dict.fieldByName.get('Symbol')?.tag, 55);
  // BeginString is plain text; RefMsgType knows every message; a Logon must name the application version.
  assert.deepEqual(dict.fieldByTag.get(8), { tag: 8, name: 'BeginString', type: 'String' });
  assert.equal(dict.fieldByTag.get(372)?.codes?.length, 181);
  assert.ok(dict.fieldByTag.get(372)?.codes?.some(code => code.name === 'NewOrderSingle' && code.value === 'D'));
  // The session layer on its own knows them by the same names (a Logon may list message types in RefMsgType); its MsgType is the session's alone.
  assert.deepEqual(layer.fieldByTag.get(372), dict.fieldByTag.get(372));
  assert.deepEqual(layer.fieldByTag.get(35)?.codes?.map(code => code.name),
    ['Heartbeat', 'TestRequest', 'ResendRequest', 'Reject', 'SequenceReset', 'Logout', 'Logon', 'BusinessMessageReject', 'XMLnonFIX']);
  assert.ok(dict.messageByName.get('Logon')?.members.some(member => member.kind === 'field' && member.tag === 1137 && member.required));
  // A field both layers define is the session layer's: SessionRejectReason 18 by its FIXT.1.1 name.
  assert.deepEqual(dict.fieldByTag.get(373), layer.fieldByTag.get(373));
  assert.ok(dict.fieldByTag.get(373)?.codes?.some(code => code.name === 'InvalidUnsupportedAppVersion' && code.value === '18'));
  // XMLData fields are data, like RawData: read by the length before them.
  for (const tag of [96, 213, 1402, 1185]) assert.ok(dict.dataTags.has(tag), `data tag ${tag}`);
  assert.ok(SESSION_DATA_TAGS.has(1402));
  assert.ok(!SESSION_DATA_TAGS.has(1185));
});

test('the FIXT.1.1 tables are read from their file when first needed, not when the library is imported', () => {
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync;
    const reads = [];
    fs.readFileSync = (path, ...rest) => { reads.push(String(path)); return read(path, ...rest); };
    syncBuiltinESMExports();
    await import(${JSON.stringify(new URL('../index.ts', import.meta.url).href)});
    const { dictionaryFor, sessionLayerFor } = await import(${JSON.stringify(new URL('./index.ts', import.meta.url).href)});
    const tables = () => reads.filter(path => path.endsWith('fix50sp2.data.json')).length;
    const counts = [tables()];
    dictionaryFor('FIX.4.4');
    sessionLayerFor('FIXT.1.1');
    counts.push(tables());
    dictionaryFor('FIXT.1.1');
    counts.push(tables());
    dictionaryFor('FIXT.1.1');
    counts.push(tables());
    console.log(JSON.stringify(counts));
  `;
  const printed = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 });
  // Not on import; not for FIX 4.4 or the FIXT.1.1 session layer; once, the first time it is asked for.
  assert.deepEqual(JSON.parse(printed), [0, 0, 1, 1]);
});
