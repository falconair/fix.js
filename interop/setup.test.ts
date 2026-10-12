// How the interop suite gets what it needs: pinned downloads, Java, and skipping. Needs neither Java nor the internet.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PinnedFile } from './pins.ts';
import { findJava, pinned, pinnedAll, prepared, Unavailable } from './setup.ts';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A local web server with one file, /file.txt, counting how often it is asked for. */
async function fileServer(t: TestContext, body: string): Promise<{ url: string; requests: () => number }> {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.url === '/file.txt') response.end(body);
    else response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  // fetch() keeps its connections open for reuse: close them too, or the server never stops.
  t.after(() => { server.close(); server.closeAllConnections(); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: () => requests };
}

const pin = (url: string, body: string, changes: Partial<PinnedFile> = {}): PinnedFile =>
  ({ path: 'files/file.txt', url: `${url}/file.txt`, bytes: body.length, sha256: sha256(body), ...changes });

test('a pinned file is downloaded once, checked, and then read from the cache', async t => {
  const cache = await mkdtemp(join(tmpdir(), 'fixjs-interop-'));
  const web = await fileServer(t, 'the contents');
  const file = pin(web.url, 'the contents');
  const path = await pinned(file, cache);
  assert.equal(path, join(cache, 'files', 'file.txt'));
  assert.equal(await readFile(path, 'utf8'), 'the contents');
  assert.equal(await pinned(file, cache), path);
  assert.equal(web.requests(), 1);
  assert.deepEqual(await pinnedAll([file, file], cache), [path, path]);
  assert.equal(web.requests(), 1);
});

test('a download that does not match its pin is an error, and nothing is kept', async t => {
  const cache = await mkdtemp(join(tmpdir(), 'fixjs-interop-'));
  const web = await fileServer(t, 'something else');
  await assert.rejects(pinned(pin(web.url, 'the contents!!'), cache), /files\/file\.txt has SHA-256 [0-9a-f]{64}, pinned as [0-9a-f]{64}/);
  await assert.rejects(pinned(pin(web.url, 'short'), cache), /files\/file\.txt is 14 bytes, pinned as 5/);
  assert.deepEqual(await readdir(cache), []);
});

test('a download larger than its pin is refused from its Content-Length, without reading the body', { timeout: 10_000 }, async t => {
  const cache = await mkdtemp(join(tmpdir(), 'fixjs-interop-'));
  // Promises a 50 MB body, sends a little and then nothing: a client that waits for the body waits for good.
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Length': 50_000_000 });
    response.write('the start');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await assert.rejects(pinned(pin(url, 'the contents'), cache), (error: unknown) =>
    !(error instanceof Unavailable) && /files\/file\.txt is 50000000 bytes, pinned as 12/.test((error as Error).message));
  assert.deepEqual(await readdir(cache), []);
});

test('a body without a Content-Length is cut off once it is longer than its pin', { timeout: 10_000 }, async t => {
  const cache = await mkdtemp(join(tmpdir(), 'fixjs-interop-'));
  const PIECE = 64 * 1024;
  const PIECES = 512; // 32 MB if it were all sent
  let written = 0;
  const server = createServer((_request, response) => {
    let closed = false;
    response.on('close', () => { closed = true; });
    void (async () => {
      for (let sent = 0; sent < PIECES && !closed; sent++) {
        written += PIECE;
        response.write(Buffer.alloc(PIECE, 'x'));
        while (response.writableNeedDrain && !closed) await new Promise(resolve => setTimeout(resolve, 1));
      }
      if (!closed) response.end();
    })();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await assert.rejects(pinned(pin(url, 'the contents'), cache), (error: unknown) =>
    !(error instanceof Unavailable) && /files\/file\.txt is more than 12 bytes, pinned as 12/.test((error as Error).message));
  assert.ok(written < PIECE * PIECES / 2, `the server wrote ${written} bytes before the client went away`);
  assert.deepEqual(await readdir(cache), []);
});

test('a cached file that no longer matches its pin is downloaded again', async t => {
  const cache = await mkdtemp(join(tmpdir(), 'fixjs-interop-'));
  const web = await fileServer(t, 'the contents');
  const file = pin(web.url, 'the contents');
  const path = await pinned(file, cache);
  await writeFile(path, 'tampered with');
  await pinned(file, cache);
  assert.equal(await readFile(path, 'utf8'), 'the contents');
  assert.equal(web.requests(), 2);
});

test('a file that cannot be downloaded is unavailable, not an error', async t => {
  const cache = await mkdtemp(join(tmpdir(), 'fixjs-interop-'));
  const web = await fileServer(t, 'the contents');
  await assert.rejects(pinned(pin(web.url, 'x', { url: `${web.url}/missing.txt` }), cache), (error: unknown) =>
    error instanceof Unavailable && error.message === `Could not download ${web.url}/missing.txt: HTTP 404`);
  await assert.rejects(pinned(pin('http://127.0.0.1:1', 'x'), cache), Unavailable);
});

test('without Java the suite is unavailable, saying where it looked', async () => {
  await assert.rejects(findJava({ JAVA_HOME: '/nowhere/at/all' }), (error: unknown) =>
    error instanceof Unavailable && error.message === 'No java in JAVA_HOME (/nowhere/at/all): the interop suite needs Java 17 or newer (a JDK)');
});

test('looking for a Java that is not there leaves nothing that keeps the process alive', { timeout: 30_000 }, async () => {
  const setup = pathToFileURL(join(import.meta.dirname, 'setup.ts')).href;
  const program = `import { findJava } from ${JSON.stringify(setup)}; await findJava({ JAVA_HOME: '/nowhere/at/all' }).catch(() => undefined);`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', program], { stdio: 'ignore' });
  const ended = await new Promise<string>(resolve => {
    const giveUp = setTimeout(() => {
      child.kill('SIGKILL');
      resolve('it was still running after 10 s');
    }, 10_000);
    child.on('close', code => {
      clearTimeout(giveUp);
      resolve(`it ended with code ${code}`);
    });
  });
  assert.equal(ended, 'it ended with code 0');
});

test('what is unavailable is skipped, unless INTEROP_REQUIRED is set; any other failure is an error', async t => {
  const before = process.env.INTEROP_REQUIRED;
  t.after(() => {
    if (before === undefined) delete process.env.INTEROP_REQUIRED;
    else process.env.INTEROP_REQUIRED = before;
  });
  delete process.env.INTEROP_REQUIRED;
  assert.deepEqual(await prepared(async () => 42), { ok: true, value: 42 });
  assert.deepEqual(await prepared(async () => { throw new Unavailable('no network'); }), { ok: false, skip: 'no network' });
  await assert.rejects(prepared(async () => { throw new Error('does not match its pin'); }), /does not match its pin/);
  process.env.INTEROP_REQUIRED = '1';
  await assert.rejects(prepared(async () => { throw new Unavailable('no network'); }), /no network/);
});
