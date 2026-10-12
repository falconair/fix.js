import { entrySize } from './size.ts';
import type { Entry } from './types.ts';

/** A limit on history, in entries and bytes: what a SessionLog keeps, and what a store's load() gives. */
export interface LogLimits {
  readonly entries: number;
  readonly bytes: number;
}

/** History kept by default: 1,000 entries, 1 MiB. */
export const DEFAULT_HISTORY: LogLimits = { entries: 1_000, bytes: 1_048_576 };

/** The history limits `memory` options ask for, with the defaults for what they leave out. */
export function historyLimits(memory: { readonly history?: number; readonly historyBytes?: number } = {}): LogLimits {
  return { entries: memory.history ?? DEFAULT_HISTORY.entries, bytes: memory.historyBytes ?? DEFAULT_HISTORY.bytes };
}

/**
 * A session's bounded view of what happened: its history, oldest dropped first, by count and
 * bytes. It is for `session.history` and nothing else: a resend is read from the store.
 */
export class SessionLog {
  readonly #limits: LogLimits;
  readonly #history: Entry[] = [];
  #historyBytes = 0;

  constructor(limits: LogLimits) {
    this.#limits = limits;
  }

  get history(): readonly Entry[] {
    return this.#history;
  }

  /** Take in what the store held, oldest first; the newest within the limits are kept. */
  restore(entries: readonly Entry[]): void {
    for (const entry of entries) {
      this.#history.push(entry);
      this.#historyBytes += entrySize(entry);
    }
    this.#trim();
  }

  /** Record an entry in the history. */
  add(entry: Entry): void {
    this.#history.push(entry);
    this.#historyBytes += entrySize(entry);
    this.#trim();
  }

  #trim(): void {
    while (this.#history.length > this.#limits.entries || this.#historyBytes > this.#limits.bytes) {
      const removed = this.#history.shift();
      if (!removed) break;
      this.#historyBytes -= entrySize(removed);
    }
  }
}
