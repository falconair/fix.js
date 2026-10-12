/** Milliseconds, or text like '5s' / '500ms'. */
export type Duration = number | `${number}s` | `${number}ms`;

const TEXT = /^(\d+(?:\.\d+)?)(ms|s)$/;

export function toMs(duration: Duration): number {
  if (typeof duration === 'number') {
    if (!Number.isFinite(duration) || duration < 0) throw new RangeError(`A duration can't be ${duration}`);
    return duration;
  }
  const match = TEXT.exec(duration);
  if (!match) throw new RangeError(`'${duration}' is not a duration; use milliseconds or text like '5s' or '500ms'`);
  const amount = Number(match[1]);
  return match[2] === 's' ? amount * 1000 : amount;
}

/** The largest delay Node's setTimeout/setInterval accept; past this they overflow a 32-bit signed int and fire after 1 ms instead. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** A timeout option in milliseconds. RangeError, naming the option, unless it is a duration greater than 0 and no more than Node's timer limit. */
export function timeoutMs(duration: Duration, name: string): number {
  let ms: number | undefined;
  try {
    ms = toMs(duration);
  } catch {
    ms = undefined;
  }
  if (ms === undefined || !(ms > 0) || ms > MAX_TIMER_MS) {
    throw new RangeError(`${name} must be a duration greater than 0 and at most ${MAX_TIMER_MS} ms (milliseconds, or text like '10s' or '500ms'), got ${String(duration)}`);
  }
  return ms;
}
