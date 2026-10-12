// QuickFIX/J's acceptance scripts: reading one, building what its `I` lines
// send, and comparing what comes back with its `E` lines, by the rules of
// QuickFIX/J's own runner. A script is latin1 text, one step per line, with SOH
// between fields:
//   iCONNECT / i2,CONNECT        open a connection (client 1 unless numbered)
//   I8=FIX.4.4|35=A|…            send a message
//   E8=FIX.4.4|9=61|35=A|…       expect a message next
//   eDISCONNECT / e2,DISCONNECT  expect the connection to be closed
//   # …                          a comment

const SOH = '\x01';

export type Step =
  | { readonly kind: 'connect'; readonly client: number; readonly line: number }
  | { readonly kind: 'send'; readonly client: number; readonly line: number; readonly text: string }
  | { readonly kind: 'expect'; readonly client: number; readonly line: number; readonly fields: ReadonlyMap<number, string> }
  | { readonly kind: 'disconnect'; readonly client: number; readonly line: number };

/** A message as tag → value; a repeated tag keeps its last value, as in QuickFIX/J's runner. */
export function fieldsOf(text: string): Map<number, string> {
  const fields = new Map<number, string>();
  for (const match of text.matchAll(/(\d+)=([^\x01]+)\x01/g)) fields.set(Number(match[1]), match[2]!);
  return fields;
}

/** A script read line by line: its steps, and the lines that are not steps (by number, with their text). */
function read(text: string): { steps: Step[]; passedOver: { line: number; content: string }[] } {
  const steps: Step[] = [];
  const passedOver: { line: number; content: string }[] = [];
  text.split('\n').forEach((raw, index) => {
    const line = index + 1;
    const content = raw.replace(/\r$/, '');
    if (content.trim() === '' || /^[ \t]*#/.test(content)) return;
    const connect = /^i(\d+)?,?CONNECT$/.exec(content);
    const disconnect = /^e(\d+)?,?DISCONNECT$/.exec(content);
    if (connect) {
      steps.push({ kind: 'connect', client: Number(connect[1] ?? 1), line });
    } else if (disconnect) {
      steps.push({ kind: 'disconnect', client: Number(disconnect[1] ?? 1), line });
    } else if (content.startsWith('I')) {
      const numbered = /^I(\d+),/.exec(content);
      steps.push({ kind: 'send', client: Number(numbered?.[1] ?? 1), line, text: content.slice(numbered ? numbered[0].length : 1) });
    } else if (content.startsWith('E')) {
      steps.push({ kind: 'expect', client: Number(/^E(\d+),/.exec(content)?.[1] ?? 1), line, fields: fieldsOf(content) });
    } else if (/^[a-z]\d*,?[A-Z_]{2,}/.test(content)) {
      // Shaped like a step (a letter, then a word in capitals), but not one this runner has.
      throw new Error(`Line ${line} is not a step this runner knows: ${content.replaceAll(SOH, '|')}`);
    } else {
      passedOver.push({ line, content });
    }
  });
  return { steps, passedOver };
}

/**
 * The steps of a script. A line that is not a step is passed over, as QuickFIX/J's
 * runner passes over it (two of its scripts have one: a stray letter, and a
 * comment without its #); with `strict`, it is an error naming the line. A line
 * shaped like a step this runner lacks is always an error naming the line.
 */
export function parseScript(text: string, { strict = false }: { readonly strict?: boolean } = {}): Step[] {
  const { steps, passedOver } = read(text);
  const first = passedOver[0];
  if (strict && first) throw new Error(`Line ${first.line} is not a step: ${first.content.replaceAll(SOH, '|')}`);
  return steps;
}

/** The numbers of the lines parseScript() passes over: neither a step, a comment nor blank. */
export function passedOver(text: string): number[] {
  return read(text).passedOver.map(each => each.line);
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/** A UTCTimestamp with milliseconds: 20260930-12:00:00.000. */
export function timestamp(at: Date): string {
  return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1, 2)}${pad(at.getUTCDate(), 2)}-`
    + `${pad(at.getUTCHours(), 2)}:${pad(at.getUTCMinutes(), 2)}:${pad(at.getUTCSeconds(), 2)}.${pad(at.getUTCMilliseconds(), 3)}`;
}

function checksum(text: string): string {
  let sum = 0;
  for (const byte of Buffer.from(text, 'latin1')) sum += byte;
  return pad(sum % 256, 3);
}

/**
 * The bytes an `I` line sends. For a line that starts with a BeginString and
 * ends with SOH: <TIME>, <TIME+n> and <TIME-n> become the time now (n × 1.1 s
 * later or earlier), BodyLength is added unless the line gives one, and a
 * CheckSum of `10=0` is sent as `10=000`. Any other line is sent as written.
 * Either way a CheckSum is added when the line has none.
 */
export function buildMessage(text: string, now: Date): Buffer {
  const parts = /^(8=FIXT?\.\d\.\d\x01)(.*?\x01)(10=.*|)$/.exec(text);
  let message = text;
  if (parts) {
    const tail = parts[2]!.replace(/<TIME(?:([+-])(\d+))?>/g, (_placeholder, sign: string | undefined, amount: string | undefined) =>
      timestamp(new Date(now.getTime() + (sign === '-' ? -1 : 1) * Number(amount ?? 0) * 1100)));
    const trailer = parts[3] === `10=0${SOH}` ? `10=000${SOH}` : parts[3]!;
    message = parts[1]! + (tail.startsWith('9=') ? '' : `9=${tail.length}${SOH}`) + tail + trailer;
  }
  if (!message.includes(`${SOH}10=`)) message += `10=${checksum(message)}${SOH}`;
  return Buffer.from(message, 'latin1');
}

/** Timestamps (SendingTime, TransactTime, OrigSendingTime) and the framing fields are never compared by value. */
const NOT_COMPARED: ReadonlySet<number> = new Set([52, 60, 122, 9, 10]);
const TIMESTAMPS = [52, 60, 122];

export interface Comparison {
  /** How the message differs from the `E` line; empty when it matches. */
  readonly differences: string[];
  /** The tags in `ignore` whose values did differ: what ignoring them let through. */
  readonly ignored: number[];
  /** The tags in `extra` that the message did carry and the `E` line lacks: what allowing them let through. Left out when there is none. */
  readonly extra?: number[];
}

/**
 * Compare a received message with an `E` line, by QuickFIX/J's rules: MsgType
 * and every other field must be equal, except that Text (58) need only begin
 * with what is expected; timestamps are not compared; neither side may have a
 * field the other lacks; and BodyLength is compared only when every expected
 * timestamp is as long as the one received.
 *
 * A tag in `ignore` must be there when expected, but a value that differs
 * from the expected one is let through (and listed in `ignored`); for Text
 * that holds even when the received text only goes on from the expected one.
 * An ignored value excuses nothing else: BodyLength is still compared, and
 * must be the expected one plus, for each ignored tag that differed, the
 * received value's length less the expected value's (in bytes, as sent).
 *
 * A tag in `extra` may be in the message though the `E` line lacks it (and is
 * listed in `extra` when it is); BodyLength must then be the expected one plus
 * that field's bytes.
 *
 * The scripts' BodyLength is not always the length of their fields. An
 * expected BodyLength that the expected fields themselves exceed is one no
 * message can have, so it is not compared; the message is held to its own
 * fields instead: its BodyLength must be what the fields read from it come
 * to, so a repeated field, an empty one or a tag that is not a number still
 * shows there.
 */
export function compare(
  expected: ReadonlyMap<number, string>, actual: ReadonlyMap<number, string>,
  ignore: ReadonlySet<number> = new Set(), extra: ReadonlySet<number> = new Set(),
): Comparison {
  if (expected.get(35) !== actual.get(35)) return { differences: [`MsgType (35) is ${actual.get(35)}, expected ${expected.get(35)}`], ignored: [] };
  const differences: string[] = [];
  const ignored: number[] = [];
  const allowed: number[] = [];
  let adjustment = 0;
  for (const [tag, value] of actual) {
    if (NOT_COMPARED.has(tag)) continue;
    const wanted = expected.get(tag);
    if (wanted === undefined) {
      if (extra.has(tag)) {
        allowed.push(tag);
        adjustment += String(tag).length + value.length + 2;
      } else {
        differences.push(`Unexpected field ${tag}=${value}`);
      }
    } else if (value === wanted) continue;
    else if (ignore.has(tag)) {
      ignored.push(tag);
      adjustment += value.length - wanted.length;
    } else if (tag === 58 && value.startsWith(wanted)) continue;
    else differences.push(`Field ${tag} is ${value}, expected ${wanted}`);
  }
  for (const tag of expected.keys()) {
    if (!actual.has(tag)) differences.push(`Missing field ${tag}`);
  }
  const sameLengthTimes = TIMESTAMPS.every(tag => !expected.has(tag) || expected.get(tag)!.length === actual.get(tag)?.length);
  if (expected.has(9) && sameLengthTimes) {
    const wanted = expected.get(9)!;
    const adjusted = adjustment === 0 ? wanted : String(Number(wanted) + adjustment);
    if (Number(wanted) < bodyOf(expected)) {
      const own = bodyOf(actual);
      if (String(own) !== actual.get(9)) differences.push(`BodyLength (9) is ${actual.get(9)}, but the fields read from the message come to ${own}`);
    } else if (adjusted !== actual.get(9)) {
      const sign = adjustment > 0 ? '+' : '';
      differences.push(adjustment === 0
        ? `BodyLength (9) is ${actual.get(9)}, expected ${wanted}`
        : `BodyLength (9) is ${actual.get(9)}, expected ${adjusted} (${wanted} adjusted by ${sign}${adjustment} for ${adjustedFor(ignored, allowed)})`);
    }
  }
  return allowed.length > 0 ? { differences, ignored, extra: allowed } : { differences, ignored };
}

/** What an expected BodyLength was adjusted for, in words: 'ignored 58', 'extra 1137', or both. */
function adjustedFor(ignored: readonly number[], extra: readonly number[]): string {
  return [...(ignored.length > 0 ? [`ignored ${ignored.join(', ')}`] : []), ...(extra.length > 0 ? [`extra ${extra.join(', ')}`] : [])].join(' and ');
}

/** What the fields BodyLength counts come to, in bytes as sent: every field but BeginString, BodyLength and CheckSum, each tag once. */
function bodyOf(fields: ReadonlyMap<number, string>): number {
  let length = 0;
  for (const [tag, value] of fields) {
    if (tag !== 8 && tag !== 9 && tag !== 10) length += String(tag).length + value.length + 2;
  }
  return length;
}

/**
 * Splits what the server sends into messages, checking each one's BodyLength
 * and CheckSum on the way, independently of fix.js's own wire layer. Throws
 * when the bytes are not a well-formed FIX message.
 */
export class MessageReader {
  #buffer = '';

  /** Add received bytes; returns the messages they complete, as latin1 text. */
  push(chunk: Uint8Array): string[] {
    this.#buffer += Buffer.from(chunk).toString('latin1');
    const messages: string[] = [];
    for (;;) {
      const header = /^8=[^\x01]*\x019=(\d+)\x01/.exec(this.#buffer);
      if (!header) {
        if (this.#buffer.length > 64 || (this.#buffer.length > 1 && !this.#buffer.startsWith('8='))) {
          throw new Error(`Not the start of a FIX message: ${this.#buffer.slice(0, 64).replaceAll(SOH, '|')}`);
        }
        return messages;
      }
      const end = header[0].length + Number(header[1]) + '10=000\x01'.length;
      if (this.#buffer.length < end) return messages;
      const message = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end);
      const trailer = message.slice(-7);
      if (trailer !== `10=${checksum(message.slice(0, -7))}${SOH}`) {
        throw new Error(`BodyLength or CheckSum is wrong in ${message.replaceAll(SOH, '|')}`);
      }
      messages.push(message);
    }
  }
}
