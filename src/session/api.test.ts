import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Problem as PublicProblem } from '../../api/index.d.ts';
import type { Problem } from './types.ts';

/** True only when A and B are the same type; `npm run typecheck` fails otherwise. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Compile-time: the published Problem type describes exactly what the engine records.
const codes: Same<PublicProblem['code'], Problem['code']> = true;
const actions: Same<PublicProblem['action'], Problem['action']> = true;
const refSeqNum: Same<PublicProblem['refSeqNum'], Problem['refSeqNum']> = true;
const text: Same<PublicProblem['text'], Problem['text']> = true;

test('the public Problem type matches the engine', () => {
  assert.deepEqual([codes, actions, refSeqNum, text], [true, true, true, true]);
});
