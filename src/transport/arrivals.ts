/** The most times of arrival kept at once (see Arrivals). */
export const ARRIVAL_MARKS = 128;

/**
 * When the bytes a session holds arrived, so that a message taken from them later is judged by
 * when its last byte came and not by when it is processed.
 *
 * One time is kept for each second of the clock in which bytes still held arrived, the time of
 * the last of them, and never more than ARRIVAL_MARKS times whatever is held and however slowly it
 * came. When one more would be kept, the two neighbours whose bytes arrived across the shortest
 * time become one, with the later one's time: their bytes are from then on judged as arrived when
 * the last of them did. So bytes are never judged as arrived before they did, nor after the newest
 * time noted (which is never after now), and later than they did by less than a second while the
 * bytes held arrived in ARRIVAL_MARKS different seconds or fewer, and otherwise by no more than a
 * sixtieth of the longest time across which the bytes held have arrived: two seconds for a session
 * two minutes behind. (Of 129 times, the 128 pairs of neighbours cover at most twice the time from
 * the first to the last between them, so the closest pair covers at most a sixty-fourth of it.)
 *
 * Noting a time costs at most one pass over the times kept, and so does taking bytes, however many
 * times that drops: they are dropped together.
 */
export class Arrivals {
  /**
   * Oldest first. `upTo` counts the bytes noted since the beginning or the last clear(), up to the
   * last this time is for; `at` is when that one arrived, and `since` when the first did.
   */
  readonly #marks: { upTo: number; since: number; at: number }[] = [];
  #received = 0;
  #taken = 0;

  /** How many times are kept. */
  get marks(): number {
    return this.#marks.length;
  }

  /** `bytes` more arrived at `at` (ms). Without `at` they are judged by the next time noted, or by none. */
  note(bytes: number, at?: number): void {
    if (bytes === 0) return;
    this.#received += bytes;
    if (at === undefined) return;
    const marks = this.#marks;
    const last = marks.at(-1);
    if (last && Math.floor(last.at / 1000) === Math.floor(at / 1000)) {
      last.upTo = this.#received;
      last.at = at;
      return;
    }
    marks.push({ upTo: this.#received, since: at, at });
    if (marks.length <= ARRIVAL_MARKS) return;
    let closest = 0;
    for (let n = 1; n < marks.length - 1; n++) {
      if (marks[n + 1]!.at - marks[n]!.since < marks[closest + 1]!.at - marks[closest]!.since) closest = n;
    }
    marks[closest + 1]!.since = marks[closest]!.since;
    marks.splice(closest, 1);
  }

  /**
   * The next `bytes` bytes are taken: when the last of them arrived, as far as it is kept (see the
   * class), or undefined when no time was noted for it. Times of bytes all taken are dropped.
   */
  take(bytes: number): number | undefined {
    this.#taken += bytes;
    const marks = this.#marks;
    let first = 0;
    while (first < marks.length && marks[first]!.upTo < this.#taken) first++;
    const mark = marks[first];
    const spent = mark !== undefined && mark.upTo === this.#taken ? first + 1 : first;
    if (spent > 0) marks.splice(0, spent);
    return mark?.at;
  }

  /** Forget every time, and the bytes they were for. */
  clear(): void {
    this.#marks.length = 0;
    this.#received = 0;
    this.#taken = 0;
  }
}
