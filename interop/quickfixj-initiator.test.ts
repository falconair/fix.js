// A QuickFIX/J initiator against fix.js listen(): FIX 4.2, FIX 4.4, and FIXT.1.1 carrying FIX 5.0 SP2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApplVerID, listen, type Server, type Session } from '../src/index.ts';
import { checked, problems, type Started } from './checks.ts';
import { startHarness, type Harness, type HarnessOptions } from './harness.ts';
import { fill, INTEROP_VERSIONS, type InteropVersion } from './messages.ts';
import { prepared, toolchain } from './setup.ts';

const tools = await prepared(toolchain);

/** What a scenario is given: a fix.js server (SERVER) that fills every order, and a way to start a QuickFIX/J initiator (CLIENT) against it. */
interface Setup {
  readonly version: InteropVersion;
  readonly server: Server;
  /** Start QuickFIX/J; resolves with it and the server's session once both sides are logged on. */
  start(options?: Partial<HarnessOptions>): Promise<{ quickfixj: Harness; session: Session }>;
}

/** One test per FIX version (every one, unless `versions` says which); see checked() for what each is held to and what a failure shows. */
function scenario(name: string, run: (setup: Setup) => Promise<void>, versions: readonly InteropVersion[] = INTEROP_VERSIONS): void {
  for (const version of versions) {
    test(`${version}: ${name}`, { skip: tools.ok ? false : tools.skip, timeout: 30_000 }, async t => {
      if (!tools.ok) return;
      const server = await listen(0, { compID: 'SERVER', host: '127.0.0.1', versions: [version] });
      t.after(() => server.close());
      let executions = 0;
      server.on('NewOrderSingle', (order, session) => session.send('ExecutionReport', fill(version, order, `EXEC-${++executions}`)));
      const started: Started = { sessions: [], harnesses: [] };
      const start: Setup['start'] = async (options = {}) => {
        const harness = await startHarness(tools.value, { role: 'initiator', version, sender: 'CLIENT', target: 'SERVER', port: server.port, ...options });
        started.harnesses.push(harness);
        t.after(() => harness.stop());
        const session = await server.whenConnected('CLIENT');
        started.sessions.push(session);
        // Until QuickFIX/J has our Logon reply it keeps what it is asked to send, and sends none of it.
        await harness.next('logon');
        return { quickfixj: harness, session };
      };
      await checked(t, started, () => run({ version, server, start }));
    });
  }
}

scenario('QuickFIX/J logs on, trades an order and logs out', async ({ start }) => {
  const { quickfixj, session } = await start();
  assert.deepEqual(session.seqNums, { next: 2, expected: 2 });
  assert.equal(session.heartbeat, 30);

  await quickfixj.command('order B1');
  const order = await session.next('NewOrderSingle');
  assert.equal(order.ClOrdID, 'B1');
  assert.equal(order.OrderQty, 100);
  // QuickFIX/J checked our ExecutionReport against its own dictionary before reporting it.
  const report = await quickfixj.message('in', tags => tags[35] === '8');
  assert.deepEqual([report[11], report[39], report[14]], ['B1', '2', '100']);

  await quickfixj.command('logout');
  assert.deepEqual(await session.closed, { by: 'them', text: 'Counterparty logged out' });
  // QuickFIX/J took our Logout as the reply to its own.
  await quickfixj.message('in', tags => tags[35] === '5');
  await quickfixj.next('logout');
  assert.deepEqual(problems(session), []);
});

scenario('fix.js logs out and QuickFIX/J confirms', async ({ start }) => {
  const { quickfixj, session } = await start();
  // 'Logout confirmed' is the library taking QuickFIX/J's Logout as the reply to its own.
  assert.deepEqual(await session.logout(), { by: 'us', text: 'Logout confirmed' });
  await quickfixj.message('out', tags => tags[35] === '5');
  await quickfixj.message('in', tags => tags[35] === '5');
  await quickfixj.next('logout');
  assert.deepEqual(problems(session), []);
});

scenario('heartbeats flow both ways, and each side answers a TestRequest', async ({ start }) => {
  const { quickfixj, session } = await start({ heartbeat: 1 });
  assert.equal(session.heartbeat, 1);
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

scenario('asks QuickFIX/J to resend after a gap, and takes what it resends', async ({ start }) => {
  const { quickfixj, session } = await start();
  await quickfixj.command('order B1');
  await session.next('NewOrderSingle', { where: { ClOrdID: 'B1' } });
  // Two Heartbeats of QuickFIX/J's own follow the order (MsgSeqNum 3 and 4), so its resend ends with one GapFill that skips both.
  await session.send('TestRequest', { TestReqID: 'BEFORE-GAP-1' });
  await session.next('Heartbeat', { where: { TestReqID: 'BEFORE-GAP-1' } });
  await session.send('TestRequest', { TestReqID: 'BEFORE-GAP-2' });
  await session.next('Heartbeat', { where: { TestReqID: 'BEFORE-GAP-2' } });
  assert.equal(session.seqNums.expected, 5);

  // As if we had lost all three messages (MsgSeqNum 2 to 4): QuickFIX/J's next message is ahead of what we expect.
  session.setSeqNums({ expected: 2 });
  await quickfixj.command('order B2');
  const request = await quickfixj.message('in', tags => tags[35] === '2');
  assert.equal(request[7], '2');

  const first = await session.next('NewOrderSingle', { where: { ClOrdID: 'B1', PossDupFlag: true } });
  assert.equal(first.MsgSeqNum, 2);
  assert.ok(first.OrigSendingTime instanceof Date);
  // The two Heartbeats are not resent: one SequenceReset-GapFill stands in for both, and the sequence moves to its NewSeqNo.
  const gapFill = await session.next('SequenceReset', { where: { GapFillFlag: true } });
  assert.equal(gapFill.MsgSeqNum, 3);
  assert.equal(gapFill.NewSeqNo, 5);
  const second = await session.next('NewOrderSingle', { where: { ClOrdID: 'B2' } });
  assert.equal(second.MsgSeqNum, 5);
  assert.equal(session.seqNums.expected, 6);
  assert.deepEqual(problems(session), ['SeqNumGap: Received MsgSeqNum 5 while expecting 2; requested a resend']);
});

scenario('resends to QuickFIX/J after a gap, and QuickFIX/J takes what is resent', async ({ start }) => {
  const { quickfixj, session } = await start();
  await quickfixj.command('order B1');
  await quickfixj.message('in', tags => tags[35] === '8' && tags[11] === 'B1');
  // Two Heartbeats of our own follow the ExecutionReport (MsgSeqNum 3 and 4), then the next ExecutionReport is 5.
  await quickfixj.command('testrequest GAP-1');
  await quickfixj.message('in', tags => tags[35] === '0' && tags[112] === 'GAP-1');
  await quickfixj.command('testrequest GAP-2');
  await quickfixj.message('in', tags => tags[35] === '0' && tags[112] === 'GAP-2');
  await quickfixj.command('order B2');
  await quickfixj.message('in', tags => tags[35] === '8' && tags[11] === 'B2');

  // As if QuickFIX/J had lost everything from MsgSeqNum 2: our next message is ahead of what it expects.
  await quickfixj.command('seq target 2');
  await quickfixj.command('order B3');
  const request = await session.next('ResendRequest');
  assert.equal(request.BeginSeqNo, 2);

  const first = await quickfixj.message('in', tags => tags[35] === '8' && tags[43] === 'Y' && tags[11] === 'B1');
  assert.deepEqual([first[34], first[17]], ['2', 'EXEC-1']);
  assert.ok(first[122], 'a resent message carries OrigSendingTime');
  // Our two Heartbeats are not resent: one SequenceReset-GapFill stands in for both, and QuickFIX/J moves to its NewSeqNo.
  const gapFill = await quickfixj.message('in', tags => tags[35] === '4' && tags[123] === 'Y');
  assert.deepEqual([gapFill[34], gapFill[36]], ['3', '5']);
  const second = await quickfixj.message('in', tags => tags[35] === '8' && tags[43] === 'Y' && tags[11] === 'B2');
  assert.equal(second[34], '5');
  // The ExecutionReport that revealed the gap is taken too.
  await quickfixj.message('in', tags => tags[35] === '8' && tags[11] === 'B3');
  assert.equal(quickfixj.transcript.filter(line => /^out\t.*\|35=2\|/.test(line)).length, 1, 'QuickFIX/J asked for one resend');
  assert.deepEqual(problems(session), []);
});

scenario('a Logon with ResetSeqNumFlag=Y starts both sides again at 1', async ({ server, start }) => {
  const first = await start();
  await first.quickfixj.command('order B1');
  await first.quickfixj.message('in', tags => tags[35] === '8');
  assert.deepEqual(first.session.seqNums, { next: 3, expected: 3 });
  await first.quickfixj.stop();
  await first.session.closed;

  // A new QuickFIX/J process has forgotten its sequence numbers; ours are kept by the server's store.
  const second = await start({ reset: true });
  const logon = await second.session.next('Logon');
  assert.equal(logon.MsgSeqNum, 1);
  assert.equal(logon.ResetSeqNumFlag, true);
  const reply = await second.quickfixj.message('in', tags => tags[35] === 'A');
  assert.deepEqual([reply[34], reply[141]], ['1', 'Y']);
  assert.deepEqual(second.session.seqNums, { next: 2, expected: 2 });
  assert.equal(server.sessions.length, 1);
  assert.deepEqual(problems(second.session), []);
});

scenario('a Logon with ResetSeqNumFlag=Y sent mid-session: QuickFIX/J resets without replying, orders flow at the new numbers, and a second reset can follow', async ({ start }) => {
  const { quickfixj, session } = await start();
  await quickfixj.command('order B1');
  await quickfixj.message('in', tags => tags[35] === '8' && tags[11] === 'B1');
  assert.deepEqual(session.seqNums, { next: 3, expected: 3 });

  const reset = { EncryptMethod: 'None', HeartBtInt: 30, ResetSeqNumFlag: true } as const;
  for (const clOrdID of ['B2', 'B3']) {
    const sent = await session.send('Logon', reset);
    assert.equal(sent.MsgSeqNum, 1);
    const taken = await quickfixj.message('in', tags => tags[35] === 'A' && tags[141] === 'Y');
    assert.equal(taken[34], '1');
    assert.deepEqual(session.seqNums, { next: 2, expected: 1 });

    // An initiator sends no Logon back: its next message is MsgSeqNum 1 of the new sequence, and our report is MsgSeqNum 2.
    await quickfixj.command(`order ${clOrdID}`);
    const order = await session.next('NewOrderSingle', { where: { ClOrdID: clOrdID } });
    assert.equal(order.MsgSeqNum, 1);
    const report = await quickfixj.message('in', tags => tags[35] === '8' && tags[11] === clOrdID);
    assert.equal(report[34], '2');
    assert.deepEqual(session.seqNums, { next: 3, expected: 2 });
  }

  assert.equal(quickfixj.transcript.filter(line => /^out\t.*\|35=A\|/.test(line)).length, 1, 'QuickFIX/J sent its first Logon and no other');
  assert.equal(quickfixj.transcript.filter(line => /^(in|out)\t.*\|35=2\|/.test(line)).length, 0, 'no ResendRequest either way');
  await quickfixj.command('logout');
  assert.deepEqual(await session.closed, { by: 'them', text: 'Counterparty logged out' });
  await quickfixj.message('in', tags => tags[35] === '5');
  assert.deepEqual(problems(session), []);
});

scenario('an order QuickFIX/J sent before our mid-session reset reached it is not taken, and the session carries on in the new sequence', async ({ start }) => {
  const { quickfixj, session } = await start({ heartbeat: 1 });
  await quickfixj.command('order B1');
  await quickfixj.message('in', tags => tags[35] === '8' && tags[11] === 'B1');

  // Hold QuickFIX/J's next order before the session sees it, as if it were still on its way when we reset.
  let release!: () => void;
  const reachedUs = new Promise<void>(resolve => { release = resolve; });
  let holding!: () => void;
  const held = new Promise<void>(resolve => { holding = resolve; });
  session.incoming(async message => {
    if (message.ClOrdID === 'EARLIER') {
      holding();
      await reachedUs;
    }
    return message;
  });
  await quickfixj.command('order EARLIER');
  await held;
  await session.send('Logon', { EncryptMethod: 'None', HeartBtInt: 1, ResetSeqNumFlag: true });
  await quickfixj.message('in', tags => tags[35] === 'A' && tags[141] === 'Y');
  release();

  // It arrives with a MsgSeqNum of the old sequence: we ask for a resend from 1, which QuickFIX/J has nothing to answer with.
  const request = await quickfixj.message('in', tags => tags[35] === '2');
  assert.deepEqual([request[34], request[7], request[16]], ['2', '1', '0']);
  // QuickFIX/J carries on at MsgSeqNum 1, and so do we.
  await quickfixj.command('order B2');
  assert.equal((await session.next('NewOrderSingle', { where: { ClOrdID: 'B2' } })).MsgSeqNum, 1);
  await quickfixj.message('in', tags => tags[35] === '8' && tags[11] === 'B2');
  // More than two heartbeat intervals on, the two sides are still in step, and that one resend is all we asked for.
  await new Promise(resolve => setTimeout(resolve, 2_500));
  await session.send('TestRequest', { TestReqID: 'STILL-IN-STEP' });
  await session.next('Heartbeat', { where: { TestReqID: 'STILL-IN-STEP' } });
  assert.equal(session.state, 'active');
  assert.equal(quickfixj.transcript.filter(line => /^in\t.*\|35=2\|/.test(line)).length, 1, 'we asked for one resend');
  // The order that was on its way is lost: no handler saw it, so QuickFIX/J has no report for it.
  assert.equal(quickfixj.transcript.filter(line => /^in\t.*\|35=8\|.*\|11=EARLIER\|/.test(line)).length, 0);
  assert.deepEqual(problems(session), ['SeqNumGap: Received MsgSeqNum 3 while expecting 1; requested a resend']);
});

scenario('a SequenceReset moves the sequence forward, in each direction', async ({ start }) => {
  const { quickfixj, session } = await start();

  // Theirs: we expect 20 next, and take it.
  await quickfixj.command('sequencereset 20');
  assert.equal((await session.next('SequenceReset')).NewSeqNo, 20);
  assert.equal(session.seqNums.expected, 20);
  await quickfixj.command('testrequest AT-20');
  assert.equal((await session.next('TestRequest')).MsgSeqNum, 20);
  await quickfixj.message('in', tags => tags[35] === '0' && tags[112] === 'AT-20');

  // Ours: QuickFIX/J expects 30 next, and takes it.
  await session.send('SequenceReset', { NewSeqNo: 30 });
  session.setSeqNums({ next: 30 });
  await session.send('TestRequest', { TestReqID: 'AT-30' });
  const taken = await quickfixj.message('in', tags => tags[35] === '1');
  assert.equal(taken[34], '30');
  await session.next('Heartbeat', { where: { TestReqID: 'AT-30' } });
  assert.deepEqual(problems(session), []);
});

scenario("QuickFIX/J's Logon names FIX 5.0 SP2, and it takes an answer that names the same; an order from it that names its own application version is delivered", async ({ start }) => {
  const { quickfixj, session } = await start();
  assert.deepEqual(session.id, { version: 'FIXT.1.1', sender: 'SERVER', target: 'CLIENT' });
  const [theirs, ours] = session.history.flatMap(entry => (entry.kind === 'message' ? [entry] : []));
  assert.deepEqual([theirs?.direction, theirs?.message.MsgType, theirs?.message.DefaultApplVerID], ['in', 'Logon', 'FIX50SP2']);
  assert.deepEqual([ours?.direction, ours?.message.MsgType, ours?.message.DefaultApplVerID], ['out', 'Logon', 'FIX50SP2']);
  // Our answer, as QuickFIX/J accepted it.
  const answer = quickfixj.transcript.find(line => line.startsWith('in\t') && line.includes('|35=A|'));
  assert.match(answer ?? '', /^in\t8=FIXT\.1\.1\|.*\|1137=9\|/);

  await quickfixj.command('order B1');
  const order = await session.next('NewOrderSingle');
  assert.deepEqual([order.BeginString, order.ClOrdID], ['FIXT.1.1', 'B1']);
  await quickfixj.message('in', tags => tags[35] === '8' && tags[39] === '2');

  // An order that names its own application version: QuickFIX/J puts ApplVerID (1128) in its header, and the order is delivered with it, and filled.
  await quickfixj.command('order B2 9');
  const sent = await quickfixj.message('out', tags => tags[35] === 'D' && tags[11] === 'B2');
  assert.equal(sent[1128], '9');
  const named = await session.next('NewOrderSingle', { where: { ClOrdID: 'B2' } });
  assert.equal(named.ApplVerID, ApplVerID.FIX50SP2);
  await quickfixj.message('in', tags => tags[35] === '8' && tags[11] === 'B2' && tags[39] === '2');
  await quickfixj.command('logout');
  assert.deepEqual(await session.closed, { by: 'them', text: 'Counterparty logged out' });
  assert.deepEqual(problems(session), []);
}, ['FIXT.1.1']);
