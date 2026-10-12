import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Member } from '../src/dictionary/model.ts';
import { parseOrchestra } from './orchestra.ts';

const fix44 = parseOrchestra(readFileSync('dictionaries/orchestra/OrchestraFIX44.xml', 'utf8'));
const fix42 = parseOrchestra(readFileSync('dictionaries/orchestra/OrchestraFIX42.xml', 'utf8'));
const field = (name: string) => fix44.fields.find(f => f.name === name);
const message = (name: string) => fix44.messages.find(m => m.name === name);
const tagsOf = (members: readonly Member[]) =>
  members.map(m => m.kind === 'field' ? m.tag : `[${m.name}]`);

test('reads the FIX version', () => {
  assert.equal(fix44.version, 'FIX.4.4');
  assert.equal(fix42.version, 'FIX.4.2');
});

test('fields carry their tag, datatype and codes', () => {
  assert.deepEqual(field('Symbol'), { tag: 55, name: 'Symbol', type: 'String' });
  assert.equal(field('Side')?.tag, 54);
  assert.equal(field('Side')?.type, 'char');
  assert.deepEqual(field('Side')?.codes?.slice(0, 2), [{ name: 'Buy', value: '1' }, { name: 'Sell', value: '2' }]);
  assert.equal(field('PossDupFlag')?.type, 'Boolean');
  assert.equal(field('ExecInst')?.type, 'MultipleValueString');
  assert.equal(field('RawData')?.type, 'data');
});

test('messages list their members in order, with components flattened', () => {
  const nos = message('NewOrderSingle');
  assert.equal(nos?.msgType, 'D');
  assert.equal(nos?.admin, false);
  assert.deepEqual(nos?.members[0], { kind: 'field', tag: 11, required: true });
  assert.deepEqual(nos?.members[3], { kind: 'group', name: 'Parties', required: false });
  const tags = tagsOf(nos!.members);
  for (const [before, after] of [[55, 54], [54, 60], [38, 40], [40, 44]] as const) {
    assert.ok(tags.indexOf(before as number | string) < tags.indexOf(after as number | string), `${before} comes before ${after}`);
  }
  assert.deepEqual(nos!.members.filter(m => m.required).map(m => (m.kind === 'field' ? m.tag : m.name)), [11, 54, 60, 40]);
});

test('session messages are admin, and bodies exclude the header and trailer', () => {
  assert.equal(message('Logon')?.admin, true);
  assert.equal(fix42.messages.find(m => m.name === 'Logon')?.admin, true);
  assert.deepEqual(message('TestRequest')?.members, [{ kind: 'field', tag: 112, required: true }]);
});

test('groups know their count tag and members', () => {
  const parties = fix44.groups.find(g => g.name === 'Parties');
  assert.equal(parties?.countTag, 453);
  assert.deepEqual(tagsOf(parties!.members), [448, 447, 452, '[PtysSubGrp]']);
});

test('header and trailer', () => {
  assert.deepEqual(tagsOf(fix44.header).slice(0, 5), [8, 9, 35, 49, 56]);
  assert.deepEqual(tagsOf(fix44.trailer), [93, 89, 10]);
  assert.deepEqual(tagsOf(fix42.header).slice(0, 3), [8, 9, 35]);
});

test('a field whose code set is open carries its union datatype; one the parser does not know is an error', () => {
  assert.equal(field('SecurityIDSource')?.union, 'Reserved100Plus');
  assert.equal(field('IOIQty')?.union, 'Qty');
  assert.equal(field('TargetStrategy')?.union, 'Reserved1000Plus');
  assert.equal(field('PosReqResult')?.union, 'Reserved4000Plus');
  assert.equal(field('Side')?.union, undefined);
  // A union datatype on a field that has no code set says nothing more than its type does: LegIOIQty is plain text.
  assert.deepEqual(field('LegIOIQty'), { tag: 682, name: 'LegIOIQty', type: 'String' });
  assert.equal(fix44.fields.filter(f => f.union !== undefined).length, 9);
  assert.equal(fix42.fields.filter(f => f.union !== undefined).length, 0);

  const repository = (union: string) => `<fixr:repository xmlns:fixr="http://fixprotocol.io/2020/orchestra/repository" name="FIX.9.9">
    <fixr:codeSets><fixr:codeSet name="KindCodeSet" id="1" type="int"><fixr:code name="First" id="2" value="1"/></fixr:codeSet></fixr:codeSets>
    <fixr:fields><fixr:field id="9001" name="Kind" type="KindCodeSet" unionDataType="${union}"/></fixr:fields>
    <fixr:components><fixr:component id="1024" name="StandardHeader"><fixr:fieldRef id="9001"/></fixr:component><fixr:component id="1025" name="StandardTrailer"><fixr:fieldRef id="9001"/></fixr:component></fixr:components>
    <fixr:groups><fixr:group id="2000" name="Kinds"><fixr:numInGroup id="9001"/><fixr:fieldRef id="9001"/></fixr:group></fixr:groups>
    <fixr:messages><fixr:message name="KindReport" id="1" msgType="U1"><fixr:structure><fixr:fieldRef id="9001"/></fixr:structure></fixr:message></fixr:messages>
  </fixr:repository>`;
  assert.deepEqual(parseOrchestra(repository('Tenor')).fields, [{ tag: 9001, name: 'Kind', type: 'int', codes: [{ name: 'First', value: '1' }], union: 'Tenor' }]);
  assert.throws(() => parseOrchestra(repository('Mystery')), /Field Kind \(9001\) has the union datatype Mystery, which this parser does not know/);
});

test('the FIXT.1.1 session layer and FIX Latest are read as they are', () => {
  const fixt = parseOrchestra(readFileSync('dictionaries/orchestra/FIXTSession.xml', 'utf8'));
  const latest = parseOrchestra(readFileSync('dictionaries/orchestra/OrchestraFIXLatest.xml', 'utf8'));
  assert.deepEqual([fixt.version, fixt.fields.length, fixt.messages.length, fixt.groups.length], ['FIXT', 92, 8, 4]);
  assert.deepEqual(fixt.messages.map(m => [m.name, m.msgType, m.admin]),
    [['Heartbeat', '0', true], ['TestRequest', '1', true], ['ResendRequest', '2', true], ['Reject', '3', true], ['SequenceReset', '4', true], ['Logout', '5', true], ['Logon', 'A', true], ['XMLnonFIX', 'n', true]]);
  // The header has ApplVerID right after MsgType, and a Logon must name the application version.
  assert.deepEqual(tagsOf(fixt.header).slice(0, 6), [8, 9, 35, 1128, 1156, 1129]);
  assert.deepEqual(fixt.messages.find(m => m.name === 'Logon')?.members.filter(m => m.required), [
    { kind: 'field', tag: 98, required: true }, { kind: 'field', tag: 108, required: true }, { kind: 'field', tag: 1137, required: true },
  ]);
  assert.deepEqual(fixt.fields.find(f => f.tag === 1137)?.codes?.slice(-4),
    [{ name: 'FIX50', value: '7' }, { name: 'FIX50SP1', value: '8' }, { name: 'FIX50SP2', value: '9' }, { name: 'FIXLatest', value: '10' }]);
  assert.equal(fixt.fields.find(f => f.tag === 373)?.union, 'Reserved100Plus');

  assert.deepEqual([latest.version, latest.fields.length, latest.messages.length, latest.groups.length], ['FIX.Latest', 6203, 181, 580]);
  assert.equal(latest.messages.filter(m => m.admin).length, 8);
  // FIX Latest carries the same session layer: the same header and trailer, member for member.
  assert.deepEqual(latest.header, fixt.header);
  assert.deepEqual(latest.trailer, fixt.trailer);
  assert.equal(latest.fields.find(f => f.tag === 213)?.type, 'XMLData');
  assert.equal(latest.fields.filter(f => f.union !== undefined).length, 206);
});
