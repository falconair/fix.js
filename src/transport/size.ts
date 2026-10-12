import type { Entry } from './types.ts';

/** An entry or message with no wire bytes (a dropped send, a problem, a route-transformed message) counts as this many bytes. */
export const UNSIZED_ENTRY_BYTES = 256;

/** An entry's size for the memory budget: its wire bytes, a fixed estimate plus the text for an error, or the estimate alone. */
export function entrySize(entry: Entry): number {
  if (entry.kind === 'message' && entry.bytes) return entry.bytes.length;
  if (entry.kind === 'error') return UNSIZED_ENTRY_BYTES + entry.text.length + (entry.stack?.length ?? 0);
  return UNSIZED_ENTRY_BYTES;
}
