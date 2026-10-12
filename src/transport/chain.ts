import { raiseSafely } from './report.ts';

/** Callbacks for a TwoStepChain. */
export interface TwoStepChainOptions {
  /** Past this many pending bytes, onOverLimit is called (the item is still queued). */
  readonly limit: number;
  readonly onOverLimit: () => void;
  /** An item failed. The chain itself carries on with the next one. */
  readonly onError: (error: unknown) => void;
  /** An item was queued, after the limit check. */
  readonly onQueued?: () => void;
  /** An item settled, either way. */
  readonly onSettled?: () => void;
  /** Where a throw from onError or onSettled goes, since neither may make idle reject or escape as an unhandled rejection. */
  readonly report: (error: unknown) => void;
}

/** Callbacks and bounds for a ListQueue. */
export interface ListQueueOptions<T> {
  /** Past this many pending bytes, onOverLimit is called (the item is still queued). */
  readonly limit: number;
  readonly onOverLimit: () => void;
  /** The most items one list holds. */
  readonly maxItems: number;
  /** The most bytes of items one list holds; an item larger than this goes in a list of its own. */
  readonly maxBytes: number;
  /** Given each list, in order, one at a time: the next is not given until this one has settled. */
  readonly keep: (items: T[]) => Promise<void>;
  /** A list failed: called once for it, before anything waiting on one of its items runs. The queue carries on with the next list. */
  readonly onError: (error: unknown) => void;
  /** An item was queued, after the limit check. */
  readonly onQueued?: () => void;
  /** A list settled, either way, and its bytes are no longer counted. */
  readonly onSettled?: () => void;
  /** Where a throw from onError or onSettled goes, since neither may make idle reject or escape as an unhandled rejection. */
  readonly report: (error: unknown) => void;
}

interface Waiting<T> {
  readonly item: T;
  readonly size: number;
  resolve(): void;
  reject(error: unknown): void;
}

/**
 * Items that are kept in lists, in order, one list at a time. While a list is being kept, the items
 * queued meanwhile wait; when it settles, those waiting (within the bounds of one list) go in the
 * next. An item's promise settles as its list did, and its bytes are counted until then. One list
 * failing fails every item in it, and never stops the next. The first list is made a microtask after
 * its first item was queued, so whoever queued an item can finish it in the same turn.
 */
export class ListQueue<T> {
  readonly #options: ListQueueOptions<T>;
  readonly #waiting: Waiting<T>[] = [];
  /** A list is being kept, or is about to be made. */
  #busy = false;
  #tail: Promise<void> = Promise.resolve();
  #pendingBytes = 0;

  constructor(options: ListQueueOptions<T>) {
    this.#options = options;
  }

  get limit(): number {
    return this.#options.limit;
  }

  /** Bytes queued but not yet settled. */
  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  /** Settles once everything queued so far has settled. Never rejects. */
  get idle(): Promise<void> {
    return this.#tail;
  }

  /** Queue `item`; its `size` bytes count until its list settles. Returns that settlement (rejected if the list failed). */
  push(size: number, item: T): Promise<void> {
    this.#pendingBytes += size;
    if (this.#pendingBytes > this.#options.limit) this.#options.onOverLimit();
    this.#options.onQueued?.();
    const settled = new Promise<void>((resolve, reject) => { this.#waiting.push({ item, size, resolve, reject }); });
    // Items settle in the order they were queued, so the last one queued settles last.
    this.#tail = settled.then(() => {}, () => {});
    if (!this.#busy) {
      this.#busy = true;
      queueMicrotask(() => this.#next());
    }
    return settled;
  }

  /** Give the next list to keep: the items waiting, in order, up to the bounds of one list and never fewer than one. */
  #next(): void {
    const { maxItems, maxBytes } = this.#options;
    let count = 0;
    let bytes = 0;
    while (count < this.#waiting.length && count < maxItems) {
      const { size } = this.#waiting[count]!;
      if (count > 0 && bytes + size > maxBytes) break;
      bytes += size;
      count++;
    }
    const list = this.#waiting.splice(0, count);
    let kept: Promise<void>;
    try {
      kept = Promise.resolve(this.#options.keep(list.map(each => each.item)));
    } catch (error) {
      kept = Promise.reject(error);
    }
    kept.then(() => this.#settle(list, bytes), (error: unknown) => this.#settle(list, bytes, { error }));
  }

  #settle(list: readonly Waiting<T>[], bytes: number, failure?: { readonly error: unknown }): void {
    this.#pendingBytes -= bytes;
    // Settled first, so whatever waits on an item is next to run; onError still runs before any of it does.
    for (const each of list) {
      if (failure) each.reject(failure.error);
      else each.resolve();
    }
    // onError/onSettled must never make idle reject or escape as an unhandled rejection; a throw from either is reported on its own instead.
    if (failure) {
      try {
        this.#options.onError(failure.error);
      } catch (handlerError) {
        raiseSafely(handlerError, this.#options.report);
      }
    }
    try {
      this.#options.onSettled?.();
    } catch (error) {
      raiseSafely(error, this.#options.report);
    }
    if (this.#waiting.length > 0) this.#next();
    else this.#busy = false;
  }
}

/** The second step of a TwoStepChain item: run once every item queued before it has finished. */
export type SecondStep = () => Promise<void>;
/**
 * The first step of a TwoStepChain item; what it gives, when it gives anything, is the item's second
 * step. `before` settles once every item queued before this one has finished (it never rejects): a
 * first step that waits for it runs after all of them, and holds up every item behind it meanwhile.
 * `carry` sets the bytes the item carries from then on, in place of those it was queued with or last
 * set: they are counted until it finishes.
 */
export type FirstStep = (before: Promise<void>, carry: (bytes: number) => void) => Promise<SecondStep | void>;

/**
 * Work done in two steps, with the bytes each item carries counted until it finishes. First steps
 * run one at a time, in the order queued, without waiting for any second step. Second steps run one
 * at a time too, in the same order, each once its own first step is done and the item before it has
 * finished. An item finishes when its second step has (or its first, when that gave none, once the
 * item before it has finished). One item failing never stops the next.
 */
export class TwoStepChain {
  readonly #options: TwoStepChainOptions;
  /** Settles once every first step queued so far has settled. */
  #begun: Promise<void> = Promise.resolve();
  #tail: Promise<void> = Promise.resolve();
  #pendingBytes = 0;

  constructor(options: TwoStepChainOptions) {
    this.#options = options;
  }

  get limit(): number {
    return this.#options.limit;
  }

  /** Bytes queued but not yet finished. */
  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  /** Settles once everything queued so far has finished. Never rejects. */
  get idle(): Promise<void> {
    return this.#tail;
  }

  /** Queue an item; its `size` bytes, or those its first step says it carries instead, count until it finishes. Returns its own settlement (rejected if either step failed). */
  push(size: number, first: FirstStep): Promise<void> {
    let carried = 0;
    let finished = false;
    const carry = (bytes: number): void => {
      if (finished) return;
      const more = bytes - carried;
      carried = bytes;
      this.#pendingBytes += more;
      if (more > 0 && this.#pendingBytes > this.#options.limit) this.#options.onOverLimit();
    };
    carry(size);
    this.#options.onQueued?.();
    const before = this.#tail;
    const begun = this.#begun.then(() => first(before, carry));
    this.#begun = begun.then(() => {}, () => {});
    const step = before.then(async () => {
      const second = await begun;
      if (second) await second();
    });
    // onError/onSettled must never make idle reject or escape as an unhandled rejection; a throw from either is reported on its own instead.
    this.#tail = step.catch(error => {
      try {
        this.#options.onError(error);
      } catch (handlerError) {
        raiseSafely(handlerError, this.#options.report);
      }
    });
    const settle = () => {
      finished = true;
      this.#pendingBytes -= carried;
      try {
        this.#options.onSettled?.();
      } catch (error) {
        raiseSafely(error, this.#options.report);
      }
    };
    step.then(settle, settle);
    return step;
  }
}
