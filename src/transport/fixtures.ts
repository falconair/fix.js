// Test support for src/transport. Not exported by the package.
import { dictionaryFor } from '../dictionary/index.ts';
import { engineConfig, type EngineOptions } from '../session/types.ts';
import { fakeClock, type FakeClock } from './clock.ts';
import { FixSession, type MemoryOptions } from './session.ts';
import { memoryStore } from './store.ts';
import type { Entry, Link, Store } from './types.ts';

export const T0 = new Date('2026-09-30T12:00:00.000Z');

type Loaded = { readonly history: readonly Entry[]; readonly next: number; readonly expected: number };
type PerSide<T> = { readonly client?: T; readonly exchange?: T };

export interface PairOptions {
  /** Engine options for both sides. */
  readonly engine?: Partial<EngineOptions>;
  /** For both sides, or per side. */
  readonly memory?: MemoryOptions | PerSide<MemoryOptions>;
  /** One store for both sides, or one per side. Default: a fresh memoryStore per side. */
  readonly store?: Store | PerSide<Store>;
  /** What each side's store held. Default: nothing, at 1/1. */
  readonly loaded?: PerSide<Loaded>;
  readonly clock?: FakeClock;
  readonly onHandlerError?: (error: unknown) => void;
  /** Whether each side's link supports pause()/resume(). Default true. */
  readonly pausable?: boolean;
  /** Called on each pause()/resume() of a side's link. */
  readonly onPause?: (side: 'client' | 'exchange', paused: boolean) => void;
  /** Called with each frame a side writes, as it is written. */
  readonly onWrite?: (side: 'client' | 'exchange', bytes: Uint8Array) => void;
  /** What reaches the other side in place of each frame a side writes. Default: the frame as written. */
  readonly rewrite?: (side: 'client' | 'exchange', bytes: Uint8Array) => Uint8Array;
}

/**
 * One direction of the in-memory wire: buffers deliveries while paused, and
 * flushes them in order on resume — pausing again mid-flush (as a receiver's
 * own backpressure may do) stops the flush where it is, not all at once.
 */
function channel(to: FixSession) {
  let paused = false;
  const queue: Uint8Array[] = [];
  const flush = () => {
    while (!paused && queue.length > 0) to.receiveBytes(queue.shift()!);
  };
  return {
    deliver(bytes: Uint8Array): void { setImmediate(() => { queue.push(bytes); flush(); }); },
    pause(): void { paused = true; },
    resume(): void { paused = false; flush(); },
  };
}

const isPerSide = <T extends object>(value: T | PerSide<T>): value is PerSide<T> => 'client' in value || 'exchange' in value;
const forSide = <T extends object>(value: T | PerSide<T> | undefined, side: 'client' | 'exchange'): T | undefined =>
  value && isPerSide(value) ? value[side] : value;

/**
 * Two sessions, CLIENT (initiator) and EXCHANGE (acceptor), wired together in
 * memory on one fake clock. Not started. With `pausable` (the default), calling
 * pause() on your own link holds up what the *other* side writes to you.
 */
export function connectedPair(options: PairOptions = {}) {
  const clock = options.clock ?? fakeClock(T0);
  const dictionary = dictionaryFor('FIX.4.4');
  const make = (side: 'client' | 'exchange', sender: string, target: string, role: 'initiator' | 'acceptor') => new FixSession({
    config: engineConfig({ version: 'FIX.4.4', sender, target, role, ...options.engine }),
    dictionary, store: forSide(options.store, side) ?? memoryStore(), clock,
    loaded: options.loaded?.[side] ?? { history: [], next: 1, expected: 1 },
    ...(forSide(options.memory, side) ? { memory: forSide(options.memory, side) } : {}),
    ...(options.onHandlerError ? { onHandlerError: options.onHandlerError } : {}),
  });
  const client = make('client', 'CLIENT', 'EXCHANGE', 'initiator');
  const exchange = make('exchange', 'EXCHANGE', 'CLIENT', 'acceptor');
  const clientToExchange = channel(exchange);
  const exchangeToClient = channel(client);
  const link = (side: 'client' | 'exchange', out: ReturnType<typeof channel>, into: ReturnType<typeof channel>, closePeer: () => void): Link => ({
    write: async bytes => { options.onWrite?.(side, bytes); out.deliver(options.rewrite ? options.rewrite(side, bytes) : bytes); },
    end: () => { setImmediate(closePeer); },
    ...(options.pausable === false ? {} : {
      pause: () => { options.onPause?.(side, true); into.pause(); },
      resume: () => { options.onPause?.(side, false); into.resume(); },
    }),
  });
  client.attach(link('client', clientToExchange, exchangeToClient, () => exchange.linkClosed()));
  exchange.attach(link('exchange', exchangeToClient, clientToExchange, () => client.linkClosed()));
  return { client, exchange, clock };
}

/**
 * Run `run` and count how the times of arrival a session keeps (arrays of `{ upTo, ... }`) were
 * dropped within it: one at a time with shift(), or several at once with splice().
 */
export function countingDrops(run: () => void): { readonly shifts: number; readonly splices: number } {
  const proto = Array.prototype as { shift: (this: unknown[]) => unknown; splice: (this: unknown[], ...args: number[]) => unknown[] };
  const { shift, splice } = proto;
  const ofMarks = (list: unknown[]) => typeof list[0] === 'object' && list[0] !== null && 'upTo' in list[0];
  let shifts = 0;
  let splices = 0;
  proto.shift = function (this: unknown[]) { if (ofMarks(this)) shifts++; return shift.call(this); };
  proto.splice = function (this: unknown[], ...args: number[]) { if (ofMarks(this)) splices++; return splice.apply(this, args); };
  try {
    run();
  } finally {
    proto.shift = shift;
    proto.splice = splice;
  }
  return { shifts, splices };
}
