import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictionaryFor } from '../dictionary/index.ts';
import { checksum } from '../wire/checksum.ts';
import { buildFrame, parseFrame } from '../wire/frame.ts';
import { fromMessage, inspectMessage } from '../wire/message.ts';
import { DEFAULT_REDACTION, hasRedactedValue, maskError, maskProblem, redactBytes, redaction, redactEntry, redactMessage, redactText } from './redact.ts';
import type { Entry } from './types.ts';

const dict = dictionaryFor('FIX.4.4');
const at = new Date('2026-09-30T12:00:00.000Z');
const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

function frame(msgType: string, fields: Record<string, unknown>): Uint8Array {
  const { fields: raw, framing } = fromMessage(msgType, { SenderCompID: 'CLIENT', TargetCompID: 'EXCHANGE', MsgSeqNum: 1, SendingTime: at, ...fields }, dict, { version: 'FIX.4.4' });
  return buildFrame(raw, framing);
}
const logonFields = { EncryptMethod: 'None', HeartBtInt: 30, RawDataLength: 5, RawData: 'ab\x01cd', Username: 'desk7', Password: 'secret' };

test('the default hides Password everywhere, and RawData and its length in Logons, leaving BodyLength and CheckSum as they were', () => {
  const bytes = frame('Logon', logonFields);
  const before = parseFrame(bytes, { dataTags: dict.dataTags }).fields;
  const text = latin1(redactBytes(bytes, DEFAULT_REDACTION, dict.dataTags));
  assert.match(text, /\x0195=\*\*\*\*\*\x0196=\*\*\*\*\*\x01/);
  assert.match(text, /\x01553=desk7\x01554=\*\*\*\*\*\x01/);
  assert.doesNotMatch(text, /secret|ab\x01cd/);
  assert.ok(text.includes(`\x019=${before[1]?.value}\x01`), 'BodyLength unchanged');
  assert.ok(text.endsWith(`\x0110=${before.at(-1)?.value}\x01`), 'CheckSum unchanged');
});

test('RawData outside a Logon is kept; Password is hidden in every message, frame by frame', () => {
  const logon = frame('Logon', logonFields);
  const request = frame('UserRequest', { UserRequestID: 'u1', UserRequestType: 'ChangePasswordForUser', Username: 'desk7', Password: 'old', NewPassword: 'new', RawDataLength: 3, RawData: 'xyz' });
  const text = latin1(redactBytes(Buffer.concat([logon, request]), DEFAULT_REDACTION, dict.dataTags));
  const second = text.slice(text.indexOf('8=FIX', 1));
  assert.match(text.slice(0, text.length - second.length), /\x0196=\*\*\*\*\*\x01/);
  assert.match(second, /\x0195=3\x0196=xyz\x01/);
  assert.match(second, /\x01554=\*\*\*\*\*\x01/);
  assert.match(second, /\x01925=\*\*\*\*\*\x01/);
});

test('bytes with nothing to hide come back as they are', () => {
  const bytes = frame('TestRequest', { TestReqID: 'ping' });
  assert.equal(redactBytes(bytes, DEFAULT_REDACTION, dict.dataTags), bytes);
});

test('messages are redacted as copies, by field name, raw tag and inside groups', () => {
  const message = inspectMessage(parseFrame(frame('Logon', logonFields), { dataTags: dict.dataTags }).fields, dict).message;
  const redacted = redactMessage(message, DEFAULT_REDACTION, dict);
  assert.deepEqual([redacted.Password, redacted.RawData, redacted.RawDataLength, redacted.Username], ['*****', '*****', '*****', 'desk7']);
  assert.equal(message.Password, 'secret');
  assert.ok(Object.isFrozen(redacted));
  const custom = redaction([9001]);
  assert.ok(custom);
  const raw = redactMessage({ MsgType: 'NewOrderSingle', 9001: 'token', Parties: [{ PartyID: 'p', 9001: 'nested' }] }, custom, dict);
  assert.deepEqual([raw[9001], (raw.Parties as Record<string, unknown>[])[0]?.[9001]], ['*****', '*****']);
  assert.equal(redactMessage({ MsgType: 'Heartbeat' }, DEFAULT_REDACTION, dict).MsgType, 'Heartbeat');
  assert.ok(hasRedactedValue(redacted));
  assert.ok(!hasRedactedValue(message));
});

test('a message has a hidden value when any of its values is the mask, whatever the field and however deep in its groups', () => {
  assert.ok(hasRedactedValue({ MsgType: 'NewOrderSingle', ClOrdID: 'o1', Account: '*****' }));
  assert.ok(hasRedactedValue({ MsgType: 'NewOrderSingle', 9001: '*****' }));
  assert.ok(hasRedactedValue({ MsgType: 'NewOrderSingle', Parties: [{ PartyID: 'p1' }, { PartyID: '*****' }] }));
  assert.ok(hasRedactedValue({ MsgType: 'NewOrderSingle', 9002: ['a', '*****'] }));
  assert.ok(hasRedactedValue({ MsgType: 'NewOrderSingle', Parties: [{ PartyID: 'p1', PartySubIDs: [{ PartySubID: 's1' }, { PartySubID: '*****' }] }] }));
  assert.ok(!hasRedactedValue({ MsgType: 'NewOrderSingle', ClOrdID: 'o1', Text: 'masked as ***** here', Parties: [{ PartyID: '****' }], SendingTime: at }));
  assert.ok(!hasRedactedValue({ MsgType: 'Heartbeat' }));
});

test('the redact option: the default, a list of tags for every message, or nothing', () => {
  assert.equal(redaction(undefined), DEFAULT_REDACTION);
  assert.equal(redaction(false), undefined);
  assert.deepEqual([...(redaction([554, 9001])?.always ?? [])], [554, 9001]);
  assert.throws(() => redaction([1.5]), RangeError);
  assert.throws(() => redaction([0]), RangeError);
  const entry: Entry = { kind: 'problem', direction: 'in', at, problem: { code: 'Garbled', text: 'x', action: 'Ignored' } };
  assert.equal(redactEntry(entry, DEFAULT_REDACTION, dict), entry);
});

test('anything that is not an array of tag numbers or false is a RangeError, not a crash (redact: true, say)', () => {
  assert.throws(() => redaction(true as never), RangeError);
  assert.throws(() => redaction('abc' as never), RangeError);
  assert.throws(() => redaction({} as never), RangeError);
});

test('a tag written with a leading zero (0554=) is still hidden: parseFrame reads it by value, not by its literal text', () => {
  const body = `35=A\x0149=CLIENT\x0156=EXCHANGE\x0134=1\x0152=20260930-12:00:00.000\x0198=0\x01108=30\x010554=secretPW\x01`;
  const head = `8=FIX.4.4\x019=${body.length}\x01${body}`;
  const bytes = Buffer.from(`${head}10=${checksum(Buffer.from(head, 'latin1'))}\x01`, 'latin1');
  const text = latin1(redactBytes(bytes, DEFAULT_REDACTION, dict.dataTags));
  assert.doesNotMatch(text, /secretPW/);
  assert.match(text, /\x010554=\*\*\*\*\*\x01/);
});

test('hiding a data field without its length rewrites the length to fit the mask, so the frame still parses', () => {
  const rules = redaction([96]);
  assert.ok(rules);
  const bytes = frame('NewOrderSingle', { ClOrdID: 'o1', Side: 'Buy', OrdType: 'Market', TransactTime: at, RawDataLength: 9, RawData: 'abc\x01efghi' });
  const redacted = redactBytes(bytes, rules, dict.dataTags);
  const text = latin1(redacted);
  assert.match(text, /\x0195=5\x0196=\*\*\*\*\*\x01/);
  assert.doesNotMatch(text, /abc|efghi/);
  const parsed = parseFrame(redacted, { dataTags: dict.dataTags });
  assert.equal(parsed.fields.find(field => field.tag === 96)?.value, '*****');
  assert.equal(parsed.fields.at(-1)?.tag, 10, 'the frame still ends with its CheckSum');
});

test('redactText masks a hidden value only where it is quoted, so ordinary words that happen to match are left alone', () => {
  const message = { MsgType: 'UserRequest', Password: 'Logon', NewPassword: 'pa"ss\\wd' };
  assert.equal(redactText('The first message was not a Logon', message, DEFAULT_REDACTION, dict), 'The first message was not a Logon');
  assert.equal(redactText("Password (554) has a malformed value 'Logon'", message, DEFAULT_REDACTION, dict), "Password (554) has a malformed value '*****'");
  assert.equal(redactText('the string "Logon" is not allowed', message, DEFAULT_REDACTION, dict), 'the string "*****" is not allowed');
  assert.equal(redactText(`can't be the string ${JSON.stringify('pa"ss\\wd')}`, message, DEFAULT_REDACTION, dict), 'can\'t be the string "*****"');
  assert.equal(redactText('Password (554) can\'t be number 98765432', { MsgType: 'UserRequest', Password: 98765432 }, DEFAULT_REDACTION, dict), 'Password (554) can\'t be number *****');
});

/** A frame from fields in the order given (tag text as written), with BodyLength and CheckSum that fit. */
function rawFrame(fields: readonly (readonly [string, string])[]): Buffer {
  const body = fields.map(([tag, value]) => `${tag}=${value}\x01`).join('');
  const head = `8=FIX.4.4\x019=${body.length}\x01${body}`;
  return Buffer.from(`${head}10=${checksum(Buffer.from(head, 'latin1'))}\x01`, 'latin1');
}
const header = [['49', 'CLIENT'], ['56', 'EXCHANGE'], ['34', '1'], ['52', '20260930-12:00:00.000']] as const;

test('a Logon is told by its MsgType anywhere in the frame, so RawData written before 35=A is hidden', () => {
  const bytes = rawFrame([...header, ['95', '13'], ['96', 'R4wD@taSecret'], ['35', 'A'], ['98', '0'], ['108', '30']]);
  const text = latin1(redactBytes(bytes, DEFAULT_REDACTION, dict.dataTags));
  assert.doesNotMatch(text, /R4wD@taSecret/);
  assert.match(text, /\x0195=\*\*\*\*\*\x0196=\*\*\*\*\*\x0135=A\x01/);
  const order = rawFrame([...header, ['95', '3'], ['96', 'xyz'], ['35', 'D']]);
  assert.equal(redactBytes(order, DEFAULT_REDACTION, dict.dataTags), order, 'RawData outside a Logon is kept');
});

test('a frame whose RawData runs past its length is masked from its first hidden field, leaving no tail', () => {
  const bytes = rawFrame([['35', 'A'], ...header, ['98', '0'], ['108', '30'], ['554', 'S3cretPassw0rd'], ['95', '5'], ['96', 'S3cretPassw0rd\x01S3cretPassw0rd']]);
  const text = latin1(redactBytes(bytes, DEFAULT_REDACTION, dict.dataTags));
  assert.doesNotMatch(text, /S3cret|ssw0rd/);
  assert.ok(text.endsWith('\x01108=30\x01554=*****'), text);
});

test('a frame with a garbled field is masked from where it can no longer be read', () => {
  for (const garbled of ['554\x00S3cretPassw0rd', '55\x00=S3cretPassw0rd', '+554=S3cretPassw0rd']) {
    const bytes = Buffer.from(latin1(rawFrame([['35', 'A'], ...header, ['98', '0'], ['108', '30']])).replace('\x0110=', `\x01${garbled}\x0110=`), 'latin1');
    const text = latin1(redactBytes(bytes, DEFAULT_REDACTION, dict.dataTags));
    assert.doesNotMatch(text, /S3cret/, JSON.stringify(garbled));
    assert.ok(text.endsWith('\x01108=30\x01*****'), JSON.stringify(text));
  }
});

test('read from the wire, a frame whose CheckSum fails is masked from a hidden tag even where its SOH was garbled', () => {
  const good = latin1(rawFrame([['35', 'A'], ...header, ['98', '0'], ['108', '30'], ['554', 'S3cretPassw0rd']]));
  const bytes = Buffer.from(good.replace('\x01554=', '\x00554='), 'latin1');
  const text = latin1(redactBytes(bytes, DEFAULT_REDACTION, dict.dataTags, { wire: true }));
  assert.doesNotMatch(text, /S3cret/);
  assert.ok(text.endsWith('108=30\x00554=*****'), JSON.stringify(text));
});

test('bytes that are not a frame are kept as they are, up to a field that would be hidden', () => {
  const junk = Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n', 'latin1');
  assert.equal(redactBytes(junk, DEFAULT_REDACTION, dict.dataTags, { wire: true }), junk);
  const broken = Buffer.from(`\x00${latin1(rawFrame([['35', 'A'], ...header, ['554', 'S3cretPassw0rd'], ['98', '0']])).slice(1)}`, 'latin1');
  const text = latin1(redactBytes(broken, DEFAULT_REDACTION, dict.dataTags, { wire: true }));
  assert.doesNotMatch(text, /S3cret/);
  assert.ok(text.startsWith('\x00=FIX.4.4\x01') && text.endsWith('\x01554=*****'), JSON.stringify(text));
});

test('redacted bytes come back the same when redacted again, although their CheckSum no longer matches', () => {
  const once = redactBytes(frame('Logon', logonFields), DEFAULT_REDACTION, dict.dataTags);
  assert.equal(latin1(redactBytes(once, DEFAULT_REDACTION, dict.dataTags)), latin1(once));
});

test('maskError and maskProblem hide a quoted hidden value, keeping the error\'s class and the problem\'s other fields', () => {
  const logon = { MsgType: 'Logon', Username: 'desk7', Password: 'S3cretPw' };
  const error = new RangeError("bad password 'S3cretPw'");
  const masked = maskError(error, logon, DEFAULT_REDACTION, dict);
  assert.ok(masked instanceof RangeError);
  assert.equal(masked.message, "bad password '*****'");
  assert.doesNotMatch(String(masked.stack), /S3cretPw/);
  assert.equal(maskError(new Error('nothing to hide'), logon, DEFAULT_REDACTION, dict) instanceof Error, true);
  const plain = new Error('nothing to hide');
  assert.equal(maskError(plain, logon, DEFAULT_REDACTION, dict), plain);
  assert.deepEqual(
    maskProblem({ code: 'LogonRefused', text: "wrong password 'S3cretPw'", action: 'LoggedOut' }, logon, DEFAULT_REDACTION, dict),
    { code: 'LogonRefused', text: "wrong password '*****'", action: 'LoggedOut' },
  );
});
