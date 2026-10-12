import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CORRECTIONS, correct, checkCorrectionsApply } from './corrections.ts';
import { parseOrchestra } from './orchestra.ts';

const fix42 = parseOrchestra(readFileSync('dictionaries/orchestra/OrchestraFIX42.xml', 'utf8'));
const fix44 = parseOrchestra(readFileSync('dictionaries/orchestra/OrchestraFIX44.xml', 'utf8'));

test('FIX 4.2 IOIShares is open to a quantity, and nothing else is corrected', () => {
  assert.deepEqual(CORRECTIONS.map(c => `${c.version}:${c.tag}:${c.union}`), ['FIX.4.2:27:Qty']);
  assert.ok(CORRECTIONS.every(c => c.reason.length > 0));
  const corrected = correct(fix42);
  const changed = corrected.fields.filter((field, i) => field !== fix42.fields[i]);
  assert.deepEqual(changed.map(f => f.name), ['IOIShares']);
  assert.equal(changed[0]?.union, 'Qty');
  assert.deepEqual(changed[0]?.codes, fix42.fields.find(f => f.name === 'IOIShares')?.codes);
  assert.deepEqual({ ...corrected, fields: [] }, { ...fix42, fields: [] });
  assert.equal(correct(fix44), fix44);
});

test('a correction that no longer applies stops the generator', () => {
  const entry = { version: 'FIX.4.2', tag: 27, union: 'Qty' as const, reason: 'test' };
  assert.throws(() => correct(fix42, [{ ...entry, tag: 9999 }]), /FIX\.4\.2 has no field 9999/);
  assert.throws(() => correct(correct(fix42), [entry]), /IOIShares \(27\) is open already/);
  assert.throws(() => correct(fix42, [{ ...entry, tag: 55 }]), /Symbol \(55\) has no code set/);
});

test('a correction for a version that none of the generated files is stops the generator', () => {
  const entry = { version: 'FIX.4.2', tag: 27, union: 'Qty' as const, reason: 'test' };
  assert.throws(() => checkCorrectionsApply(['FIX.4.4', 'FIXT.1.1'], [entry]), /Correction for FIX\.4\.2: none of the files generated is FIX\.4\.2/);
  assert.throws(() => checkCorrectionsApply([fix44.version], [{ ...entry, version: 'FIX.4.3' }]), /Correction for FIX\.4\.3: none of the files generated is FIX\.4\.3/);
  assert.doesNotThrow(() => checkCorrectionsApply([fix42.version, fix44.version]));
  assert.doesNotThrow(() => checkCorrectionsApply([fix42.version], [entry]));
});
