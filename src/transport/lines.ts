import { open } from 'node:fs/promises';

/** One line of a text file. */
export interface Line {
  /** The line, without its newline. */
  readonly text: string;
  /** Where it starts in the file, in bytes. */
  readonly start: number;
  /** Whether a newline ends it. Only a file's last line can lack one (an append cut short). */
  readonly ended: boolean;
}

/** How much of a file is read at a time. */
const CHUNK_BYTES = 64 * 1024;

/** A line longer than the limit: the file is not one this code wrote. */
export class LineTooLongError extends Error {}

function tooLong(path: string, maxLine: number): Error {
  return new LineTooLongError(`${path}: a line is longer than ${maxLine} bytes`);
}

/**
 * A file's non-empty lines, last first, read a chunk at a time from the end.
 * Holds at most one chunk plus one line (up to `maxLine` bytes) at once — a
 * line that spans many chunks is never copied more than once as it grows,
 * and a longer-than-`maxLine` line is rejected without ever being joined
 * into one buffer. Stopping early reads no more of the file.
 */
export async function* linesBackward(path: string, maxLine: number): AsyncGenerator<Line> {
  const file = await open(path, 'r');
  try {
    let position = (await file.stat()).size;
    /** Pieces of the line still being assembled, earliest-in-file first; its start is further back still. */
    const parts: Buffer[] = [];
    let pendingLength = 0;
    let ended: boolean | undefined;
    while (position > 0) {
      const length = Math.min(CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await file.read(chunk, 0, length, position);
      if (bytesRead !== length) throw new Error('file changed while reading');
      let end = length;
      if (ended === undefined) {
        ended = chunk[end - 1] === 0x0a;
        if (ended) end -= 1;
      }
      while (end > 0) {
        const newline = chunk.lastIndexOf(0x0a, end - 1);
        if (newline < 0) break;
        const segment = chunk.subarray(newline + 1, end);
        const combinedLength = segment.length + pendingLength;
        if (combinedLength > maxLine) throw tooLong(path, maxLine);
        if (combinedLength > 0) {
          const text = parts.length === 0 ? segment.toString('utf8') : Buffer.concat([segment, ...parts]).toString('utf8');
          yield { text, start: position + newline + 1, ended };
        }
        parts.length = 0;
        pendingLength = 0;
        ended = true;
        end = newline;
      }
      if (end > 0) {
        parts.unshift(chunk.subarray(0, end));
        pendingLength += end;
        if (pendingLength > maxLine) throw tooLong(path, maxLine);
      }
    }
    if (pendingLength > 0) yield { text: Buffer.concat(parts).toString('utf8'), start: 0, ended: ended ?? false };
  } finally {
    await file.close();
  }
}

/**
 * A file's non-empty lines, first first, read a chunk at a time. Holds at
 * most one chunk plus one line (up to `maxLine` bytes) at once — a line that
 * spans many chunks is never copied more than once as it grows, and a
 * longer-than-`maxLine` line is rejected without ever being joined into one
 * buffer. Stopping early reads no more of the file. With `range`, only the
 * bytes from `from` (where a line starts; default the start of the file) up to
 * but not including `to` (default the end of the file) are read: a range that
 * ends inside a line gives what it has of it, as a line no newline ends.
 */
export async function* linesForward(path: string, maxLine: number, range: { readonly from?: number; readonly to?: number } = {}): AsyncGenerator<Line> {
  const file = await open(path, 'r');
  try {
    const to = range.to ?? Infinity;
    let offset = range.from ?? 0;
    /** Pieces of the line still being assembled, earliest-in-file first. */
    const parts: Buffer[] = [];
    let pendingLength = 0;
    let pendingStart = 0;
    while (offset < to) {
      const wanted = Math.min(CHUNK_BYTES, to - offset);
      const chunk = Buffer.alloc(wanted);
      const { bytesRead } = await file.read(chunk, 0, wanted, offset);
      if (bytesRead === 0) break;
      const chunkStart = offset;
      offset += bytesRead;
      const data = chunk.subarray(0, bytesRead);
      let begin = 0;
      for (let newline = data.indexOf(0x0a); newline >= 0; newline = data.indexOf(0x0a, begin)) {
        const segment = data.subarray(begin, newline);
        const combinedLength = pendingLength + segment.length;
        if (combinedLength > maxLine) throw tooLong(path, maxLine);
        if (combinedLength > 0) {
          const start = pendingLength > 0 ? pendingStart : chunkStart + begin;
          const text = parts.length === 0 ? segment.toString('utf8') : Buffer.concat([...parts, segment]).toString('utf8');
          yield { text, start, ended: true };
        }
        parts.length = 0;
        pendingLength = 0;
        begin = newline + 1;
      }
      const tail = data.subarray(begin);
      if (tail.length > 0) {
        if (pendingLength === 0) pendingStart = chunkStart + begin;
        parts.push(tail);
        pendingLength += tail.length;
        if (pendingLength > maxLine) throw tooLong(path, maxLine);
      }
    }
    if (pendingLength > 0) yield { text: Buffer.concat(parts).toString('utf8'), start: pendingStart, ended: false };
  } finally {
    await file.close();
  }
}

/**
 * The start of a file's first line: at most `maxBytes` bytes, up to its
 * newline. May end mid-character if a multi-byte UTF-8 character straddles
 * `maxBytes`. Undefined when the file doesn't exist.
 */
export async function firstLineStart(path: string, maxBytes: number): Promise<string | undefined> {
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await file.read(buffer, 0, maxBytes, 0);
    const head = buffer.subarray(0, bytesRead);
    const newline = head.indexOf(0x0a);
    return head.toString('utf8', 0, newline < 0 ? bytesRead : newline);
  } finally {
    await file.close();
  }
}
