import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode } from './index.ts';
import { defineDictionary, Side, OrdType, FIXDecodeError, FIXEncodeError } from '../index.ts';

const at = new Date('2026-09-27T14:30:05.123Z');
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1').replaceAll('\x01', '|');

const order = {
  SenderCompID: 'ME', TargetCompID: 'EXCHANGE', MsgSeqNum: 2, SendingTime: at,
  ClOrdID: 'ord-1', Symbol: 'GOOG', Side: Side.Buy, TransactTime: at,
  OrderQty: 100, OrdType: OrdType.Limit, Price: 150.25,
};
const ORDER = '8=FIX.4.4|9=122|35=D|49=ME|56=EXCHANGE|34=2|52=20260927-14:30:05.123|11=ord-1|55=GOOG|54=1|60=20260927-14:30:05.123|38=100|40=2|44=150.25|10=138|';

test('encodes byte for byte', () => {
  assert.equal(text(encode('NewOrderSingle', order)), ORDER);
});

test('decodes what it encodes', () => {
  const msg = decode(encode('NewOrderSingle', order));
  assert.equal(msg.MsgType, 'NewOrderSingle');
  if (msg.MsgType !== 'NewOrderSingle') return;
  assert.equal(msg.Side, 'Buy');
  assert.equal(msg.Price, 150.25);
  assert.deepEqual(msg.SendingTime, at);
});

test('decode throws on a broken frame, unless lenient text is expected', () => {
  assert.throws(() => decode(ORDER.replace('10=138', '10=000').replaceAll('|', '\x01')),
    (error: unknown) => error instanceof FIXDecodeError && error.message === 'CheckSum is 000 but should be 138');
  const loose = decode('8=FIX.4.4|35=0|49=ME|56=EXCHANGE|34=5|', { lenient: true });
  assert.equal(loose.MsgType, 'Heartbeat');
});

test('the version picks the dictionary and BeginString', () => {
  assert.ok(text(encode('Heartbeat', {}, { version: 'FIX.4.2' })).startsWith('8=FIX.4.2|'));
  assert.equal(decode(encode('Heartbeat', {}, { version: 'FIX.4.2' })).BeginString, 'FIX.4.2');
});

test('custom dictionaries', () => {
  const acme = defineDictionary({
    fields: { AlgoStrategy: { tag: 9702, values: { VWAP: 'V' } } },
    messages: { NewOrderSingle: ['AlgoStrategy'] },
  });
  const bytes = encode('NewOrderSingle', { ...order, AlgoStrategy: acme.AlgoStrategy.VWAP }, { dictionary: acme });
  assert.ok(text(bytes).includes('|44=150.25|9702=V|10='));
  const withDictionary = decode(bytes, { dictionary: acme });
  assert.equal((withDictionary as unknown as Record<string, unknown>).AlgoStrategy, 'VWAP');
  assert.equal(decode(bytes)[9702], 'V');
});

test('a custom dictionary that cannot extend a frame\'s version is said so, not thrown as a plain Error', () => {
  // SessionStatus (1409) is a standard FIXT.1.1 field with a standard meaning; FIX 4.4 has no such field.
  const clash = defineDictionary({ fields: { SessionStatus: { tag: 1409 } }, messages: { Logon: ['SessionStatus'] } });
  const cannot = /^The custom dictionary cannot be used with FIXT\.1\.1: Custom field SessionStatus uses tag 1409, which is SessionStatus$/;
  const frame = encode('Logon', { SenderCompID: 'ME', TargetCompID: 'EXCHANGE', MsgSeqNum: 1, SendingTime: at, EncryptMethod: 'None', HeartBtInt: 30, DefaultApplVerID: 'FIX50SP2' } as never, { version: 'FIXT.1.1' });
  assert.throws(() => decode(frame, { dictionary: clash }), (error: unknown) => error instanceof FIXDecodeError && cannot.test(error.message));
  assert.throws(() => encode('Heartbeat', {}, { version: 'FIXT.1.1', dictionary: clash }), (error: unknown) => error instanceof FIXEncodeError && cannot.test(error.message));
  // The same dictionary is fine where it fits.
  assert.equal(decode(encode('Heartbeat', {}, { dictionary: clash }), { dictionary: clash }).MsgType, 'Heartbeat');
});

test('an XMLData field is data: bytes with a field delimiter in them are sent as given and read back by their length', () => {
  const xml = Buffer.from('<a>\x01<b/></a>', 'latin1');
  const bytes = encode('SecurityDefinition', {
    SenderCompID: 'ME', TargetCompID: 'EXCHANGE', MsgSeqNum: 1, SendingTime: at,
    SecurityXMLLen: xml.length, SecurityXML: new Uint8Array(xml),
  } as never, { version: 'FIXT.1.1' });
  assert.ok(text(bytes).includes(`|1184=${xml.length}|1185=<a>|<b/></a>|`));
  const decoded = decode(bytes) as unknown as Record<string, unknown>;
  assert.equal(decoded.BeginString, 'FIXT.1.1');
  assert.ok(Buffer.from(decoded.SecurityXML as string, 'latin1').equals(xml));
  assert.equal(decoded.SecurityXMLLen, xml.length);
});
