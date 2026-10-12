import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFrame, parseFrame, type RawField } from './frame.ts';

const wire = (text: string) => text.replaceAll('|', '\x01');
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1').replaceAll('\x01', '|');

const heartbeat: RawField[] = [
  { tag: 8, value: 'FIX.4.4' }, { tag: 35, value: '0' }, { tag: 49, value: 'ME' },
  { tag: 56, value: 'EXCHANGE' }, { tag: 34, value: '99' }, { tag: 52, value: '20260927-14:30:05.123' },
];
const HEARTBEAT = '8=FIX.4.4|9=54|35=0|49=ME|56=EXCHANGE|34=99|52=20260927-14:30:05.123|10=234|';

test('builds a frame with BodyLength and CheckSum computed', () => {
  assert.equal(text(buildFrame(heartbeat)), HEARTBEAT);
});

test('BodyLength and CheckSum can be written or left out', () => {
  assert.equal(text(buildFrame(heartbeat, { checkSum: '000' })), HEARTBEAT.replace('10=234', '10=000'));
  assert.equal(text(buildFrame(heartbeat, { bodyLength: '5' })).split('|')[1], '9=5');
  assert.ok(!text(buildFrame(heartbeat, { bodyLength: null, checkSum: null })).includes('|9='));
});

test('parses a valid frame', () => {
  const frame = parseFrame(wire(HEARTBEAT));
  assert.deepEqual(frame.errors, []);
  assert.deepEqual(frame.fields.map(f => f.tag), [8, 9, 35, 49, 56, 34, 52, 10]);
  assert.equal(frame.fields[5]?.value, '99');
});

test('reports a wrong checksum or body length, without throwing', () => {
  assert.deepEqual(parseFrame(wire(HEARTBEAT.replace('10=234', '10=000'))).errors, ['CheckSum is 000 but should be 234']);
  const errors = parseFrame(wire(HEARTBEAT.replace('9=54', '9=50'))).errors;
  assert.ok(errors.includes('BodyLength is 50 but the body is 54 bytes'), errors.join());
});

test('reports structural problems', () => {
  assert.deepEqual(parseFrame(wire('35=0|8=FIX.4.4|')).errors.slice(0, 1), ['BeginString (8) must be the first field']);
  assert.deepEqual(parseFrame(wire('8=FIX.4.4|oops|')).errors, ['Garbled field at byte 10']);
});

test('MsgType must be the third field', () => {
  const [begin, msgType, ...rest] = heartbeat;
  const moved = buildFrame([begin!, ...rest, msgType!]);
  assert.equal(text(moved).slice(0, 23), '8=FIX.4.4|9=54|49=ME|56');
  assert.deepEqual(parseFrame(moved).errors, ['MsgType (35) must be the third field']);
  assert.deepEqual(parseFrame(buildFrame([begin!, ...rest])).errors, ['MsgType (35) must be the third field']);
  // Hand-written text is read as it comes.
  assert.deepEqual(parseFrame('8=FIX.4.4|34=1|35=0|', { lenient: true }).errors, []);
});

test('lenient: | delimiters and no BodyLength/CheckSum', () => {
  const frame = parseFrame('8=FIX.4.4|35=0|49=ME|56=EXCHANGE|34=1|\n', { lenient: true });
  assert.deepEqual(frame.errors, []);
  assert.deepEqual(frame.fields.map(f => f.tag), [8, 35, 49, 56, 34]);
});

test('data fields may contain SOH', () => {
  const logon = buildFrame([
    { tag: 8, value: 'FIX.4.4' }, { tag: 35, value: 'A' }, { tag: 95, value: '5' }, { tag: 96, value: 'a\x01b\x01c' }, { tag: 98, value: '0' },
  ]);
  const frame = parseFrame(logon, { dataTags: new Set([96]) });
  assert.deepEqual(frame.errors, []);
  assert.equal(frame.fields.find(f => f.tag === 96)?.value, 'a\x01b\x01c');
});
