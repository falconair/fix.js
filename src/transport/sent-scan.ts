/**
 * How many MsgSeqNums a fileStore's sent() gives from one pass over the part of an epoch file that
 * is before the latest run of originals in MsgSeqNum order. It holds the places of at most twice as
 * many at once, whatever the range and whatever the file holds.
 */
export const SENT_BATCH = 4_096;

/** A line of an epoch file that holds an original: its MsgSeqNum, where the line starts, and its length in bytes with its newline. */
export interface OriginalLine {
  readonly seq: number;
  readonly start: number;
  readonly length: number;
}

/**
 * Where the latest original of each of the lowest SENT_BATCH MsgSeqNums within low..to is, of the
 * lines noted in file order, passing over every MsgSeqNum within `except`. It never holds more than
 * twice SENT_BATCH places: at that many it drops the higher half, and from then on passes over any
 * MsgSeqNum above the highest it kept.
 */
export class LowestOriginals {
  readonly #latest = new Map<number, OriginalLine>();
  readonly #low: number;
  readonly #to: number;
  readonly #except: { readonly from: number; readonly to: number } | undefined;
  #ceiling: number;

  constructor(low: number, to: number, except?: { readonly from: number; readonly to: number }) {
    this.#low = low;
    this.#to = to;
    this.#ceiling = to;
    this.#except = except;
  }

  /** How many places are held. */
  get places(): number { return this.#latest.size; }

  /** The SENT_BATCH lowest held, in MsgSeqNum order. */
  #lowest(): OriginalLine[] {
    return [...this.#latest.values()].sort((a, b) => a.seq - b.seq).slice(0, SENT_BATCH);
  }

  /** An original is on `line`. Called for every original of the part read, in file order: a later one with the same MsgSeqNum takes the place of an earlier. */
  note(line: OriginalLine): void {
    if (line.seq < this.#low || line.seq > this.#ceiling) return;
    if (this.#except && line.seq >= this.#except.from && line.seq <= this.#except.to) return;
    this.#latest.set(line.seq, line);
    if (this.#latest.size < 2 * SENT_BATCH) return;
    const kept = this.#lowest();
    this.#latest.clear();
    for (const each of kept) this.#latest.set(each.seq, each);
    this.#ceiling = kept.at(-1)!.seq;
  }

  /**
   * The lines found, lowest MsgSeqNum first, and whether there may be originals with higher
   * MsgSeqNums within the range than those: some were dropped (the ceiling came down), or more than
   * one batch is held.
   */
  found(): { lines: OriginalLine[]; more: boolean } {
    return { lines: this.#lowest(), more: this.#ceiling < this.#to || this.#latest.size > SENT_BATCH };
  }
}
