// fix.js connect() against a QuickFIX/J acceptor: FIX 4.2, FIX 4.4, and FIXT.1.1 carrying FIX 5.0 SP2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApplVerID, connect, memoryStore, type ConnectOptions, type Session, type Store } from '../src/index.ts';
import { checked, problems, type Started } from './checks.ts';
import { startHarness, type Harness } from './harness.ts';
import { INTEROP_VERSIONS, newOrder, type InteropVersion } from './messages.ts';
import { prepared, toolchain } from './setup.ts';

const tools = await prepared(toolchain);

/** What a scenario is given: a QuickFIX/J acceptor (EXEC), and a way to connect to it. */
interface Setup {
  readonly version: InteropVersion;
  readonly quickfixj: Harness;
  /** Connect and log on as CLIENT; the session is closed when the test ends. */
  client(options?: Partial<ConnectOptions>): Promise<Session>;
}

/** One test per FIX version (every one, unless `versions` says which), each with its own QuickFIX/J acceptor; see checked() for what each is held to and what a failure shows. */
function scenario(name: string, run: (setup: Setup) => Promise<void>, versions: readonly InteropVersion[] = INTEROP_VERSIONS): void {
  for (const version of versions) {
    test(`${version}: ${name}`, { skip: tools.ok ? false : tools.skip, timeout: 30_000 }, async t => {
      if (!tools.ok) return;
      const quickfixj = await startHarness(tools.value, { role: 'acceptor', version, sender: 'EXEC', target: 'CLIENT' });
      t.after(() => quickfixj.stop());
      const started: Started = { sessions: [], harnesses: [quickfixj] };
      const client: Setup['client'] = async (options = {}) => {
        const session = await connect({ host: '127.0.0.1', port: quickfixj.port }, { sender: 'CLIENT', target: 'EXEC', version, ...options });
        started.sessions.push(session);
        t.after(() => session.close());
        return session;
      };
      await checked(t, started, () => run({ version, quickfixj, client }));
    });
  }
}

scenario('logs on, trades an order and logs out', async ({ version, quickfixj, client }) => {
  const session = await client();
  await quickfixj.next('logon');
  assert.deepEqual(session.seqNums, { next: 2, expected: 2 });

  await session.send('NewOrderSingle', newOrder(version, 'A1'));
  const accepted = await quickfixj.message('in', tags => tags[35] === 'D');
  assert.equal(accepted[11], 'A1');
  const acked = await session.next('ExecutionReport', { where: { OrdStatus: 'New' } });
  const filled = await session.next('ExecutionReport', { where: { OrdStatus: 'Filled' } });
  assert.equal(acked.ClOrdID, 'A1');
  assert.equal(acked.LeavesQty, 100);
  assert.equal(filled.CumQty, 100);
  assert.equal(filled.AvgPx, 10);
  assert.equal(filled.ExecType, version === 'FIX.4.2' ? 'Fill' : 'Trade');

  assert.deepEqual(await session.logout(), { by: 'us', text: 'Logout confirmed' });
  await quickfixj.next('logout');
  assert.deepEqual(problems(session), []);
});

scenario('QuickFIX/J logs out and fix.js confirms', async ({ version, quickfixj, client }) => {
  const session = await client();
  await quickfixj.command('logout');
  assert.deepEqual(await session.closed, { by: 'them', text: 'Counterparty logged out' });
  // QuickFIX/J took our Logout as the reply to its own.
  await quickfixj.message('in', tags => tags[35] === '5');
  await quickfixj.next('logout');
  assert.deepEqual(problems(session), []);
});

scenario('heartbeats flow both ways, and each side answers a TestRequest', async ({ version, quickfixj, client }) => {
  const session = await client({ heartbeat: 1 });
  // With HeartBtInt=1 each side sends a Heartbeat once it has been quiet for a second. These are the
  // unprompted ones: a Heartbeat answering a TestRequest carries its TestReqID.
  await session.next('Heartbeat', { where: { TestReqID: undefined }, timeout: '5s' });
  await quickfixj.message('in', tags => tags[35] === '0' && tags[112] === undefined);

  await session.send('TestRequest', { TestReqID: 'PING' });
  await session.next('Heartbeat', { where: { TestReqID: 'PING' } });
  await quickfixj.command('testrequest PONG');
  await quickfixj.message('in', tags => tags[35] === '0' && tags[112] === 'PONG');
  assert.deepEqual(problems(session), []);
});

scenario('asks QuickFIX/J to resend after a gap, and takes what it resends', async ({ version, quickfixj, client }) => {
  const session = await client();
  await session.send('NewOrderSingle', newOrder(version, 'A1'));
  await session.next('ExecutionReport', { where: { OrdStatus: 'Filled' } });
  assert.equal(session.seqNums.expected, 4);

  // Two Heartbeats follow the ExecutionReports (MsgSeqNum 4 and 5), so the resend ends with one GapFill that skips both.
  await session.send('TestRequest', { TestReqID: 'BEFORE-GAP' });
  await session.next('Heartbeat', { where: { TestReqID: 'BEFORE-GAP' } });
  assert.equal(session.seqNums.expected, 5);

  // As if we had lost the ExecutionReports (MsgSeqNum 2 and 3) and that Heartbeat: the next message from QuickFIX/J is ahead of what we expect.
  session.setSeqNums({ expected: 2 });
  await session.send('TestRequest', { TestReqID: 'AFTER-GAP' });
  const request = await quickfixj.message('in', tags => tags[35] === '2');
  assert.equal(request[7], '2');

  const acked = await session.next('ExecutionReport', { where: { OrdStatus: 'New', PossDupFlag: true } });
  const filled = await session.next('ExecutionReport', { where: { OrdStatus: 'Filled', PossDupFlag: true } });
  assert.equal(acked.MsgSeqNum, 2);
  assert.equal(filled.MsgSeqNum, 3);
  assert.ok(acked.OrigSendingTime instanceof Date);
  // The two Heartbeats (4 and 5) are not resent: one SequenceReset-GapFill stands in for both, and the sequence moves to its NewSeqNo.
  const gapFill = await session.next('SequenceReset', { where: { GapFillFlag: true } });
  assert.equal(gapFill.MsgSeqNum, 4);
  assert.equal(gapFill.NewSeqNo, 6);
  assert.equal(session.seqNums.expected, 6);

  // Back in step: the next exchange needs no recovery.
  await session.send('TestRequest', { TestReqID: 'IN-STEP' });
  await session.next('Heartbeat', { where: { TestReqID: 'IN-STEP' } });
  assert.deepEqual(problems(session), ['SeqNumGap: Received MsgSeqNum 5 while expecting 2; requested a resend']);
});

scenario('resends to QuickFIX/J after a gap, and QuickFIX/J takes what is resent', async ({ version, quickfixj, client }) => {
  const session = await client();
  await session.send('NewOrderSingle', newOrder(version, 'A1'));
  await session.send('NewOrderSingle', newOrder(version, 'A2'));
  await session.next('ExecutionReport', { where: { ClOrdID: 'A2', OrdStatus: 'Filled' } });

  // As if QuickFIX/J had lost both orders (MsgSeqNum 2 and 3): our next message is ahead of what it expects.
  await quickfixj.command('seq target 2');
  await session.send('NewOrderSingle', newOrder(version, 'A3'));
  const request = await session.next('ResendRequest');
  assert.equal(request.BeginSeqNo, 2);

  const first = await quickfixj.message('in', tags => tags[35] === 'D' && tags[43] === 'Y');
  const second = await quickfixj.message('in', tags => tags[35] === 'D' && tags[43] === 'Y');
  assert.deepEqual([first[34], first[11], second[34], second[11]], ['2', 'A1', '3', 'A2']);
  assert.ok(first[122], 'a resent message carries OrigSendingTime');
  // The order that revealed the gap is taken too, and answered.
  await session.next('ExecutionReport', { where: { ClOrdID: 'A3', OrdStatus: 'Filled' } });
  assert.deepEqual(problems(session), []);
});

scenario('a Logon with ResetSeqNumFlag=Y starts both sides again at 1', async ({ version, quickfixj, client }) => {
  const store = memoryStore();
  const first = await client({ store });
  await first.send('NewOrderSingle', newOrder(version, 'A1'));
  await first.next('ExecutionReport', { where: { OrdStatus: 'Filled' } });
  await first.logout();
  await quickfixj.next('logout');

  // Without a reset, the next connection carries on where the last one stopped.
  const second = await client({ store });
  const carriedOn = await quickfixj.message('in', tags => tags[35] === 'A' && tags[34] !== '1');
  assert.equal(carriedOn[34], '4');
  assert.deepEqual(second.seqNums, { next: 5, expected: 6 });
  await second.logout();
  await quickfixj.next('logout');

  const third = await client({ store, logon: { ResetSeqNumFlag: true } });
  const logon = await quickfixj.message('in', tags => tags[35] === 'A' && tags[141] === 'Y');
  assert.equal(logon[34], '1');
  const reply = await third.next('Logon');
  assert.equal(reply.MsgSeqNum, 1);
  assert.equal(reply.ResetSeqNumFlag, true);
  assert.deepEqual(third.seqNums, { next: 2, expected: 2 });
  assert.deepEqual([...problems(first), ...problems(second), ...problems(third)], []);
});

scenario('a Logon with ResetSeqNumFlag=Y sent mid-session starts both sides again at 1, and orders flow at the new numbers', async ({ version, quickfixj, client }) => {
  const session = await client();
  await session.send('NewOrderSingle', newOrder(version, 'A1'));
  await session.next('ExecutionReport', { where: { ClOrdID: 'A1', OrdStatus: 'Filled' } });
  assert.deepEqual(session.seqNums, { next: 3, expected: 4 });

  const sent = await session.send('Logon', { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true });
  assert.equal(sent.MsgSeqNum, 1);
  // QuickFIX/J took it as MsgSeqNum 1, and answered with the same.
  const taken = await quickfixj.message('in', tags => tags[35] === 'A' && tags[141] === 'Y');
  assert.equal(taken[34], '1');
  const answer = await quickfixj.message('out', tags => tags[35] === 'A' && tags[141] === 'Y');
  assert.equal(answer[34], '1');
  const reply = await session.next('Logon', { where: { ResetSeqNumFlag: true } });
  assert.equal(reply.MsgSeqNum, 1);
  assert.deepEqual(session.seqNums, { next: 2, expected: 2 });

  // Both sides are in step at the new numbers: our order is MsgSeqNum 2 to QuickFIX/J, and its two reports are 2 and 3 to us.
  await session.send('NewOrderSingle', newOrder(version, 'A2'));
  const accepted = await quickfixj.message('in', tags => tags[35] === 'D' && tags[11] === 'A2');
  assert.equal(accepted[34], '2');
  const acked = await session.next('ExecutionReport', { where: { ClOrdID: 'A2', OrdStatus: 'New' } });
  const filled = await session.next('ExecutionReport', { where: { ClOrdID: 'A2', OrdStatus: 'Filled' } });
  assert.deepEqual([acked.MsgSeqNum, filled.MsgSeqNum], [2, 3]);
  assert.deepEqual(session.seqNums, { next: 3, expected: 4 });

  // Nothing was asked for again, by either side, and the session ends as any other.
  assert.equal(quickfixj.transcript.filter(line => /^(in|out)\t.*\|35=2\|/.test(line)).length, 0, 'no ResendRequest either way');
  assert.deepEqual(await session.logout(), { by: 'us', text: 'Logout confirmed' });
  await quickfixj.next('logout');
  assert.deepEqual(problems(session), []);
});

/**
 * Trades an order and logs out, then gives the store of a client that lost what it had received:
 * its own numbers carry on, but it expects MsgSeqNum 1 again. QuickFIX/J's Logon reply to it is
 * MsgSeqNum 5, so a session on that store is logged on with a resend from 1 asked for.
 */
async function storeThatLostWhatItReceived({ version, quickfixj, client }: Setup): Promise<Store> {
  const kept = memoryStore();
  const first = await client({ store: kept });
  await first.send('NewOrderSingle', newOrder(version, 'A1'));
  await first.next('ExecutionReport', { where: { OrdStatus: 'Filled' } });
  await first.logout();
  await quickfixj.next('logout');
  const { next } = await kept.load(first.id);
  const empty = memoryStore();
  return { ...empty, load: async (id, context) => ({ ...(await empty.load(id, context)), next, expected: 1 }) };
}

/** The reset Logons QuickFIX/J took and sent, from line `from` of what it printed. */
const resetLogons = (quickfixj: Harness, from: number): [taken: number, sent: number] => {
  const count = (direction: 'in' | 'out') =>
    quickfixj.transcript.slice(from).filter(line => line.startsWith(`${direction}\t`) && /\|35=A\|/.test(line) && /\|141=Y\|/.test(line)).length;
  return [count('in'), count('out')];
};

/** The session resets at once, takes QuickFIX/J's reply, and after a moment in which a second round of Logons would show itself, trades an order at the new numbers. */
async function resetAtOnceAndTrade({ version, quickfixj }: Setup, session: Session, logged: number): Promise<void> {
  const sent = await session.send('Logon', { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true });
  assert.equal(sent.MsgSeqNum, 1);
  const reply = await session.next('Logon', { where: { ResetSeqNumFlag: true } });
  assert.equal(reply.MsgSeqNum, 1);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(resetLogons(quickfixj, logged), [1, 1]);
  assert.deepEqual(session.seqNums, { next: 2, expected: 2 });

  await session.send('NewOrderSingle', newOrder(version, 'A2'));
  const accepted = await quickfixj.message('in', tags => tags[35] === 'D' && tags[11] === 'A2');
  assert.equal(accepted[34], '2');
  const filled = await session.next('ExecutionReport', { where: { ClOrdID: 'A2', OrdStatus: 'Filled', PossDupFlag: undefined } });
  assert.equal(filled.MsgSeqNum, 3);
  assert.deepEqual(session.seqNums, { next: 3, expected: 4 });
  assert.deepEqual(problems(session), ['SeqNumGap: Received MsgSeqNum 5 while expecting 1; requested a resend']);
}

/** What the session received, apart from Logons, briefly: `SequenceReset 1 resent`. */
const receivedSince = (session: Session): string[] =>
  session.history.flatMap(entry => (entry.kind === 'message' && entry.direction === 'in' && entry.message.MsgType !== 'Logon'
    ? [`${String(entry.message.MsgType)} ${String(entry.message.MsgSeqNum)}${entry.message.PossDupFlag === true ? ' resent' : ''}`] : []));

scenario('a reset Logon sent while a resend from 1 is outstanding: QuickFIX/J\'s resend of the old sequence is taken, and one reset Logon goes each way', async setup => {
  const store = await storeThatLostWhatItReceived(setup);
  const logged = setup.quickfixj.transcript.length;
  // The reset follows the logon at once, before QuickFIX/J's resend can arrive.
  const session = await setup.client({ store });
  await resetAtOnceAndTrade(setup, session, logged);
  // What QuickFIX/J resent in answer to the request made before the reset: gap fills for its session messages, and the two reports.
  assert.deepEqual(receivedSince(session).slice(0, 4), ['SequenceReset 1 resent', 'ExecutionReport 2 resent', 'ExecutionReport 3 resent', 'SequenceReset 4 resent']);
});

scenario('the same when the gap fills are not marked as resent: the first ends the wait for a reply, the reply is still taken, and one reset Logon goes each way', async setup => {
  const store = await storeThatLostWhatItReceived(setup);
  const logged = setup.quickfixj.transcript.length;
  const session = await setup.client({ store });
  // As from an engine that does not mark its gap fills: PossDupFlag and OrigSendingTime are taken off before the session reads them.
  session.incoming(message => {
    if (message.MsgType !== 'SequenceReset') return message;
    const { PossDupFlag: _flag, OrigSendingTime: _time, ...unmarked } = message;
    return unmarked;
  });
  await resetAtOnceAndTrade(setup, session, logged);
  assert.deepEqual(receivedSince(session).slice(0, 4), ['SequenceReset 1', 'ExecutionReport 2 resent', 'ExecutionReport 3 resent', 'SequenceReset 4']);
});

scenario('a SequenceReset moves the sequence forward, in each direction', async ({ version, quickfixj, client }) => {
  const session = await client();

  // Ours: QuickFIX/J expects 20 next, and takes it.
  await session.send('SequenceReset', { NewSeqNo: 20 });
  session.setSeqNums({ next: 20 });
  await session.send('TestRequest', { TestReqID: 'AT-20' });
  const taken = await quickfixj.message('in', tags => tags[35] === '1');
  assert.equal(taken[34], '20');
  await session.next('Heartbeat', { where: { TestReqID: 'AT-20' } });

  // Theirs: we expect 30 next, and take it.
  await quickfixj.command('sequencereset 30');
  assert.equal((await session.next('SequenceReset')).NewSeqNo, 30);
  assert.equal(session.seqNums.expected, 30);
  await quickfixj.command('testrequest AT-30');
  assert.equal((await session.next('TestRequest')).MsgSeqNum, 30);
  await quickfixj.message('in', tags => tags[35] === '0' && tags[112] === 'AT-30');
  assert.deepEqual(problems(session), []);
});

scenario('the Logon each way names FIX 5.0 SP2, and QuickFIX/J takes an order with a field no FIX 4 version has, and one that names its own application version', async ({ quickfixj, client }) => {
  const session = await client();
  // Our Logon, as QuickFIX/J accepted it, and its answer, as fix.js read it.
  const ours = await quickfixj.message('in', tags => tags[35] === 'A');
  assert.deepEqual([ours[8], ours[1137]], ['FIXT.1.1', '9']);
  const theirs = session.history.find(entry => entry.kind === 'message' && entry.direction === 'in');
  assert.ok(theirs?.kind === 'message');
  assert.deepEqual([theirs.message.MsgType, theirs.message.DefaultApplVerID], ['Logon', 'FIX50SP2']);

  // PreTradeAnonymity (1091) is a field of a FIX 5.0 SP2 NewOrderSingle, and of no FIX 4 one: both dictionaries must have it.
  await session.send('NewOrderSingle', { ...newOrder('FIXT.1.1', 'A1'), PreTradeAnonymity: true });
  const accepted = await quickfixj.message('in', tags => tags[35] === 'D');
  assert.deepEqual([accepted[11], accepted[1091]], ['A1', 'Y']);
  const filled = await session.next('ExecutionReport', { where: { OrdStatus: 'Filled' } });
  assert.deepEqual([filled.BeginString, filled.ClOrdID, filled.ExecType], ['FIXT.1.1', 'A1', 'Trade']);

  // An order that names its own application version: ApplVerID (1128) goes in its header, and QuickFIX/J reads the order as that version.
  await session.send('NewOrderSingle', { ...newOrder('FIXT.1.1', 'A2'), ApplVerID: ApplVerID.FIX50SP2 });
  const named = await quickfixj.message('in', tags => tags[35] === 'D' && tags[11] === 'A2');
  assert.equal(named[1128], '9');
  await session.next('ExecutionReport', { where: { ClOrdID: 'A2', OrdStatus: 'Filled' } });
  assert.deepEqual(await session.logout(), { by: 'us', text: 'Logout confirmed' });
  assert.deepEqual(problems(session), []);
}, ['FIXT.1.1']);
