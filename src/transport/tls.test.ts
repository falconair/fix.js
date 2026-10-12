import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect as netConnect, type Socket } from 'node:net';
import { selfSignedCertificate } from './certificate.ts';
import { fakeClock } from './clock.ts';
import { connect } from './net.ts';
import { listen } from './server.ts';
import { peerClose } from './sockets.ts';
import type { ConnectionEntry } from './types.ts';

// A closed peer gets 200 ms, not 1 s, to close its end, as in net.test.ts.
peerClose.waitMs = 200;

const { key, cert } = selfSignedCertificate();

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** Resolve with `promise`, or reject if it takes longer than `ms`. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Resolve once `condition` holds, checking after each turn of the event loop; reject if it takes longer than `ms`. */
async function waitFor(condition: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${ms} ms waiting for ${what}`);
    await tick();
  }
}

/** A TCP connection that never says hello. */
function tcpOnly(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1');
    socket.on('error', () => undefined);   // a refused connection is reset: expected here
    socket.once('connect', () => resolve(socket));
    socket.once('close', () => reject(new Error('closed before connecting')));
  });
}

/** The events of one connection in the feed, in order. */
const eventsOf = (feed: readonly ConnectionEntry[], connectionId: string | undefined) =>
  feed.filter(entry => entry.connectionId === connectionId).map(entry => entry.event);

const count = (feed: readonly ConnectionEntry[], event: ConnectionEntry['event']) => feed.filter(entry => entry.event === event).length;

test('a client logs on to a server over TLS, and they talk', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', tls: { key, cert } });
  t.after(() => server.close(), { timeout: 5_000 });
  const client = await connect({ host: '127.0.0.1', port: server.port }, { sender: 'CLIENT', target: 'EXCHANGE', tls: { ca: cert } });
  const serverSide = await server.whenConnected('CLIENT');
  await client.send('TestRequest', { TestReqID: 'secure' });
  assert.equal((await client.next('Heartbeat', { where: { TestReqID: 'secure' } })).TestReqID, 'secure');
  assert.equal(serverSide.peer?.address, '127.0.0.1');
  await client.logout();
  assert.equal((await serverSide.closed).by, 'them');
});

test("connect({ tls: true }) refuses a server whose certificate it doesn't trust", { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', tls: { key, cert } });
  t.after(() => server.close(), { timeout: 5_000 });
  await assert.rejects(
    connect({ host: '127.0.0.1', port: server.port }, { sender: 'CLIENT', target: 'EXCHANGE', tls: true }),
    { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' },
  );
  assert.equal(server.sessions.length, 0);
});

test('a client without TLS never logs on to a TLS server: its connection is opened, rejected as no TLS on the TLS port, and closed', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', tls: { key, cert } });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed: ConnectionEntry[] = [];
  server.watch(entry => { feed.push(entry); });
  await assert.rejects(connect({ host: '127.0.0.1', port: server.port }, { sender: 'CLIENT', target: 'EXCHANGE', logonTimeout: '2s' }), { name: 'FIXLogonError' });
  assert.equal(server.sessions.length, 0);
  await waitFor(() => count(feed, 'closed') === 1, 2000, 'the closed entry');
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'rejected', 'closed']);
  assert.deepEqual(feed[1]?.problem, { code: 'TLSMismatch', text: 'No TLS on the TLS port: this port uses TLS', action: 'Disconnected' });
});

test('a TLS handshake that fails is rejected in the feed, saying why, and its place under the limits is freed', { timeout: 10_000 }, async t => {
  const server = await listen(0, {
    compID: 'EXCHANGE', host: '127.0.0.1', tls: { key, cert, minVersion: 'TLSv1.3' },
    limits: { connectionsPerAddress: 1, pendingLogons: 1 },
  });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed: ConnectionEntry[] = [];
  server.watch(entry => { feed.push(entry); });
  await assert.rejects(connect({ host: '127.0.0.1', port: server.port }, { sender: 'CLIENT', target: 'EXCHANGE', tls: { ca: cert, maxVersion: 'TLSv1.2' } }));
  await waitFor(() => count(feed, 'closed') === 1, 2000, 'the closed entry');
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'rejected', 'closed']);
  assert.deepEqual(feed[1]?.problem, { code: 'TLSMismatch', text: 'TLS handshake failed: unsupported protocol', action: 'Disconnected' });
  // One place each: a second client logs on only if the failed one gave its places back, and so does a third after it.
  for (const sender of ['A', 'B']) {
    const client = await connect({ host: '127.0.0.1', port: server.port }, { sender, target: 'EXCHANGE', tls: { ca: cert } });
    await client.logout();
    await waitFor(() => count(feed, 'closed') === count(feed, 'opened'), 2000, 'the session closing');
  }
  assert.equal(count(feed, 'rejected'), 1);
});

test('a TLS handshake that never finishes is rejected and closed after limits.logonTimeout', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', tls: { key, cert }, limits: { logonTimeout: 300 } });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed: ConnectionEntry[] = [];
  server.watch(entry => { feed.push(entry); });
  const socket = await tcpOnly(server.port);   // TCP only: it never says hello
  await within(new Promise(resolve => socket.once('close', resolve)), 2000, 'closing the silent connection');
  await waitFor(() => count(feed, 'closed') === 1, 2000, 'the closed entry');
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'rejected', 'closed']);
  assert.deepEqual(feed[1]?.problem, { code: 'LogonTimeout', text: 'No TLS handshake within 0.3 s', action: 'Disconnected' });
});

test('a TLS handshake that runs out of tls.handshakeTimeout is closed then, long before limits.logonTimeout', { timeout: 10_000 }, async t => {
  // Node reports the handshake as failed, but leaves its connection open: the server closes it.
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', tls: { key, cert, handshakeTimeout: 200 }, limits: { logonTimeout: '60s' } });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed: ConnectionEntry[] = [];
  server.watch(entry => { feed.push(entry); });
  const socket = await tcpOnly(server.port);
  socket.write(Buffer.from([0x16, 0x03, 0x01, 0x01, 0x00, 0x01]));   // the start of a ClientHello, and no more
  await within(new Promise(resolve => socket.once('close', resolve)), 3000, 'closing the stalled connection');
  await waitFor(() => count(feed, 'closed') === 1, 2000, 'the closed entry');
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'rejected', 'closed']);
  assert.deepEqual(feed[1]?.problem, { code: 'LogonTimeout', text: 'No TLS handshake within 0.2 s', action: 'Disconnected' });
});

test("a half-finished TLS handshake is closed when limits.logonTimeout passes on the server's clock", { timeout: 10_000 }, async t => {
  const clock = fakeClock();
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', clock, tls: { key, cert }, limits: { logonTimeout: '5s' } });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed: ConnectionEntry[] = [];
  server.watch(entry => { feed.push(entry); });
  const socket = await tcpOnly(server.port);
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.write(Buffer.from([0x16, 0x03, 0x01, 0x01, 0x00, 0x01]));   // the start of a ClientHello, and no more
  await waitFor(() => count(feed, 'opened') === 1, 2000, 'the server taking the connection');
  await clock.advance('4999ms');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(feed.map(entry => entry.event), ['opened']);
  await clock.advance(1);
  await within(closed, 2000, 'closing the stalled connection');
  await waitFor(() => count(feed, 'closed') === 1, 2000, 'the closed entry');
  assert.deepEqual(feed.map(entry => entry.event), ['opened', 'rejected', 'closed']);
  assert.deepEqual(feed[1]?.problem, { code: 'LogonTimeout', text: 'No TLS handshake within 5 s', action: 'Disconnected' });
});

test('connections still in their TLS handshake count toward limits.pendingLogons: a burst past it is closed at once, and every place comes back', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', tls: { key, cert }, limits: { pendingLogons: 3, connectionsPerAddress: 100 } });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed: ConnectionEntry[] = [];
  server.watch(entry => { feed.push(entry); });
  const burst = await Promise.all(Array.from({ length: 8 }, () => tcpOnly(server.port)));
  t.after(() => { for (const socket of burst) socket.destroy(); });
  await waitFor(() => count(feed, 'opened') === 8 && count(feed, 'closed') === 5, 2000, 'five connections refused');
  const refused = feed.filter(entry => entry.event === 'rejected');
  assert.equal(refused.length, 5);
  for (const entry of refused) {
    assert.deepEqual(entry.problem, { code: 'ConnectionLimit', text: 'Too many connections waiting to log on', action: 'Disconnected' });
    assert.deepEqual(eventsOf(feed, entry.connectionId), ['opened', 'rejected', 'closed']);
  }
  // While the three are still in their handshake, a real client is refused too.
  await assert.rejects(connect({ host: '127.0.0.1', port: server.port }, { sender: 'CLIENT', target: 'EXCHANGE', tls: { ca: cert } }));
  await waitFor(() => count(feed, 'closed') === 6, 2000, 'the refused client closing');
  for (const socket of burst) socket.destroy();
  await waitFor(() => count(feed, 'closed') === 9, 2000, 'every connection closing');
  // Back to zero: three new connections all fit, and a fourth does not.
  const rejectedBefore = count(feed, 'rejected');
  const again = await Promise.all(Array.from({ length: 3 }, () => tcpOnly(server.port)));
  t.after(() => { for (const socket of again) socket.destroy(); });
  await waitFor(() => count(feed, 'opened') === 12, 2000, 'three more connections');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(count(feed, 'rejected'), rejectedBefore);
  const fourth = await tcpOnly(server.port);
  await within(new Promise(resolve => fourth.once('close', resolve)), 2000, 'closing the fourth connection');
  assert.equal(count(feed, 'rejected'), rejectedBefore + 1);
  for (const socket of again) socket.destroy();
  await waitFor(() => count(feed, 'closed') === count(feed, 'opened'), 2000, 'every connection closing');
  const client = await connect({ host: '127.0.0.1', port: server.port }, { sender: 'CLIENT', target: 'EXCHANGE', tls: { ca: cert } });
  await client.logout();
});

test('connections still in their TLS handshake count toward limits.connectionsPerAddress', { timeout: 10_000 }, async t => {
  const server = await listen(0, { compID: 'EXCHANGE', host: '127.0.0.1', tls: { key, cert }, limits: { connectionsPerAddress: 2 } });
  t.after(() => server.close(), { timeout: 5_000 });
  const feed: ConnectionEntry[] = [];
  server.watch(entry => { feed.push(entry); });
  const open = [await tcpOnly(server.port), await tcpOnly(server.port)];
  t.after(() => { for (const socket of open) socket.destroy(); });
  const third = await tcpOnly(server.port);
  await within(new Promise(resolve => third.once('close', resolve)), 2000, 'closing the third connection');
  await waitFor(() => count(feed, 'closed') === 1, 2000, 'the closed entry');
  assert.deepEqual(feed.find(entry => entry.event === 'rejected')?.problem, { code: 'ConnectionLimit', text: 'Too many connections from 127.0.0.1', action: 'Disconnected' });
});

test('listen() and connect() refuse tls settings of the wrong kind, saying what they must be', { timeout: 10_000 }, async () => {
  await assert.rejects(listen(0, { compID: 'EXCHANGE', tls: 'yes' } as never), { name: 'RangeError', message: "tls must be Node's TLS server options (key, cert, …), got 'yes'" });
  await assert.rejects(connect('127.0.0.1:1', { sender: 'CLIENT', target: 'EXCHANGE', tls: 'yes' } as never), { name: 'RangeError', message: "tls must be true, false, or Node's TLS connection options (ca, …), got 'yes'" });
});
