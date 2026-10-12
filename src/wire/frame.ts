import { checksum } from './checksum.ts';

export const SOH = '\x01';

/** One tag=value pair. The value is wire text: latin1, one char per byte. */
export interface RawField {
  readonly tag: number;
  readonly value: string;
}

export interface Frame {
  readonly fields: readonly RawField[];
  /** Problems found, in plain English. Empty for a well-formed frame. */
  readonly errors: readonly string[];
}

export interface ParseOptions {
  /** Accept '|' as the delimiter, surrounding whitespace, a missing BodyLength/CheckSum, and MsgType anywhere in the frame. */
  lenient?: boolean;
  /** Tags whose values are raw data; each one's length is the value of the field just before it. */
  dataTags?: ReadonlySet<number>;
}

/** Split one frame into fields and check its framing. Never throws. */
export function parseFrame(input: Uint8Array | string, options: ParseOptions = {}): Frame {
  let text = typeof input === 'string' ? input : Buffer.from(input).toString('latin1');
  if (options.lenient) {
    text = text.trim();
    if (!text.includes(SOH)) text = text.replaceAll('|', SOH);
  }
  const fields: RawField[] = [];
  const errors: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    const equals = text.indexOf('=', pos);
    const tagText = equals < 0 ? '' : text.slice(pos, equals);
    if (!/^\d+$/.test(tagText)) {
      errors.push(`Garbled field at byte ${pos}`);
      break;
    }
    const tag = Number(tagText);
    const previous = fields.at(-1);
    let end: number;
    if (options.dataTags?.has(tag) && previous && /^\d+$/.test(previous.value)) {
      end = equals + 1 + Number(previous.value);
      if (end > text.length || (end < text.length && text[end] !== SOH)) {
        errors.push(`Data field ${tag} is not ${previous.value} bytes long`);
        break;
      }
    } else {
      end = text.indexOf(SOH, equals + 1);
      if (end < 0) {
        if (!options.lenient) {
          errors.push(`Field ${tag} is not terminated by SOH`);
          break;
        }
        end = text.length;
      }
    }
    fields.push({ tag, value: text.slice(equals + 1, end) });
    pos = end + 1;
  }
  if (errors.length === 0) errors.push(...checkFraming(text, fields, options.lenient ?? false));
  return { fields, errors };
}

function checkFraming(text: string, fields: readonly RawField[], lenient: boolean): string[] {
  const errors: string[] = [];
  const bodyLength = fields[1]?.tag === 9 ? fields[1] : undefined;
  const last = fields.at(-1);
  const trailer = last?.tag === 10 ? text.lastIndexOf(`${SOH}10=`) + 1 : -1;
  if (fields[0]?.tag !== 8) errors.push('BeginString (8) must be the first field');
  if (!bodyLength && !lenient) errors.push('BodyLength (9) must be the second field');
  if (trailer < 0 && !lenient) errors.push('CheckSum (10) must be the last field');
  if (bodyLength && fields[2]?.tag !== 35 && !lenient) errors.push('MsgType (35) must be the third field');
  if (bodyLength) {
    const bodyStart = text.indexOf(SOH, text.indexOf(SOH) + 1) + 1;
    const actual = (trailer < 0 ? text.length : trailer) - bodyStart;
    if (bodyLength.value !== String(actual)) errors.push(`BodyLength is ${bodyLength.value} but the body is ${actual} bytes`);
  }
  if (trailer >= 0 && last) {
    const expected = checksum(Buffer.from(text.slice(0, trailer), 'latin1'));
    if (last.value !== expected) errors.push(`CheckSum is ${last.value} but should be ${expected}`);
  }
  return errors;
}

/** undefined: computed. null: left out. A string: written as given. */
export interface FramingOverrides {
  bodyLength?: string | null;
  checkSum?: string | null;
}

/** Assemble fields (without 9 and 10) into a frame, adding BodyLength after BeginString and CheckSum at the end. */
export function buildFrame(fields: readonly RawField[], framing: FramingOverrides = {}): Uint8Array {
  const [first, ...rest] = fields;
  const hasBegin = first?.tag === 8;
  const begin = hasBegin ? `8=${first.value}${SOH}` : '';
  const body = (hasBegin ? rest : fields).map(field => `${field.tag}=${field.value}${SOH}`).join('');
  const length = framing.bodyLength === null ? '' : `9=${framing.bodyLength ?? body.length}${SOH}`;
  const head = begin + length + body;
  const sum = framing.checkSum === null ? '' : `10=${framing.checkSum ?? checksum(Buffer.from(head, 'latin1'))}${SOH}`;
  return Buffer.from(head + sum, 'latin1');
}
