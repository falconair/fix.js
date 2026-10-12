// What the interop suite needs before it can run: Java, QuickFIX/J's jars, our
// harness compiled against them, and QuickFIX/J's acceptance scripts. Everything
// downloaded or built goes into interop/.cache, which git ignores.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { JARS, SCRIPTS, type PinnedFile } from './pins.ts';

const HERE = import.meta.dirname;
export const CACHE = join(HERE, '.cache');
const HARNESS_SOURCE = join(HERE, 'harness', 'Harness.java');
const OLDEST_JAVA = 17;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const TOOL_TIMEOUT_MS = 120_000;

/** Something the suite needs isn't there (no Java, no network): its tests are skipped, saying why. */
export class Unavailable extends Error {
  override name = 'Unavailable';
}

/** What was prepared, or why the tests that need it are skipped. */
export type Prepared<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly skip: string };

/**
 * Run `prepare`. When what it needs is unavailable the result says so, and the
 * caller skips its tests; with INTEROP_REQUIRED set (CI), that is an error
 * instead, so a run that tested nothing can't pass. Anything else that goes
 * wrong (a download that doesn't match its pin, the harness not compiling) is
 * always an error.
 */
export async function prepared<T>(prepare: () => Promise<T>): Promise<Prepared<T>> {
  try {
    return { ok: true, value: await prepare() };
  } catch (error) {
    if (!(error instanceof Unavailable) || process.env.INTEROP_REQUIRED) throw error;
    return { ok: false, skip: error.message };
  }
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

/** A file that is not what its pin says: never used. */
function mismatch(file: PinnedFile, bytes: Uint8Array): string | undefined {
  if (bytes.length !== file.bytes) return `${file.path} is ${bytes.length} bytes, pinned as ${file.bytes}`;
  const actual = sha256(bytes);
  return actual === file.sha256 ? undefined : `${file.path} has SHA-256 ${actual}, pinned as ${file.sha256}`;
}

/** Why a fetch or a read failed, in a few words. */
const reason = (error: unknown): string =>
  error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);

/**
 * The file's bytes from its URL, never more than its pin allows: a response that
 * declares another length is refused before its body is read, and a body that
 * grows past the pinned size is cut off. A download that can't be made is
 * Unavailable; one that is the wrong size is an error.
 */
async function download(file: PinnedFile): Promise<Uint8Array> {
  const unavailable = (why: string) => new Unavailable(`Could not download ${file.url}: ${why}`);
  const wrongSize = (what: string) => new Error(`Downloaded from ${file.url}: ${file.path} ${what}, pinned as ${file.bytes}`);
  let response: Response;
  try {
    response = await fetch(file.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    throw unavailable(reason(error));
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw unavailable(`HTTP ${response.status}`);
  }
  // Content-Length counts the encoded bytes, so it is only the file's size when nothing was encoded.
  const declared = response.headers.get('content-length');
  if (declared !== null && !response.headers.has('content-encoding') && Number(declared) !== file.bytes) {
    await response.body?.cancel().catch(() => undefined);
    throw wrongSize(`is ${declared} bytes`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read().catch((error: unknown) => { throw unavailable(reason(error)); });
    if (done) break;
    total += value.length;
    if (total > file.bytes) {
      await reader.cancel().catch(() => undefined);
      throw wrongSize(`is more than ${file.bytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * The pinned file's path in the cache, downloading it first when it isn't there.
 * A cached file that no longer matches its pin is downloaded again; a download
 * that doesn't match is an error, and nothing is kept. It is written under a
 * temporary name and renamed, so test files running side by side never see half
 * a file.
 */
export async function pinned(file: PinnedFile, cache: string = CACHE): Promise<string> {
  const path = join(cache, file.path);
  const cached = await readFile(path).catch(() => undefined);
  if (cached && mismatch(file, cached) === undefined) return path;
  const bytes = await download(file);
  const wrong = mismatch(file, bytes);
  if (wrong !== undefined) throw new Error(`Downloaded from ${file.url}: ${wrong}`);
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, path);
  return path;
}

/** Every one of these pinned files, a few at a time; resolves with their paths, in order. */
export async function pinnedAll(files: readonly PinnedFile[], cache: string = CACHE): Promise<string[]> {
  const paths = new Array<string>(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const index = next++;
      paths[index] = await pinned(files[index]!, cache);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return paths;
}

interface Ran { readonly code: number | null; readonly output: string }

/**
 * Run a tool to its end, bounded by TOOL_TIMEOUT_MS; undefined when it can't be
 * started. The bound is a timer of our own, cleared when the tool ends or fails
 * to start: spawn()'s `timeout` keeps its timer, and so the process, alive for
 * the whole bound when the tool can't be started.
 */
function run(command: string, args: readonly string[]): Promise<Ran | undefined> {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const bound = setTimeout(() => child.kill('SIGKILL'), TOOL_TIMEOUT_MS);
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', () => {
      clearTimeout(bound);
      resolve(undefined);
    });
    child.on('close', code => {
      clearTimeout(bound);
      resolve({ code, output });
    });
  });
}

export interface Java {
  readonly java: string;
  readonly javac: string;
}

/** `java` and `javac` from JAVA_HOME, or else from PATH; Unavailable unless both run and are Java 17 or newer. */
export async function findJava(env: NodeJS.ProcessEnv = process.env): Promise<Java> {
  const home = env.JAVA_HOME;
  const tool = (name: string) => (home ? join(home, 'bin', name) : name);
  const where = home ? `in JAVA_HOME (${home})` : 'on PATH';
  for (const name of ['java', 'javac']) {
    const ran = await run(tool(name), ['-version']);
    if (!ran || ran.code !== 0) throw new Unavailable(`No ${name} ${where}: the interop suite needs Java ${OLDEST_JAVA} or newer (a JDK)`);
    // `java -version` prints: openjdk version "17.0.17" …; `javac -version` prints: javac 17.0.17
    const major = Number(/(?:version "|javac )(\d+)/.exec(ran.output)?.[1]);
    if (!(major >= OLDEST_JAVA)) throw new Unavailable(`${name} ${where} is not Java ${OLDEST_JAVA} or newer: ${ran.output.trim().split('\n')[0] ?? ''}`);
  }
  return { java: tool('java'), javac: tool('javac') };
}

/** What starts the harness: `java -cp <classpath> Harness …`. */
export interface Toolchain {
  readonly java: string;
  readonly classpath: string;
}

let ready: Promise<Toolchain> | undefined;

/** Java, QuickFIX/J's jars and the compiled harness; prepared once per process. */
export function toolchain(): Promise<Toolchain> {
  ready ??= prepareToolchain();
  return ready;
}

async function prepareToolchain(): Promise<Toolchain> {
  const { java, javac } = await findJava();
  const jars = await pinnedAll(JARS);
  const source = await readFile(HARNESS_SOURCE);
  // Compiled for the oldest Java the suite accepts, so the classes run on every Java it accepts.
  const options = ['--release', String(OLDEST_JAVA)];
  // Compiled again whenever the harness, the jars or the options change.
  const stamp = sha256(Buffer.concat([source, Buffer.from([...JARS.map(jar => jar.sha256), ...options].join())])).slice(0, 16);
  const classes = join(CACHE, `classes-${stamp}`);
  if (!await exists(join(classes, 'Harness.class'))) {
    const building = `${classes}.${process.pid}.partial`;
    await rm(building, { recursive: true, force: true });
    await mkdir(building, { recursive: true });
    const ran = await run(javac, ['-nowarn', ...options, '-cp', jars.join(delimiter), '-d', building, HARNESS_SOURCE]);
    if (!ran || ran.code !== 0) throw new Error(`javac could not compile ${HARNESS_SOURCE}:\n${ran?.output ?? 'it did not start'}`);
    // Another test file may have built it meanwhile: either copy will do.
    await rename(building, classes).catch(() => rm(building, { recursive: true, force: true }));
  }
  return { java, classpath: [...jars, classes].join(delimiter) };
}

/** QuickFIX/J's acceptance scripts, downloaded and checked; resolves with the folder holding fix42/, fix44/, fix50/ and fixLatest/. */
export async function acceptanceScripts(): Promise<string> {
  const paths = await pinnedAll(SCRIPTS);
  return dirname(dirname(paths[0]!));
}
