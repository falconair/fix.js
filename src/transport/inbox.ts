import { FIXStateError, TimeoutError } from '../errors.ts';
import { toMs, type Duration } from '../util/duration.ts';
import type { MessageObject } from '../wire/message.ts';
import type { Clock } from './clock.ts';
import { UNSIZED_ENTRY_BYTES } from './size.ts';

const DEFAULT_TIMEOUT: Duration = '5s';

/** How much an Inbox keeps, and how far a messages() consumer may fall behind: entries and bytes. */
export interface InboxLimits {
  readonly entries: number;
  readonly bytes: number;
}

export interface InboxOptions {
  readonly clock: Clock;
  /** Whether messages() without a type yields this message. */
  readonly isApplication: (message: MessageObject) => boolean;
  /** Where a listener's error goes. */
  readonly onError: (error: unknown) => void;
}

/** Told about each delivered message (with its size), or, with none, that the session closed. */
type Listener = (message: MessageObject | undefined, size?: number) => void;

interface Item {
  readonly message: MessageObject;
  readonly size: number;
}

/**
 * Delivered messages waiting to be taken by next(), and the listeners
 * (next() calls, messages() iterators) told about each new one. Bounded by
 * count and bytes: the oldest untaken message is dropped first.
 */
export class Inbox {
  readonly #limits: InboxLimits;
  readonly #options: InboxOptions;
  readonly #items: Item[] = [];
  #bytes = 0;
  readonly #listeners = new Set<Listener>();
  /** Why the session closed, once it has. */
  #closedText: string | undefined;

  constructor(limits: InboxLimits, options: InboxOptions) {
    this.#limits = limits;
    this.#options = options;
  }

  /** How many delivered messages are waiting (for tests). */
  get size(): number {
    return this.#items.length;
  }

  /** Keep a delivered message for next(), dropping the oldest past the limits. */
  keep(message: MessageObject, size: number): void {
    this.#items.push({ message, size });
    this.#bytes += size;
    while (this.#items.length > this.#limits.entries || this.#bytes > this.#limits.bytes) {
      const removed = this.#items.shift();
      if (!removed) break;
      this.#bytes -= removed.size;
    }
  }

  /** Tell every listener about a delivered message. */
  notify(message: MessageObject, size: number): void {
    this.#tell(message, size);
  }

  /** The session closed: waiting next() calls reject, and messages() iterators end. */
  close(text: string): void {
    if (this.#closedText !== undefined) return;
    this.#closedText = text;
    this.#tell(undefined);
  }

  /** Subscribes immediately (not on the first next()). Its own queue is bounded (count and bytes); past that it ends by throwing once, then reports done. return() unsubscribes. */
  messages(msgType?: string): AsyncIterableIterator<MessageObject> {
    const queue: Item[] = [];
    let queueBytes = 0;
    let waiters: (() => void)[] = [];
    let ended = this.#closedText !== undefined;
    let overflow: Error | undefined;
    const wake = () => {
      const list = waiters;
      waiters = [];
      for (const resolve of list) resolve();
    };
    const unsubscribe = () => this.#listeners.delete(listener);
    const listener: Listener = (message, size = UNSIZED_ENTRY_BYTES) => {
      if (message === undefined) {
        ended = true;
      } else if (msgType === undefined ? this.#options.isApplication(message) : message.MsgType === msgType) {
        queue.push({ message, size });
        queueBytes += size;
        if (queue.length > this.#limits.entries) {
          overflow = new FIXStateError(`messages() fell more than ${this.#limits.entries} messages behind`);
        } else if (queueBytes > this.#limits.bytes) {
          overflow = new FIXStateError(`messages() fell more than ${this.#limits.bytes} bytes behind`);
        }
        if (overflow) {
          queue.length = 0;
          queueBytes = 0;
          ended = true;   // once overflowed, the iterator ends for good (after reporting the error once)
          unsubscribe();
        }
      }
      wake();
    };
    this.#listeners.add(listener);
    const iterator: AsyncIterableIterator<MessageObject> = {
      async next(): Promise<IteratorResult<MessageObject>> {
        for (;;) {
          if (overflow) {
            const error = overflow;
            overflow = undefined;
            throw error;
          }
          const item = queue.shift();
          if (item) {
            queueBytes -= item.size;
            return { value: item.message, done: false };
          }
          if (ended) {
            unsubscribe();
            return { value: undefined, done: true };
          }
          await new Promise<void>(resolve => { waiters.push(resolve); });
        }
      },
      async return(value?: unknown): Promise<IteratorResult<MessageObject>> {
        unsubscribe();
        ended = true;
        wake();   // a next() already pending must resolve {done: true}, not hang forever
        return { value: value as MessageObject, done: true };
      },
      [Symbol.asyncIterator]() { return iterator; },
    };
    return iterator;
  }

  next(msgType: string, options: { where?: Readonly<Record<string, unknown>>; timeout?: Duration } = {}): Promise<MessageObject> {
    const ms = toMs(options.timeout ?? DEFAULT_TIMEOUT);
    const { clock } = this.#options;
    return new Promise((resolve, reject) => {
      let timer: unknown;
      const finish = () => {
        this.#listeners.delete(check);
        clock.clearTimeout(timer);
      };
      const take = (): boolean => {
        const index = this.#items.findIndex(item => matches(item.message, msgType, options.where));
        if (index >= 0) {
          const [item] = this.#items.splice(index, 1);
          this.#bytes -= item!.size;
          finish();
          resolve(item!.message);
          return true;
        }
        if (this.#closedText !== undefined) {
          finish();
          reject(new FIXStateError(`The session closed before a ${msgType} arrived: ${this.#closedText}`));
          return true;
        }
        return false;
      };
      const check = () => { take(); };
      if (take()) return;
      this.#listeners.add(check);
      timer = clock.setTimeout(() => {
        finish();
        reject(new TimeoutError(`No ${msgType} within ${ms} ms`, { kind: 'message', msgType }));
      }, ms);
    });
  }

  #tell(message: MessageObject | undefined, size?: number): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(message, size);
      } catch (error) {
        this.#options.onError(error);
      }
    }
  }
}

function matches(message: MessageObject, msgType: string, where: Readonly<Record<string, unknown>> | undefined): boolean {
  if (message.MsgType !== msgType) return false;
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => {
    const actual = message[key];
    return value instanceof Date && actual instanceof Date ? value.getTime() === actual.getTime() : actual === value;
  });
}
