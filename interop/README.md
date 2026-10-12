# Interoperability with QuickFIX/J

`npm run test:interop` tests fix.js's sessions against an independent FIX
engine, [QuickFIX/J](https://www.quickfixj.org), in FIX 4.2, FIX 4.4, and
FIXT.1.1 carrying FIX 5.0 SP2.

This suite exists because QuickFIX/J's engine and its acceptance scripts are freely available, and many of the session-layer faults fixed in fix.js were found with them (see "What the scripts changed in fix.js" below). Thank you to the QuickFIX/J project.

The suite has three parts:

- **fix.js `connect()` against a QuickFIX/J acceptor** (`quickfixj-acceptor.test.ts`),
  and **a QuickFIX/J initiator against fix.js `listen()`** (`quickfixj-initiator.test.ts`):
  logon, heartbeats and TestRequests, an order and its ExecutionReports, a resend
  after a gap (asked for by either side), a Logon with ResetSeqNumFlag=Y at logon,
  one sent by fix.js in the middle of a session (also while a resend it asked
  for is outstanding, with QuickFIX/J's gap fills as they come and with their
  PossDupFlag taken off), a SequenceReset, and logout (started by either side);
  and for FIXT.1.1, the application version each Logon names (DefaultApplVerID 9),
  an order from fix.js with a field no FIX 4 version has, and an order from each
  side that names its own application version (ApplVerID 9). Every scenario ends
  by checking that the QuickFIX/J process printed no `error` line and that no
  Reject went either way, and one that fails shows the problems and errors the
  fix.js session recorded and everything QuickFIX/J printed (`checks.ts`).
- **QuickFIX/J's own acceptance scripts for an acceptor** (`acceptance.test.ts`):
  the 63 FIX 4.2 and 65 FIX 4.4 scripts, and the 66 FIX 5.0 and 67 FIX Latest
  ones, which speak FIXT.1.1, played against fix.js `listen()`.
- **Scripts of our own in the same format** (`own-scripts.test.ts`), which hold
  fix.js to what it does where it differs from those scripts on purpose.

Of the application versions fix.js reads over FIXT.1.1, only FIX 5.0 SP2
(DefaultApplVerID 9) is exercised against QuickFIX/J itself: the two files of
scenarios name no other, and the harness's QuickFIX/J has that one application
dictionary. FIX 5.0 (7) and FIX Latest (10) are exercised by QuickFIX/J's
acceptance scripts, whose two FIXT.1.1 folders log on as those; no QuickFIX/J
process runs there. Nothing of QuickFIX/J's names FIX 5.0 SP1 (8): only
fix.js's own tests do (the unit tests, and one script of our own here, which
logs on as each of the four).

It is separate from `npm test`, which needs neither Java nor the network.

## Running it

```sh
JAVA_HOME=/path/to/a/jdk npm run test:interop
```

It needs a JDK, Java 17 or newer, from `JAVA_HOME` or else on `PATH`, and, the
first time, the network. What it downloads and builds is kept in
`interop/.cache`, which git ignores; later runs use that and need no network.
On a warm cache the suite takes about a minute: each scenario against
QuickFIX/J starts a Java process of its own, and the scenarios of one file run
one after another, for three versions.

Tests whose needs are missing are skipped, saying why, and the run still passes:
without Java the two QuickFIX/J files are skipped; without the scripts (no
network and no cache) the acceptance scripts are. Set `INTEROP_REQUIRED=1` to
make that an error instead, so a run that tested nothing cannot pass. Our own
scripts need neither, and always run.

## What is downloaded

Nothing from QuickFIX/J is kept in this repository: no jar, no source, no
script. `pins.ts` records each file's URL, size and SHA-256, and a file is used
only if it matches; a download that does not match is an error.

- QuickFIX/J 3.0.2 from Maven Central: `quickfixj-core`, `quickfixj-base`,
  `quickfixj-messages-fix42`, `quickfixj-messages-fix44`,
  `quickfixj-messages-fixt11`, `quickfixj-messages-fix50sp2`, and what they need
  at run time, `mina-core` 2.2.9 and `slf4j-api` 2.0.18: 13 MB in all.
- The acceptance scripts (`definitions/server/fix42`, `fix44`, `fix50` and
  `fixLatest`: 261 files, 280 KB) from github.com/quickfix-j/quickfixj at the
  commit tagged `QFJ_RELEASE_3_0_2`. Maven Central does not carry them.

`harness/Harness.java` is ours: one QuickFIX/J session, as an acceptor or an
initiator, driven by lines on stdin and reporting on stdout. A FIXT.1.1 session
of it carries FIX 5.0 SP2. It is compiled
with `javac` against the jars the first time it is needed. A harness exits when
its stdin closes, so it never outlives the test that started it.

## The acceptance scripts

Each script is a list of steps: connect, send this message, expect that
message, expect the connection to be closed. `script.ts` reads them and
compares messages by the rules of QuickFIX/J's own runner; `acceptance.ts` plays
one over raw TCP against a fix.js server set up as the scripts assume (we are
ISLD, the counterparty is TW, every connection starts at MsgSeqNum 1, and the
application sends each NewOrderSingle back as it came). A line that is not a
step is passed over, as QuickFIX/J's runner passes over it: two scripts have
one. In some scripts an expected
message's BodyLength (9) is less than the fields listed with it come to, which
no message can match; on those lines the suite does not compare it, and checks
instead that the reply's BodyLength is what the reply's own fields come to.

Of the 261 scripts, 132 pass exactly as written (65 of the 128 for FIX 4.2 and
FIX 4.4, 67 of the 133 for FIXT.1.1). The other 129 differ in a way that is
recorded, with its reason, in `differences.ts`, and the suite holds fix.js to
that record both ways: a script that is not listed must pass as written, and a
listed script must differ exactly as recorded. A ruling records:

- `ignore`: the tags whose values differ from the script's. Each must be there
  when expected, and must really differ somewhere in the script.
- `extra`: the tags fix.js sends in a message where the script's line has no
  such field. Each must really be sent somewhere in the script.
- `failsAt` and `arrives`: the line at which fix.js stops matching the script,
  and what comes there in place of the expected message: a message's MsgType
  as it is on the wire (`5` is a Logout), `nothing` when no message comes
  within the wait, or `closed` when the connection is closed instead. The
  script is not played beyond that line.
- `unread`: the MsgType of each message fix.js sends that the script never
  reads.

`ignore` and `extra` apply to a whole script, not to one line of it: a tag
that is ignored is ignored wherever it appears in that script, and an extra
tag is let through in any message of it.

### The scripts for FIXT.1.1

QuickFIX/J has two folders of scripts that speak FIXT.1.1: `fix50`, whose
Logons name FIX 5.0 (DefaultApplVerID 7), and `fixLatest`, whose Logons name
FIX Latest (10); one script in each names FIX 5.0 SP2 (9). It has none for
FIX 5.0 SP1 or SP2. fix.js reads all of them with its one dictionary for
FIX 5.0 and later, FIX Latest (FIX 5.0 SP2 with every extension pack since),
and three of the reasons below come from that: it is one dictionary for the
session layer and the application layer; it gives TradingSessionID a set of
values (which fix.js checks before the count of their group, where QuickFIX/J
checks the count first); and it is not FIX 5.0's own.

### What the scripts changed in fix.js

Running the scripts found these, and fix.js now does what the scripts (and the
FIX session specification) expect:

- A SequenceReset in reset mode is applied whatever its own MsgSeqNum is.
- A tag the dictionary does not have is rejected as an invalid tag number
  (SessionRejectReason 0).
- A message whose CompID is missing or empty is rejected for that field, and the
  session carries on; only a CompID that is wrong ends it.
- A header field after the body began, or a body field after the trailer began,
  is rejected (SessionRejectReason 14); so is a repeating group whose fields are
  out of order, or whose entry does not begin with the group's first field
  (SessionRejectReason 15).
- A message whose MsgType is not its third field is garbled: it is ignored, and
  its MsgSeqNum is not used.
- A Logon with ResetSeqNumFlag=Y on a logged-on session starts both sequences
  again at 1. Every reset fix.js starts is owed one such Logon in reply: one
  that arrives while a reply is owed is taken as that reply, and any other is a
  request, and is answered.
- A Reject carries the routing fields of the message it rejects, turned round
  (OnBehalfOfCompID as DeliverToCompID, and so on).
- A Logon that fails a header check before the session is logged on is
  answered with a Logout alone, not a Reject and then a Logout.
- On FIX 4.2 a Reject carries SessionRejectReason only for the reasons FIX 4.2
  has (0 to 11).
- The texts fix.js writes into a Logout or Reject are plain ASCII.

The scripts for FIXT.1.1 found nothing more to change in fix.js. They changed
this suite: a line that is not a step is passed over, and the server's
application sends a message back without a TransactTime when it came without
one (the session would fill one in, and fix.js's FIX Latest dictionary gives a
SecurityDefinition that field).

### Where fix.js differs on purpose

| Reason | Scripts (in every folder unless said) |
|---|---|
| fix.js words its own Text (58): it names the field and says what is wrong with it | The scripts whose Reject or Logout fix.js words differently: 11c, 14a to 14j, 1d (bad SendingTime; 4.2 and 4.4, where the script reads the Logout), 2f, 2g, 2i, 2k, 2o, 2q, QFJ648, QFJ650, QFJ934 (4.4), LogonUnknownDefaultApplVerID (Latest), RejectResentMessage, ReverseRoute, ReverseRouteWithEmptyRoutingTags. The Text is checked for being there, not for what it says. |
| the test application sends an order back decoded and encoded again, so a quantity written with leading zeros and decimals goes back as a plain number | 14e_IncorrectEnumValue |
| fix.js numbers its TestReqIDs (TEST-1, TEST-2, ...), so a reply can be told from a reply to an earlier one; QuickFIX/J always sends TEST | 6_SendTestRequest |
| before it closes a connection it refuses, fix.js sends a Logout saying why; QuickFIX/J only closes it | 1b_DuplicateIdentity, 1c_InvalidSenderCompID, 1c_InvalidTargetCompID, 1d_InvalidLogonWrongBeginString, AlreadyLoggedOn; and in the FIXT.1.1 folders 1d_InvalidLogonBadSendingTime and 1d_InvalidLogonNoDefaultApplVerID. The scripts pass; the Logout is one message they never read. |
| the script's Logout has a MsgSeqNum that is too low, which QuickFIX/J never checks on a Logout; fix.js answers any message that is too low with a Logout saying so, and disconnects | 10_MsgSeqNumEqual, at its last message |
| a field whose tag is not a number (a tag of -1, say) makes the message garbled, and fix.js ignores it; and it takes user-defined tags (5000 and up) without a dictionary | 14a_BadField, from its third case on |
| what comes where the script expects a Reject is fix.js's own Heartbeat, or its TestRequest when its once-a-second timer puts that first | 14a_BadField, at its third case (the script asks for a heartbeat every 2 s) |
| a garbled message's MsgSeqNum is not used, so the script's next message comes ahead of sequence and gets a ResendRequest | 14a_BadField, at its fourth case |
| fix.js reads a FIXT.1.1 session with one dictionary for both layers, so a field of the application layer on a session message is not defined for that message type (SessionRejectReason 2); QuickFIX/J reads session messages with the session layer's dictionary alone, to which the tag is no tag at all (0) | 14a_BadField (5.0 and Latest), at its first case: a Heartbeat with tag 999, which is LegUnitOfMeasure in FIX 5.0 SP2 |
| fix.js's FIX 4.4 dictionary is FIX Orchestra's, where Symbol (55) is optional in a NewOrderSingle; QuickFIX/J's requires it | 14b_RequiredFieldMissing (4.4), at its second case |
| fix.js checks the values of a group's fields before its count: its FIX Latest dictionary gives TradingSessionID (336) a set of values, so it rejects a value that is neither among them nor in the range left open to agreement (100 and up), with SessionRejectReason 5; QuickFIX/J checks the count first (16), even with a dictionary that gives 336 values | 14i_RepeatingGroupCountNotEqual (5.0 and Latest): a Reject comes where one is expected, for another field and another reason |
| fix.js reads FIX 5.0 with its FIX Latest dictionary, in which a SecurityDefinition no longer has TradingSessionID (336) among its own fields, so it rejects the script's; QuickFIX/J has a dictionary for FIX 5.0 itself | 21_RepeatingGroupSpecifierWithValueOfZero (5.0) |
| the script's expected Logon lacks DefaultApplVerID (1137), which a FIXT.1.1 Logon must carry; QuickFIX/J's own run does not compare the fields of a Logon | QFJ650_MissingMsgSeqNum (5.0 and Latest). QuickFIX/J's build runs its scripts with shortened heartbeats, and then its runner does not compare the fields of a line that has HeartBtInt. |
| after rejecting a resent message whose OrigSendingTime is later than its SendingTime, fix.js carries on; QuickFIX/J also logs out | 2f_PossDupOrigSendingTimeTooHigh |
| fix.js does not keep a message that arrives ahead of sequence: it asks for everything from the gap on (EndSeqNo=0) and takes it when it is resent; the script resends only the message that was missing | 2m_BodyLengthValueNotCorrect, RejectResentMessage |
| after a message whose BodyLength is too large, fix.js looks for the next BeginString and so reads the message that follows, which is ahead of sequence and gets a ResendRequest; the script expects that message to be lost with the first | 2m_BodyLengthValueNotCorrect, in its second half |
| the script's Logout has a MsgSeqNum that is too high, which QuickFIX/J never checks on a Logout; fix.js sends a ResendRequest for what it missed (unless it is waiting for a resend already), then its Logout in reply, and closes the connection at once, so the resend it asked for is never received | 2m_BodyLengthValueNotCorrect, RejectResentMessage, at their last message |

### The scripts that stop early

Seven scripts stop matching part of the way through, and are not played beyond
that line: five in every folder, one in FIX 4.4 only and one in FIX 5.0 only
(22 of the 261 files). Their rulings name every reason the whole script has,
and this is what happens at each step the suite does not play:

| Script | Where it stops, and what comes there | What the rest of it would meet |
|---|---|---|
| 10_MsgSeqNumEqual | Line 14: a Logout saying that the MsgSeqNum is too low, where the script expects a Logout without a Text. | Only the close of the connection, which comes. |
| 14a_BadField | Line 27: no Reject comes for the field whose tag is -1. Two or three seconds later fix.js's own Heartbeat or TestRequest does. | The message with tag 5000 is numbered as if the garbled one had counted, so it is ahead of sequence and gets a ResendRequest where the script expects a Reject (line 32); in sequence it would be taken, with no Reject. The Logout that ends the script is answered. |
| 14b_RequiredFieldMissing (4.4) | Line 22: the order without Symbol, sent back, where the script expects a Reject. | The Logout that ends the script, answered as expected. |
| 21_RepeatingGroupSpecifierWithValueOfZero (5.0) | Line 18: a Reject for TradingSessionID (336), where the script expects the SecurityDefinition sent back. | The Logout that ends the script, answered as expected. |
| 2f_PossDupOrigSendingTimeTooHigh | Line 20: nothing. fix.js has sent its Reject (line 18) and carries on. | The script's own Logout is answered with a Logout, which the script does not read, and the connection is closed. |
| 2m_BodyLengthValueNotCorrect | Line 18: nothing. The order that came ahead of sequence was not kept. | fix.js is still waiting for that order to be sent again, so none of the four orders that follow is sent back (lines 28 and 29). It answers the Logout with MsgSeqNum 4 where the script expects 7 (line 33), and then closes the connection. Had the order been sent again, the message with the BodyLength that is too large (line 22) would be ignored and the one after it read and found ahead of sequence: a ResendRequest where line 28 expects an order, and another before the answer to the Logout, whose MsgSeqNum is one too high; the connection is closed once the answer is sent, so that resend would never be received. |
| RejectResentMessage | Line 19: nothing. The TestRequest that came ahead of sequence was not kept. | No Heartbeat for the second TestRequest either (line 20): it is dropped while fix.js waits for the first to be sent again. The Logout, whose MsgSeqNum is too high, is answered with MsgSeqNum 4 where the script expects 6 (line 24). The connection is closed once the answer is sent. Had the first TestRequest been sent again, lines 19 and 20 would pass and the Logout would get a ResendRequest, then its answer, and the connection would be closed at once, so that resend would never be received. |

`own-scripts.test.ts` holds fix.js to each of these with a script of our own,
in FIX 4.2, FIX 4.4 and FIXT.1.1: the Logout that is too low and the one that
is too high, the resent message with a later OrigSendingTime, the tag that is
not a number, the user-defined tag, the BodyLength that is too large, the
message ahead of sequence (asked for again, not kept, and what is dropped
meanwhile), and an order without a required field (Side in every version;
Symbol, which only FIX 4.2 requires). Six more, for FIXT.1.1, hold it to what
this page says of application versions and of its one dictionary: a Logon is
answered with the version it names; one that names none, or one fix.js does not
read, gets a Logout saying so; an application message that names such a version
is rejected (SessionRejectReason 18), and a session message is not held to it;
a field of the application layer on a session message is not defined for that
message; TradingSessionID takes its values and the range left open, and no
other; and a FIX 5.0 SecurityDefinition with TradingSessionID among its own
fields is rejected.

## Continuous integration

`.github/workflows/interop.yml` runs the suite on every push to `master`, on
every pull request, and by hand, on Linux with Node 24 and Java 17 (Temurin).
It asks for no more than read access to the repository. It sets
`INTEROP_REQUIRED=1`, so a runner without Java or network fails instead of
skipping the tests. It keeps the downloads (`interop/.cache/jars` and
`interop/.cache/scripts`) between runs, keyed on `pins.ts`, so they happen once
per set of pins; a kept file is still checked against its pin each time it is
used. The compiled harness is not kept: it is compiled on every run. The suite
imports only `src/` and Node's own modules, so the workflow runs no `npm ci`.

The workflow has not run on GitHub yet: it could not be tried before the branch
was pushed, and only its YAML has been checked. Look at its first run.
