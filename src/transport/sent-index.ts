/** The most places a SentIndex holds. */
export const MAX_CHECKPOINTS = 1_024;

/** What to read of an epoch file for the originals within a range of MsgSeqNums (see SentIndex.plan). */
export interface SentPlan {
  /** The byte to begin reading the latest run at: a line of it starts there, and no original of the range is before it in the run. */
  readonly start: number;
  /** The lowest MsgSeqNum the latest run holds: its first. 0 when the file holds no original. */
  readonly first: number;
  /**
   * What to read of the file before the latest run, when the range has a MsgSeqNum that part could
   * hold and the latest run is not known to hold: its bytes up to `end`, for the MsgSeqNums from..to
   * that are not within `except` (the latest run holds every one of those).
   */
  readonly earlier?: {
    readonly end: number;
    readonly from: number;
    readonly to: number;
    readonly except: { readonly from: number; readonly to: number };
  };
}

/**
 * What a fileStore remembers of one epoch file so that sent() need not read all of it. It follows
 * the latest run of originals written in MsgSeqNum order: the originals from the last one whose
 * MsgSeqNum was not higher than the one before it, on to the end of the file. Of that run it marks
 * the place of one original in every `stride`, and holds at most MAX_CHECKPOINTS places: once full it
 * drops every other one and marks half as often. At an original whose MsgSeqNum is not higher than
 * the one before, the run begins again from that line with no place held, and of everything before
 * that line the index keeps only the lowest and the highest MsgSeqNum (and that it ends where the
 * run begins). So it is the same size however often the MsgSeqNums step backward.
 */
export class SentIndex {
  /** The byte offset of the end of the file: where the next line appended to it will start. */
  end = 0;
  #checkpoints: { readonly seq: number; readonly offset: number }[] = [];
  #stride = 1;
  /** How many originals the latest run holds. */
  #originals = 0;
  #highest = 0;
  /** Where the latest run begins: the start of the file while no MsgSeqNum has stepped backward. */
  #runStart = 0;
  /** The MsgSeqNums of the first and the last original of the latest run: its lowest and highest. */
  #runFirst = 0;
  #runLast = 0;
  /** The latest run holds every MsgSeqNum from this one to its last: it is the last one that did not follow the one before by exactly 1. */
  #solidFrom = 0;
  /** The lowest and highest MsgSeqNum of the originals before the latest run; `#earlierHighest` is 0 when there are none. */
  #earlierLowest = 0;
  #earlierHighest = 0;

  /** The highest MsgSeqNum of any original noted; 0 when there is none. */
  get highest(): number { return this.#highest; }
  /** True while every original noted had a higher MsgSeqNum than the one before: the latest run is the whole file, one original per MsgSeqNum. */
  get regular(): boolean { return this.#earlierHighest === 0; }
  /** How many places are held, all of the latest run. */
  get places(): number { return this.#checkpoints.length; }
  /** One original of the latest run in this many has its place marked. */
  get stride(): number { return this.#stride; }

  /** An original with MsgSeqNum `seq` is on the line that starts at byte `offset`. Called for every original, in file order. */
  note(seq: number, offset: number): void {
    if (this.#originals > 0 && seq <= this.#runLast) {
      // A step backward: everything up to here becomes the earlier part, and the run begins again.
      this.#earlierLowest = this.#earlierHighest === 0 ? this.#runFirst : Math.min(this.#earlierLowest, this.#runFirst);
      this.#earlierHighest = Math.max(this.#earlierHighest, this.#runLast);
      this.#checkpoints = [];
      this.#stride = 1;
      this.#originals = 0;
      this.#runStart = offset;
    }
    if (this.#originals === 0) this.#runFirst = seq;
    if (this.#originals === 0 || seq !== this.#runLast + 1) this.#solidFrom = seq;
    this.#runLast = seq;
    if (seq > this.#highest) this.#highest = seq;
    if (this.#originals % this.#stride === 0) {
      this.#checkpoints.push({ seq, offset });
      if (this.#checkpoints.length > MAX_CHECKPOINTS) {
        this.#checkpoints = this.#checkpoints.filter((_, index) => index % 2 === 0);
        this.#stride *= 2;
      }
    }
    this.#originals++;
  }

  /**
   * Where to begin reading the latest run for the originals from MsgSeqNum `from` on: the last
   * place marked at or below it, or where the run begins when there is none.
   */
  startFor(from: number): number {
    let low = 0;
    let high = this.#checkpoints.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.#checkpoints[middle]!.seq <= from) low = middle + 1;
      else high = middle;
    }
    return low === 0 ? this.#runStart : this.#checkpoints[low - 1]!.offset;
  }

  /**
   * What to read for the originals within from..to, the latest of each MsgSeqNum: the latest run
   * from `start`, and the part of the file before it only when that part could hold a MsgSeqNum of
   * the range (it is within the lowest and highest noted there) that the latest run is not known
   * to hold. The numbers it gives stay true of the file's bytes up to `end` as it is now, whatever
   * is noted after.
   */
  plan(from: number, to: number): SentPlan {
    const plan = { start: this.startFor(from), first: this.#runFirst };
    if (this.#earlierHighest === 0) return plan;
    const low = Math.max(from, this.#earlierLowest);
    const high = Math.min(to, this.#earlierHighest);
    if (low > high || (low >= this.#solidFrom && high <= this.#runLast)) return plan;
    return { ...plan, earlier: { end: this.#runStart, from: low, to: high, except: { from: this.#solidFrom, to: this.#runLast } } };
  }
}
