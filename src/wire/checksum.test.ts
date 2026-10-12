import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checksum } from './checksum.ts';

/** FIX text with '|' standing in for the SOH delimiter. */
const wire = (text: string) => Buffer.from(text.replaceAll('|', '\x01'), 'latin1');

test('sums every byte before the CheckSum field, modulo 256', () => {
  assert.equal(checksum(wire('8=FIX.4.4|9=54|35=0|49=ME|56=EXCHANGE|34=99|52=20260927-14:30:05.123|')), '234');
  assert.equal(checksum(wire('8=FIX.4.4|9=53|35=0|49=ME|56=EXCHANGE|34=3|52=20260927-14:30:05.123|')), '170');
});

test('always three digits', () => {
  assert.equal(checksum(Buffer.from([1])), '001');
  assert.equal(checksum(Buffer.from([])), '000');
});
