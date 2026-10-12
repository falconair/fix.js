// QuickFIX/J's acceptance scripts for an acceptor (FIX 4.2, FIX 4.4, and FIX 5.0
// and FIX Latest over FIXT.1.1) against fix.js listen(). Needs the scripts
// (downloaded once, then cached); no Java.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { join } from 'node:path';
import { acceptanceServer, playScript, playText } from './acceptance.ts';
import { DIFFERENCES, type Difference } from './differences.ts';
import { SCRIPTS, SCRIPTS_COMMIT } from './pins.ts';
import { buildMessage, passedOver } from './script.ts';
import { acceptanceScripts, prepared } from './setup.ts';

const scripts = await prepared(acceptanceScripts);
const names = SCRIPTS.map(file => file.path.slice(`scripts/${SCRIPTS_COMMIT}/`.length));
const rulings = new Map(DIFFERENCES.map(difference => [difference.script, difference]));

/** What a script did, or is ruled to do, in the ways the rulings speak of. */
const outcome = (failsAt: number | undefined, arrives: string | undefined, ignore: readonly number[], extra: readonly number[], unread: readonly string[]) =>
  ({ failsAt, arrives, ignore: [...ignore].sort((a, b) => a - b), extra: [...extra].sort((a, b) => a - b), unread: [...unread] });

/** The MsgType of a message shown with | for SOH. */
const msgType = (shown: string): string => /\|35=([^|]*)\|/.exec(shown)?.[1] ?? '';

test('every ruling is for a script there is, and no script has two', () => {
  assert.deepEqual(DIFFERENCES.map(difference => difference.script).filter(script => !names.includes(script)), []);
  assert.equal(rulings.size, DIFFERENCES.length);
});

test('every ruling says how its script differs, and what arrives where it stops', () => {
  const says = (difference: Difference): boolean =>
    (difference.ignore?.length ?? 0) > 0 || (difference.extra?.length ?? 0) > 0 || difference.failsAt !== undefined || (difference.unread?.length ?? 0) > 0;
  assert.deepEqual(DIFFERENCES.filter(difference => !says(difference)).map(difference => difference.script), []);
  const lopsided = DIFFERENCES.filter(difference => (difference.failsAt === undefined) !== ((difference.arrives?.length ?? 0) === 0));
  assert.deepEqual(lopsided.map(difference => difference.script), []);
});

test('every reason is explained in interop/README.md', async () => {
  const readme = await readFile(join(import.meta.dirname, 'README.md'), 'utf8');
  const missing = [...new Set(DIFFERENCES.flatMap(difference => difference.reason.split('; ')))].filter(reason => !readme.includes(reason));
  assert.deepEqual(missing, []);
});

test('the lines passed over in the pinned scripts are these two, and no others', { skip: scripts.ok ? false : scripts.skip }, async () => {
  if (!scripts.ok) return;
  const passed: string[] = [];
  for (const name of names) {
    for (const line of passedOver(await readFile(join(scripts.value, name), 'latin1'))) passed.push(`${name} line ${line}`);
  }
  // A stray letter, and a comment without its #: QuickFIX/J's runner passes over both.
  assert.deepEqual(passed, ['fix50/21_RepeatingGroupSpecifierWithValueOfZero.def line 17', 'fixLatest/2r_UnregisteredMsgType.def line 6']);
});

test('a message left unread on a connection still counts after the client connects again', async () => {
  const soh = (text: string): string => text.replaceAll('|', '\x01');
  const heartbeat = (seq: number): Buffer => buildMessage(soh(`8=FIX.4.4|35=0|34=${seq}|`), new Date());
  // A server that sends its first connection two Heartbeats at once, and each later one a single Heartbeat.
  const sockets: Socket[] = [];
  const server = createServer(socket => {
    socket.on('error', () => undefined);
    socket.write(sockets.length === 0 ? Buffer.concat([heartbeat(1), heartbeat(2)]) : heartbeat(1));
    sockets.push(socket);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    // Each connection reads one Heartbeat; the first connection's second one is never read.
    const text = soh(['iCONNECT', 'E8=FIX.4.4|9=10|35=0|34=1|', 'iCONNECT', 'E8=FIX.4.4|9=10|35=0|34=1|'].join('\n'));
    const result = await playText(text, (server.address() as AddressInfo).port);
    assert.deepEqual(result, { ignored: [], unread: [heartbeat(2).toString('latin1').replaceAll('\x01', '|')] });
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
  }
});

// 'nothing' takes the whole wait for a message, so it is left to the scripts ruled to stop that way.
test('a script that stops says what came there: a message of another kind, or the close', async () => {
  const soh = (text: string): string => text.replaceAll('|', '\x01');
  // A server that answers a TestRequest with a Heartbeat and then closes.
  const sockets: Socket[] = [];
  const server = createServer(socket => {
    sockets.push(socket);
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      if (chunk.toString('latin1').includes('\x0135=1\x01')) socket.end(buildMessage(soh('8=FIX.4.4|35=0|34=1|'), new Date()));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const stopsAt = async (lines: string[]): Promise<unknown> => {
    const { failure } = await playText(soh(lines.join('\n')), port);
    return failure && { line: failure.line, arrived: failure.arrived };
  };
  try {
    const ask = 'I8=FIX.4.4|35=1|34=1|112=now|';
    assert.deepEqual(await stopsAt(['iCONNECT', ask, 'E8=FIX.4.4|35=5|34=1|']), { line: 3, arrived: '0' });
    assert.deepEqual(await stopsAt(['iCONNECT', ask, 'E8=FIX.4.4|35=0|34=1|', 'E8=FIX.4.4|35=0|34=2|']), { line: 4, arrived: 'closed' });
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
  }
});

describe('QuickFIX/J acceptance scripts against listen()', { concurrency: 16 }, () => {
  for (const name of names) {
    test(name, { skip: scripts.ok ? false : scripts.skip, timeout: 90_000 }, async () => {
      if (!scripts.ok) return;
      const ruling: Difference | undefined = rulings.get(name);
      const { server, errors } = await acceptanceServer();
      try {
        const result = await playScript(join(scripts.value, name), server.port, new Set(ruling?.ignore), new Set(ruling?.extra));
        assert.deepEqual(errors, []);
        // What came where the script stopped must be what the ruling names (or one of them, where it names several).
        const arrived = result.failure?.arrived;
        const asRuled = arrived !== undefined && ruling?.arrives?.includes(arrived) ? arrived : ruling?.arrives?.join(' or ');
        const said = result.failure ? `line ${result.failure.line}: ${result.failure.text}` : 'the script ran to its end';
        assert.deepEqual(
          outcome(result.failure?.line, arrived, result.ignored, result.extra ?? [], result.unread.map(msgType)),
          outcome(ruling?.failsAt, asRuled, ruling?.ignore ?? [], ruling?.extra ?? [], ruling?.unread ?? []),
          `${ruling ? `differences.ts rules that ${ruling.reason}` : 'differences.ts has no ruling for this script'}, but ${said}`
            + `${result.unread.length > 0 ? `; unread: ${result.unread.join(' ')}` : ''}`,
        );
      } finally {
        await server.close();
      }
    });
  }
});
