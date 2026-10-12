import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ListQueue, TwoStepChain, type ListQueueOptions, type TwoStepChainOptions } from './chain.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** A TwoStepChain that notes what happens to it. */
function chainOf(options: Partial<TwoStepChainOptions> = {}) {
  const errors: string[] = [];
  const chain = new TwoStepChain({ limit: 1000, onOverLimit: () => {}, onError: error => errors.push((error as Error).message), report: () => {}, ...options });
  return { chain, errors };
}

/** A promise and the function that resolves it. */
function gate(): { readonly opened: Promise<void>; open(): void } {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { opened, open };
}

test('first steps run one at a time in the order queued, without waiting for any second step; second steps run in that order too, each after the one before has finished', { timeout: 10_000 }, async () => {
  const { chain } = chainOf();
  const ran: string[] = [];
  const gates = { a: gate(), b: gate(), c: gate() };
  const item = (label: 'a' | 'b' | 'c') => chain.push(1, async () => {
    ran.push(`first ${label}`);
    await tick();                      // a first step that takes a while: the next does not begin meanwhile
    ran.push(`first ${label} done`);
    return async () => {
      ran.push(`second ${label}`);
      await gates[label].opened;
      ran.push(`second ${label} done`);
    };
  });
  const done = [item('a'), item('b'), item('c')];
  for (let i = 0; i < 10; i++) await tick();
  // Every first step is done though no second step has finished; only a's second step has begun.
  assert.deepEqual(ran.filter(each => each.startsWith('first')), ['first a', 'first a done', 'first b', 'first b done', 'first c', 'first c done']);
  assert.deepEqual(ran.filter(each => each.startsWith('second')), ['second a']);
  // Opened out of order: the second steps still finish in the order queued.
  gates.c.open();
  gates.b.open();
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(ran.filter(each => each.startsWith('second')), ['second a']);
  gates.a.open();
  await Promise.all([...done, chain.idle]);
  assert.deepEqual(ran.filter(each => each.startsWith('second')), ['second a', 'second a done', 'second b', 'second b done', 'second c', 'second c done']);
});

test('the bytes a first step says its item carries are counted in place of those it was queued with, until the item finishes, and can take the chain over its limit', { timeout: 10_000 }, async () => {
  let over = 0;
  const { chain } = chainOf({ limit: 100, onOverLimit: () => { over++; } });
  const written = gate();
  let late!: (bytes: number) => void;
  const item = chain.push(40, async (_before, carry) => {
    carry(90);
    late = carry;
    return () => written.opened;
  });
  await tick();
  assert.deepEqual([chain.pendingBytes, over], [90, 0], '90 in place of 40, not beside them');
  const next = chain.push(5, async (_before, carry) => { carry(15); });
  await tick();
  assert.deepEqual([chain.pendingBytes, over], [105, 1], 'the second item took it over, by what its first step said it carries');
  late(88);
  assert.deepEqual([chain.pendingBytes, over], [103, 1], 'an item that carries less is not what takes the chain over');
  late(0);
  assert.deepEqual([chain.pendingBytes, over], [15, 1], 'an item may carry nothing');
  late(90);
  assert.deepEqual([chain.pendingBytes, over], [105, 2]);
  written.open();
  await Promise.all([item, next]);
  assert.equal(chain.pendingBytes, 0);
  late(1000);
  assert.deepEqual([chain.pendingBytes, over], [0, 2], 'an item that has finished carries nothing more');
});

test('a second step does not begin before its own first step is done, though everything before it has finished', { timeout: 10_000 }, async () => {
  const { chain } = chainOf();
  const ran: string[] = [];
  const slow = gate();
  const done = chain.push(1, async () => {
    await slow.opened;
    ran.push('first');
    return async () => { ran.push('second'); };
  });
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(ran, []);
  slow.open();
  await done;
  assert.deepEqual(ran, ['first', 'second']);
});

test('an item with no second step finishes once the item before it has, not sooner', { timeout: 10_000 }, async () => {
  const { chain } = chainOf();
  const finished: string[] = [];
  const held = gate();
  void chain.push(1, async () => () => held.opened).then(() => finished.push('a'));
  void chain.push(1, async () => {}).then(() => finished.push('b'));
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(finished, []);
  held.open();
  await chain.idle;
  assert.deepEqual(finished, ['a', 'b']);
});

test('a first step that waits for `before` runs once everything queued before it has finished, and holds up the first steps behind it', { timeout: 10_000 }, async () => {
  const { chain } = chainOf();
  const ran: string[] = [];
  const held = gate();
  const whole = gate();
  void chain.push(1, async () => { ran.push('first a'); return async () => { await held.opened; ran.push('second a'); }; });
  void chain.push(1, async before => { await before; ran.push('b, whole'); await whole.opened; ran.push('b done'); });
  void chain.push(1, async () => { ran.push('first c'); return async () => { ran.push('second c'); }; });
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(ran, ['first a']);
  held.open();
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(ran, ['first a', 'second a', 'b, whole']);
  whole.open();
  await chain.idle;
  assert.deepEqual(ran, ['first a', 'second a', 'b, whole', 'b done', 'first c', 'second c']);
});

test('an item whose first or second step fails rejects with that error and is given to onError; the items after it still run both steps, in order', { timeout: 10_000 }, async () => {
  const { chain, errors } = chainOf();
  const ran: string[] = [];
  const a = chain.push(1, async () => { ran.push('first a'); throw new Error('first of a failed'); });
  const b = chain.push(1, async () => { ran.push('first b'); return async () => { ran.push('second b'); throw new Error('second of b failed'); }; });
  const c = chain.push(1, () => { ran.push('first c'); throw new Error('first of c threw'); });
  const d = chain.push(1, async () => { ran.push('first d'); return async () => { ran.push('second d'); }; });
  await assert.rejects(a, { message: 'first of a failed' });
  await assert.rejects(b, { message: 'second of b failed' });
  await assert.rejects(c, { message: 'first of c threw' });
  await Promise.all([d, chain.idle]);
  assert.deepEqual(ran.filter(each => each.startsWith('first')), ['first a', 'first b', 'first c', 'first d']);
  assert.deepEqual(ran.filter(each => each.startsWith('second')), ['second b', 'second d']);
  assert.deepEqual(errors, ['first of a failed', 'second of b failed', 'first of c threw']);
});

test('an onError that throws still lets later items run, and idle resolves', { timeout: 10_000 }, async () => {
  const reported: unknown[] = [];
  const ran: string[] = [];
  const { chain } = chainOf({ onError: () => { throw new Error('onError itself failed'); }, report: error => reported.push(error) });
  const a = chain.push(10, async () => { ran.push('a'); throw new Error('a failed'); });
  const b = chain.push(10, async () => async () => { ran.push('b'); });
  await assert.rejects(a, { message: 'a failed' });
  await Promise.all([b, chain.idle]);
  assert.deepEqual(ran, ['a', 'b']);
  assert.deepEqual(reported.map(error => (error as Error).message), ['onError itself failed']);
});

test('a two-step chain counts bytes from when an item is queued until it has finished, and says when it is over its limit', { timeout: 10_000 }, async () => {
  let over = 0;
  const seen: string[] = [];
  const { chain } = chainOf({
    limit: 25,
    onOverLimit: () => { over++; },
    onQueued: () => seen.push(`queued ${chain.pendingBytes}`),
    onSettled: () => seen.push(`settled ${chain.pendingBytes}`),
  });
  const held = gate();
  const first = chain.push(10, async () => () => held.opened);
  void chain.push(10, async () => {});                 // its first step is done at once; it is counted until the one before has finished
  assert.equal(over, 0);
  void chain.push(10, async () => async () => {});
  assert.deepEqual([chain.pendingBytes, over, chain.limit], [30, 1, 25]);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(chain.pendingBytes, 30);
  held.open();
  await first;
  await chain.idle;
  assert.equal(chain.pendingBytes, 0);
  assert.deepEqual(seen, ['queued 10', 'queued 20', 'queued 30', 'settled 20', 'settled 10', 'settled 0']);
});

test('while a second step never settles, the first steps behind it still run and no second step does; they stay counted, and idle does not settle', { timeout: 10_000 }, async () => {
  const { chain } = chainOf();
  const ran: string[] = [];
  let idle = false;
  void chain.push(5, async () => { ran.push('first a'); return () => new Promise<void>(() => {}); });
  for (let n = 0; n < 3; n++) void chain.push(5, async () => { ran.push(`first ${n}`); return async () => { ran.push(`second ${n}`); }; });
  void chain.idle.then(() => { idle = true; });
  for (let i = 0; i < 20; i++) await tick();
  assert.deepEqual(ran, ['first a', 'first 0', 'first 1', 'first 2']);
  assert.equal(chain.pendingBytes, 20);
  assert.equal(idle, false);
});

test('while a first step never settles, nothing behind it begins', { timeout: 10_000 }, async () => {
  const { chain } = chainOf();
  const ran: string[] = [];
  void chain.push(5, () => { ran.push('first a'); return new Promise<undefined>(() => {}); });
  void chain.push(5, async () => { ran.push('first b'); });
  for (let i = 0; i < 20; i++) await tick();
  assert.deepEqual(ran, ['first a']);
  assert.equal(chain.pendingBytes, 10);
});

/** A ListQueue of labels whose lists are kept when the test says so: `calls` are the lists given so far, `finish(error?)` settles the oldest one still being kept. */
function heldQueue(options: Partial<ListQueueOptions<string>> = {}) {
  const calls: string[][] = [];
  const settling: { resolve(): void; reject(error: unknown): void }[] = [];
  let inFlight = 0;
  let most = 0;
  const queue: ListQueue<string> = new ListQueue<string>({
    limit: 1_000_000, maxItems: 256, maxBytes: 1_000_000, onOverLimit: () => {}, onError: () => {}, report: () => {},
    keep: items => {
      calls.push(items);
      most = Math.max(most, ++inFlight);
      return new Promise<void>((resolve, reject) => { settling.push({ resolve, reject }); }).finally(() => { inFlight--; });
    },
    ...options,
  });
  const finish = async (error?: unknown) => {
    const next = settling.shift()!;
    if (error === undefined) next.resolve();
    else next.reject(error);
    await tick();
  };
  return { queue, calls, finish, most: () => most };
}

test('a list queue gives what is queued in one turn as one list, a microtask after the first of it was queued', { timeout: 10_000 }, async () => {
  // Whoever queues an item may still finish it in the same turn: the list is not made until that turn is over.
  const seen: { label: string }[] = [];
  const direct = new ListQueue<{ label: string }>({
    limit: 1000, maxItems: 256, maxBytes: 1000, onOverLimit: () => {}, onError: () => {}, report: () => {},
    keep: async list => { seen.push(...list.map(each => ({ ...each }))); },
  });
  const item = { label: 'as it was queued' };
  const kept = direct.push(1, item);
  item.label = 'as it was left in the same turn';
  await kept;
  assert.deepEqual(seen, [{ label: 'as it was left in the same turn' }]);

  const { queue, calls, finish } = heldQueue();
  void queue.push(1, 'a');
  void queue.push(1, 'b');
  assert.deepEqual(calls, []);   // not while the one who queued them is still running
  await Promise.resolve();
  assert.deepEqual(calls, [['a', 'b']]);
  await finish();
});

test('a list queue keeps one list at a time: what is queued meanwhile waits, and goes in the next list, in order', { timeout: 10_000 }, async () => {
  const { queue, calls, finish, most } = heldQueue();
  const settled: string[] = [];
  const push = (label: string) => { void queue.push(1, label).then(() => settled.push(label)); };
  push('a');
  await tick();
  for (const label of ['b', 'c', 'd']) push(label);
  await tick();
  push('e');
  await tick();
  assert.deepEqual(calls, [['a']]);
  assert.deepEqual(settled, []);
  await finish();
  assert.deepEqual(calls, [['a'], ['b', 'c', 'd', 'e']]);
  assert.deepEqual(settled, ['a']);
  push('f');
  await finish();
  assert.deepEqual(calls, [['a'], ['b', 'c', 'd', 'e'], ['f']]);
  assert.deepEqual(settled, ['a', 'b', 'c', 'd', 'e']);
  await finish();
  await queue.idle;
  assert.deepEqual(settled, ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(most(), 1);
});

test('a list holds no more items than maxItems: the rest wait for the next', { timeout: 10_000 }, async () => {
  const { queue, calls, finish } = heldQueue({ maxItems: 4 });
  void queue.push(1, 'first');
  await tick();
  const labels = Array.from({ length: 10 }, (_unused, index) => `i${index}`);
  for (const label of labels) void queue.push(1, label);
  for (let n = 0; n < 4; n++) await finish();
  assert.deepEqual(calls.map(list => list.length), [1, 4, 4, 2]);
  assert.deepEqual(calls.flat(), ['first', ...labels]);
  await queue.idle;
});

test('a list holds no more bytes than maxBytes, and an item larger than that goes in a list of its own', { timeout: 10_000 }, async () => {
  const { queue, calls, finish } = heldQueue({ maxBytes: 100 });
  void queue.push(1, 'first');
  await tick();
  for (const [label, size] of [['a', 40], ['b', 40], ['c', 40], ['d', 60], ['huge', 500], ['e', 100], ['f', 1], ['g', 99]] as const) void queue.push(size, label);
  for (let n = 0; n < 6; n++) await finish();
  assert.deepEqual(calls, [['first'], ['a', 'b'], ['c', 'd'], ['huge'], ['e'], ['f', 'g']]);
  await queue.idle;
});

test('a list that fails rejects every item in it with its error and calls onError once; the next list is still kept', { timeout: 10_000 }, async () => {
  const errors: unknown[] = [];
  const { queue, calls, finish } = heldQueue({ onError: error => errors.push(error) });
  const outcome: string[] = [];
  const push = (label: string) => { queue.push(1, label).then(() => outcome.push(`${label} kept`), (error: unknown) => outcome.push(`${label} ${(error as Error).message}`)); };
  push('a');
  await tick();
  for (const label of ['b', 'c', 'd']) push(label);
  await finish();
  push('e');
  await finish(new Error('disk full'));
  assert.deepEqual(outcome, ['a kept', 'b disk full', 'c disk full', 'd disk full']);
  assert.deepEqual(errors.map(error => (error as Error).message), ['disk full']);
  await finish();
  await queue.idle;   // never rejects
  assert.deepEqual(calls, [['a'], ['b', 'c', 'd'], ['e']]);
  assert.deepEqual(outcome, ['a kept', 'b disk full', 'c disk full', 'd disk full', 'e kept']);
});

test('onError runs before anything that waits on an item of the failed list', { timeout: 10_000 }, async () => {
  const order: string[] = [];
  const queue = new ListQueue<string>({
    limit: 1000, maxItems: 256, maxBytes: 1000, onOverLimit: () => {}, report: () => {},
    keep: async () => { throw new Error('no'); },
    onError: () => order.push('onError'),
    onSettled: () => order.push('onSettled'),
  });
  await queue.push(1, 'a').catch(() => order.push('the one waiting'));
  assert.deepEqual(order, ['onError', 'onSettled', 'the one waiting']);
});

test('a keep that throws instead of rejecting fails its list the same way, and one that gives no promise keeps it', { timeout: 10_000 }, async () => {
  const errors: unknown[] = [];
  let calls = 0;
  const queue = new ListQueue<string>({
    limit: 1000, maxItems: 256, maxBytes: 1000, onOverLimit: () => {}, onError: error => errors.push(error), report: () => {},
    keep: (() => { if (++calls === 1) throw new Error('thrown'); return undefined; }) as never,
  });
  await assert.rejects(queue.push(1, 'a'), { message: 'thrown' });
  await queue.push(1, 'b');
  await queue.idle;
  assert.deepEqual(errors.map(error => (error as Error).message), ['thrown']);
});

test('an onError or onSettled that throws is reported; later lists are kept and idle resolves', { timeout: 10_000 }, async () => {
  const reported: unknown[] = [];
  const kept: string[][] = [];
  const queue = new ListQueue<string>({
    limit: 1000, maxItems: 256, maxBytes: 1000, onOverLimit: () => {},
    keep: async items => { kept.push(items); if (items[0] === 'a') throw new Error('a failed'); },
    onError: () => { throw new Error('onError itself failed'); },
    onSettled: () => { throw new Error('onSettled itself failed'); },
    report: error => reported.push(error),
  });
  const a = queue.push(1, 'a');
  await assert.rejects(a, { message: 'a failed' });
  await queue.push(1, 'b');
  await queue.idle;
  assert.deepEqual(kept, [['a'], ['b']]);
  assert.deepEqual(reported.map(error => (error as Error).message), ['onError itself failed', 'onSettled itself failed', 'onSettled itself failed']);
});

test('a list queue counts bytes from when an item is queued until its list settles, and says when it is over its limit', { timeout: 10_000 }, async () => {
  let over = 0;
  const seen: string[] = [];
  const { queue, finish } = heldQueue({
    limit: 25,
    onOverLimit: () => { over++; },
    onQueued: () => seen.push(`queued ${queue.pendingBytes}`),
    onSettled: () => seen.push(`settled ${queue.pendingBytes}`),
  });
  void queue.push(10, 'a');
  await tick();
  void queue.push(10, 'b');
  assert.equal(over, 0);
  void queue.push(10, 'c');
  assert.deepEqual([queue.pendingBytes, over, queue.limit], [30, 1, 25]);
  await finish();
  assert.equal(queue.pendingBytes, 20);
  await finish(new Error('failed'));
  assert.equal(queue.pendingBytes, 0);   // a list that failed is no longer counted either
  await queue.idle;
  assert.deepEqual(seen, ['queued 10', 'queued 20', 'queued 30', 'settled 20', 'settled 0']);
});

test('idle settles once everything queued so far has settled, kept or not, and not before', { timeout: 10_000 }, async () => {
  const { queue, finish } = heldQueue();
  let idle = false;
  void queue.push(1, 'a').catch(() => {});
  await tick();
  void queue.push(1, 'b');
  void queue.idle.then(() => { idle = true; });
  await finish(new Error('failed'));
  assert.equal(idle, false);   // b is still being kept
  await finish();
  assert.equal(idle, true);
  await queue.idle;            // with nothing queued it is settled already
});

test('while a list never settles nothing more is given to keep: what is queued waits, counted, and idle does not settle', { timeout: 10_000 }, async () => {
  const { queue, calls } = heldQueue();
  let idle = false;
  void queue.push(5, 'a');
  await tick();
  for (let n = 0; n < 1000; n++) void queue.push(5, `later${n}`);
  void queue.idle.then(() => { idle = true; });
  for (let n = 0; n < 20; n++) await tick();
  assert.deepEqual(calls, [['a']]);
  assert.equal(queue.pendingBytes, 5005);
  assert.equal(idle, false);
});
