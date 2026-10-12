import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictionaryFor, indexDictionary } from '../dictionary/index.ts';
import { extendDictionary } from '../dictionary/define.ts';
import type { RawField } from './frame.ts';
import { fromMessage, inspectMessage, rawValue, toMessage } from './message.ts';

const dict = dictionaryFor('FIX.4.4');
const at = new Date('2026-09-27T14:30:05.123Z');
const context = { version: 'FIX.4.4', now: () => at };
const raw = (text: string): RawField[] => text.split('|').filter(Boolean).map(pair => {
  const equals = pair.indexOf('=');
  return { tag: Number(pair.slice(0, equals)), value: pair.slice(equals + 1) };
});
const tags = (fields: readonly RawField[]) => fields.map(field => field.tag);
const valueOf = (fields: readonly RawField[], tag: number) => fields.find(field => field.tag === tag)?.value;

test('decodes named, typed fields; groups become arrays; unknown tags keep their number', () => {
  const msg = toMessage(raw('8=FIX.4.4|9=0|35=D|49=ME|11=ord-1|453=2|448=DESK-7|452=36|448=ACME|447=D|452=3|1=ACC|54=1|60=20260927-14:30:05.123|40=1|9702=X|10=000'), dict);
  assert.equal(msg.MsgType, 'NewOrderSingle');
  assert.equal(msg.BeginString, 'FIX.4.4');
  assert.equal(msg.SenderCompID, 'ME');
  assert.equal(msg.Side, 'Buy');
  assert.deepEqual(msg.TransactTime, at);
  assert.deepEqual(msg.Parties, [
    { PartyID: 'DESK-7', PartyRole: 'EnteringTrader' },
    { PartyID: 'ACME', PartyIDSource: 'Proprietary', PartyRole: 'ClientID' },
  ]);
  assert.equal(msg.Account, 'ACC');
  assert.equal(msg['9702'], 'X');
  assert.equal('BodyLength' in msg, false);
  assert.equal('CheckSum' in msg, false);
  assert.ok(Object.isFrozen(msg));
});

test('a group ends at the first field that is not a member', () => {
  const msg = toMessage(raw('8=FIX.4.4|35=D|453=3|448=A|452=3|1=ACC'), dict);
  assert.deepEqual(msg.Parties, [{ PartyID: 'A', PartyRole: 'ClientID' }]);
  assert.equal(msg.Account, 'ACC');
});

test('an unknown MsgType keeps its wire value', () => {
  assert.equal(toMessage(raw('8=FIX.4.4|35=ZZ|58=hi'), dict).MsgType, 'ZZ');
});

test('encodes in dictionary order: header, body, groups, custom tags, trailer', () => {
  const { fields } = fromMessage('NewOrderSingle', {
    9702: 'X', Price: 150.25, OrdType: 'Limit', Side: 'Buy', ClOrdID: 'ord-1', TransactTime: at,
    SenderCompID: 'ME', Parties: [{ PartyRole: 'ClientID', PartyID: 'ACME' }],
  }, dict, context);
  assert.deepEqual(tags(fields), [8, 35, 49, 11, 453, 448, 452, 54, 60, 40, 44, 9702]);
  assert.equal(valueOf(fields, 35), 'D');
  assert.equal(valueOf(fields, 54), '1');
  assert.equal(valueOf(fields, 453), '1');
  assert.equal(valueOf(fields, 452), '3');
  assert.equal(valueOf(fields, 60), '20260927-14:30:05.123');
});

test('fills BeginString and TransactTime when left out', () => {
  const { fields } = fromMessage('NewOrderSingle', { ClOrdID: 'o', Side: 'Buy', OrdType: 'Market' }, dict, context);
  assert.equal(valueOf(fields, 8), 'FIX.4.4');
  assert.equal(valueOf(fields, 60), '20260927-14:30:05.123');
});

test('null leaves a field out; numeric keys are raw text at the field\'s own position', () => {
  const { fields } = fromMessage('NewOrderSingle', { ClOrdID: 'o', Side: null, OrdType: 'Market', SenderCompID: 'ME', 52: 'garbage', BeginString: null }, dict, context);
  assert.deepEqual(tags(fields).slice(0, 3), [35, 49, 52]);
  assert.equal(valueOf(fields, 52), 'garbage');
  assert.equal(valueOf(fields, 54), undefined);
});

test('BodyLength and CheckSum are framing, not fields', () => {
  const { fields, framing } = fromMessage('Heartbeat', { CheckSum: '000', BodyLength: null }, dict, context);
  assert.deepEqual(framing, { checkSum: '000', bodyLength: null });
  assert.deepEqual(tags(fields), [8, 35]);
});

test('numeric tags 9 and 10 are framing, exactly like the named form', () => {
  const withChecksum = fromMessage('Heartbeat', { 10: '999' }, dict, context);
  assert.deepEqual(withChecksum.framing, { checkSum: '999' });
  assert.equal(tags(withChecksum.fields).includes(10), false);

  const withBodyLength = fromMessage('Heartbeat', { 9: '100' }, dict, context);
  assert.deepEqual(withBodyLength.framing, { bodyLength: '100' });
  assert.equal(tags(withBodyLength.fields).filter(t => t === 9).length, 0);

  assert.throws(() => fromMessage('Heartbeat', { CheckSum: '000', 10: '001' }, dict, context),
    { name: 'FIXEncodeError' });
});

test('mistakes are errors that say how to fix them', () => {
  assert.throws(() => fromMessage('NewOrderSingel', {}, dict, context),
    { name: 'FIXEncodeError', message: "Unknown message type 'NewOrderSingel'. Did you mean 'NewOrderSingle'?" });
  assert.throws(() => fromMessage('NewOrderSingle', { ClOrdID: 'o', Side: 'Buy', OrdType: 'Market', Prise: 1 }, dict, context),
    { message: "Unknown field 'Prise'. Did you mean 'Price'?" });
  assert.throws(() => fromMessage('NewOrderSingle', { ClOrdID: 'o', OrdType: 'Market' }, dict, context),
    { message: 'NewOrderSingle requires Side (54). Write Side: null to leave it out on purpose.' });
  assert.throws(() => fromMessage('NewOrderSingle', { ClOrdID: 'o', Side: 'Buy', OrdType: 'Market', 54: '2' }, dict, context),
    { message: 'Side is given twice (also as tag 54)' });
  assert.throws(() => fromMessage('NewOrderSingle', { MsgType: 'Logon' }, dict, context),
    { message: "MsgType 'Logon' doesn't match the message type 'NewOrderSingle'" });
});

test('round trip', () => {
  const input = { ClOrdID: 'o', Side: 'Sell', OrdType: 'Limit', Price: 10.5, OrderQty: 7, TransactTime: at, ExecInst: ['NotHeld'] };
  const msg = toMessage(fromMessage('NewOrderSingle', input, dict, context).fields, dict);
  assert.deepEqual({ ...msg, MsgType: undefined, BeginString: undefined }, { ...input, MsgType: undefined, BeginString: undefined });
});

const HEADER = '8=FIX.4.4|9=0|35=1|49=THEM|56=ME|34=2|52=20260929-12:00:00.000|';
const problemsOf = (text: string) => inspectMessage(raw(text), dict).problems.map(p => `${p.code}:${p.tag ?? ''}`);

test('a valid message has no problems', () => {
  assert.deepEqual(problemsOf(`${HEADER}112=ping|10=000`), []);
});

test('a message that carries MsgType twice has a repeated tag, whatever the second says, in every version', () => {
  for (const version of ['FIX.4.2', 'FIX.4.4', 'FIXT.1.1']) {
    const versioned = dictionaryFor(version);
    const text = (types: string) => `8=${version}|9=0|${types}|49=THEM|56=ME|34=2|52=20260929-12:00:00.000|112=ping|10=000`;
    const problems = (types: string) => inspectMessage(raw(text(types)), versioned).problems.map(p => `${p.code}:${p.tag ?? ''}`);
    assert.deepEqual(problems('35=1'), [], version);
    assert.deepEqual(problems('35=1|35=1'), ['TagAppearsMoreThanOnce:35'], version);
    assert.deepEqual(problems('35=1|35=0'), ['TagAppearsMoreThanOnce:35'], version);
    assert.equal(inspectMessage(raw(text('35=1|35=0')), versioned).message.MsgType, 'TestRequest', version);
  }
});

test('the length of a raw data field is a whole number without a sign: a negative one is a malformed value, as a non-numeric one is, in every version', () => {
  const cases: [string, string, string, number][] = [
    // version, MsgType, the fields after the header, the tag that is wrong
    ['FIX.4.2', 'A', '98=0|108=30|95=-1|96=abc', 95],
    ['FIX.4.4', 'A', '98=0|108=30|95=-1|96=abc', 95],
    ['FIX.4.4', 'A', '98=0|108=30|95=12ab|96=abc', 95],
    ['FIX.4.4', 'D', '11=o1|54=1|40=1|60=20260929-12:00:00.000|354=-1|355=abc', 354],
    ['FIX.4.4', '0', '212=-1|213=abc', 212],
    ['FIXT.1.1', 'A', '98=0|108=30|1137=9|1400=0|1401=-1|1402=abc', 1401],
    ['FIXT.1.1', 'A', '98=0|108=30|1137=9|1400=0|1401=3|1402=abc|1403=-5|1404=abc', 1403],
  ];
  for (const [version, msgType, fields, tag] of cases) {
    const text = `8=${version}|9=0|35=${msgType}|49=THEM|56=ME|34=2|52=20260929-12:00:00.000|${fields}|10=000`;
    const found = inspectMessage(raw(text), dictionaryFor(version)).problems.map(p => `${p.code}:${p.tag ?? ''}`);
    assert.deepEqual(found, [`IncorrectDataFormatForValue:${tag}`], `${version} ${fields}`);
  }
  // It is the length that is blamed, wherever the data field is: one with no data field after it is as malformed.
  for (const [version, fields, tag] of [
    ['FIX.4.2', '98=0|108=30|95=-1', 95], ['FIX.4.4', '98=0|108=30|95=-1', 95], ['FIXT.1.1', '98=0|108=30|1137=9|1400=0|1401=-1', 1401],
  ] as const) {
    const text = `8=${version}|9=0|35=A|49=THEM|56=ME|34=2|52=20260929-12:00:00.000|${fields}|10=000`;
    assert.deepEqual(inspectMessage(raw(text), dictionaryFor(version)).problems.map(p => `${p.code}:${p.tag}`), [`IncorrectDataFormatForValue:${tag}`], `${version} ${fields}`);
  }
  // A field that only stands before a data field is not its length: a text or a price may be what it is.
  for (const version of ['FIX.4.2', 'FIX.4.4']) {
    const news = `8=${version}|9=0|35=B|49=THEM|56=ME|34=2|52=20260929-12:00:00.000|148=h|33=1|58=-1|355=abc|10=000`;
    assert.deepEqual(inspectMessage(raw(news), dictionaryFor(version)).problems.filter(p => p.code === 'IncorrectDataFormatForValue'), [], `${version} Text`);
    const order = `8=${version}|9=0|35=D|49=THEM|56=ME|34=2|52=20260929-12:00:00.000|11=o1|55=IBM|54=1|60=20260929-12:00:00.000|40=2|38=100|44=-1|355=abc|10=000`;
    assert.deepEqual(inspectMessage(raw(order), dictionaryFor(version)).problems.filter(p => p.code === 'IncorrectDataFormatForValue'), [], `${version} Price`);
  }
  // A length that is right, 0 included, is no problem.
  for (const [version, fields] of [['FIX.4.2', '98=0|108=30|95=3|96=abc'], ['FIX.4.4', '98=0|108=30|95=0|96=x'], ['FIXT.1.1', '98=0|108=30|1137=9|1400=0|1401=3|1402=abc']] as const) {
    const text = `8=${version}|9=0|35=A|49=THEM|56=ME|34=2|52=20260929-12:00:00.000|${fields}|10=000`;
    assert.deepEqual(inspectMessage(raw(text), dictionaryFor(version)).problems.filter(p => p.code === 'IncorrectDataFormatForValue'), [], `${version} ${fields}`);
  }
});

test('decode problems are reported, never thrown', () => {
  assert.deepEqual(problemsOf(`${HEADER}112=a|112=b|10=000`), ['TagAppearsMoreThanOnce:112']);
  assert.deepEqual(problemsOf(`${HEADER}10=000`), ['RequiredTagMissing:112']);
  assert.deepEqual(problemsOf(`${HEADER}112=|10=000`), ['TagSpecifiedWithoutAValue:112']);
  assert.deepEqual(problemsOf(`${HEADER.replace('34=2', '34=abc')}112=x|10=000`), ['IncorrectDataFormatForValue:34']);
  assert.deepEqual(problemsOf(`${HEADER}112=x|9702=y|150=0|10=000`), ['InvalidTagNumber:9702', 'TagNotDefinedForThisMessageType:150']);
  assert.ok(problemsOf(`${HEADER.replace('35=1', '35=ZZ')}10=000`).includes('InvalidMsgType:35'));
});

test('bad enum values and group counts', () => {
  const order = `${HEADER.replace('35=1', '35=D')}11=o|60=20260929-12:00:00.000|40=1|`;
  assert.deepEqual(problemsOf(`${order}54=Z|10=000`), ['ValueIsIncorrect:54']);
  assert.deepEqual(problemsOf(`${order}54=1|453=3|448=A|452=3|10=000`), ['IncorrectNumInGroupCountForRepeatingGroup:453']);
  assert.deepEqual(problemsOf(`${order}54=1|453=1|448=A|10=000`), []);
});

test('the header, the body and the trailer must come in that order', () => {
  const body = '11=o|54=1|60=20260929-12:00:00.000|40=1|';
  const header = '49=THEM|56=ME|34=2|52=20260929-12:00:00.000|';
  assert.deepEqual(problemsOf(`8=FIX.4.4|9=0|35=D|${header}${body}10=000`), []);
  // Header fields may come in any order among themselves.
  assert.deepEqual(problemsOf(`8=FIX.4.4|9=0|35=D|52=20260929-12:00:00.000|34=2|56=ME|49=THEM|${body}10=000`), []);
  // The body first: the first header field after it is the one out of order, reported once.
  assert.deepEqual(problemsOf(`8=FIX.4.4|9=0|35=D|${body}${header}10=000`), ['TagSpecifiedOutOfRequiredOrder:49']);
  assert.deepEqual(problemsOf(`8=FIX.4.4|9=0|35=D|55=IBM|${header}${body}10=000`), ['TagSpecifiedOutOfRequiredOrder:49']);
  // A body field after the trailer began.
  assert.deepEqual(problemsOf(`${HEADER}93=1|89=x|112=ping|10=000`), ['TagSpecifiedOutOfRequiredOrder:112']);
  const problem = inspectMessage(raw(`8=FIX.4.4|9=0|35=D|${body}${header}10=000`), dict).problems[0];
  assert.equal(problem?.text, 'SenderCompID (49) is out of order: the header comes first, then the body, then the trailer');
});

test('a user-defined tag may come anywhere among the header, body and trailer fields', () => {
  const body = '11=o|54=1|60=20260929-12:00:00.000|40=1|';
  const stamp = '52=20260929-12:00:00.000|';
  // A tag no dictionary knows is a problem of its own (and one the session lets pass); only the order problems are looked at.
  const orderOf = (found: ReturnType<typeof inspectMessage>) =>
    found.problems.filter(p => p.code === 'TagSpecifiedOutOfRequiredOrder').map(p => `${p.code}:${p.tag}`);
  const orderProblems = (version: string, text: string) =>
    orderOf(inspectMessage(raw(text.replace('FIX.4.4', version)), dictionaryFor(version)));
  const orderIn = (text: string) => orderOf(inspectMessage(raw(text), dict));
  for (const version of ['FIX.4.4', 'FIX.4.2']) {
    const start = '8=FIX.4.4|9=0|35=D|';
    assert.deepEqual(orderProblems(version, `${start}49=THEM|56=ME|5001=x|34=2|${stamp}${body}10=000`), [], version);
    assert.deepEqual(orderProblems(version, `${start}5001=x|49=THEM|56=ME|34=2|${stamp}${body}10=000`), [], version);
    assert.deepEqual(orderProblems(version, `${start}49=THEM|56=ME|34=2|${stamp}${body}93=1|89=x|5001=x|10=000`), [], version);
    assert.deepEqual(orderProblems(version, `${start}49=THEM|56=ME|34=2|${stamp}5001=x|${body}5002=y|10=000`), [], version);
  }
  // At the end of a header Hop entry, and between the entry and the next header field.
  assert.deepEqual(orderIn(`8=FIX.4.4|9=0|35=D|49=THEM|56=ME|627=1|628=HOP|5001=x|34=2|${stamp}${body}10=000`), []);
  assert.deepEqual(orderIn(`8=FIX.4.4|9=0|35=D|49=THEM|56=ME|627=1|628=HOP|630=r|5001=x|34=2|${stamp}${body}10=000`), []);
  // A field a custom dictionary names, placed between header fields.
  const acme = extendDictionary(dict, { fields: { DeskName: { tag: 6001 } }, messages: { NewOrderSingle: ['DeskName'] } });
  const custom = inspectMessage(raw(`8=FIX.4.4|9=0|35=D|49=THEM|56=ME|6001=desk|34=2|${stamp}${body}10=000`), acme);
  assert.deepEqual(custom.problems, []);
  assert.equal(custom.message['DeskName'], 'desk');
  // Standard fields keep their order beside a user-defined tag.
  assert.deepEqual(orderIn(`8=FIX.4.4|9=0|35=D|49=THEM|5001=x|${body}56=ME|34=2|${stamp}10=000`), ['TagSpecifiedOutOfRequiredOrder:56']);
  assert.deepEqual(orderIn(`${HEADER}93=1|89=x|5001=x|112=ping|10=000`), ['TagSpecifiedOutOfRequiredOrder:112']);
});

test('a user-defined tag in the middle of a header Hop entry ends the entry; the Hop field after it is not also an order problem', () => {
  const body = '11=o|54=1|60=20260929-12:00:00.000|40=1|';
  const stamp = '20260929-12:00:00.000';
  // 628 and 629 are fields of the header's group of hops (HopGrp): wherever one stands, it is a header field, not a body field.
  const found = inspectMessage(raw(`8=FIX.4.4|9=0|35=D|49=THEM|56=ME|627=1|628=HOP|5001=x|629=${stamp}|34=2|52=${stamp}|${body}10=000`), dict);
  assert.deepEqual(found.problems, [
    { code: 'InvalidTagNumber', tag: 5001, text: 'Tag 5001 is not defined in FIX.4.4' },
    { code: 'TagNotDefinedForThisMessageType', tag: 629, text: 'HopSendingTime (629) is not defined for this message type' },
  ]);
  assert.deepEqual(found.message.HopGrp, [{ HopCompID: 'HOP' }]);
  assert.equal(found.message.MsgSeqNum, 2);
  // A header group's field after the body began is out of order, like any header field.
  assert.deepEqual(problemsOf(`8=FIX.4.4|9=0|35=D|49=THEM|56=ME|34=2|52=${stamp}|${body}627=1|628=HOP|10=000`), ['TagSpecifiedOutOfRequiredOrder:627']);
  // A whole Hop entry among the header fields is in order.
  assert.deepEqual(problemsOf(`8=FIX.4.4|9=0|35=D|49=THEM|56=ME|627=1|628=HOP|629=${stamp}|630=7|34=2|52=${stamp}|${body}10=000`), []);
});

test('the fields of a group entry must come in the order the group gives them, its first field first', () => {
  const order = `${HEADER.replace('35=1', '35=D')}11=o|60=20260929-12:00:00.000|40=1|54=1|`;
  assert.deepEqual(problemsOf(`${order}453=1|448=A|447=D|452=3|10=000`), []);
  assert.deepEqual(problemsOf(`${order}453=2|448=A|452=3|447=D|448=B|452=3|10=000`), ['RepeatingGroupFieldsOutOfOrder:447']);
  // An entry that does not begin with the group's first field is not counted as an entry.
  assert.deepEqual(problemsOf(`${order}453=1|452=3|448=A|10=000`).slice(0, 1), ['RepeatingGroupFieldsOutOfOrder:452']);
  assert.ok(!problemsOf(`${order}453=1|452=3|448=A|10=000`).includes('IncorrectNumInGroupCountForRepeatingGroup:453'));
  // A count with nothing of the group after it is still a wrong count.
  assert.deepEqual(problemsOf(`${order}453=1|10=000`), ['IncorrectNumInGroupCountForRepeatingGroup:453']);
  const texts = (text: string) => inspectMessage(raw(text), dict).problems.map(found => found.text);
  assert.equal(texts(`${order}453=2|448=A|452=3|447=D|448=B|452=3|10=000`)[0], 'PartyIDSource (447) is out of order in its Parties entry');
  assert.equal(texts(`${order}453=1|452=3|448=A|10=000`)[0], 'Each Parties entry must begin with PartyID (448), not PartyRole (452)');
});

test('rawValue gives the exact wire text; text that is not UTF-8 keeps its bytes', () => {
  const latin = inspectMessage(raw(`${HEADER}112=caf\xe9|10=000`), dict).message;
  assert.equal(latin.TestReqID, 'caf\xe9');
  assert.equal(rawValue(latin, 112), 'caf\xe9');
  assert.equal(rawValue(latin, 35), '1');
  const utf8 = inspectMessage(raw(`${HEADER}112=caf\xc3\xa9|10=000`), dict).message;
  assert.equal(utf8.TestReqID, 'café');
  assert.equal(rawValue(utf8, 112), 'caf\xc3\xa9');
  assert.equal(rawValue(utf8, 9999), undefined);
  assert.equal(Object.keys(utf8).some(key => key.includes('raw')), false);   // raw values are not message fields
});

test('a value an open code set takes is no problem, is read as its text, and goes out again as it came', () => {
  // SecurityIDSource (22) is open from 100 up: 100 is a source the two sides agreed on.
  const text = `${HEADER.replace('35=1', '35=D')}11=A1|22=100|48=XYZ|54=1|60=20260929-12:00:00.000|40=1|10=000|`;
  const { message, problems } = inspectMessage(raw(text), dict);
  assert.deepEqual(problems, []);
  assert.equal(message.SecurityIDSource, '100');
  const { MsgType: _msgType, ...fields } = message;
  assert.equal(valueOf(fromMessage('NewOrderSingle', fields, dict, context).fields, 22), '100');
  // 99 is neither a code nor in the open range.
  assert.deepEqual(problemsOf(text.replace('22=100', '22=99')), ['ValueIsIncorrect:22']);
});

test('in FIX 4.2 an IOI quantity is a number or S, M, L: it is read, and goes out again as it came', () => {
  const dict42 = dictionaryFor('FIX.4.2');
  const context42 = { version: 'FIX.4.2', now: () => at };
  const ioi = (shares: string) => `8=FIX.4.2|9=0|35=6|49=THEM|56=ME|34=2|52=20260929-12:00:00.000|23=I1|28=N|55=XYZ|54=1|27=${shares}|10=000|`;
  const inspect = (shares: string) => inspectMessage(raw(ioi(shares)), dict42);
  assert.deepEqual(inspect('15000').problems, []);
  assert.equal(inspect('15000').message.IOIShares, '15000');
  assert.equal(inspect('L').message.IOIShares, 'Large');
  assert.deepEqual(inspect('lots').problems.map(p => `${p.code}:${p.tag}`), ['ValueIsIncorrect:27']);
  const { MsgType: _msgType, ...fields } = inspect('15000').message;
  assert.equal(valueOf(fromMessage('IOI', fields, dict42, context42).fields, 27), '15000');
  assert.equal(valueOf(fromMessage('IOI', { ...fields, IOIShares: 'Small' }, dict42, context42).fields, 27), 'S');
});

test('a group and a field may share a name: it is the group where the level holds that group, and the field elsewhere', () => {
  // As in FIX 5.0 SP2, where the group RateSource (NoRateSources, 1445) begins with the field RateSource (1446).
  const sources = indexDictionary({
    version: 'FIX.9.9',
    fields: [
      { tag: 8, name: 'BeginString', type: 'String' }, { tag: 9, name: 'BodyLength', type: 'Length' },
      { tag: 35, name: 'MsgType', type: 'String' }, { tag: 10, name: 'CheckSum', type: 'String' },
      { tag: 11, name: 'ClOrdID', type: 'String' },
      { tag: 1445, name: 'NoRateSources', type: 'NumInGroup' },
      { tag: 1446, name: 'RateSource', type: 'int', codes: [{ name: 'Bloomberg', value: '0' }, { name: 'Reuters', value: '1' }] },
      { tag: 1447, name: 'RateSourceType', type: 'int', codes: [{ name: 'Primary', value: '0' }, { name: 'Secondary', value: '1' }] },
      { tag: 700, name: 'NoOuters', type: 'NumInGroup' },
      { tag: 701, name: 'OuterRef', type: 'String' },
      { tag: 720, name: 'NoNotes', type: 'NumInGroup' },
      { tag: 721, name: 'NoteText', type: 'String' },
    ],
    groups: [
      { name: 'RateSource', countTag: 1445, members: [{ kind: 'field', tag: 1446, required: true }, { kind: 'field', tag: 1447, required: false }] },
      // A group whose entries hold the group RateSource, in a message where RateSource is also a field.
      { name: 'Outers', countTag: 700, members: [{ kind: 'field', tag: 701, required: true }, { kind: 'group', name: 'RateSource', required: false }] },
      { name: 'Notes', countTag: 720, members: [{ kind: 'field', tag: 721, required: true }] },
    ],
    messages: [
      { name: 'RateReport', msgType: 'U1', admin: false, members: [{ kind: 'field', tag: 11, required: true }, { kind: 'group', name: 'RateSource', required: false }] },
      { name: 'RateNote', msgType: 'U2', admin: false, members: [{ kind: 'field', tag: 11, required: true }, { kind: 'field', tag: 1446, required: false }, { kind: 'group', name: 'Notes', required: false }] },
      { name: 'RateNested', msgType: 'U3', admin: false, members: [{ kind: 'field', tag: 11, required: true }, { kind: 'field', tag: 1446, required: false }, { kind: 'group', name: 'Outers', required: false }] },
    ],
    header: [{ kind: 'field', tag: 8, required: true }, { kind: 'field', tag: 9, required: true }, { kind: 'field', tag: 35, required: true }],
    trailer: [{ kind: 'field', tag: 10, required: true }],
  });
  const wire = (type: string, fields: Record<string, unknown>) =>
    fromMessage(type, fields, sources, { version: 'FIX.9.9' }).fields.map(field => `${field.tag}=${field.value}`).join('|');

  // In a RateReport, RateSource is the group; in each of its entries, the field.
  const entries = [{ RateSource: 'Bloomberg', RateSourceType: 'Primary' }, { RateSource: 'Reuters' }];
  assert.equal(wire('RateReport', { ClOrdID: 'A1', RateSource: entries }), '8=FIX.9.9|35=U1|11=A1|1445=2|1446=0|1447=0|1446=1');
  const decoded = toMessage(raw('8=FIX.9.9|9=0|35=U1|11=A1|1445=2|1446=0|1447=0|1446=1|10=000|'), sources);
  assert.deepEqual(decoded.RateSource, entries);
  // What was decoded encodes again to the same fields.
  const { MsgType: _msgType, ...again } = decoded;
  assert.equal(wire('RateReport', again), '8=FIX.9.9|35=U1|11=A1|1445=2|1446=0|1447=0|1446=1');

  // In a RateNote, which has the field and not the group, RateSource is the field.
  assert.equal(wire('RateNote', { ClOrdID: 'A1', RateSource: 'Reuters' }), '8=FIX.9.9|35=U2|11=A1|1446=1');
  assert.throws(() => wire('RateNote', { ClOrdID: 'A1', RateSource: entries }), { name: 'FIXEncodeError', message: /RateSource \(1446\) can't be an array/ });
  // A group named in a message that does not have it is still an error, and so is a name that is neither.
  assert.equal(wire('RateNote', { ClOrdID: 'A1', Notes: [{ NoteText: 'x' }] }), '8=FIX.9.9|35=U2|11=A1|720=1|721=x');
  assert.throws(() => wire('RateReport', { ClOrdID: 'A1', Notes: [{ NoteText: 'x' }] }), { name: 'FIXEncodeError', message: /Notes is not a group of this message/ });
  assert.throws(() => wire('RateNote', { ClOrdID: 'A1', Parties: [] }), { name: 'FIXEncodeError', message: /Unknown field 'Parties'/ });

  // Inside a group entry that holds the group, the name is the group, though the message itself has the field.
  const nested = { ClOrdID: 'A1', RateSource: 'Reuters', Outers: [{ OuterRef: 'x', RateSource: entries }, { OuterRef: 'y' }] };
  const nestedWire = '8=FIX.9.9|35=U3|11=A1|1446=1|700=2|701=x|1445=2|1446=0|1447=0|1446=1|701=y';
  assert.equal(wire('RateNested', nested), nestedWire);
  const decodedNested = toMessage(raw('8=FIX.9.9|9=0|35=U3|11=A1|1446=1|700=2|701=x|1445=2|1446=0|1447=0|1446=1|701=y|10=000|'), sources);
  assert.deepEqual(decodedNested.Outers, nested.Outers);
  assert.equal(decodedNested.RateSource, 'Reuters');
  const { MsgType: _nestedType, ...nestedAgain } = decodedNested;
  assert.equal(wire('RateNested', nestedAgain), nestedWire);
  // A group entry that holds the group wants an array for it; one that does not, takes the name as the field.
  assert.throws(() => wire('RateNested', { ClOrdID: 'A1', Outers: [{ OuterRef: 'x', RateSource: 'Reuters' }] }), { name: 'FIXEncodeError', message: /RateSource must be an array of entries/ });
});

test('a group in the header is the group in every message, though a field shares its name', () => {
  const shared = () => indexDictionary({
    version: 'FIX.9.9',
    fields: [
      { tag: 8, name: 'BeginString', type: 'String' }, { tag: 9, name: 'BodyLength', type: 'Length' },
      { tag: 35, name: 'MsgType', type: 'String' }, { tag: 10, name: 'CheckSum', type: 'String' },
      { tag: 11, name: 'ClOrdID', type: 'String' },
      { tag: 1445, name: 'NoRateSources', type: 'NumInGroup' },
      { tag: 1446, name: 'RateSource', type: 'int', codes: [{ name: 'Bloomberg', value: '0' }, { name: 'Reuters', value: '1' }] },
    ],
    groups: [{ name: 'RateSource', countTag: 1445, members: [{ kind: 'field', tag: 1446, required: true }] }],
    messages: [{ name: 'Plain', msgType: 'U1', admin: false, members: [{ kind: 'field', tag: 11, required: true }] }],
    header: [{ kind: 'field', tag: 8, required: true }, { kind: 'field', tag: 9, required: true }, { kind: 'field', tag: 35, required: true },
      { kind: 'group', name: 'RateSource', required: false }],
    trailer: [{ kind: 'field', tag: 10, required: true }],
  });
  const fields = fromMessage('Plain', { ClOrdID: 'A1', RateSource: [{ RateSource: 'Reuters' }] }, shared(), { version: 'FIX.9.9' }).fields;
  assert.equal(fields.map(field => `${field.tag}=${field.value}`).join('|'), '8=FIX.9.9|35=U1|1445=1|1446=1|11=A1');
});
