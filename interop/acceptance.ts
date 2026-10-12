// Plays an acceptance script (one of QuickFIX/J's, or one of our own in the
// same format) against fix.js listen(): a server that behaves as the scripts
// assume, and raw TCP connections that send each `I` line as written
// (malformed ones included) and check each `E` line.
import { connect as tcpConnect, type Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import { listen, memoryStore, type Server, type Session } from '../src/index.ts';
import { rawValue } from '../src/wire/message.ts';
import { buildMessage, compare, fieldsOf, MessageReader, parseScript } from './script.ts';

/** How long an `E` line waits for a message, and an `eDISCONNECT` for the close: QuickFIX/J's runner's own limits. */
const EXPECT_TIMEOUT_MS = 10_000;
const DISCONNECT_TIMEOUT_MS = 20_000;
/** QuickFIX/J's runner pauses this long before each connection. */
const CONNECT_DELAY_MS = 50;

/**
 * What an echo leaves out of the message it received: the fields the session
 * fills in, and the marks of a resend (QuickFIX/J's send removes them too).
 */
const NOT_ECHOED = ['BeginString', 'SenderCompID', 'TargetCompID', 'MsgSeqNum', 'SendingTime', 'PossDupFlag', 'OrigSendingTime'];

/**
 * A server set up as the scripts assume: we are ISLD, the counterparty is TW,
 * and each connection starts again at MsgSeqNum 1 (QuickFIX/J's
 * ResetOnDisconnect=Y). Its application is the one QuickFIX/J's test server
 * runs (a message is sent back as it came: without a TransactTime, when it had
 * none): a NewOrderSingle is sent back as it came, unless it is marked
 * PossResend and its ClOrdID was already seen on that connection; a
 * SecurityDefinition is sent back as it came; any other application message
 * is answered with a BusinessMessageReject (unsupported message type).
 * `errors` collects what the application itself got wrong.
 */
export async function acceptanceServer(): Promise<{ server: Server; errors: string[] }> {
  const errors: string[] = [];
  const server = await listen(0, {
    compID: 'ISLD',
    host: '127.0.0.1',
    accept: logon => (logon.SenderCompID === 'TW' ? { store: memoryStore() } : `SenderCompID ${String(logon.SenderCompID)} is not known here`),
  });
  server.watch(entry => {
    if (entry.event !== 'loggedOn') return;
    const session = server.sessions.find(candidate => candidate.connectionId === entry.connectionId);
    if (!session) return;
    // Sending to a session that has just closed is no fault of the application.
    application(session).catch((error: unknown) => {
      if (session.state !== 'closed') errors.push(`The server's application failed: ${String(error)}`);
    });
  });
  return { server, errors };
}

async function application(session: Session): Promise<void> {
  const seen = new Set<unknown>();
  for await (const message of session.messages()) {
    const { MsgType, ...received } = message;
    const fields: Record<string, unknown> = { ...received };
    for (const name of NOT_ECHOED) delete fields[name];
    // Sent back as it came: a message that came without TransactTime goes back without one (the session would fill it in).
    if (!('TransactTime' in fields)) fields.TransactTime = null;
    // QuickFIX/J keeps no group whose count is 0, so its echo has none.
    for (const [name, value] of Object.entries(fields)) {
      if (Array.isArray(value) && value.length === 0) delete fields[name];
    }
    if (MsgType === 'NewOrderSingle') {
      if (message.PossResend === true && seen.has(message.ClOrdID)) continue;
      seen.add(message.ClOrdID);
      await session.send('NewOrderSingle', fields);
    } else if (MsgType === 'SecurityDefinition') {
      await session.send('SecurityDefinition', fields);
    } else {
      // RefMsgType (372) as raw text: the MsgType as it came on the wire, in either FIX version.
      await session.send('BusinessMessageReject', {
        RefSeqNum: message.MsgSeqNum, 372: rawValue(message, 35),
        BusinessRejectReason: 'UnsupportedMessageType', Text: 'Unsupported Message Type',
      });
    }
  }
}

/** One raw connection to the server: what it has received, and whether it was closed. */
class Client {
  readonly #socket: Socket;
  readonly #reader = new MessageReader();
  readonly #messages: string[] = [];
  #closed = false;
  #error: Error | undefined;
  #wake: (() => void) | undefined;

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.on('data', (chunk: Buffer) => {
      try {
        this.#messages.push(...this.#reader.push(chunk));
      } catch (error) {
        this.#error = error instanceof Error ? error : new Error(String(error));
      }
      this.#wake?.();
    });
    socket.on('error', () => undefined);   // a reset is a close, reported by 'close'
    socket.on('close', () => {
      this.#closed = true;
      this.#wake?.();
    });
  }

  static open(port: number): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = tcpConnect({ host: '127.0.0.1', port });
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        resolve(new Client(socket));
      });
    });
  }

  send(bytes: Uint8Array): void {
    this.#socket.write(bytes);
  }

  /** Wait until `done` holds or `ms` have passed; resolves with whether it holds. */
  async #until(done: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!done() && this.#error === undefined) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, left);
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.#wake = undefined;
    }
    if (this.#error) throw this.#error;
    return done();
  }

  /** The next message not yet taken, or undefined when none came in time or the connection was closed first. */
  async next(): Promise<string | undefined> {
    await this.#until(() => this.#messages.length > 0 || this.#closed, EXPECT_TIMEOUT_MS);
    return this.#messages.shift();
  }

  /** Whether the server has closed the connection. */
  get closed(): boolean { return this.#closed; }

  /** Whether the server closed the connection in time. */
  disconnected(): Promise<boolean> {
    return this.#until(() => this.#closed, DISCONNECT_TIMEOUT_MS);
  }

  /** Messages received and never taken by an `E` line. */
  get unread(): readonly string[] { return this.#messages; }

  close(): void {
    this.#socket.destroy();
  }
}

export interface ScriptResult {
  /**
   * The step the script stopped matching at, and how; undefined when it ran to
   * its end. `arrived` is what came at that step: the MsgType of the message
   * received, as it is on the wire; 'closed' when the connection was closed
   * where a message was expected; 'nothing' when neither a message nor the
   * close came within the wait.
   */
  readonly failure?: { readonly line: number; readonly arrived: string; readonly text: string };
  /** The tags in `ignore` whose values did differ somewhere in the script. */
  readonly ignored: readonly number[];
  /** The tags in `extra` that a message did carry where the script's line lacks them. Left out when there is none. */
  readonly extra?: readonly number[];
  /** Messages the server sent, on any of the script's connections, that no `E` line read (QuickFIX/J's runner does not look at them). */
  readonly unread: readonly string[];
}

const show = (message: string): string => message.replaceAll('\x01', '|');

/**
 * Play the script in the file at `path` against a server on `port`. The first
 * step that fails ends the script. `ignore`: tags whose values are not
 * compared; `extra`: tags a message may carry though the script's line lacks
 * them (see compare()).
 */
export async function playScript(path: string, port: number, ignore: ReadonlySet<number> = new Set(), extra: ReadonlySet<number> = new Set()): Promise<ScriptResult> {
  return playText(await readFile(path, 'latin1'), port, ignore, extra);
}

/** Play a script given as its text (latin1, SOH between fields); otherwise as playScript(). */
export async function playText(text: string, port: number, ignore: ReadonlySet<number> = new Set(), extra: ReadonlySet<number> = new Set()): Promise<ScriptResult> {
  const steps = parseScript(text);
  const clients = new Map<number, Client>();
  const ignored = new Set<number>();
  const allowed = new Set<number>();
  /** What connections since replaced had received and not read. */
  const leftUnread: string[] = [];
  let failure: ScriptResult['failure'];
  try {
    for (const step of steps) {
      /** What is wrong at this step, if anything, and what came there. */
      let wrong: string | undefined;
      let arrived = 'nothing';
      const client = clients.get(step.client);
      if (step.kind === 'connect') {
        if (client) {
          leftUnread.push(...client.unread);
          client.close();
        }
        await new Promise(resolve => setTimeout(resolve, CONNECT_DELAY_MS));
        clients.set(step.client, await Client.open(port));
      } else if (!client) {
        wrong = `client ${step.client} is not connected`;
      } else if (step.kind === 'send') {
        client.send(buildMessage(step.text, new Date()));
      } else if (step.kind === 'expect') {
        const message = await client.next();
        if (message === undefined) {
          arrived = client.closed ? 'closed' : 'nothing';
          wrong = client.closed ? 'the connection was closed' : `no message within ${EXPECT_TIMEOUT_MS / 1000} s`;
        } else {
          const received = fieldsOf(message);
          arrived = received.get(35) ?? '';
          const compared = compare(step.fields, received, ignore, extra);
          for (const tag of compared.ignored) ignored.add(tag);
          for (const tag of compared.extra ?? []) allowed.add(tag);
          if (compared.differences.length > 0) wrong = `${compared.differences.join('; ')} in ${show(message)}`;
        }
      } else if (!await client.disconnected()) {
        wrong = `the connection was not closed within ${DISCONNECT_TIMEOUT_MS / 1000} s`;
      }
      if (wrong !== undefined) {
        failure = { line: step.line, arrived, text: wrong };
        break;
      }
    }
    const unread = [...leftUnread, ...[...clients.values()].flatMap(each => each.unread)].map(show);
    return { ...(failure ? { failure } : {}), ignored: [...ignored].sort((a, b) => a - b), ...(allowed.size > 0 ? { extra: [...allowed].sort((a, b) => a - b) } : {}), unread };
  } finally {
    for (const client of clients.values()) client.close();
  }
}
