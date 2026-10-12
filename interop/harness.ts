// Starts interop/harness/Harness.java (one QuickFIX/J session per process) and
// drives it: commands go in on stdin, events come back as lines on stdout.
import { spawn, type ChildProcess } from 'node:child_process';
import type { Toolchain } from './setup.ts';

export interface HarnessOptions {
  readonly role: 'acceptor' | 'initiator';
  /** BeginString. With FIXT.1.1 the QuickFIX/J session carries FIX 5.0 SP2. */
  readonly version: 'FIX.4.2' | 'FIX.4.4' | 'FIXT.1.1';
  /** QuickFIX/J's CompID. */
  readonly sender: string;
  /** The CompID of the fix.js side. */
  readonly target: string;
  /** An initiator: the port to connect to. An acceptor: the port to listen on; default any free port. */
  readonly port?: number;
  /** The HeartBtInt an initiator asks for, in seconds. Default 30. */
  readonly heartbeat?: number;
  /** ResetOnLogon=Y: its Logon carries ResetSeqNumFlag=Y. */
  readonly reset?: boolean;
}

/** A FIX message from an `in` or `out` line: tag → value, the first value of a repeated tag. */
export type Tags = Readonly<Record<number, string>>;

export interface Harness {
  /** The port QuickFIX/J listens on (acceptor) or connects to (initiator). */
  readonly port: number;
  /** Every line so far, stderr included: what a failure message shows. */
  readonly transcript: readonly string[];
  /**
   * Send one command line (see Harness.java); resolves once the harness has
   * carried it out (its `done` line), rejects if it failed or no answer comes
   * within `timeoutMs` (default 5,000).
   */
  command(line: string, timeoutMs?: number): Promise<void>;
  /**
   * The detail of the next line of this event not yet given to an earlier
   * next(), for which `match` holds; waits up to `timeoutMs` (default 5,000).
   */
  next(event: string, match?: (detail: string) => boolean, timeoutMs?: number): Promise<string>;
  /** As next(), for a message QuickFIX/J accepted ('in') or sent ('out'), matched on its tags. */
  message(direction: 'in' | 'out', match: (tags: Tags) => boolean, timeoutMs?: number): Promise<Tags>;
  /** Stop the process; resolves once it has exited. */
  stop(): Promise<void>;
}

const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 2_000;

/** Harnesses still running: killed if this process exits first. Closing stdin stops them too. */
const running = new Set<ChildProcess>();
process.on('exit', () => {
  for (const child of running) child.kill('SIGKILL');
});

export function tags(message: string): Tags {
  const out: Record<number, string> = {};
  for (const field of message.split('|')) {
    const equals = field.indexOf('=');
    if (equals <= 0) continue;
    const tag = Number(field.slice(0, equals));
    if (!(tag in out)) out[tag] = field.slice(equals + 1);
  }
  return out;
}

interface Line { readonly event: string; readonly detail: string; taken: boolean }
interface Pending { readonly line: string; readonly resolve: () => void; readonly reject: (error: Error) => void; readonly timer: NodeJS.Timeout }
interface Waiter { readonly event: string; readonly match: (detail: string) => boolean; readonly resolve: (detail: string) => void; readonly reject: (error: Error) => void; readonly timer: NodeJS.Timeout }

/** Start a harness; resolves once QuickFIX/J is listening (acceptor) or started (initiator). */
export async function startHarness(tools: Toolchain, options: HarnessOptions): Promise<Harness> {
  const args = [
    '-Dslf4j.internal.verbosity=ERROR', '-cp', tools.classpath, 'Harness',
    options.role, options.version, options.sender, options.target,
    String(options.port ?? 0), String(options.heartbeat ?? 30), ...(options.reset ? ['reset'] : []),
  ];
  const child = spawn(tools.java, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  running.add(child);
  const transcript: string[] = [];
  const lines: Line[] = [];
  const waiters = new Set<Waiter>();
  /** Commands sent and not yet answered; the harness answers them in the order sent. */
  const pending: Pending[] = [];
  let exited: string | undefined;

  const summary = () => `${options.role} ${options.version} ${options.sender}→${options.target}; its output:\n${transcript.join('\n')}`;
  const onLine = (text: string) => {
    transcript.push(text);
    const tab = text.indexOf('\t');
    if (tab < 0) return;
    const line: Line = { event: text.slice(0, tab), detail: text.slice(tab + 1), taken: false };
    lines.push(line);
    if (line.event === 'done' || line.event === 'failed') {
      const command = pending.shift();
      if (command) {
        clearTimeout(command.timer);
        if (line.event === 'done') command.resolve();
        else command.reject(new Error(`The QuickFIX/J harness could not carry out '${command.line}': ${line.detail}`));
      }
      return;
    }
    for (const waiter of waiters) {
      if (waiter.event !== line.event || !waiter.match(line.detail)) continue;
      line.taken = true;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(line.detail);
      return;
    }
  };
  const splitLines = (stream: NodeJS.ReadableStream, each: (line: string) => void) => {
    let rest = '';
    stream.setEncoding('latin1');
    stream.on('data', (chunk: string) => {
      const parts = (rest + chunk).split('\n');
      rest = parts.pop() ?? '';
      for (const part of parts) each(part.replace(/\r$/, ''));
    });
    stream.on('end', () => { if (rest !== '') each(rest); });
  };
  splitLines(child.stdout, onLine);
  splitLines(child.stderr, line => transcript.push(`stderr\t${line}`));
  child.stdin.on('error', () => undefined);   // writing to a harness that has already exited

  const closed = new Promise<void>(resolve => {
    child.on('close', (code, signal) => {
      running.delete(child);
      exited = `exited (${signal ?? code})`;
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`The QuickFIX/J harness ${exited} while waiting for '${waiter.event}': ${summary()}`));
      }
      waiters.clear();
      for (const command of pending.splice(0)) {
        clearTimeout(command.timer);
        command.reject(new Error(`The QuickFIX/J harness ${exited} before it answered '${command.line}': ${summary()}`));
      }
      resolve();
    });
  });
  child.on('error', error => { transcript.push(`stderr\t${error.message}`); });

  const next = (event: string, match: (detail: string) => boolean = () => true, timeoutMs = 5_000): Promise<string> => {
    const seen = lines.find(line => !line.taken && line.event === event && match(line.detail));
    if (seen) {
      seen.taken = true;
      return Promise.resolve(seen.detail);
    }
    if (exited) return Promise.reject(new Error(`The QuickFIX/J harness ${exited} before '${event}': ${summary()}`));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        event, match, resolve, reject,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`No '${event}' line from the QuickFIX/J harness within ${timeoutMs} ms: ${summary()}`));
        }, timeoutMs),
      };
      waiters.add(waiter);
    });
  };

  const stop = async (): Promise<void> => {
    if (!exited) {
      child.stdin.end('stop\n');
      const kill = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
      await closed;
      clearTimeout(kill);
    }
  };

  const command = (line: string, timeoutMs = 5_000): Promise<void> => {
    if (exited) return Promise.reject(new Error(`The QuickFIX/J harness ${exited} before '${line}': ${summary()}`));
    return new Promise((resolve, reject) => {
      // A command that times out stays in the queue, so its late answer is not taken for the next one's.
      const timer = setTimeout(() => reject(new Error(`No answer to '${line}' from the QuickFIX/J harness within ${timeoutMs} ms: ${summary()}`)), timeoutMs);
      pending.push({ line, resolve, reject, timer });
      child.stdin.write(`${line}\n`);
    });
  };

  let port: number;
  try {
    port = Number(await next('ready', undefined, START_TIMEOUT_MS));
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    port,
    transcript,
    command,
    next,
    message: async (direction, match, timeoutMs) => tags(await next(direction, detail => match(tags(detail)), timeoutMs)),
    stop,
  };
}
