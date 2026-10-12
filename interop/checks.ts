// What every scenario against QuickFIX/J is held to, and what a failing one shows.
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { Session } from '../src/index.ts';
import { tags, type Harness } from './harness.ts';

/** What the session noticed wrong, as `code: text`. */
export const problems = (session: Session): string[] =>
  session.history.flatMap(entry => (entry.kind === 'problem' ? [`${entry.problem.code}: ${entry.problem.text}`] : []));

/** The session's `problem` and `error` entries, one line each, in the order they were recorded. */
export function troubles(session: Session): string[] {
  return session.history.flatMap(entry => {
    if (entry.kind === 'problem') return [`problem\t${entry.problem.code} (${entry.problem.action}): ${entry.problem.text}`];
    if (entry.kind === 'error') return [`error\t${entry.text}`];
    return [];
  });
}

/** The `error` lines a QuickFIX/J process printed, and the Rejects (35=3) it sent or accepted. */
export function complaints(harness: Harness): string[] {
  return harness.transcript.filter(line => {
    const tab = line.indexOf('\t');
    const event = line.slice(0, tab);
    if (event === 'error') return true;
    return (event === 'in' || event === 'out') && tags(line.slice(tab + 1))[35] === '3';
  });
}

/** Everything a scenario started: its fix.js sessions and its QuickFIX/J processes. */
export interface Started {
  readonly sessions: Session[];
  readonly harnesses: Harness[];
}

/**
 * Run a scenario's body, then hold every QuickFIX/J process it started to having printed no
 * `error` line and to no Reject having gone either way: no scenario here expects one. When the
 * scenario fails, the test shows what each fix.js session recorded as a problem or an error, and
 * everything each QuickFIX/J process printed.
 */
export async function checked(t: TestContext, started: Started, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    for (const harness of started.harnesses) assert.deepEqual(complaints(harness), [], 'QuickFIX/J printed an error, or a Reject was sent');
  } catch (error) {
    for (const session of started.sessions) {
      const recorded = troubles(session);
      t.diagnostic(`fix.js session ${session.id.sender} to ${session.id.target} recorded:\n${recorded.length > 0 ? recorded.join('\n') : '(no problem and no error)'}`);
    }
    for (const harness of started.harnesses) t.diagnostic(`QuickFIX/J printed:\n${harness.transcript.join('\n')}`);
    throw error;
  }
}
