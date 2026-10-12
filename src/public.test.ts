import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dictionaryFor } from './dictionary/index.ts';
import * as generated from './dictionary/fix50sp2.ts';
import * as fix from './index.ts';
import * as testing from './test.ts';

test('the package entry exposes the transport', () => {
  for (const name of ['connect', 'listen', 'memoryStore', 'fileStore', 'entryToJSON', 'entryFromJSON', 'FIXLogonError', 'TimeoutError', 'FIXStateError', 'defineDictionary', 'MsgType', 'Side', 'ApplVerID', 'Version']) {
    assert.ok(name in fix, `fix.js exports ${name}`);
  }
  assert.deepEqual(Object.keys(fix.Version), ['FIX.4.2', 'FIX.4.4', 'FIXT.1.1']);
  assert.deepEqual(Object.keys(fix.ApplVerID), ['FIX50', 'FIX50SP1', 'FIX50SP2', 'FIXLatest']);
  assert.equal(typeof testing.fakeClock, 'function');
  assert.equal(typeof testing.storeContract, 'function');
});

test('a round trip through the public entry', async () => {
  const server = await fix.listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  try {
    const client = await fix.connect({ host: '127.0.0.1', port: server.port }, { sender: 'CLIENT', target: 'EXCHANGE' });
    await client.send(fix.MsgType.TestRequest, { TestReqID: 'hello' });
    assert.equal((await client.next(fix.MsgType.Heartbeat)).TestReqID, 'hello');
    await client.logout();
  } finally {
    await server.close();
  }
});

test("the fix50sp2 entry has the constants of FIX 5.0 SP2 over FIXT.1.1, and a session takes them", async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, string> };
  assert.equal(pkg.exports['./fix50sp2'], './src/fix50sp2.ts');
  const fix50sp2 = await import(new URL(`../${pkg.exports['./fix50sp2']}`, import.meta.url).href) as typeof import('./fix50sp2.ts');

  // The entry exports exactly what the generated module does, and the same objects.
  assert.deepEqual(Object.keys(fix50sp2).sort(), Object.keys(generated).sort());
  for (const name of ['MsgType', 'Side', 'OrdType', 'TimeInForce', 'ApplVerID', 'DefaultApplVerID', 'SessionRejectReason', 'RateSource', 'PartyRole'] as const) {
    assert.ok(Object.hasOwn(fix50sp2, name), `fix.js/fix50sp2 exports ${name}`);
    assert.equal(fix50sp2[name], generated[name], name);
  }

  // Each constant is its own name, for every message and value of the FIXT.1.1 dictionary: FIX 5.0 SP2 has some FIX 4.4 lacks.
  const dict = dictionaryFor('FIXT.1.1');
  assert.deepEqual(Object.keys(fix50sp2.MsgType), [...dict.messageByName.keys()]);
  assert.equal(fix50sp2.MsgType.ExecutionAck, 'ExecutionAck');
  assert.equal('ExecutionAck' in fix.MsgType, false);
  assert.deepEqual(Object.keys(fix50sp2.ApplVerID), dict.fieldByName.get('ApplVerID')?.codes?.map(code => code.name));
  assert.equal(fix50sp2.DefaultApplVerID.FIX50SP2, fix.ApplVerID.FIX50SP2);
  assert.equal(fix50sp2.SessionRejectReason.InvalidUnsupportedAppVersion, 'InvalidUnsupportedAppVersion');
  assert.equal(fix50sp2.RateSource.Bloomberg, 'Bloomberg');

  const server = await fix.listen(0, { compID: 'EXCHANGE', host: '127.0.0.1' });
  try {
    const client = await fix.connect({ host: '127.0.0.1', port: server.port }, { sender: 'CLIENT', target: 'EXCHANGE', version: fix.Version['FIXT.1.1'] });
    const sent = await client.send(fix50sp2.MsgType.NewOrderSingle, {
      ClOrdID: 'order-1', Symbol: 'GOOG', Side: fix50sp2.Side.Buy, OrderQty: 100, OrdType: fix50sp2.OrdType.Limit, Price: 150,
      RateSource: [{ RateSource: fix50sp2.RateSource.Bloomberg, RateSourceType: fix50sp2.RateSourceType.Primary }],
    });
    assert.deepEqual([sent.MsgType, sent.Side, sent.OrdType], [fix50sp2.MsgType.NewOrderSingle, fix50sp2.Side.Buy, fix50sp2.OrdType.Limit]);
    await client.logout();
  } finally {
    await server.close();
  }
});
