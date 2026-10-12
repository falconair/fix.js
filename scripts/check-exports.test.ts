import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkExports, listedNames, quotedNames, typeExports } from './check-exports.ts';

test('typeExports finds the types a module exports by name, not its values or what it re-exports with *', () => {
  const source = `
    export * from './dictionary/fix44.ts';
    export { defineDictionary, type Dictionary, type FieldDef as Field } from './define.ts';
    export type {
      Session,
      Server } from './api.ts';
    export interface Peer { readonly port: number }
    export interface FakeClock extends Clock {}
    export type Duration<T = number> = T;
    export declare function connect(): void;
    export declare class TimeoutError extends Error {}
    export { Version } from './version.ts';
    interface Hidden {}
    type Local = string;
  `;
  assert.deepEqual([...typeExports(source)].sort(), ['Dictionary', 'Duration', 'FakeClock', 'Field', 'Peer', 'Server', 'Session']);
});

test('listedNames reads the keys of a named object type, and quotedNames a union of names', () => {
  const source = `type TypeExports = {\n  Clock: [Spec.Clock, Impl.Clock];\n  Peer: [Spec.Peer, Impl.Peer];\n};\ntype LaterTypes = 'Fault' | 'Where';`;
  assert.deepEqual([...listedNames(source, 'TypeExports')], ['Clock', 'Peer']);
  assert.deepEqual([...quotedNames(source, 'LaterTypes')], ['Fault', 'Where']);
  assert.throws(() => listedNames(source, 'Missing'), /Missing/);
});

test('checkExports names every type exported but not listed, listed but not exported, or in the spec but in neither list', () => {
  const problems = checkExports({
    impl: new Set(['Session', 'FixSession']),
    listed: new Set(['Session', 'StoreContext']),
    spec: new Set(['Session', 'StoreContext', 'Where', 'Fault']),
    later: new Set(['Where', 'Gone']),
  }, 'src/index.ts');
  assert.deepEqual(problems, [
    'src/index.ts exports type FixSession, which api/conformance.ts does not list',
    'api/conformance.ts lists StoreContext, which src/index.ts does not export',
    'the spec exports type Fault, which api/conformance.ts neither lists nor marks as later',
    'api/conformance.ts marks Gone as later, but the spec does not export it',
  ]);
});
