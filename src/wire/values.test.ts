import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictionaryFor } from '../dictionary/index.ts';
import { decodeValue, encodeValue, formatNumber, valueProblem } from './values.ts';

const field = (name: string) => {
  const found = dictionaryFor('FIX.4.4').fieldByName.get(name);
  assert.ok(found, name);
  return found;
};

test('enum values go by name', () => {
  assert.equal(encodeValue(field('Side'), 'Buy'), '1');
  assert.equal(decodeValue(field('Side'), '2'), 'Sell');
  assert.equal(encodeValue(field('EncryptMethod'), 'None'), '0');
});

test('an unknown enum name is an error with a suggestion', () => {
  assert.throws(() => encodeValue(field('Side'), 'Buyy'), {
    name: 'FIXEncodeError',
    message: "'Buyy' is not a Side value. Did you mean 'Buy'?",
  });
});

test('an unknown wire value decodes to its text', () => {
  assert.equal(decodeValue(field('Side'), 'Z'), 'Z');
});

test('Y/N fields are booleans', () => {
  assert.equal(encodeValue(field('PossDupFlag'), true), 'Y');
  assert.equal(encodeValue(field('GapFillFlag'), false), 'N');
  assert.equal(decodeValue(field('PossDupFlag'), 'Y'), true);
  assert.equal(decodeValue(field('PossDupFlag'), 'N'), false);
});

test('multi-value enums are arrays of names', () => {
  assert.equal(encodeValue(field('ExecInst'), ['NotHeld', 'Work']), '1 2');
  assert.deepEqual(decodeValue(field('ExecInst'), '1 2'), ['NotHeld', 'Work']);
});

test('an empty multi-value enum array is refused, not sent as an empty field', () => {
  assert.throws(() => encodeValue(field('ExecInst'), []), {
    name: 'FIXEncodeError',
    message: /ExecInst \(18\)/,
  });
});

test('a non-string item in a multi-value enum array is refused, not coerced', () => {
  assert.throws(() => encodeValue(field('ExecInst'), ['NotHeld', 42]), {
    name: 'FIXEncodeError',
    message: /ExecInst \(18\)/,
  });
});

test('decoding empty text for a multi-value enum returns the raw text', () => {
  assert.equal(decodeValue(field('ExecInst'), ''), '');
});

test('numbers', () => {
  assert.equal(encodeValue(field('Price'), 150.25), '150.25');
  assert.equal(encodeValue(field('OrderQty'), 100), '100');
  assert.equal(decodeValue(field('OrderQty'), '100'), 100);
  assert.equal(decodeValue(field('Price'), '-0.5'), -0.5);
  assert.equal(decodeValue(field('Price'), 'abc'), 'abc');
  assert.throws(() => encodeValue(field('OrderQty'), '100'), { name: 'FIXEncodeError', message: /OrderQty \(38\) can't be the string "100"; expected a number/ });
});

test('numbers never use exponent notation', () => {
  assert.equal(formatNumber(0.0000001), '0.0000001');
  assert.equal(formatNumber(0.00000015), '0.00000015');
  assert.equal(formatNumber(1e21), '1000000000000000000000');
  assert.equal(formatNumber(-2.5e-7), '-0.00000025');
});

test('UTC timestamps are Dates', () => {
  const at = new Date('2026-09-27T14:30:05.123Z');
  assert.equal(encodeValue(field('SendingTime'), at), '20260927-14:30:05.123');
  assert.deepEqual(decodeValue(field('SendingTime'), '20260927-14:30:05.123'), at);
  assert.deepEqual(decodeValue(field('SendingTime'), '20260927-14:30:05'), new Date('2026-09-27T14:30:05.000Z'));
  assert.deepEqual(decodeValue(field('SendingTime'), '20260927-14:30:05.123456'), at);
  assert.equal(decodeValue(field('SendingTime'), '20261399-99:99:99'), '20261399-99:99:99');
  assert.equal(decodeValue(field('SendingTime'), 'garbage'), 'garbage');
});

test('strings keep non-ASCII text as UTF-8 bytes', () => {
  const wire = encodeValue(field('Text'), 'café');
  assert.equal(wire.length, 5);      // é is two bytes
  assert.equal(decodeValue(field('Text'), wire), 'café');
});

test('data fields pass through unchanged', () => {
  assert.equal(encodeValue(field('RawData'), 'a\x01b'), 'a\x01b');
  assert.equal(decodeValue(field('RawData'), 'a\x01b'), 'a\x01b');
});

test('integer fields refuse fractions', () => {
  assert.throws(() => encodeValue(field('MsgSeqNum'), 1.5), { name: 'FIXEncodeError', message: /MsgSeqNum \(34\) can't be number 1.5; expected a whole number/ });
  assert.equal(encodeValue(field('MsgSeqNum'), 7), '7');
  assert.equal(encodeValue(field('Price'), 1.5), '1.5');
});

test('strings that are not valid UTF-8 keep every byte', () => {
  assert.equal(decodeValue(field('Text'), 'caf\xe9'), 'caf\xe9');          // latin1 é: invalid UTF-8
  assert.equal(decodeValue(field('Text'), 'caf\xc3\xa9'), 'café');          // valid UTF-8
});

test('a Length is a whole number of bytes without a sign', () => {
  assert.equal(valueProblem(field('RawDataLength'), '0'), undefined);
  assert.equal(valueProblem(field('RawDataLength'), '12'), undefined);
  for (const text of ['-1', '12ab', '1.5', '+3']) {
    assert.deepEqual(valueProblem(field('RawDataLength'), text), { code: 'IncorrectDataFormatForValue', text: `RawDataLength (95) has a malformed value '${text}'` }, text);
  }
  // Other whole numbers keep their sign.
  assert.equal(valueProblem(field('CumQty'), '-1'), undefined);
});

test('valueProblem explains why wire text is not a valid value', () => {
  assert.equal(valueProblem(field('Side'), '1'), undefined);
  assert.deepEqual(valueProblem(field('Side'), 'Z'), { code: 'ValueIsIncorrect', text: "Side (54) has no value 'Z'" });
  assert.deepEqual(valueProblem(field('MsgSeqNum'), 'abc'), { code: 'IncorrectDataFormatForValue', text: "MsgSeqNum (34) has a malformed value 'abc'" });
  assert.equal(valueProblem(field('MsgSeqNum'), '1.5')?.code, 'IncorrectDataFormatForValue');
  assert.equal(valueProblem(field('PossDupFlag'), 'X')?.code, 'IncorrectDataFormatForValue');
  assert.equal(valueProblem(field('SendingTime'), 'garbage')?.code, 'IncorrectDataFormatForValue');
  assert.equal(valueProblem(field('ExecInst'), '1 z')?.code, 'ValueIsIncorrect');
  assert.deepEqual(valueProblem(field('Text'), ''), { code: 'TagSpecifiedWithoutAValue', text: 'Text (58) has no value' });
  assert.equal(valueProblem(field('Text'), 'anything'), undefined);
});

test('a code set FIX leaves open takes the values it is open to, and still rejects the rest', () => {
  const open = (union: 'Reserved100Plus' | 'Reserved1000Plus' | 'Reserved4000Plus' | 'Qty' | 'Tenor') =>
    ({ tag: 9001, name: 'Kind', type: 'int', codes: [{ name: 'First', value: '1' }], union });
  const ok = (union: Parameters<typeof open>[0], text: string) => valueProblem(open(union), text) === undefined;
  // Whole numbers from 100, 1000 or 4000 up are for counterparties to agree on.
  assert.deepEqual(['1', '100', '2500', '99', '2', '100.5', '-100', 'abc'].map(text => ok('Reserved100Plus', text)), [true, true, true, false, false, false, false, false]);
  assert.deepEqual(['1', '999', '1000'].map(text => ok('Reserved1000Plus', text)), [true, false, true]);
  assert.deepEqual(['1', '3999', '4000'].map(text => ok('Reserved4000Plus', text)), [true, false, true]);
  // A quantity, or a tenor (D5, M3, W13, Y1), beside the codes.
  assert.deepEqual(['1', '250', '2.5', 'lots'].map(text => ok('Qty', text)), [true, true, true, false]);
  assert.deepEqual(['1', 'D5', 'M3', 'W13', 'Y1', 'Q1', 'D', '5D'].map(text => ok('Tenor', text)), [true, true, true, true, true, false, false, false]);
  assert.deepEqual(valueProblem(open('Reserved100Plus'), '99'), { code: 'ValueIsIncorrect', text: "Kind (9001) has no value '99'" });
  // Without a union datatype the code set is closed, as before.
  const closed = { tag: 9001, name: 'Kind', type: 'int', codes: [{ name: 'First', value: '1' }] };
  assert.equal(valueProblem(closed, '100')?.code, 'ValueIsIncorrect');

  // Such a value has no name: it is read as its text, and written as it is, so a message that carries one can be sent again.
  assert.equal(decodeValue(open('Reserved100Plus'), '100'), '100');
  assert.equal(encodeValue(open('Reserved100Plus'), '100'), '100');
  assert.equal(encodeValue(open('Reserved100Plus'), 'First'), '1');
  assert.throws(() => encodeValue(closed, '100'), { name: 'FIXEncodeError' });
});

test('wire text outside an open range is refused: a sign, trailing characters', () => {
  const kind = (union: 'Reserved100Plus' | 'Tenor') => ({ tag: 9001, name: 'Kind', type: 'int', codes: [{ name: 'First', value: '1' }], union });
  assert.equal(valueProblem(kind('Reserved100Plus'), '+100')?.code, 'ValueIsIncorrect');
  assert.equal(valueProblem(kind('Tenor'), 'D5x')?.code, 'ValueIsIncorrect');
});

test('a value an open code set does not take says what it is open to, and a number is told to be written as text', () => {
  const open = (union: 'Reserved100Plus' | 'Reserved1000Plus' | 'Reserved4000Plus' | 'Qty' | 'Tenor') =>
    ({ tag: 9001, name: 'Kind', type: 'int', codes: [{ name: 'First', value: '1' }], union });
  const closed = { tag: 9001, name: 'Kind', type: 'int', codes: [{ name: 'First', value: '1' }] };
  const thrown = (field: Parameters<typeof encodeValue>[0], value: unknown) => {
    try { encodeValue(field, value); } catch (error) { return (error as Error).message; }
    return undefined;
  };
  assert.equal(thrown(open('Reserved100Plus'), '99'), "'99' is not a Kind value; Kind also takes a whole number from 100 up, written as text");
  assert.equal(thrown(open('Reserved1000Plus'), 'x'), "'x' is not a Kind value; Kind also takes a whole number from 1000 up, written as text");
  assert.equal(thrown(open('Reserved4000Plus'), 'x'), "'x' is not a Kind value; Kind also takes a whole number from 4000 up, written as text");
  assert.equal(thrown(open('Qty'), 'lots'), "'lots' is not a Kind value; Kind also takes a number, written as text");
  assert.equal(thrown(open('Tenor'), 'Q1'), "'Q1' is not a Kind value; Kind also takes a tenor such as D5 or M3, written as text");
  assert.equal(thrown(open('Reserved100Plus'), 100), "Kind (9001) can't be number 100; write it as text, '100'");
  assert.equal(thrown(open('Qty'), 15000), "Kind (9001) can't be number 15000; write it as text, '15000'");
  assert.equal(thrown(open('Reserved100Plus'), 99), "Kind (9001) can't be number 99; expected one of First, or a whole number from 100 up written as text");
  // A closed code set keeps its texts.
  assert.equal(thrown(closed, '100'), "'100' is not a Kind value");
  assert.equal(thrown(closed, 100), "Kind (9001) can't be number 100; expected one of First");
  assert.equal(thrown(field('Side'), 'Buyy'), "'Buyy' is not a Side value. Did you mean 'Buy'?");
});

test('in the FIX 4.2 dictionary IOIShares takes a quantity beside S, M and L', () => {
  const ioiShares = dictionaryFor('FIX.4.2').fieldByName.get('IOIShares');
  assert.ok(ioiShares);
  assert.equal(ioiShares.union, 'Qty');
  assert.equal(valueProblem(ioiShares, '15000'), undefined);
  assert.equal(valueProblem(ioiShares, 'L'), undefined);
  assert.equal(valueProblem(ioiShares, 'lots')?.code, 'ValueIsIncorrect');
  // Its other code sets are as the Orchestra file has them.
  assert.equal(dictionaryFor('FIX.4.2').fieldByName.get('IDSource')?.union, undefined);
});

test('in the FIX 4.4 dictionary SecurityIDSource is open from 100 up, IOIQty takes a quantity, and Side is closed', () => {
  assert.equal(field('SecurityIDSource').union, 'Reserved100Plus');
  assert.equal(valueProblem(field('SecurityIDSource'), '100'), undefined);
  assert.equal(valueProblem(field('SecurityIDSource'), 'Z9')?.code, 'ValueIsIncorrect');
  assert.equal(field('IOIQty').union, 'Qty');
  assert.equal(valueProblem(field('IOIQty'), '15000'), undefined);
  assert.equal(field('Side').union, undefined);
  assert.equal(valueProblem(field('Side'), '100')?.code, 'ValueIsIncorrect');
});
