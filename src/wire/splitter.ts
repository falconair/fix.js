import { checksum } from './checksum.ts';

export interface SplitFrame {
  readonly bytes: Uint8Array;
  readonly valid: boolean;
  readonly error?: string;
}

export interface SplitterOptions {
  /** Largest frame accepted, in bytes. Default 64 KiB. */
  maxMessageSize?: number;
}

const BEGIN = Buffer.from('8=FIX', 'latin1');
const SOH = 0x01;
/** "10=" + three digits + SOH */
const TRAILER_LENGTH = 7;
/** How far an unterminated BeginString or BodyLength may run before it's treated as garbage. */
const HEADER_LIMIT = 64;
/** The room a buffer is given when it is made for a chunk smaller than what is already held: as much as is held, within these. */
const TAIL_MIN = 64;
const TAIL_MAX = 64 * 1024;

/**
 * Splits a byte stream into FIX frames. Handles fragmentation, several frames
 * per chunk and garbage between frames. Memory is bounded by maxMessageSize.
 * Never throws: problems come back as frames with valid: false.
 */
export class FrameSplitter {
  /**
   * The bytes not yet consumed, oldest first; made into one buffer only when a frame completes or a
   * header needs inspecting. Every buffer is full except, at times, the last (see #tailUsed).
   */
  #chunks: Buffer[] = [];
  /** How many bytes the last of #chunks holds, when it was made with room for more (see add); undefined when every buffer is full. */
  #tailUsed: number | undefined;
  #length = 0;
  /** Bytes needed to complete the frame at the head, once known, so later pushes can skip re-scanning until enough are buffered. */
  #pendingTotal: number | undefined;
  readonly #max: number;

  constructor(options: SplitterOptions = {}) {
    const max = options.maxMessageSize;
    if (max !== undefined && !(Number.isInteger(max) && max >= 64)) {
      throw new RangeError(`maxMessageSize must be a finite integer of at least 64, got ${max}`);
    }
    this.#max = max ?? 64 * 1024;
  }

  /** Add received bytes; returns every frame they complete, in order. */
  push(chunk: Uint8Array): SplitFrame[] {
    this.add(chunk);
    const out: SplitFrame[] = [];
    for (let next = this.take(); next; next = this.take()) out.push(next);
    return out;
  }

  /**
   * Add received bytes without splitting them: take() gives their frames, one at a time. Nothing
   * here bounds what is added and not taken; whoever adds without taking keeps its own count of `length`.
   *
   * The bytes are copied, once, and what is held costs what it weighs however small the chunks: a
   * chunk added to an empty splitter, or one at least as large as all that is held, gets a buffer
   * of its own size, as it always did; a smaller one goes into the room left in the last buffer,
   * and when there is none, into a new buffer with room for as much as is already held (64 bytes
   * at least, 64 KiB at most). So the buffers have room for no more than twice the bytes held plus
   * 64, their number grows with the logarithm of the bytes held up to 64 KiB and by one for every
   * 64 KiB after, and no buffer is ever copied into a larger one here: a large frame that arrives
   * in many small chunks costs one copy of each byte as it is added and one more when it is whole.
   */
  add(chunk: Uint8Array): void {
    let copied = 0;
    if (this.#tailUsed !== undefined) {
      const tail = this.#chunks[this.#chunks.length - 1]!;
      copied = Math.min(chunk.length, tail.length - this.#tailUsed);
      tail.set(copied === chunk.length ? chunk : chunk.subarray(0, copied), this.#tailUsed);
      this.#tailUsed += copied;
      if (this.#tailUsed === tail.length) this.#tailUsed = undefined;
    }
    const rest = chunk.length - copied;
    if (rest > 0) {
      const held = this.#length + copied;
      const room = held === 0 ? 0 : Math.min(Math.max(held, TAIL_MIN), TAIL_MAX);
      if (rest >= room) {
        this.#chunks.push(Buffer.from(copied === 0 ? chunk : chunk.subarray(copied)));
      } else {
        // Not from Node's shared pool: a buffer that waits for bytes would keep a whole slab of it.
        const tail = Buffer.allocUnsafeSlow(room);
        tail.set(chunk.subarray(copied));
        this.#chunks.push(tail);
        this.#tailUsed = rest;
      }
    }
    this.#length += chunk.length;
  }

  /** The next frame of the bytes added, or undefined when they hold no whole frame: only the beginning of one, at most. */
  take(): SplitFrame | undefined {
    return this.#next();
  }

  /** Bytes added and not yet given as frames. */
  get length(): number {
    return this.#length;
  }

  /**
   * The buffers that hold the bytes added and not yet given as frames: how many there are, and the
   * bytes they have room for between them.
   */
  get buffers(): { readonly count: number; readonly capacity: number } {
    return { count: this.#chunks.length, capacity: this.#chunks.reduce((sum, each) => sum + each.length, 0) };
  }

  /** Drop the bytes added and not yet given as frames. */
  clear(): void {
    this.#chunks = [];
    this.#tailUsed = undefined;
    this.#length = 0;
    this.#pendingTotal = undefined;
  }

  #next(): SplitFrame | undefined {
    if (this.#length === 0) return undefined;
    if (this.#pendingTotal !== undefined && this.#length < this.#pendingTotal) return undefined;
    this.#pendingTotal = undefined;
    const buf = this.#materialize();

    const start = buf.indexOf(BEGIN);
    if (start < 0) {
      // Keep the last few bytes: they may be the start of "8=FIX".
      return buf.length > BEGIN.length ? this.#take(buf.length - (BEGIN.length - 1), 'Bytes before BeginString (8=FIX)') : undefined;
    }
    if (start > 0) return this.#take(start, 'Bytes before BeginString (8=FIX)');

    const beginEnd = buf.indexOf(SOH);
    if (beginEnd < 0) return this.#waitOrSkip(buf.length, 'BeginString (8) is not terminated');
    if (buf.length < beginEnd + 3) return undefined;
    if (buf.toString('latin1', beginEnd + 1, beginEnd + 3) !== '9=') return this.#skip('BodyLength (9) must follow BeginString');

    const lengthEnd = buf.indexOf(SOH, beginEnd + 3);
    if (lengthEnd < 0) return this.#waitOrSkip(buf.length - beginEnd, 'BodyLength (9) is not terminated');
    const lengthText = buf.toString('latin1', beginEnd + 3, lengthEnd);
    if (!/^\d+$/.test(lengthText)) return this.#skip(`BodyLength '${lengthText}' is not a number`);
    if (lengthText.length > 1 && lengthText[0] === '0') return this.#skip(`BodyLength '${lengthText}' has a leading zero`);

    const total = lengthEnd + 1 + Number(lengthText) + TRAILER_LENGTH;
    if (total > this.#max) return this.#skip(`BodyLength ${lengthText} exceeds the ${this.#max}-byte limit`);
    if (buf.length < total) {
      this.#pendingTotal = total;
      return undefined;
    }

    const trailerStart = total - TRAILER_LENGTH;
    if (buf.toString('latin1', trailerStart, trailerStart + 3) !== '10=' || buf[total - 1] !== SOH) {
      return this.#skip(`BodyLength ${lengthText} doesn't end at the CheckSum field`);
    }

    const bytes = this.#consume(total);
    const expected = checksum(bytes.subarray(0, trailerStart));
    const actual = bytes.toString('latin1', trailerStart + 3, total - 1);
    return actual === expected
      ? { bytes, valid: true }
      : { bytes, valid: false, error: `CheckSum is ${actual} but should be ${expected}` };
  }

  /**
   * Collapse the buffers into one, of exactly the bytes held, so header bytes and frame bounds can
   * be inspected. A buffer with room to spare never outlives this: the frames given are views of a
   * buffer nothing is added to afterwards.
   */
  #materialize(): Buffer {
    if (this.#tailUsed !== undefined || this.#chunks.length !== 1) {
      // Only the last buffer can have room to spare, and concat stops at #length: the room is left out.
      this.#chunks = [Buffer.concat(this.#chunks, this.#length)];
      this.#tailUsed = undefined;
    }
    return this.#chunks[0]!;
  }

  /** Remove and return the first n bytes of the (already materialized) buffer. */
  #consume(n: number): Buffer {
    const buf = this.#chunks[0]!;
    const bytes = buf.subarray(0, n);
    const rest = buf.subarray(n);
    this.#chunks = rest.length ? [rest] : [];
    this.#length -= n;
    return bytes;
  }

  /** Emit the first n bytes as invalid. */
  #take(n: number, error: string): SplitFrame {
    return { bytes: this.#consume(n), valid: false, error };
  }

  /** Give up on the frame starting at byte 0: discard up to the next "8=FIX". */
  #skip(error: string): SplitFrame {
    const buf = this.#chunks[0]!;
    const next = buf.indexOf(BEGIN, 1);
    return this.#take(next < 0 ? buf.length : next, error);
  }

  #waitOrSkip(size: number, error: string): SplitFrame | undefined {
    return size > HEADER_LIMIT ? this.#skip(error) : undefined;
  }
}

/** Frames from an async stream of byte chunks (a socket, a file stream). */
export async function* frames(chunks: AsyncIterable<Uint8Array>, options?: SplitterOptions): AsyncGenerator<SplitFrame> {
  const splitter = new FrameSplitter(options);
  for await (const chunk of chunks) yield* splitter.push(chunk);
}
