import type { Clock } from './clock.ts';
import { errorDetails } from './report.ts';
import { remover, type ConnectionEntry, type Peer, type Remove } from './types.ts';

/** The connection an entry is about. */
export interface ConnectionRef {
  readonly connectionId: string;
  readonly peer: Peer;
}

type Watcher = (entry: ConnectionEntry) => void;

/**
 * A server's connection feed. Delivers each entry to every watcher; a watcher
 * that throws becomes an 'error' entry (never fed back for an error entry, so
 * a broken watcher can't loop); errors also go to onHandlerError. A replay goes
 * only to the new watcher, and so does the error entry when that watcher throws
 * during it. Never throws.
 */
export class ConnectionFeed {
  readonly #watchers = new Set<Watcher>();
  readonly #clock: Clock;
  readonly #onHandlerError: ((error: unknown) => void) | undefined;

  constructor(clock: Clock, onHandlerError?: (error: unknown) => void) {
    this.#clock = clock;
    this.#onHandlerError = onHandlerError;
  }

  /** Whether anyone is watching; entries needn't be built otherwise. */
  get watched(): boolean {
    return this.#watchers.size > 0;
  }

  /** Follow the feed, after first receiving `replay`. */
  watch(fn: Watcher, replay: readonly ConnectionEntry[] = []): Remove {
    const only = [fn];
    for (const entry of replay) this.#deliver(fn, entry, only);
    this.#watchers.add(fn);
    return remover(() => this.#watchers.delete(fn));
  }

  emit(entry: ConnectionEntry): void {
    for (const fn of [...this.#watchers]) this.#deliver(fn, entry);
  }

  /** A failure on a connection (or, without one, on the listening socket): an 'error' entry, then onHandlerError. What onHandlerError throws is recorded too. */
  error(on: ConnectionRef | undefined, error: unknown): void {
    this.#error(on, error);
  }

  /** As error(), delivered to `to` (every watcher when undefined). */
  #error(on: ConnectionRef | undefined, error: unknown, to?: readonly Watcher[]): void {
    this.#emitError(on, error, to);
    if (!this.#onHandlerError) return;
    try {
      this.#onHandlerError(error);
    } catch (handlerError) {
      this.#emitError(on, handlerError, to);
    }
  }

  #emitError(on: ConnectionRef | undefined, error: unknown, to: readonly Watcher[] | undefined): void {
    if (to === undefined && !this.watched) return;
    let at: Date;
    try {
      at = this.#clock.now();
    } catch {
      return;
    }
    const details = errorDetails(error);
    const entry: ConnectionEntry = on === undefined
      ? { kind: 'connection', event: 'error', at, error: details }
      : { kind: 'connection', event: 'error', connectionId: on.connectionId, peer: on.peer, at, error: details };
    if (to === undefined) this.emit(entry);
    else for (const fn of to) this.#deliver(fn, entry, to);
  }

  /** Deliver one entry; what the watcher throws goes to `to` (every watcher when undefined). */
  #deliver(fn: Watcher, entry: ConnectionEntry, to?: readonly Watcher[]): void {
    try {
      fn(entry);
    } catch (error) {
      if (entry.event !== 'error') {
        this.#error(entry.connectionId === undefined ? undefined : { connectionId: entry.connectionId, peer: entry.peer }, error, to);
        return;
      }
      try {
        this.#onHandlerError?.(error);
      } catch {
        // A broken watcher and a broken onHandlerError: nowhere left to report it.
      }
    }
  }
}
