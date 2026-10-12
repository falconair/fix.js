// The acceptance-script reader on its own: needs neither Java nor the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessage, compare, fieldsOf, MessageReader, parseScript, passedOver, timestamp } from './script.ts';

const soh = (text: string): string => text.replaceAll('|', '\x01');
const shown = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1').replaceAll('\x01', '|');
const NOW = new Date('2026-09-30T12:00:00.000Z');

test('a script is read as steps: connect, send, expect, disconnect, each for a numbered client', () => {
  const steps = parseScript(soh([
    '# a comment, then a blank line',
    '',
    'iCONNECT',
    'I8=FIX.4.4|35=A|34=1|',
    'E8=FIX.4.4|9=10|35=A|34=1|',
    'i2,CONNECT',
    'I2,8=FIX.4.4|35=0|34=2|',
    'E2,8=FIX.4.4|35=5|',
    'e2,DISCONNECT',
    'eDISCONNECT\r',
  ].join('\n')));
  assert.deepEqual(steps.map(step => `${step.line} ${step.kind} ${step.client}`), [
    '3 connect 1', '4 send 1', '5 expect 1', '6 connect 2', '7 send 2', '8 expect 2', '9 disconnect 2', '10 disconnect 1',
  ]);
  assert.deepEqual(steps[1], { kind: 'send', client: 1, line: 4, text: soh('8=FIX.4.4|35=A|34=1|') });
  assert.deepEqual(steps[4], { kind: 'send', client: 2, line: 7, text: soh('8=FIX.4.4|35=0|34=2|') });
  assert.deepEqual(steps[2]?.kind === 'expect' && [...steps[2].fields], [[8, 'FIX.4.4'], [9, '10'], [35, 'A'], [34, '1']]);
  assert.deepEqual(steps[5]?.kind === 'expect' && [...steps[5].fields], [[8, 'FIX.4.4'], [35, '5']]);
});

test('a line shaped like a step that this runner does not know is an error naming the line', () => {
  assert.throws(() => parseScript('iCONNECT\nxSOMETHING'), /Line 2 is not a step this runner knows: xSOMETHING/);
});

test('fields are read by tag, the last value of a repeated tag winning', () => {
  assert.deepEqual([...fieldsOf(soh('8=FIX.4.4|58=a|58=b|'))], [[8, 'FIX.4.4'], [58, 'b']]);
});

test('timestamps are UTC with milliseconds', () => {
  assert.equal(timestamp(new Date('2026-01-02T03:04:05.006Z')), '20260102-03:04:05.006');
});

test('a sent message gets its BodyLength and CheckSum, and <TIME> becomes the time now', () => {
  assert.equal(shown(buildMessage(soh('8=FIX.4.4|35=0|34=2|52=<TIME>|'), NOW)), '8=FIX.4.4|9=35|35=0|34=2|52=20260930-12:00:00.000|10=106|');
});

test('<TIME+n> and <TIME-n> are n times 1.1 s later and earlier', () => {
  const message = shown(buildMessage(soh('8=FIX.4.4|35=0|52=<TIME-10>|122=<TIME+121>|60=<TIME>|'), NOW));
  assert.match(message, /\|52=20260930-11:59:49\.000\|122=20260930-12:02:13\.100\|60=20260930-12:00:00\.000\|/);
});

test('a BodyLength or CheckSum the line gives is sent as given; 10=0 goes out as 10=000', () => {
  assert.equal(shown(buildMessage(soh('8=FIX.4.4|9=3|35=0|34=2|'), NOW)), '8=FIX.4.4|9=3|35=0|34=2|10=120|');
  assert.equal(shown(buildMessage(soh('8=FIX.4.4|35=0|34=2|10=0|'), NOW)), '8=FIX.4.4|9=10|35=0|34=2|10=000|');
  assert.equal(shown(buildMessage(soh('8=FIX.4.4|35=0|34=2|10=123|'), NOW)), '8=FIX.4.4|9=10|35=0|34=2|10=123|');
});

test('a line that does not begin with a BeginString is sent as written, with a CheckSum added', () => {
  assert.equal(shown(buildMessage(soh('35=0|8=FIX.4.4|9=5|34=2|52=<TIME>|'), NOW)), '35=0|8=FIX.4.4|9=5|34=2|52=<TIME>|10=200|');
  assert.equal(shown(buildMessage(soh('35=0|8=FIX.4.4|9=5|34=2|10=001|'), NOW)), '35=0|8=FIX.4.4|9=5|34=2|10=001|');
});

const expected = fieldsOf(soh('8=FIX.4.4|9=62|35=5|34=2|49=ISLD|52=00000000-00:00:00.000|56=TW|58=Bad thing|'));
const received = (changes: Record<number, string | undefined> = {}): Map<number, string> => {
  const fields = fieldsOf(soh('8=FIX.4.4|9=62|35=5|34=2|49=ISLD|52=20260930-12:00:00.000|56=TW|58=Bad thing|10=123|'));
  for (const [tag, value] of Object.entries(changes)) {
    if (value === undefined) fields.delete(Number(tag));
    else fields.set(Number(tag), value);
  }
  return fields;
};

test('a message matches when every field but the timestamps and CheckSum is the same', () => {
  assert.deepEqual(compare(expected, received()), { differences: [], ignored: [] });
});

test('Text need only begin with what is expected', () => {
  assert.deepEqual(compare(expected, received({ 58: 'Bad thing, field=52', 9: '72' })).differences, ['BodyLength (9) is 72, expected 62']);
  assert.deepEqual(compare(expected, received({ 58: 'Worse' })).differences, ['Field 58 is Worse, expected Bad thing']);
});

test('a different MsgType is the only difference reported', () => {
  assert.deepEqual(compare(expected, received({ 35: '3', 34: '9' })).differences, ['MsgType (35) is 3, expected 5']);
});

test('neither side may have a field the other lacks', () => {
  assert.deepEqual(compare(expected, received({ 141: 'Y' })).differences, ['Unexpected field 141=Y']);
  assert.deepEqual(compare(expected, received({ 58: undefined })).differences, ['Missing field 58']);
});

test('BodyLength is compared only when the expected timestamps are as long as the ones received', () => {
  assert.deepEqual(compare(expected, received({ 9: '99' })).differences, ['BodyLength (9) is 99, expected 62']);
  const short = new Map(expected).set(52, '<TIME>');
  assert.deepEqual(compare(short, received({ 9: '99' })).differences, []);
});

test('an ignored tag must be there, but its value is not compared', () => {
  const ignore = new Set([58]);
  assert.deepEqual(compare(expected, received({ 58: 'Worse', 9: '58' }), ignore), { differences: [], ignored: [58] });
  assert.deepEqual(compare(expected, received({ 58: undefined }), ignore), { differences: ['Missing field 58'], ignored: [] });
  // Where the value is as expected, nothing was ignored, and BodyLength still counts.
  assert.deepEqual(compare(expected, received({ 9: '99' }), ignore), { differences: ['BodyLength (9) is 99, expected 62'], ignored: [] });
});

// A message framed with its true BodyLength, as a peer would send it.
const framed = (body: string): Map<number, string> => fieldsOf(soh(`8=FIX.4.4|9=${body.length}|${body}10=000|`));

test('an ignored Text of another length is let through, with the BodyLength it must then have', () => {
  const wanted = framed('35=5|34=2|58=Bad thing|');
  assert.deepEqual(compare(wanted, framed('35=5|34=2|58=Worse|'), new Set([58])), { differences: [], ignored: [58] });
  assert.deepEqual(compare(wanted, framed('35=5|34=2|58=A much longer reason|'), new Set([58])), { differences: [], ignored: [58] });
});

test('an ignored value does not excuse a repeated field: the BodyLength still has to add up', () => {
  const wanted = framed('35=5|34=2|45=7|58=Bad thing|');
  const sent = framed('35=5|34=2|45=9|45=7|58=Worse|');
  assert.equal(sent.get(9), '29');
  assert.deepEqual(compare(wanted, sent, new Set([58])), {
    differences: ['BodyLength (9) is 29, expected 24 (28 adjusted by -4 for ignored 58)'],
    ignored: [58],
  });
});

test('an ignored value does not excuse a BodyLength that is nowhere near', () => {
  const wanted = framed('35=5|34=2|58=Bad thing|');
  const sent = framed('35=5|34=2|58=Worse|').set(9, '999');
  assert.deepEqual(compare(wanted, sent, new Set([58])), {
    differences: ['BodyLength (9) is 999, expected 19 (23 adjusted by -4 for ignored 58)'],
    ignored: [58],
  });
});

test('a Text that goes on from the expected one is ignored when ruled so, and is a BodyLength difference when not', () => {
  const wanted = framed('35=5|34=2|58=Nope|');
  const sent = framed('35=5|34=2|58=Nope!!|');
  assert.deepEqual(compare(wanted, sent, new Set([58])), { differences: [], ignored: [58] });
  assert.deepEqual(compare(wanted, sent), { differences: ['BodyLength (9) is 20, expected 18'], ignored: [] });
});

test('every ignored tag that differed adjusts the BodyLength, and one that did not adjusts nothing', () => {
  const wanted = framed('35=D|38=100|58=Nope|54=1|');
  const ignore = new Set([38, 58, 54]);
  assert.deepEqual(compare(wanted, framed('35=D|38=1000|58=Nope!!|54=1|'), ignore), { differences: [], ignored: [38, 58] });
  assert.deepEqual(compare(wanted, framed('35=D|38=1000|58=Nope!!|54=1|').set(9, '24'), ignore), {
    differences: ['BodyLength (9) is 24, expected 28 (25 adjusted by +3 for ignored 38, 58)'],
    ignored: [38, 58],
  });
});

// An expected line whose BodyLength is less than its own fields come to: 17, for fields that come to 23.
const tooShort = (body: string): Map<number, string> => framed(body).set(9, '17');

test('an expected BodyLength that the expected fields themselves exceed is not compared', () => {
  const wanted = tooShort('35=5|34=2|58=Bad thing|');
  assert.deepEqual(compare(wanted, framed('35=5|34=2|58=Bad thing|')), { differences: [], ignored: [] });
  assert.deepEqual(compare(wanted, framed('35=5|34=2|58=Worse|'), new Set([58])), { differences: [], ignored: [58] });
  assert.deepEqual(compare(wanted, framed('35=5|34=2|58=A much longer reason|'), new Set([58])), { differences: [], ignored: [58] });
});

test('where the expected BodyLength is not compared, the message is held to its own fields', () => {
  const wanted = tooShort('35=5|34=2|58=Bad thing|');
  // A repeated field, an empty one and a tag that is not a number are not among the fields read, but BodyLength counts them.
  assert.deepEqual(compare(wanted, framed('35=5|34=2|34=2|58=Bad thing|')).differences, ['BodyLength (9) is 28, but the fields read from the message come to 23']);
  assert.deepEqual(compare(wanted, framed('35=5|34=2|58=Bad thing|141=|')).differences, ['BodyLength (9) is 28, but the fields read from the message come to 23']);
  assert.deepEqual(compare(wanted, framed('35=5|34=2|58=Bad thing|x=1|')).differences, ['BodyLength (9) is 27, but the fields read from the message come to 23']);
  assert.deepEqual(compare(wanted, framed('35=5|34=2|34=2|58=Worse|'), new Set([58])), {
    differences: ['BodyLength (9) is 24, but the fields read from the message come to 19'],
    ignored: [58],
  });
  // A field the expected line lacks is a difference of its own, as anywhere.
  assert.deepEqual(compare(wanted, framed('35=5|34=2|58=Bad thing|141=Y|')).differences, ['Unexpected field 141=Y']);
});

test('an expected BodyLength is compared as it stands unless the expected fields exceed it', () => {
  // One less than the fields come to: not compared.
  assert.deepEqual(compare(framed('35=5|34=2|58=Bad thing|').set(9, '22'), framed('35=5|34=2|58=Bad thing|')).differences, []);
  // What the fields come to: compared.
  const exact = framed('35=5|34=2|58=Bad thing|');
  assert.deepEqual(compare(exact, framed('35=5|34=2|58=Bad thing|')).differences, []);
  assert.deepEqual(compare(exact, framed('35=5|34=2|58=Bad thing|').set(9, '24')).differences, ['BodyLength (9) is 24, expected 23']);
  // More than the fields read come to, as on a line with a repeated tag: compared.
  const repeated = framed('35=5|34=2|45=9|45=7|');
  assert.equal(repeated.get(9), '20');
  assert.deepEqual(compare(repeated, framed('35=5|34=2|45=9|45=7|')).differences, []);
  assert.deepEqual(compare(repeated, framed('35=5|34=2|45=7|')).differences, ['BodyLength (9) is 15, expected 20']);
});

test('received bytes are split into messages, however they arrive', () => {
  const one = buildMessage(soh('8=FIX.4.4|35=0|34=2|'), NOW);
  const two = buildMessage(soh('8=FIX.4.4|35=1|34=3|112=PING|'), NOW);
  const reader = new MessageReader();
  const all = Buffer.concat([one, two]);
  assert.deepEqual(reader.push(all.subarray(0, 5)), []);
  assert.deepEqual(reader.push(all.subarray(5, one.length + 9)).map(message => message.replaceAll('\x01', '|')), ['8=FIX.4.4|9=10|35=0|34=2|10=166|']);
  assert.deepEqual(reader.push(all.subarray(one.length + 9)).map(message => fieldsOf(message).get(112)), ['PING']);
});

test('a message whose BodyLength or CheckSum is wrong is an error, as are bytes that are not FIX', () => {
  assert.throws(() => new MessageReader().push(Buffer.from(soh('8=FIX.4.4|9=10|35=0|34=2|10=000|'), 'latin1')), /BodyLength or CheckSum is wrong in 8=FIX\.4\.4\|9=10\|35=0\|34=2\|10=000\|/);
  assert.throws(() => new MessageReader().push(Buffer.from('hello there', 'latin1')), /Not the start of a FIX message: hello there/);
});

test("a line that is not a step is passed over, as QuickFIX/J's runner passes over it", () => {
  const steps = parseScript(['iCONNECT', 'z', 'a comment that lost its hash sign', 'I8=FIX.4.4\x0135=0\x01', 'e the end'].join('\n'));
  assert.deepEqual(steps.map(step => [step.kind, step.line]), [['connect', 1], ['send', 4]]);
  // A line shaped like a step (a letter, then a word in capitals) that this runner lacks is still an error.
  assert.throws(() => parseScript('iCONNECT\niSET_SESSION,ResetOnLogon=Y'), /Line 2 is not a step this runner knows: iSET_SESSION,ResetOnLogon=Y/);
});

test('the lines passed over can be listed, and a strict reading refuses the first of them', () => {
  const text = ['iCONNECT', '# a comment', '', ' I8=FIX.4.4\x0135=0\x01', 'eDisconnect', 'I8=FIX.4.4\x0135=0\x01'].join('\n');
  // A comment and a blank line are not steps either, but they are not passed over: they are what they look like.
  assert.deepEqual(passedOver(text), [4, 5]);
  assert.deepEqual(parseScript(text).map(step => step.line), [1, 6]);
  assert.throws(() => parseScript(text, { strict: true }), /^Error: Line 4 is not a step: {2}I8=FIX\.4\.4\|35=0\|$/);
  assert.deepEqual(parseScript(['iCONNECT', '# a comment', 'eDISCONNECT'].join('\n'), { strict: true }).map(step => step.kind), ['connect', 'disconnect']);
});

test("a field the script's line lacks is let through only when ruled so, and counts in the BodyLength", () => {
  const wanted = framed('35=A|34=1|98=0|108=30|');
  const sent = framed('35=A|34=1|98=0|108=30|1137=10|');
  assert.deepEqual(compare(wanted, sent).differences, ['Unexpected field 1137=10', 'BodyLength (9) is 30, expected 22']);
  assert.deepEqual(compare(wanted, sent, new Set(), new Set([1137])), { differences: [], ignored: [], extra: [1137] });
  // The BodyLength must be the expected one and the extra field's bytes, and no more.
  assert.deepEqual(compare(wanted, framed('35=A|34=1|98=0|108=30|1137=10|').set(9, '33'), new Set(), new Set([1137])), {
    differences: ['BodyLength (9) is 33, expected 30 (22 adjusted by +8 for extra 1137)'], ignored: [], extra: [1137],
  });
  // Allowed, and not there: nothing is listed, so a ruling that names it is seen to be stale.
  assert.deepEqual(compare(wanted, framed('35=A|34=1|98=0|108=30|'), new Set(), new Set([1137])), { differences: [], ignored: [] });
  // Another field the line lacks is still unexpected.
  assert.deepEqual(compare(wanted, framed('35=A|34=1|98=0|108=30|1137=10|141=Y|'), new Set(), new Set([1137])).differences.slice(0, 1), ['Unexpected field 141=Y']);
});
