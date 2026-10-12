/**
 * fix.js/log — read stored session logs back, and replay them. (Not built yet.)
 * Any store can already give a session's log back: store.read() and
 * store.list() (fix.js). entryToJSON() and entryFromJSON() (fix.js) carry
 * single entries as JSON, live or stored.
 * fileStore() keeps a folder per session: session.json holds its SessionId,
 * and each epoch is a JSONL file whose first line says when it began, then one
 * record per line (messages as base64 wire bytes).
 */

import type { Entry, Session, SessionId } from './index';

export interface Log {
  readonly id: SessionId;
  readonly entries: readonly Entry[];
}

export declare function readLog(path: string): Promise<Log>;

/** The logs in a fileStore() directory, newest first. */
export declare function listLogs(dir: string): Promise<{ path: string; id: SessionId; started: Date }[]>;

/**
 * Re-send one side of a recorded session over a live one. Header fields are
 * re-filled for the new session; everything else is sent as recorded.
 * Session-level messages are skipped. Timing is kept, scaled by `speed`.
 */
export declare function replay(log: Log, session: Session<any>, options?: { side?: 'out' | 'in'; speed?: number }): Promise<void>;
