// Tests of what the QuickFIX/J scenarios are held to. They need neither Java nor the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checked, complaints } from './checks.ts';
import type { Harness } from './harness.ts';

/** A harness that printed these lines, and does nothing else. */
function printed(...transcript: string[]): Harness {
  const never = () => Promise.reject(new Error('not a running harness'));
  return { port: 0, transcript, command: never, next: never, message: never, stop: async () => {} };
}

test('an error line and a Reject either way are complaints; nothing else QuickFIX/J prints is', () => {
  const rejectSent = 'out\t8=FIX.4.4|9=70|35=3|34=2|49=EXEC|56=CLIENT|45=2|58=no|10=000|';
  const rejectTaken = 'in\t8=FIX.4.4|9=70|35=3|34=2|49=CLIENT|56=EXEC|45=2|58=no|10=000|';
  const harness = printed(
    'ready\t5001',
    'event\tsomething about 35=3 in its log',
    'in\t8=FIX.4.4|9=60|35=0|34=3|49=CLIENT|56=EXEC|112=35=3|10=000|',
    'out\t8=FIX.4.4|9=60|35=8|34=3|49=EXEC|56=CLIENT|150=3|39=3|10=000|',
    rejectSent,
    'stderr\ta warning',
    'error\tanswering an order: it failed',
    rejectTaken,
    'done\torder A1',
  );
  assert.deepEqual(complaints(harness), [rejectSent, 'error\tanswering an order: it failed', rejectTaken]);
  assert.deepEqual(complaints(printed('ready\t5001', 'logon\tFIX.4.4:EXEC->CLIENT')), []);
});

test('a scenario whose body passes still fails when QuickFIX/J complained, and the failure shows what it printed', async t => {
  const shown: string[] = [];
  const context = { diagnostic: (message: string) => { shown.push(message); } } as unknown as typeof t;
  const harness = printed('logon\tFIX.4.4:EXEC->CLIENT', 'error\tanswering an order: it failed');
  await assert.rejects(checked(context, { sessions: [], harnesses: [harness] }, async () => {}), { name: 'AssertionError' });
  assert.deepEqual(shown, ['QuickFIX/J printed:\nlogon\tFIX.4.4:EXEC->CLIENT\nerror\tanswering an order: it failed']);

  // A body that fails is shown the same way, and its own error is the one thrown.
  shown.length = 0;
  const quiet = printed('logon\tFIX.4.4:EXEC->CLIENT');
  await assert.rejects(checked(context, { sessions: [], harnesses: [quiet] }, async () => { throw new Error('the scenario failed'); }), { message: 'the scenario failed' });
  assert.deepEqual(shown, ['QuickFIX/J printed:\nlogon\tFIX.4.4:EXEC->CLIENT']);

  shown.length = 0;
  await checked(context, { sessions: [], harnesses: [quiet] }, async () => {});
  assert.deepEqual(shown, []);
});
