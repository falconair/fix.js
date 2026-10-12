import { toMs, type Duration } from '../util/duration.ts';

/** Where the transport gets time from. Injected so tests can control it. */
export interface Clock {
  now(): Date;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => new Date(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A clock moved by hand, so heartbeat and timeout tests run instantly. */
export interface FakeClock extends Clock {
  /** Move time forward, running every timer that falls due, in order. Real I/O gets a chance to run between timers. */
  advance(duration: Duration): Promise<void>;
}

export function fakeClock(start: Date = new Date('2026-01-01T00:00:00Z')): FakeClock {
  let now = start.getTime();
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => new Date(now),
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    async advance(duration) {
      const target = now + toMs(duration);
      for (;;) {
        await settle();
        let due: [number, { at: number; fn: () => void }] | undefined;
        for (const entry of timers) {
          if (entry[1].at <= target && (!due || entry[1].at < due[1].at)) due = entry;
        }
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
      }
      now = target;
      await settle();
    },
  };
}

/** Let pending I/O and promise callbacks run. */
function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 1));
}
