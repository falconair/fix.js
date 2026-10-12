import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { appendFile, lstat, mkdir, open, readdir, rename, rm, stat, truncate, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { IndexedDictionary } from '../dictionary/index.ts';
import { resolveDictionary } from '../dictionary/resolve.ts';
import { isVersion } from '../version.ts';
import { firstLineStart, LineTooLongError, linesBackward, linesForward, type Line } from './lines.ts';
import { DEFAULT_HISTORY, type LogLimits } from './log.ts';
import { entrySize } from './size.ts';
import { checkKnownKeys, plainObject, wholeNumber } from './options.ts';
import { byId, checkReadOptions, checkRecords, checkSentRange, empty, inRange, originalSeq } from './store-common.ts';
import { SentIndex, type SentPlan } from './sent-index.ts';
import { LowestOriginals, type OriginalLine } from './sent-scan.ts';
import { fromStored, MAX_LINE_BYTES, parseLine, recordLine, seqInClear, type EpochHeader } from './stored-entry.ts';
import type { Entry, SeqNums, SessionId, Store, StoreContext, StoredEpoch, StoredSession, StoreReadOptions } from './types.ts';

/**
 * A file name for a session: a readable prefix when the IDs are plain, always
 * followed by a hash of the exact id so distinct sessions never collide — not
 * on the readable prefix (which drops the delimiter) and not on case (some
 * filesystems, e.g. macOS, are case-insensitive). Never a path from the wire (H-1).
 */
export function safeFileName(id: SessionId): string {
  const parts = [id.version, id.sender, id.target];
  const safe = parts.every(part => /^[A-Za-z0-9.-]{1,40}$/.test(part) && !part.startsWith('.'));
  const prefix = safe ? `${id.version}_${id.sender}_${id.target}` : 'session';
  const hash = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
  return `${prefix}-${hash}`;
}

/** How many sessions' current epochs a fileStore remembers; one it has forgotten is looked up again. */
const REMEMBERED_SESSIONS = 1_000;

/** How many epoch files a fileStore keeps open to append to, unless it is told (`openFiles`): one for each of the sessions written most recently. */
const OPEN_FILES = 256;

/** A file not appended to for this long is closed, in ms, the next time idle files are looked for (as often as this); it is opened again by the next append. */
const IDLE_MS = 2_000;

export interface FileStoreOptions {
  /**
   * How many files the store keeps open to append to, at most: the current epoch's file of each of
   * the sessions written most recently. Default 256. A whole number of at least 1.
   *
   * With more sessions written at once than this, a session without a place among them waits for
   * one: for the file of a session with no call part-way through to be closed (the least recently
   * written first), or, when every open file has a call part-way through, for the first of those
   * calls to finish, which then gives its place up. Sessions that wait are given places in the order
   * they asked. Such a session's append costs an open and a close besides its write, so a store
   * written by many more sessions at once than it has places keeps far fewer records a second, and
   * each record waits longer: give it as many places as it has sessions written at the same time.
   *
   * The operating system's limit on the files a process may have open must be above this, with room
   * for the process's sockets and for reads: read(), sent() and load() each open the file they read
   * for as long as they read it, and those are not counted here.
   */
  readonly openFiles?: number;
}

/** A fileStore's limits, which its tests set lower. */
export interface FileStoreLimits extends FileStoreOptions {
  /** How long a file is kept open with nothing appended to it, in ms, and how often idle files are looked for. Default 2,000. */
  readonly idleMs?: number;
}

/** A session's epoch file open to append to, or its place among them while the file is being opened (no `handle` yet). */
interface OpenFile {
  readonly epoch: number;
  handle?: FileHandle;
  /** When it was opened or last written to, in ms. */
  used: number;
}

/** An OpenFile whose file is open. */
type Opened = OpenFile & { readonly handle: FileHandle };

/** Writes all of `text` to an open file with one write, and carries on from where the operating system stopped when it wrote only part. */
async function writeAll(handle: FileHandle, text: string): Promise<void> {
  const bytes = Buffer.from(text);
  for (let done = 0; done < bytes.length;) {
    const { bytesWritten } = await handle.write(bytes, done, bytes.length - done);
    if (bytesWritten <= 0) throw new Error(`Wrote nothing of the ${bytes.length - done} bytes still to be written`);
    done += bytesWritten;
  }
}

/** A session folder a reset has renamed to remove it: `<name>.deleting-<uuid>`. A session folder's own name never ends like this. */
const DELETING = /\.deleting-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Removes the folders in `dir` a reset renamed and did not finish removing. */
async function removeDeleting(dir: string): Promise<void> {
  for (const name of await namesIn(dir)) {
    if (DELETING.test(name)) await rm(join(dir, name), { recursive: true, force: true });
  }
}

/** What `work` gives, or `missing` when the file or folder it looks at isn't there (ENOENT). Any other error is thrown. */
async function ifExists<T, M>(work: () => Promise<T>, missing: M): Promise<T | M> {
  try {
    return await work();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return missing;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  return ifExists(async () => { await stat(path); return true; }, false);
}

/** The names in a folder; none when there is no folder. */
async function namesIn(folder: string): Promise<string[]> {
  return ifExists(() => readdir(folder), []);
}

/**
 * The epoch numbers in a session's folder, lowest first; none when it has no
 * folder. Only a regular file is an epoch: not a `.tmp` file, a folder, or a
 * symlink (which could lead out of the store).
 */
async function epochsIn(folder: string): Promise<number[]> {
  const found: Dirent[] = await ifExists(() => readdir(folder, { withFileTypes: true }), []);
  return found.flatMap(each => {
    const match = each.isFile() ? /^([1-9]\d{0,8})\.jsonl$/.exec(each.name) : null;
    return match ? [Number(match[1])] : [];
  }).sort((a, b) => a - b);
}

/** Whether a path is a regular file, not following a symlink; false when there is nothing there. */
async function isRegularFile(path: string): Promise<boolean> {
  return ifExists(async () => (await lstat(path)).isFile(), false);
}

/** Which folder is at a path (its device and inode), or undefined when there is none: a folder removed and made again is a different one. */
async function identityOf(folder: string): Promise<string | undefined> {
  return ifExists(async () => {
    const found = await stat(folder, { bigint: true });
    return `${found.dev}:${found.ino}`;
  }, undefined);
}

/**
 * The random id a session's session.json was made with, or undefined when
 * there is none: no session.json, or one written before this field existed.
 * A device and inode can be reused by a filesystem the moment a folder is
 * removed (ext4 does this); this id tells a folder's next lifetime apart from
 * its last even when that happens to land on the same inode.
 */
async function lifetimeOf(folder: string): Promise<string | undefined> {
  const value = await readSessionJson(join(folder, 'session.json'));
  return typeof value?.lifetime === 'string' ? value.lifetime : undefined;
}

/** Removes the `.tmp` files a write cut short left in a session's folder. */
async function removeTemporaries(folder: string): Promise<void> {
  for (const name of await namesIn(folder)) {
    if (name.endsWith('.tmp')) await rm(join(folder, name), { force: true });
  }
}

/** Writes a file whole or not at all: to `<path>.tmp` first, then renamed into place. */
async function writeWhole(path: string, text: string): Promise<void> {
  const temporary = `${path}.tmp`;
  try {
    await writeFile(temporary, text);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Whether an epoch file was left part-written: empty, a first line cut short,
 * or a header with no whole record after it. An epoch file is written whole
 * (its header and first record together), so only a write cut short leaves
 * one like this. A file from before epochs begins with a record, and is kept.
 */
async function unfinished(path: string): Promise<boolean> {
  const lines = linesForward(path, MAX_LINE_BYTES);
  try {
    const first = await lines.next();
    if (first.done) return true;
    const head = parseLine(first.value.text);
    if (head?.epoch === undefined) return head === undefined && !first.value.ended;
    if (!first.value.ended) return true;
    const second = await lines.next();
    if (second.done) return true;
    return !second.value.ended && parseLine(second.value.text) === undefined;
  } finally {
    await lines.return(undefined);
  }
}

/**
 * A folder per session in `dir`, named by safeFileName: `session.json` holds
 * the SessionId and a random lifetime id (made with randomUUID, so a folder
 * can be told apart from whatever the filesystem puts at the same path next,
 * even on a filesystem that reuses a removed folder's inode right away), and
 * each epoch is a JSONL file, `1.jsonl`, `2.jsonl`, …, whose first line says
 * when it began. Every other line is one record: the sequence numbers after
 * it, and its entry when it has one; messages are kept as their wire bytes
 * (base64). A message that never reached the wire and can't be encoded is
 * kept without its frame: its sequence numbers still count, but it's left out
 * of history. A file from before epochs (`<name>.jsonl` beside the folders),
 * from before lifetime ids too, becomes the session's first epoch the first
 * time it is loaded or appended to (read() reads it where it is), unless
 * the session's folder already has an epoch: then the old file is left alone
 * and never read. A new epoch's file and `session.json` are written whole (to
 * a `.tmp` file, then renamed); a store that finds an epoch file left
 * part-written, or a `.tmp` file, removes it. Calls on one session run one at
 * a time, in the order they were made.
 *
 * append() takes its own copy of the list when it is called, and writes the
 * records with one write (carried on when the operating system writes only
 * part of it), to a file it keeps open: the current epoch's file of each
 * session written lately, at most `openFiles` of them (256 unless given; see
 * FileStoreOptions for what a store with more sessions than places does). A
 * session without a place asks for one. While a place is free it has it at
 * once; otherwise a file is closed for it, in that file's own session's turn:
 * the least recently written whose session has no call part-way through, or,
 * when every open file has one, the file of the first such call to finish,
 * which is closed as that call ends, before its session's next call. A place
 * that comes free is handed to the session that has waited longest, never
 * left for whichever looks first: sessions are given places in the order
 * they asked, and a session that appends again the moment its last append
 * resolves does not keep the others out. A place is given back, and the next
 * session let on, when the file cannot be opened too: the append is refused
 * with the error. A file is also
 * closed when its session begins a new epoch, is reset, has an append fail,
 * or is no longer among the 1,000 remembered, and once nothing has been
 * appended to it for 2 s (looked for every 2 s, and not while a call on its
 * session is part-way through: so within 4 s of its last append, or of that
 * call ending), on a timer that does not keep the process alive and runs
 * only while a file is open: a store no longer used leaves nothing open. A
 * store that is only read opens none. A list that holds a record with
 * `newEpoch` is written in parts: the records before it with one write to the
 * epoch before, then the new epoch's file whole, with its header and the
 * records from that one on. A list is refused, with nothing of it written,
 * when a record of it is not a record or cannot be made a line. A list that
 * fails later may leave its first records written: the whole lines of a
 * write cut short, and the part before a new epoch that could not be begun.
 * Those are kept: load() gives their sequence numbers. The next call cuts
 * off a line cut short. A
 * record counts as kept once the operating system has it: nothing here waits
 * for the disk (no fsync), so what was kept survives the process ending, and
 * not a loss of power. Because the file stays open, a folder that something
 * other than this store removes or renames under it is not noticed until the
 * file is next closed, and a file in steady use (appended to more often than
 * every 2 s, with a place to itself) is never closed by the idle rule: for as
 * long as that lasts every append resolves and goes to the removed file,
 * while load(), read() and sent() find nothing of the session. Only
 * reset(id) through this store removes a session it is writing.
 *
 * read() changes nothing: it removes no file and moves no file from before
 * epochs, so another store, a log viewer say, can read a folder a live writer
 * is using. It takes its turn only to find the
 * epochs, then streams each file a line at a time without it, so a reader that
 * pauses never holds up an append. It reads the epochs there were when it
 * began, leaving out a last one left part-written, and the last of them on to
 * the end of the file as it finds it: a writer appending faster than the
 * reader reads can keep it going. It stops at a reset, by this store or by
 * another on the same folder — by its device and inode, and, when the folder
 * was there from the start, by its lifetime id — and gives nothing written
 * after it. With `from` or `to`, it leaves out whole epochs by when each
 * began, so it relies on a session's entries being kept in time order.
 *
 * list() reads only each session.json and the first line of each epoch file,
 * and leaves out a folder it did not write; it fails when the operating system
 * won't let it read one. Only regular files are epochs: a folder or symlink
 * named like an epoch file is not one. Nothing in session.json, including the
 * lifetime id, is ever used to build a path.
 *
 * reset() renames the session's folder to `<name>.deleting-<uuid>` and then
 * removes it, so a reset cut short never leaves a session half there: nothing
 * reads a folder named like that, and the store's first load() starts removing
 * any it finds in the background (without waiting for it), and every list()
 * removes any it finds, in its own turn.
 *
 * sent() reads the current epoch's file. A record line whose entry is an
 * original (a sent message not marked PossDupFlag, with its frame) names its
 * MsgSeqNum in clear, `{"next":…,"expected":…,"seq":n,"entry":…}`; a line
 * that names none, or names a number that is not a whole number from 1 held
 * exactly, is decoded to find it. The first sent() for a session after the
 * store is created reads the file through once, in the session's turn (so
 * appends to that session wait for it: a fraction of a second for 200,000
 * records), and remembers a SentIndex of it, which every append then keeps
 * up, for each line of its list; it is dropped with the session's remembered epoch (a new epoch, a
 * reset, an append that failed, the session no longer among the 1,000
 * remembered), and made again when the file is not the length remembered.
 *
 * The index follows the latest run of originals written in MsgSeqNum order:
 * from the last original whose MsgSeqNum was not higher than the one before
 * it, on to the end of the file. It holds at most 1,024 places in that run,
 * and of the lines before the run only the lowest and the highest MsgSeqNum
 * among their originals, so it is the same size however often a MsgSeqNum
 * steps backward. sent() begins at the last place remembered at or below
 * `from` and reads the run on until it has passed `to`. It reads the lines
 * before the run only when the range has a MsgSeqNum they could hold (one
 * within their lowest and highest) that the run is not known to hold (the run
 * holds every MsgSeqNum from the last one that did not follow the one before
 * by exactly 1, up to its highest). Those lines it reads in passes: each
 * reads them through to find where the latest original of each of the next
 * 4,096 such MsgSeqNums is, holding at most 8,192 places, then reads those
 * originals in order. Of a MsgSeqNum both parts hold, the run's original is
 * given, the latest appended, and nothing when the run's line no longer holds
 * it. So what a step backward costs follows the lines before the run and the
 * originals of the range among them, never how large a MsgSeqNum is. Those
 * lines are nearly the whole epoch when a MsgSeqNum steps backward late in a
 * long one.
 *
 * A MsgSeqNum steps backward when setSeqNums moves `next` back to a number
 * other than 1 (to 1 begins a new epoch), when a message is sent with a
 * MsgSeqNum written by hand, and when the counterparty's Logon resets the
 * sequences while messages this session numbered before it are still waiting
 * to be kept: their records are kept after the one that begins the new epoch,
 * so they are the first originals of its file, before the Logon sent in reply
 * as MsgSeqNum 1. Those lines are all that is read outside the run then, and
 * only for a MsgSeqNum the run has not reached.
 *
 * sent() takes its turn only to find the file, its end and what to read, and
 * reads outside it no further than that end. A line that does not hold the
 * original it names is left out, and so is a last line cut short, as read()
 * leaves it.
 *
 * Unlike read(), sent() is for the store that writes the session: like load()
 * it looks up the current epoch, which may mend a last line cut short and take
 * in a file from before epochs, and it gives nothing more once this store
 * resets the session, but does not notice a reset made by another.
 *
 * Every sequence reset begins a new epoch file, and a fileStore never removes
 * one: only reset() removes a session, all of it. list() and read() take
 * longer the more sessions and epochs there are. Old epoch files are for the
 * operator to remove (never a session's last one).
 */
export function fileStore(dir: string, options: FileStoreOptions = {}): Store {
  const given = plainObject(options, 'fileStore() options', 'an object of options');
  checkKnownKeys(given, OPTION_KEYS, 'fileStore() options');
  return fileStoreWith(dir, given.openFiles === undefined ? {} : { openFiles: wholeNumber(given.openFiles, 'fileStore() openFiles', 1) });
}

const OPTION_KEYS: readonly string[] = Object.keys({ openFiles: 1 } satisfies Record<keyof FileStoreOptions, 1>);

/** fileStore(dir) with its limits given. Not exported by the package. */
export function fileStoreWith(dir: string, limits: FileStoreLimits = {}): Store {
  const openFiles = limits.openFiles ?? OPEN_FILES;
  const idleMs = limits.idleMs ?? IDLE_MS;
  const dictFor = (id: SessionId, context?: StoreContext) => resolveDictionary(id.version, context?.dictionary);
  // A session is known here by its folder's name (`key`), which each call works out once: it is a hash.
  const folderOf = (key: string) => join(dir, key);
  const fileOf = (key: string, epoch: number) => join(dir, key, `${epoch}.jsonl`);
  /** The current epoch (0: none yet) of the sessions used most recently, least recently used first. */
  const currentEpochs = new Map<string, number>();
  /**
   * What sent() remembers of a session's current epoch file (see SentIndex), only ever for a session
   * whose current epoch is remembered, so never for more than REMEMBERED_SESSIONS: made the first
   * time sent() is called for a session, kept up by every append after that, and dropped with the
   * remembered epoch (a new epoch, a reset, an append that failed, the session no longer among those
   * remembered).
   */
  const sentIndexes = new Map<string, { readonly epoch: number; readonly index: SentIndex }>();
  /**
   * The last call made on each session that has one still to finish. A load
   * cuts a torn last line off the file, so it must never run while an append
   * to the same file is part-way through; each call waits for the one before.
   */
  const running = new Map<string, Promise<void>>();
  const inTurn = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const before = running.get(key) ?? Promise.resolve();
    const result = before.then(work);
    // The call is over for its caller here. The session's next call waits a little longer: for its file to be closed, when a session waits for the place.
    const done = result.then(() => giveUpPlace(key), () => giveUpPlace(key));
    running.set(key, done);
    void done.then(() => {
      if (running.get(key) !== done) return;
      running.delete(key);
      // The session has no call part-way through now: its file, when it has one open, can be closed for a session that waits for a place.
      makePlaces();
    });
    return result;
  };
  /**
   * The epoch files open to append to, least recently appended to first: the current epoch's file of
   * each session written lately, never more than `openFiles` (a place whose file is being opened
   * counts, and has no `handle` yet). A session's file is opened, used and closed only in that
   * session's turn, so never closed under a write. A file is closed when its session begins a new
   * epoch, is reset, has an append fail, is no longer among those remembered, has had nothing
   * appended for `idleMs` when idle files are next looked for, or when a session that has waited
   * for a place is to have this one.
   */
  const files = new Map<string, OpenFile>();
  /**
   * The sessions that have asked for a place among the open files and have none yet, in the order
   * they asked: each in its own turn, with no file open, so no two ever wait for each other, and no
   * more of them than sessions with a call part-way through. A place that comes free is given to
   * the first of them (it is in `files` under that session's name before the session goes on), so
   * no session that asks later, and no session that already has a file, can take it first.
   */
  const waitingForPlace: { readonly key: string; readonly place: OpenFile; readonly go: () => void }[] = [];
  /** How many files are being closed, or are about to be, so that a waiting session can have the place: no more than there are sessions waiting. */
  let closingForWaiting = 0;
  /** Looks for files left idle, from the first file opened until no place is taken. It does not keep the process alive. */
  let sweeper: ReturnType<typeof setInterval> | undefined;
  /**
   * Gives the places that are free to the sessions that have waited longest, and, for those still
   * without one, has files closed: the least recently used of those whose session has no call
   * part-way through, each in its own session's turn, so a write that never finishes holds up
   * nobody else. A file whose session has a call part-way through is closed when that call ends
   * (see giveUpPlace). Called whenever a session begins to wait, a place comes free, or a session's
   * calls have all finished.
   */
  const makePlaces = (): void => {
    while (waitingForPlace.length > 0 && files.size < openFiles) {
      const next = waitingForPlace.shift()!;
      files.set(next.key, next.place);
      next.go();
    }
    if (waitingForPlace.length <= closingForWaiting) return;
    for (const key of files.keys()) {
      if (running.has(key)) continue;
      closingForWaiting++;
      void inTurn(key, () => closeFile(key, true));
      if (waitingForPlace.length <= closingForWaiting) return;
    }
  };
  /**
   * At the end of each call of a session: closes the session's file when a session waits for a
   * place that no file is being closed for yet. The call's own promise has settled by then; the
   * session's next call, though it was made already, runs after the close and asks for a place
   * behind those that wait. So every call that ends lets one waiting session on.
   */
  const giveUpPlace = (key: string): Promise<void> | undefined => {
    if (waitingForPlace.length <= closingForWaiting || !files.has(key)) return undefined;
    closingForWaiting++;
    return closeFile(key, true);
  };
  /** Gives back the place a session has among the open files, when it has one, and lets the sessions that wait go on. The timer stops with the last place. */
  const giveBack = (key: string): void => {
    files.delete(key);
    makePlaces();
    if (files.size === 0 && sweeper !== undefined) {
      clearInterval(sweeper);
      sweeper = undefined;
    }
  };
  /**
   * Closes a session's file, when it has one open, and gives its place back, also when the place
   * has no file (one that could not be opened). Only in the session's turn. `forWaiting`: it was
   * counted in closingForWaiting. Never rejects: a file that fails to close is forgotten all the same.
   */
  const closeFile = async (key: string, forWaiting = false): Promise<void> => {
    try {
      await files.get(key)?.handle?.close();
    } catch {
      // Whatever it wrote was written when its append resolved; there is nothing more to do with it.
    }
    if (forWaiting) closingForWaiting--;
    giveBack(key);
  };
  /**
   * Closes each file nothing was appended to for `idleMs`, in its session's turn. A file whose
   * session has a call part-way through is left for the next look: nothing is queued behind a
   * write that does not finish.
   */
  const closeIdle = (): void => {
    const now = Date.now();
    for (const [key, held] of files) {
      if (running.has(key) || now - held.used < idleMs) continue;
      void inTurn(key, () => closeFile(key));
    }
  };
  /**
   * A session's current epoch file, open to append to. Only in the session's turn. A session with
   * no file open asks for a place and waits until it is given one (see makePlaces): at once while
   * fewer than `openFiles` are open or being opened and nobody waits. When the file cannot be
   * opened this throws with the place still the session's: append() gives it back as it fails
   * (closeFile), for the next session that waits.
   */
  const fileFor = async (key: string, epoch: number): Promise<Opened> => {
    const held = files.get(key);
    if (held?.handle && held.epoch === epoch) {
      files.delete(key);
      files.set(key, held);
      held.used = Date.now();
      return held as Opened;
    }
    // Another epoch's file: the session's epoch was looked up again and is not the one this store last wrote (another store began it).
    if (held) await closeFile(key);
    const mine: OpenFile = { epoch, used: Date.now() };
    await new Promise<void>(go => {
      waitingForPlace.push({ key, place: mine, go });
      makePlaces();
    });
    mine.handle = await open(fileOf(key, epoch), 'a');
    mine.used = Date.now();
    if (sweeper === undefined) {
      sweeper = setInterval(closeIdle, idleMs);
      sweeper.unref();
    }
    return mine as Opened;
  };
  const remember = (key: string, epoch: number) => {
    currentEpochs.delete(key);
    currentEpochs.set(key, epoch);
    while (currentEpochs.size > REMEMBERED_SESSIONS) {
      const oldest = currentEpochs.keys().next();
      if (oldest.done) break;
      const gone = oldest.value;
      currentEpochs.delete(gone);
      sentIndexes.delete(gone);
      // Its file is closed in its own turn, unless it has been remembered again by then.
      if (files.has(gone)) void inTurn(gone, async () => { if (!currentEpochs.has(gone)) await closeFile(gone); });
    }
  };
  /**
   * For each session being read, how many readers it has and how many resets
   * there have been since the first of them began: a reader stops at a reset.
   * A session no reader is reading has no entry.
   */
  const readers = new Map<string, { count: number; resets: number }>();
  /**
   * The session's folder, with its SessionId and a random lifetime id written
   * in it. A session.json from before lifetime ids gains one now, at this
   * roll-over, rewritten atomically (tmp then rename), like a fresh one.
   */
  const makeFolder = async (key: string, id: SessionId) => {
    await mkdir(folderOf(key), { recursive: true });
    const path = join(folderOf(key), 'session.json');
    if (!await exists(path)) {
      await writeWhole(path, `${JSON.stringify({ version: id.version, sender: id.sender, target: id.target, lifetime: randomUUID() })}\n`);
      return;
    }
    const parsed = await readSessionJson(path);
    if (parsed && typeof parsed.lifetime !== 'string') {
      await writeWhole(path, `${JSON.stringify({ ...parsed, lifetime: randomUUID() })}\n`);
    }
  };
  /**
   * The session's current epoch, 0 when it has none. A file from before epochs
   * becomes epoch 1 first. The first time a session is looked up, `.tmp` files
   * and a last epoch file left part-written are removed, and a last line cut
   * short in the current epoch is mended (see mendTail). An append that fails
   * forgets the session's current epoch, so the next call looks it up again.
   */
  const currentEpoch = async (key: string, id: SessionId): Promise<number> => {
    const known = currentEpochs.get(key);
    if (known !== undefined) {
      remember(key, known);
      return known;
    }
    await removeTemporaries(folderOf(key));
    let epochs = await epochsIn(folderOf(key));
    const old = join(dir, `${key}.jsonl`);
    if (epochs.length === 0 && await exists(old)) {
      await makeFolder(key, id);
      await ifExists(() => rename(old, fileOf(key, 1)), undefined);   // gone: adopted already, by another store on the same folder
      epochs = await epochsIn(folderOf(key));
    }
    let epoch = epochs.at(-1) ?? 0;
    if (epoch > 0 && await unfinished(fileOf(key, epoch))) {
      await rm(fileOf(key, epoch), { force: true });
      epoch = epochs.at(-2) ?? 0;
    }
    if (epoch > 0) await mendTail(fileOf(key, epoch));
    remember(key, epoch);
    return epoch;
  };
  /**
   * The store's first load() starts, in the background, removing the folders a reset cut short left
   * behind (list() does the same, in its own turn, every time, and fails when it can't). load() never
   * waits for this: a large leftover folder must never delay a session's first load() past its
   * timeout. Started at most once per store instance; its errors are ignored, same as before.
   */
  let swept: Promise<void> | undefined;
  /**
   * The files read() reads, oldest first, found without changing anything: the
   * epoch files, leaving out a last one left part-written; or, when the folder
   * has no epoch, a file from before epochs as epoch 1, where it is.
   */
  const epochFiles = async (key: string): Promise<{ epoch: number; path: string }[]> => {
    const epochs = await epochsIn(folderOf(key));
    if (epochs.length === 0) {
      const old = join(dir, `${key}.jsonl`);
      return await isRegularFile(old) ? [{ epoch: 1, path: old }] : [];
    }
    const last = epochs.at(-1)!;
    if (await unfinishedOrGone(fileOf(key, last))) epochs.pop();
    return epochs.map(epoch => ({ epoch, path: fileOf(key, epoch) }));
  };
  return {
    load(id, context) {
      swept ??= removeDeleting(dir).catch(() => {});
      const key = safeFileName(id);
      return inTurn(key, async () => {
        const epoch = await currentEpoch(key, id);
        if (epoch === 0) return empty();
        return loadTail(fileOf(key, epoch), dictFor(id, context), context?.history ?? DEFAULT_HISTORY);
      });
    },
    async append(id, records, context) {
      const list = checkRecords(records);
      const key = safeFileName(id);
      return inTurn(key, async () => {
        try {
          // Every line is made before any is written: a record that cannot be made a line fails its list with nothing of it written.
          const dict = dictFor(id, context);
          const lines = list.map(record => `${recordLine(record, dict)}\n`);
          let epoch = await currentEpoch(key, id);
          for (let from = 0; from < list.length;) {
            // One write for the records up to the next one that begins an epoch.
            let to = from + 1;
            while (to < list.length && !list[to]!.newEpoch) to++;
            const text = lines.slice(from, to).join('');
            const first = list[from]!;
            if (epoch === 0 || first.newEpoch) {
              epoch += 1;
              sentIndexes.delete(key);
              await closeFile(key);
              await makeFolder(key, id);
              await writeWhole(fileOf(key, epoch), `${JSON.stringify({ epoch, startedAt: first.at.toISOString() } satisfies EpochHeader)}\n${text}`);
            } else {
              const file = await fileFor(key, epoch);
              await writeAll(file.handle, text);
              file.used = Date.now();
              // The lines began where the file ended: no need to ask the filesystem.
              const kept = sentIndexes.get(key);
              if (kept?.epoch === epoch) {
                for (let at = from; at < to; at++) {
                  const line = lines[at]!;
                  const seq = seqInClear(line);
                  if (seq !== undefined) kept.index.note(seq, kept.index.end);
                  kept.index.end += Buffer.byteLength(line);
                }
              }
            }
            remember(key, epoch);
            from = to;
          }
        } catch (error) {
          // It may have written part of its lines (a full disk, say): the file is closed, and the next
          // call looks the epoch up again, which mends the end of the file before anything is written after it.
          // A file that could not be opened left a place without one: that is given back here too.
          currentEpochs.delete(key);
          sentIndexes.delete(key);
          await closeFile(key);
          throw error;
        }
      });
    },
    async *read(id, options = {}, context) {
      const range = checkReadOptions(options);
      const dict = dictFor(id, context);
      const key = safeFileName(id);
      const watch = readers.get(key) ?? { count: 0, resets: 0 };
      readers.set(key, watch);
      watch.count++;
      try {
        // Only finding the epochs takes the session's turn; the files are read outside it, so a
        // reader that pauses never holds up an append.
        const found = await inTurn(key, async () => {
          const resets = watch.resets;
          const folder = await identityOf(folderOf(key));
          const lifetime = await lifetimeOf(folderOf(key));
          return { resets, folder, lifetime, files: await epochFiles(key) };
        });
        // The same session as when the read began: not reset by this store, and its folder not
        // removed and made again by another — by its device and inode, and, since a filesystem can
        // reuse those immediately (ext4 does), by the random lifetime id written in session.json.
        const unchanged = async () => watch.resets === found.resets
          && (found.folder === undefined || await identityOf(folderOf(key)) === found.folder)
          && (found.lifetime === undefined || await lifetimeOf(folderOf(key)) === found.lifetime);
        const { files } = found;
        const starts = new Map<number, EpochStart | undefined>();
        const startOf = async (index: number) => {
          if (!starts.has(index)) starts.set(index, await epochStart(files[index]!.path));
          return starts.get(index);
        };
        for (let index = 0; index < files.length; index++) {
          const { epoch, path } = files[index]!;
          if (range.epoch !== undefined && epoch !== range.epoch) continue;
          if (range.to !== undefined) {
            const start = await startOf(index);
            if (start?.exact && start.at > range.to) return;   // this epoch and every later one began after `to`
          }
          if (range.from !== undefined && index + 1 < files.length) {
            const next = await startOf(index + 1);
            if (next?.exact && next.at < range.from) continue;   // over before `from`: the next one began first
          }
          if (!(yield* readEpoch(path, dict, range, unchanged))) return;
        }
      } finally {
        if (--watch.count === 0 && readers.get(key) === watch) readers.delete(key);
      }
    },
    async *sent(id, range, context) {
      const { from, to } = checkSentRange(range);
      const dict = dictFor(id, context);
      const key = safeFileName(id);
      const watch = readers.get(key) ?? { count: 0, resets: 0 };
      readers.set(key, watch);
      watch.count++;
      try {
        // Finding the current epoch's file, its end and what is remembered of it takes the session's
        // turn; the file is read outside it, and only up to that end: every line before it is whole.
        const found = await inTurn(key, async () => {
          const resets = watch.resets;
          const epoch = await currentEpoch(key, id);
          if (epoch === 0) return undefined;
          const path = fileOf(key, epoch);
          const end = await ifExists(async () => (await stat(path)).size, 0);
          let kept = sentIndexes.get(key);
          // Read through once when nothing is remembered of this file, or it is not the length remembered (something else wrote to it).
          if (kept?.epoch !== epoch || kept.index.end !== end) {
            const index = new SentIndex();
            for await (const line of originalLines(path, 0, end, dict)) index.note(line.seq, line.start);
            index.end = end;
            kept = { epoch, index };
            // Kept only for a session still remembered: enough others may have been looked up, while
            // this file was read, for it to be forgotten, and then this read alone uses what it found.
            if (currentEpochs.get(key) === epoch) sentIndexes.set(key, kept);
          }
          return { resets, path, end, highest: kept.index.highest, plan: kept.index.plan(from, to) };
        });
        if (!found || from > found.highest) return;
        yield* sentOriginals(found.path, found.end, found.plan, dict, from, to, () => watch.resets !== found.resets);
      } finally {
        if (--watch.count === 0 && readers.get(key) === watch) readers.delete(key);
      }
    },
    async list() {
      const found: Dirent[] = await ifExists(() => readdir(dir, { withFileTypes: true }), []);
      const sessions: StoredSession[] = [];
      for (const each of found) {
        if (!each.isDirectory()) continue;
        if (DELETING.test(each.name)) {
          await rm(join(dir, each.name), { recursive: true, force: true });
          continue;
        }
        const session = await sessionIn(join(dir, each.name), each.name);
        if (session) sessions.push(session);
      }
      return sessions.sort(byId);
    },
    reset(id) {
      const key = safeFileName(id);
      return inTurn(key, async () => {
        currentEpochs.delete(key);
        sentIndexes.delete(key);
        await closeFile(key);
        const watch = readers.get(key);
        if (watch) watch.resets++;
        // The file from before epochs goes first: were the folder to go first and the reset be cut
        // short, the old file would be taken up again as the session's first epoch.
        await rm(join(dir, `${key}.jsonl`), { force: true });
        // Renamed first, so the session is gone all at once; a removal cut short leaves only a folder nothing reads.
        const doomed = `${folderOf(key)}.deleting-${randomUUID()}`;
        const moved = await ifExists(async () => { await rename(folderOf(key), doomed); return true; }, false);
        if (moved) await rm(doomed, { recursive: true, force: true });
      });
    },
  };
}

/**
 * Mends an epoch file whose last line an append cut short (a full disk, a
 * failing write), so the next append starts a line of its own: a last line
 * that is a whole JSON object gets its newline, and any other is cut off. A
 * file that ends with a newline, or is gone, is left as it is.
 */
async function mendTail(path: string): Promise<void> {
  const whole = await ifExists(async () => {
    const file = await open(path, 'r');
    try {
      const { size } = await file.stat();
      if (size === 0) return true;
      const last = Buffer.alloc(1);
      await file.read(last, 0, 1, size - 1);
      return last[0] === 0x0a;
    } finally {
      await file.close();
    }
  }, true);
  if (whole) return;
  for await (const line of linesBackward(path, MAX_LINE_BYTES)) {
    if (parseLine(line.text)) await appendFile(path, '\n');
    else await truncate(path, line.start);
    return;
  }
}

/** unfinished(), and true for a file gone meanwhile. */
async function unfinishedOrGone(path: string): Promise<boolean> {
  return ifExists(() => unfinished(path), true);
}

/**
 * The entries of one epoch file within `range`, first first, read a line at a
 * time on to the end of the file as it finds it. A last line cut short by a
 * crash is left out; a bad line before it is an error. Once the file is open,
 * and before it gives anything, `unchanged` says whether the session is still
 * the one the read began on; when it isn't, or the file is gone, this gives
 * nothing. Returns whether the read should go on to the next epoch.
 */
async function* readEpoch(path: string, dict: IndexedDictionary, range: StoreReadOptions, unchanged: () => Promise<boolean>): AsyncGenerator<Entry, boolean> {
  let checked = false;
  try {
    for await (const line of linesForward(path, MAX_LINE_BYTES)) {
      if (!checked) {
        checked = true;
        if (!await unchanged()) return false;
      }
      const stored = parseLine(line.text);
      if (!stored) {
        if (!line.ended) return true;
        throw new Error(`${path}: the line at byte ${line.start} is not a JSON object`);
      }
      const entry = stored.entry ? fromStored(stored.entry, dict) : undefined;
      if (entry && inRange(entry, range)) yield entry;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !checked) return unchanged();
    throw error;
  }
  return true;
}

/**
 * The MsgSeqNum of the original a record line holds, or undefined when it holds none: the one the
 * line names in clear, or, for a line that names none (one written before lines named it), the one
 * its frame decodes to. A line that names its MsgSeqNum and that a newline ends is not parsed here.
 * Any other line that is not a JSON object is an error, except a last line no newline ends: that one
 * was cut short (an append part-way through, or one that failed) and holds nothing, as for read().
 */
function originalSeqOf(line: Line, path: string, dict: IndexedDictionary): number | undefined {
  const named = seqInClear(line.text);
  if (named !== undefined && line.ended) return named;
  const stored = parseLine(line.text);
  if (!stored) {
    if (!line.ended) return undefined;
    throw new Error(`${path}: the line at byte ${line.start} is not a JSON object`);
  }
  if (named !== undefined) return named;
  const kept = stored.entry;
  if (kept?.kind !== 'message' || kept.direction !== 'out') return undefined;
  const entry = fromStored(kept, dict);
  return entry ? originalSeq(entry) : undefined;
}

/**
 * The original with MsgSeqNum `seq` that a record line holds, or undefined when the line does not
 * hold it: it is not JSON (it only began like a record), its frame no longer decodes, or what it
 * holds is not a message this session sent, is marked PossDupFlag, or has another MsgSeqNum (a line
 * changed by hand, or another file put where this one was). Such a line is left out, never an error
 * and never given: sent() gives nothing but the original it is giving for a MsgSeqNum.
 */
function originalOn(text: string, seq: number, dict: IndexedDictionary): Entry | undefined {
  const kept = parseLine(text)?.entry;
  const entry = kept ? fromStored(kept, dict) : undefined;
  return entry && originalSeq(entry) === seq ? entry : undefined;
}

/**
 * The lines of an epoch file that hold an original, first first, from byte `from` up to `end`. A
 * file that is gone has none; a line that is not a JSON object is an error where originalSeqOf says so.
 */
async function* originalLines(path: string, from: number, end: number, dict: IndexedDictionary): AsyncGenerator<OriginalLine> {
  try {
    for await (const line of linesForward(path, MAX_LINE_BYTES, { from, to: end })) {
      const seq = originalSeqOf(line, path, dict);
      if (seq !== undefined) yield { seq, start: line.start, length: Buffer.byteLength(line.text) + 1 };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** The original the record line at `start` holds, or undefined when the file is gone or the line no longer holds it (see originalOn). */
async function entryAt(path: string, { seq, start, length }: OriginalLine, dict: IndexedDictionary): Promise<Entry | undefined> {
  return ifExists(async () => {
    for await (const line of linesForward(path, MAX_LINE_BYTES, { from: start, to: start + length })) {
      return originalOn(line.text, seq, dict);
    }
    return undefined;
  }, undefined);
}

/**
 * The originals within from..to of the latest run of an epoch file (the originals from byte `start`,
 * where a line begins, up to `end`, which are in MsgSeqNum order, one per MsgSeqNum), read a line at
 * a time and no further than the first original past `to`. Each comes with its MsgSeqNum, and with
 * no entry when its line does not hold the original it names (see originalOn). A file that is gone
 * has none.
 */
async function* runOriginals(path: string, start: number, end: number, dict: IndexedDictionary, from: number, to: number): AsyncGenerator<{ readonly seq: number; readonly entry: Entry | undefined }> {
  try {
    for await (const line of linesForward(path, MAX_LINE_BYTES, { from: start, to: end })) {
      const seq = originalSeqOf(line, path, dict);
      if (seq === undefined || seq < from) continue;
      if (seq > to) return;
      yield { seq, entry: originalOn(line.text, seq, dict) };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Where the latest original of each MsgSeqNum is in the part of an epoch file before its latest run
 * (see SentPlan.earlier), lowest MsgSeqNum first, whatever order they were written in; none when
 * `earlier` is undefined. What it costs follows how many originals that part holds within the range,
 * never how large their MsgSeqNums or the range are: it reads that part through once for every
 * SENT_BATCH places it gives (at most once more, when it dropped places and nothing was left above
 * them), holding one batch of places at a time (see LowestOriginals).
 */
async function* earlierPlaces(path: string, dict: IndexedDictionary, earlier: SentPlan['earlier']): AsyncGenerator<OriginalLine> {
  if (!earlier) return;
  for (let low = earlier.from; low <= earlier.to;) {
    const lowest = new LowestOriginals(low, earlier.to, earlier.except);
    for await (const line of originalLines(path, 0, earlier.end, dict)) lowest.note(line);
    const { lines, more } = lowest.found();
    yield* lines;
    if (!more) return;
    low = lines.at(-1)!.seq + 1;
  }
}

/**
 * The originals of an epoch file (its bytes up to `end`) within from..to, in MsgSeqNum order, the
 * latest appended of several with one MsgSeqNum, read as `plan` says: the latest run from where the
 * plan begins, and the part before it only where the plan names one. A MsgSeqNum both parts hold
 * comes from the latest run, and is left out when the run's line no longer holds it; one only the
 * earlier part holds comes from there. It holds one entry at a time, and reads the run no sooner
 * than it has given every earlier original numbered below the run's first. Gives nothing more once
 * `reset` says the session was reset.
 */
async function* sentOriginals(path: string, end: number, plan: SentPlan, dict: IndexedDictionary, from: number, to: number, reset: () => boolean): AsyncGenerator<Entry> {
  const earlier = earlierPlaces(path, dict, plan.earlier);
  const latest = runOriginals(path, plan.start, end, dict, from, to);
  try {
    let before = await earlier.next();
    let run: IteratorResult<{ readonly seq: number; readonly entry: Entry | undefined }> | undefined;
    for (;;) {
      if (before.done || before.value.seq >= plan.first) run ??= await latest.next();
      let entry: Entry | undefined;
      if (!before.done && (!run || run.done || before.value.seq < run.value.seq)) {
        entry = await entryAt(path, before.value, dict);
        before = await earlier.next();
      } else if (run && !run.done) {
        if (!before.done && before.value.seq === run.value.seq) before = await earlier.next();   // in both parts: the latest appended wins
        entry = run.value.entry;
        run = await latest.next();
      } else {
        return;
      }
      if (reset()) return;
      if (entry) yield entry;
    }
  } finally {
    await earlier.return(undefined);
    await latest.return(undefined);
  }
}

/**
 * The session a fileStore folder holds and its epochs, or undefined when the
 * folder is not one this store wrote: its session.json is missing, not a
 * regular file, empty, cut short, not a SessionId, or names a session whose
 * folder this isn't; or it has no epoch with anything in it. Nothing in
 * session.json is used to build a path. An error from the operating system
 * (no permission, too many open files, a failing disk) is not one of these:
 * it is thrown.
 */
async function sessionIn(folder: string, name: string): Promise<StoredSession | undefined> {
  const id = sessionIdIn(await readSessionJson(join(folder, 'session.json')));
  if (!id || safeFileName(id) !== name) return undefined;
  const epochs: StoredEpoch[] = [];
  for (const epoch of await epochsIn(folder)) {
    const start = await epochStart(join(folder, `${epoch}.jsonl`));
    if (start) epochs.push({ epoch, startedAt: start.at });
  }
  return epochs.length > 0 ? { id, epochs } : undefined;
}

/** A session.json's first line, or undefined when it is missing, not a regular file, empty, or a line too long to be one this store wrote. */
async function sessionJson(path: string): Promise<string | undefined> {
  try {
    return await ifExists(async () => {
      if (!await isRegularFile(path)) return undefined;
      const lines = linesForward(path, MAX_LINE_BYTES);
      try {
        const first = await lines.next();
        return first.done ? undefined : first.value.text;
      } finally {
        await lines.return(undefined);
      }
    }, undefined);
  } catch (error) {
    if (error instanceof LineTooLongError) return undefined;
    throw error;
  }
}

/** What a session.json holds, as an object; undefined when it holds none (see sessionJson), or its line isn't a JSON object. */
async function readSessionJson(path: string): Promise<Record<string, unknown> | undefined> {
  const text = await sessionJson(path);
  return text === undefined ? undefined : parseLine(text) as Record<string, unknown> | undefined;
}

/** The SessionId a session.json holds (as readSessionJson gives it), or undefined when it holds none. */
function sessionIdIn(value: Record<string, unknown> | undefined): SessionId | undefined {
  if (!value) return undefined;
  const { version, sender, target } = value;
  if (!isVersion(version) || typeof sender !== 'string' || sender === '' || typeof target !== 'string' || target === '') return undefined;
  return { version, sender, target };
}

/** When an epoch began; `exact` when it is the time the epoch's first line gives, not when its file last changed. */
interface EpochStart {
  readonly at: Date;
  readonly exact: boolean;
}

/**
 * When an epoch began: its header's startedAt. A file with no header (one from
 * before epochs) begins with its first entry's time, or else when the file last
 * changed. Undefined for an empty file, or one gone meanwhile.
 */
async function epochStart(path: string): Promise<EpochStart | undefined> {
  const head = await firstLineStart(path, 1024);
  if (!head) return undefined;
  const match = /"(?:startedAt|at)":"([^"]+)"/.exec(head);
  const date = match ? new Date(match[1]!) : undefined;
  if (date && !Number.isNaN(date.getTime())) return { at: date, exact: true };
  return ifExists(async () => ({ at: (await stat(path)).mtime, exact: false }), undefined);
}

/**
 * The newest entries of an epoch file within `limits`, and the sequence numbers
 * its last record holds, reading from the end and stopping at the limits. A
 * last line cut short by a crash is cut off the file, so the next append starts
 * a fresh line; a bad line before it is an error. The caller makes sure no
 * append to the file runs meanwhile.
 */
async function loadTail(path: string, dict: IndexedDictionary, limits: LogLimits): Promise<{ history: Entry[]; next: number; expected: number }> {
  const history: Entry[] = [];
  let bytes = 0;
  // With no room for an entry, only the sequence numbers are wanted: the last record has them.
  let full = limits.entries <= 0 || limits.bytes <= 0;
  let seqNums: SeqNums | undefined;
  let last = true;
  const gone = await ifExists(async () => {
    for await (const line of linesBackward(path, MAX_LINE_BYTES)) {
      const stored = parseLine(line.text);
      if (!stored) {
        if (!last) throw new Error(`${path}: the line at byte ${line.start} is not a JSON object`);
        await truncate(path, line.start);
        last = false;
        continue;
      }
      if (last && !line.ended) await appendFile(path, '\n');
      last = false;
      if (stored.epoch !== undefined) break;   // the header: the epoch begins here
      if (seqNums === undefined && stored.next !== undefined && stored.expected !== undefined) seqNums = { next: stored.next, expected: stored.expected };
      if (!full && stored.entry) {
        const entry = fromStored(stored.entry, dict);
        if (entry) {
          const size = entrySize(entry);
          if (history.length >= limits.entries || bytes + size > limits.bytes) full = true;
          else {
            history.push(entry);
            bytes += size;
          }
        }
      }
      if (full && seqNums) break;
    }
    return false;
  }, true);
  if (gone) return empty();
  return { history: history.reverse(), ...(seqNums ?? { next: 1, expected: 1 }) };
}
