# fix.js API

The API is written as TypeScript declarations in this folder. The examples in
[`../examples`](../examples) are programs written against it; `npm run check:api`
type-checks all of them (it does not run them), and checks the implementation
(`src/`) against the declarations for everything implemented so far. An example
that uses what is not implemented yet cannot run: `16-quickfixj.test.ts` places
its order with `newOrder()`, so it cannot run until orders exist.

Status (2026-10-07): **implemented:** dictionaries (FIX 4.2, FIX 4.4, and
FIX 5.0 SP2 over FIXT.1.1; custom fields), the wire layer, the session engine,
`connect()` and `listen()`, a hardened server (limits, the connection feed,
per-counterparty settings), stores with epochs (`read()`, `list()`, and
`sent()`, which answers a ResendRequest), entries as JSON, and TLS. The session behaviour of `connect()` and `listen()` is tested
against QuickFIX/J in FIX 4.2, FIX 4.4 and FIXT.1.1 carrying FIX 5.0 SP2
([`../interop`](../interop/README.md)); the server's limits, the stores and TLS
are not part of that.
**Next:** orders, then faults.
[`conformance.ts`](conformance.ts) lists what isn't implemented yet.

## Conventions

- **Naming.** FIX data keeps FIX's exact names (`ClOrdID`, `OrdStatus`, `CumQty`),
  the way the AWS SDK keeps its service model's names. Our own API uses JavaScript
  conventions: camelCase functions, methods and options (`newOrder`, `heartbeat`),
  PascalCase types. Never snake_case.
- **Constants for enum values and message types.** `Side.Buy`, `OrdType.Limit`,
  `MsgType.ExecutionReport`. Each constant *is* its name as a string
  (`Side.Buy === 'Buy'`), so constants and strings never disagree; docs use constants.
- **The message type is always the first argument.**
  `session.on(MsgType.X, …)`, `session.next(MsgType.X, …)`, `session.send(MsgType.X, …)`,
  `drop(MsgType.X, …)`.
- **Options are one object, last:** `{ where, timeout }`.
- **Defaults for everything that can be defaulted.** A client needs an address,
  `sender` and `target`; a server needs a port and `compID`.

## Two levels

| Level | For | Looks like |
|---|---|---|
| Domain | Everyday use | `session.newOrder({...})`, `order.fill()`, `order.cancel()`, `order.until(OrdStatus.Filled)` |
| Low | Any message, deliberate faults | `session.send(MsgType.Heartbeat, { MsgSeqNum: 99 })`, `session.sendBytes(...)` |

Both obey one **auto-fill rule**: leave a field out and it's filled in correctly;
write it and it's sent as written; `null` leaves it out. Order replies use FIX
fields for everything beyond their main argument: `order.fill(40)` is a partial
fill, `order.fill(50, { CumQty: 150 })` a deliberate overfill.

## Orders

Orders are objects: the NewOrderSingle's fields plus methods. Their state
(`order.state.CumQty`, …) is computed from the session history, so it survives
reconnects and can't drift from what was sent.

- Sending side: `newOrder`, `order.replace` and `order.cancel` all resolve when
  the other side accepts, and throw `OrderRejectedError` / `CancelRejectedError`
  with its reason if it refuses. `order.until(status)` waits for later statuses.
  OrdType follows from the prices given unless written: none → Market,
  Price → Limit, StopPx → Stop, both → StopLimit.
- Receiving side: `order.ack`, `order.fill`, `order.reject`, `order.cancel`;
  `request.accept` / `request.reject` for cancel and replace requests.
- Server defaults: every order is acked (unless your handler rejects it first);
  cancels and replaces are accepted, or refused TooLateToCancel once the order is
  done; requests for unknown orders are rejected UnknownOrder before any handler runs.

## Custom fields

`defineDictionary({ fields, messages })` declares a firm's custom fields once.
After that they are named, typed and autocompleted like standard fields, with
constants for their values (`acme.AlgoStrategy.VWAP`). A firm with an Orchestra
file could generate the same definition. Raw numeric tags always work, with or
without a dictionary.

## Driving fix.js from a GUI or DSL

Other programs (a GUI, a test-scenario format) can drive this API. The
constraint on fix.js: **every built-in capability can be expressed as plain data.**

- Faults are data: `drop(MsgType.Heartbeat)` returns `{ fault: 'drop', type: 'Heartbeat' }`,
  and `session.outgoing()` accepts that object directly (from JSON, for example).
- Message types, field values and matches are strings and plain objects.
- Session history, including faults added and removed, is plain data a UI can show.
- A message whose type is only known at runtime can still be sent and matched
  (see `16-quickfixj.test.ts`).

Custom inline functions remain available in code; they just can't be serialized.

## Modules

| Module | Contents |
|---|---|
| `fix.js` ([index.d.ts](index.d.ts), [orders.d.ts](orders.d.ts)) | `connect`, `listen`, sessions, orders, constants, `defineDictionary`, stores, `entryToJSON` / `entryFromJSON` |
| `fix.js/faults` ([faults.d.ts](faults.d.ts)) | `drop`, `delay`, `set`, `duplicate`, `dropSeq`, `nth`, `first`, `after`, `sometimes` |
| `fix.js/test` ([test.d.ts](test.d.ts)) | `expectNone`, `within`, `fakeClock`, `storeContract` |
| `fix.js/log` ([log.d.ts](log.d.ts)) | `readLog`, `listLogs`, `replay` |
| `fix.js/wire` ([wire.d.ts](wire.d.ts)) | `encode`, `decode`, `frames` |
| `fix.js/fix50sp2` ([fix50sp2.d.ts](fix50sp2.d.ts), a stand-in like dictionary.d.ts) | The constants and types of FIX Latest (FIX 5.0 SP2 with every extension pack since), which the library reads for FIXT.1.1: `MsgType`, `Side`, `Messages`, … (the root's are FIX 4.4's). Use the root's `ApplVerID`, whose four names are the versions the library reads |
| ([dictionary.d.ts](dictionary.d.ts)) | Stand-in for the types generated from FIX Orchestra |

Internally the session protocol engine still knows nothing about orders or
faults; the order and fault features are built on it. The public objects just
put everything where users look for it.

## Revision 2 changes (from review)

| Review point | Change |
|---|---|
| Naming consistency | FIX names for FIX data (order state was camelCase, now `order.state.CumQty`); camelCase for our API |
| Minimal setup | `version`, `heartbeat`, `store` default; `listen(port, options)` mirrors `connect(address, options)` |
| Receiving looked like several APIs | One pattern: type first (`on`, `next`, `messages`, `send`, faults); handler maps, `is()` and `receive()` removed |
| `send()` is too low-level for daily use | Domain methods: `session.newOrder`, `order.fill`, `order.cancel`, … |
| Type-safe enum values | Constants everywhere (`TimeInForce.ImmediateOrCancel`) |
| Custom tags | `defineDictionary`, fully typed |
| Other layers must drive this one | Faults and matches are plain data |
| (found while rewriting) `request.order!` | Unknown-order requests rejected automatically, so `request.order` always exists |
| (found while rewriting) `next(type, {}, { timeout })` | One options object: `next(type, { where, timeout })` |
| (found while rewriting) `fill({ qty })` mixed our names into FIX data | Fills use FIX fields: `LastQty`, `LastPx` |
| `venue()` vs `listen()` | Merged: `listen()` has the order defaults |

## Arguments: positional or object?

JavaScript has no keyword arguments, so an object is how a call names its
values. The rule used throughout:

- **Positional** for the one or two required or obvious arguments a call is
  about: `order.fill(40)`, `order.reject('Not listed')`, `session.next(MsgType.Logon)`,
  `listen(9878, …)`.
- **An object, last** for FIX fields (there are many, most optional, and each
  firm adds its own) and for optional settings: `session.newOrder({ Symbol, Side, OrderQty })`,
  `{ timeout: '5s' }`.

Positional arguments would force `undefined` placeholders to reach a later
optional value, and two numbers (quantity and price) could be swapped without a
compile error. Object keys are checked and autocompleted like any other type.

## Revision 3 changes

| Question | Change |
|---|---|
| Can a market order skip OrdType and Price? | Yes: OrdType is inferred from the prices given |
| Is `order.until(OrdStatus.New)` required? | No longer exists as a step: `newOrder()` resolves on acceptance, like `cancel()` and `replace()` |
| Why objects instead of arguments? | `fill(qty?, fields?)` and `reject(text?, fields?)` take their main value positionally; objects stay for FIX fields and settings |

## Revision 5 changes (2026-09-30)

| Change | Why |
|---|---|
| `server.watch(fn)` with `ConnectionEntry` (opened / received / rejected / loggedOn / closed, peer, problem, bytes) | "Why won't my engine connect?" needs attempts that never become a session |
| `accept()` may return `AcceptOptions` (heartbeat range, manual, store) | Per-counterparty settings on a multi-counterparty acceptor |
| `listen({ heartbeat: { min, max } })`, default 1–120 s | A huge HeartBtInt would switch off liveness |
| `tls` on `listen` and `connect` | Hosting |
| Problem codes `LogonRefused`, `ConnectionLimit`, `MessageTooLarge` | Refusals before a session exists |
| `heartbeat` moved from the shared options to `connect` only | An acceptor uses the counterparty's HeartBtInt, within the range |

## Revision 6 changes (2026-09-30)

| Change | Why |
|---|---|
| `Session` and `Server` are interfaces; the classes behind them stay internal | Transport wiring (attach, receiveBytes, …) isn't part of the API |
| `session.key`, `connectionId`, `peer`, `connectedAt`, `loggedOnAt` | Identify, log and monitor each session (`key` is a label; look sessions up by `id`) |
| Every timeout is a `Duration`: a number is milliseconds, or `'10s'` / `'500ms'` | `logonTimeout: 10` meant seconds while `connectTimeout: 10` meant milliseconds |
| Errors in handlers, routes and watchers, and the session's own failures, are `'error'` entries; nothing crashes by default; `onHandlerError` is optional | One ordered audit trail per session |
| Credentials are hidden in history, `watch()` and the store (`redact`) | A security baseline for logs |
| The session hands its custom dictionary to its store (`StoreContext`) | It had to be given twice |
| `connect()` refuses an unsupported `version`; `FIXLogonError` and the other errors, `MemoryOptions` and `memoryStore()`'s options are in the spec | The spec matches the code, and `npm run check:api` checks it: every export and type export by name, function arguments, Session and Server members, option keys (see `conformance.ts` for what isn't implemented yet) |
| `TimeoutError.waitingFor` says what timed out: `{ kind: 'message', msgType }`, `{ kind: 'logon', target }`, `{ kind: 'connect', address }` or `{ kind: 'store' }` | A program can tell the waits apart without parsing the message |
| `server.watch(fn, { replay })`: `ConnectionEntry` gains `connectionId` (shared with the session), the Logon's CompIDs, `sessionKey` and an `'error'` event | "Why won't they log on?", with failures outside any session in the same feed |
| `ConnectionEntry` is a union by `event`: `'received'` always has `bytes`, `'rejected'` its `problem`, `'loggedOn'` its `logon` and `sessionKey`, `'error'` its `error`. A store that fails to load is rejected (`Store unavailable`); a connection lost mid-logon is only closed; nothing is rejected after it closed | Narrowing on `event` needs no optional checks, and the feed tells a refusal from a dropped connection |
| `limits`: `maxSessions`, `connectionsPerAddress`, `pendingLogons`, `processingTimeout` | A server open to many counterparties must bound what each one, and all of them, can take |
| `accept()` may return `AcceptOptions` (`heartbeat`, `manual`, `store`, `memory`, `dictionary`, `context` → `session.context`); `compID` may list several CompIDs; `listen({ heartbeat: { min, max } })` refuses a HeartBtInt outside 1–120 s by default, so HeartBtInt=0 (heartbeats off) is refused unless `min` is 0; settings accept() returns that can't be used are an `'error'` entry and the Logon is refused; `memory` bounds must be positive integers; `server.session(target, { compID })` and `whenConnected(target, { compID })` choose among our CompIDs (without it, the first of the counterparty's sessions to be accepted) | One acceptor serving counterparties that differ |
| `connect()` and `listen()` check every option up front (a key they don't know, a value of the wrong kind), in one wording | A typo fails at once, not on the first connection |
| `server.close()` refuses a Logon from the moment it's called, and resolves once every connection has closed; `limits.processingTimeout`, and `limits.logonTimeout` while a Logon is still being checked, send a Logout saying why before closing | No session starts on a closing server, and a counterparty learns why it was dropped |
| A Logon is told by its MsgType anywhere in the frame; a received frame that fails to parse is masked from its first hidden or data field; a Logon's hidden values quoted in `accept()`'s errors and refusals are masked in `server.watch()` and `onHandlerError` (the Logout keeps the text as written) | Credentials stay out of the feed whatever order the fields come in |

### Changes

Code written against earlier revisions needs these changes:

- A bare number for a timeout now means milliseconds; it used to mean seconds
  (`logonTimeout: 10` is now 10 ms). Write `'10s'` for ten seconds.
- `fileStore(dir)` takes no dictionary: the session hands it its custom dictionary
  (`StoreContext`), so a dictionary isn't given twice.
- `Version` still lists FIXT.1.1, but it isn't supported yet: `connect()` and
  `listen()` refuse it. (It is supported from revision 9.)
- `listen()` refuses a Logon whose HeartBtInt is outside 1–120 s, including
  HeartBtInt=0 (heartbeats off). Pass `heartbeat: { min, max }` to `listen()`
  (`{ min: 0 }` allows 0), or return it from `accept()` for one counterparty,
  to allow others. This keeps every session on a shared server live.
- `memory` bounds must be positive integers with known names; anything else is
  a RangeError from `connect()` and `listen()`.
- Every option object is checked the same way: `connect()`, `listen()`,
  `limits`, `memory`, `heartbeat` and the settings `accept()` returns refuse a
  key they don't know and a value of the wrong kind. `listen({ heartbeat: 30 })`
  is a RangeError: write `{ min, max }`. `limits: null` is refused too.
- Option objects must be plain objects (literals, or `Object.create(null)`);
  an object with another prototype is refused.
- `tls` (on `connect()` and `listen()`) and `marketPrice` (on `listen()`) are
  in this spec but not built yet. They are refused with "not supported yet"
  rather than ignored, so a connection is never silently left unencrypted.

## Revision 7 changes (2026-10-01)

| Change | Why |
|---|---|
| A store is given one record per message (`StoreRecord`: the entry and the sequence numbers after it), and a sent message's record is kept before the message reaches the network. `saveSeqNums` is gone: a change of sequence numbers alone is a record with no entry | A restart never reuses a MsgSeqNum already sent, and a store writes once per message, not twice |
| `storeTimeout` (on `connect()` and `listen()`, default `'10s'`): one store write taking longer closes the session (`Store write took longer than N s`); `connect()` waits no longer for `store.load()` (a `TimeoutError`, `waitingFor: { kind: 'store' }`, and no connection opened) | A sent message waits for the store, so a store that stops would otherwise hold up every outgoing message, Heartbeats included |
| Stores keep each session's log in epochs: a new one begins at every sequence reset (a Logon with ResetSeqNumFlag=Y, or `setSeqNums` bringing `next` down to 1). `load()` returns only the current epoch's newest entries, within `memory.history` / `historyBytes` (`StoreContext.history`) | What was sent before a reset is never resent after it, and logging on no longer reads a whole log |
| `store.read(id, { from, to, epoch })` streams a session's entries across epochs, oldest first; `store.list()` gives each session a store holds and its epochs | A session's log can be read back from any store, without knowing how it is kept |
| `entryToJSON(entry)` / `entryFromJSON(json, dictionary?)`: an entry or connection entry as plain JSON (Dates as ISO 8601 text, bytes as base64), and back | A UI or a log file can carry entries, live or stored, and get Dates and bytes back |
| `tls` on `listen()` (Node's TLS server options) and `connect()` (`true`, or Node's TLS connection options). A TLS connection counts toward the limits and is in `server.watch()` from the moment TCP opens; a handshake that fails is rejected with problem code `TLSMismatch`, one not done within `limits.logonTimeout` with `LogonTimeout`. A TLS handshake on a plain listener is rejected with `TLSMismatch` | Hosting over TLS, without a handshake flood getting round the limits; and a counterparty that dials the wrong port learns why it was dropped |

### Changes

Code written against revision 6 needs these changes:

- A custom `Store`: `append` now takes one record, `append(id, record, context?)`, where `record` is `{ at, entry?, seqNums, newEpoch? }`; `saveSeqNums` is gone; `read()` and `list()` are new and required. A store written for the earlier `append(id, entry, seqNums, context)` must be updated: fix.js can't tell the two shapes apart (both are a function named `append`), so an old store would be given a record where it expects an entry.
- `fileStore(dir)` keeps a folder per session, `<dir>/<name>/`, with `session.json` (its SessionId) and one `<epoch>.jsonl` per epoch. A file from before (`<dir>/<name>.jsonl`) is moved in as epoch 1 the first time its session is loaded or appended to; `read()` reads it where it is. If both exist (the folder already has an epoch), the old file is left where it is and never read. A new epoch's file is written whole (a `.tmp` file, then renamed), so a crash never leaves one half-begun. `reset()` renames the session's folder to `<name>.deleting-<uuid>` before removing it, so a reset cut short never leaves a session half there; the store removes any such folder on its first `load()` and on every `list()`.
- After a restart, resends were answered from the current epoch's newest entries (`memory.history`), and older originals were gap-filled. Since revision 10 every resend is read from the store, as far back as the store reaches.
- `tls` is built: `listen({ tls })` and `connect({ tls })` no longer refuse it. `marketPrice` is still refused with "not supported yet".
- A sent message now waits for the store before it is written, so a slow store holds up sending: past `memory.outgoingBytes` the session closes (`Outgoing queue over N bytes: …`), and one store write taking longer than `storeTimeout` ('10s') closes it too (`Store write took longer than N s`).

## Revision 8 changes (2026-10-01)

The session behaviour of `connect()` and `listen()` is tested against
QuickFIX/J 3.0.2 in FIX 4.2 and FIX 4.4, in both directions, and `listen()` also
against QuickFIX/J's own acceptance scripts for an acceptor: see
[`../interop/README.md`](../interop/README.md).

How sessions behave on the wire changed, to follow the FIX session
specification where other engines hold a counterparty to it:

| Change | Why |
|---|---|
| The texts fix.js writes into a Logout or Reject are plain ASCII: `CompIDs are WT to ISLD, expected TW to ISLD`, `HeartBtInt 300 is outside 1 to 120 s`. That holds for fix.js's own words. A text that quotes a value the counterparty sent (the CompIDs above, say) carries that value, and a byte of it that is not ASCII goes out as UTF-8 | Text (58) is not an encoded field; another engine reads its bytes one by one |
| A Logon that fails a header check before the session is logged on (its SendingTime too far from our clock, a Logon reply with the wrong CompIDs) is answered with a Logout alone | A session-level Reject belongs to a session that is logged on |
| A SequenceReset in reset mode (no GapFillFlag, or GapFillFlag=N) is applied whatever its own MsgSeqNum is, 0 included | FIX says a reset's own MsgSeqNum is ignored |
| A message whose SenderCompID or TargetCompID is missing or empty is rejected for that field (`RequiredTagMissing`, `TagSpecifiedWithoutAValue`) and the session carries on; a CompID that is wrong still gets a Reject, a Logout and a disconnect. Two cases differ. A Logon with a missing or empty CompID is refused, like any Logon that fails a check, and the connection is closed. And a message whose MsgSeqNum is too high or too low is treated as that first (a ResendRequest for one too high; a Logout for one too low, unless it is a possible duplicate), whatever its CompIDs lack | A missing field is not a counterparty we don't know |
| A frame whose MsgType (35) is not its third field is garbled: it is ignored, and its MsgSeqNum is not used. Such a Logon does not log the session on. A server's checks before a session exists (CompIDs, HeartBtInt range, `accept()`) still apply and may answer it with a Logout; one that passes them leaves a connection waiting for a readable Logon until `limits.logonTimeout` | FIX's definition of a garbled message |
| On FIX 4.2 a Reject leaves SessionRejectReason (373) out when the reason is one FIX 4.2 does not have (anything above 11); the Text still says it | A FIX 4.2 counterparty that checks its dictionary would reject our Reject |
| Problem code `UndefinedTag` is now `InvalidTagNumber`, and the Reject for a tag the dictionary does not have carries SessionRejectReason 0 | What the FIX session tests ask for, and what other engines send |
| Problem codes `TagSpecifiedOutOfRequiredOrder` and `RepeatingGroupFieldsOutOfOrder`: a header field after the body began (or a body field after the trailer began), and a repeating group whose fields are out of order or whose entry does not begin with the group's first field, are rejected (SessionRejectReason 14 and 15). User-defined tags (5000 and up) may come anywhere among the header, body and trailer fields, whether or not a custom dictionary names them. A field a custom dictionary defines with a tag below 5000 is a body field: placed among the header fields, or after the trailer began, it gets the message rejected (`TagSpecifiedOutOfRequiredOrder`) | FIX fixes the order of header, body and trailer, and of the fields in a group entry |
| A Reject carries the routing fields of the message it rejects, turned round: OnBehalfOfCompID, OnBehalfOfSubID and OnBehalfOfLocationID go back as DeliverToCompID, DeliverToSubID and DeliverToLocationID, and the other way. `redact` hides values tag by tag, so hiding a routing field means listing its counterpart too: with `redact: [115]` alone, the Reject for a message that carried 115 is recorded with that value under 128 | A hub between the two sides can pass the Reject on to whoever sent the message |
| A Logon with ResetSeqNumFlag=Y and MsgSeqNum 1 on a logged-on session starts both sequences again at 1, and is answered with the same, unless a reset of ours is owed a reply (the next row). `accept()` is not consulted again: it accepted the counterparty when this connection logged on, and the Logon reaches handlers like any other message. One that fails a check is refused by the rule for a logged-on session: wrong CompIDs or a SendingTime too far from our clock get a Reject and then a Logout; a wrong BeginString or a field problem gets the Logout alone; nothing is reset. Any other Logon on a logged-on session still ends it | Sessions that stay up for days reset their sequence numbers without logging out |
| `session.send(MsgType.Logon, { EncryptMethod, HeartBtInt, ResetSeqNumFlag: true })` starts a reset from our side (`141: 'Y'` in place of the named field does the same). It goes out as MsgSeqNum 1. Every reset we start is owed one reset Logon (ResetSeqNumFlag=Y, MsgSeqNum 1) from the counterparty. A reset Logon that arrives while one is owed is that reply, however late it comes and whatever was sent or received meanwhile: it is taken, and not answered. Any other reset Logon is a request, and is answered. A reply that lacks ResetSeqNumFlag=Y ends the session, like any other Logon. A second reset of ours is refused (`FIXStateError`) until the first is answered, or the counterparty's MsgSeqNum 1 of the new sequence arrives as another message: not every engine replies (QuickFIX/J, as the initiator, resets and carries on without a Logon of its own). A message marked as resent (PossDupFlag=Y) does not count for that; a resent message that is not marked does, like any message sent new, though it may be of the sequence before the reset. So ending the wait this way only allows another reset of ours: the reply stays owed | A reply must never be answered as a request, or two engines would answer each other for ever. So a reset we start is answered at most once, and what pairs a reply with its reset is a count, not a guess. A counterparty that sends reset Logons nobody asked for is answered each time, as any request is; a limit on that is not built |
| The count costs something when replies never come. After N resets of ours that had no reset Logon in reply (from an engine that sends none, or because a reply was lost), the counterparty's next N reset Logons are taken as those replies: each gets no answering Logon, and our own numbers stay as they are. The counterparty has started again at 1 and expects our MsgSeqNum 1, so our next message is ahead of what it expects: its ResendRequest from 1 brings the messages of our current sequence again, with PossDupFlag=Y, and the two sides are in step. It is now the one owed a reply: a fix.js session in its place refuses its next reset until a reset Logon arrives, and ours, when we next send one, is taken as that reply | One reset Logon cannot be told from another: while one is owed, the next to arrive is taken to be it |
| Send a reset when the session is quiet, and no resend is outstanding. A message the counterparty sent before our reset reached it is of the old sequence, and is not told from one of the new. Most such messages have a MsgSeqNum ahead of the 1 we now expect, and are lost: no handler sees them (they stay in history). The first is a `SeqNumGap` problem and is answered with a ResendRequest from 1; each one after it is a `SeqNumGap` problem and is dropped. The counterparty has nothing of the old sequence left to resend, so the resend is given up as soon as its reply to the reset arrives, or, when it sends none, its MsgSeqNum 1 of the new sequence. QuickFIX/J as the acceptor answers that ResendRequest with a gap fill from 1 to 2, which by then is below what we expect and is ignored as a possible duplicate (a `SeqNumTooLow` problem); as the initiator, with nothing sent yet in the new sequence, it answers with nothing. A resend we asked for before the reset is different: it comes numbered from where we asked, so one asked for from 1 is in sequence, and is taken as if it were of the new sequence (its messages reach handlers, with PossDupFlag=Y, and what we expect moves on with it). The reply to the reset then puts what we expect back to 2, and the session carries on. A counterparty that sends no reply is then too low with its first new message, and the session ends in a Logout (`SeqNumTooLow`) | The two sides do not reset at the same point in the stream |

### Changes

Code written against revision 7 needs these changes:

- Tests that match either of those two texts need the new wording (`to` where there was an arrow or a dash).
- A frame whose MsgType is not its third field used to be read; a session now ignores it as garbled, and `decode()` throws a `FIXDecodeError` for it unless `lenient`.
- `'UndefinedTag'` is no longer a Problem code: match `'InvalidTagNumber'`. `entryFromJSON()` refuses JSON that still carries the old code; a store gives back an entry it kept with the old code as it was kept.
- A counterparty (or a test) that sends header fields after body fields, or the fields of a group entry out of order, is now rejected where it used to be accepted.
- A test that matches a session's Reject field for field now sees the routing fields as well, when the rejected message carried any: its OnBehalfOf… fields come back as DeliverTo… fields, and the other way.
- A Logon that fails a header check before the session is logged on (its SendingTime too far from our clock, a Logon reply with the wrong CompIDs) used to get a Reject and then a Logout; it now gets the Logout alone. A test that waits for that Reject must wait for the Logout.
- A message whose SenderCompID or TargetCompID is missing or empty used to be treated as a wrong CompID, which ends the session; it is now rejected for that field (`RequiredTagMissing`, `TagSpecifiedWithoutAValue`), and the session carries on. A Logon like that is still refused and the connection closed; and when the message's MsgSeqNum is too high or too low, that is acted on first.
- On FIX 4.2 a Reject for a reason FIX 4.2 does not have (a tag that appears more than once, fields out of order, a wrong group count) no longer carries SessionRejectReason (373). Match its RefTagID or its Text.
- A SequenceReset in reset mode with MsgSeqNum 0 used to end the session (`MissingMsgSeqNum`); it is now applied, like one with any other MsgSeqNum.
- A Logon with ResetSeqNumFlag=Y and MsgSeqNum 1 received on a logged-on session used to end it (`UnexpectedLogon`); it now resets both sequences and is answered. A test that ends a session with a second Logon must leave the flag out, or give it another MsgSeqNum.

## Revision 9 changes (2026-10-02)

fix.js speaks FIXT.1.1, the session layer that carries FIX 5.0 and later:

```ts
import { connect, Version } from 'fix.js';
import { MsgType, OrdType, Side } from 'fix.js/fix50sp2';

const session = await connect('localhost:9878', { sender: 'MY_FIRM', target: 'EXCHANGE', version: Version['FIXT.1.1'] });
await session.send(MsgType.NewOrderSingle, {
  ClOrdID: 'order-1', Symbol: 'GOOG', Side: Side.Buy, OrderQty: 100, OrdType: OrdType.Limit, Price: 150,
});
```

A server needs nothing new: `listen(9878, { compID: 'EXCHANGE' })` takes
FIX 4.2, FIX 4.4 and FIXT.1.1 sessions. The session behaviour is tested against
QuickFIX/J in FIXT.1.1 carrying FIX 5.0 SP2, in both directions, and against
QuickFIX/J's acceptance scripts for FIX 5.0 and FIX Latest: see
[`../interop/README.md`](../interop/README.md).

The dictionaries are generated from FIX Orchestra: the FIXT.1.1 session layer,
and FIX Latest (Extension Pack 312) for the application messages. The rows below
about the checks every Logon passes, a reset Logon's heartbeat interval, open
code sets, `redact` and custom field names are about every version; the others
are about FIXT.1.1.

| Change | Why |
|---|---|
| Every Logon received passes one set of checks, whether it is the first message of a connection or resets the sequence numbers of a logged-on session: the header, MsgSeqNum, HeartBtInt, the dictionary's rules, EncryptMethod, PossDupFlag, and that a reset comes as MsgSeqNum 1. One that fails is refused with a Logout saying why, and nothing is reset. A reset Logon on a logged-on session already had its header and the dictionary's rules checked (so a missing, empty or malformed HeartBtInt was already refused); what is new for it is that EncryptMethod other than `None`, a negative HeartBtInt and a PossDupFlag problem are refused too, and that it is checked at all when an incoming route has replaced the message | A reset Logon is a Logon |
| A Logon marked as a possible duplicate (PossDupFlag=Y) must carry an OrigSendingTime that is not later than its SendingTime, like any other message so marked; one that does not is refused with a Logout, as the first message of a connection too | The mark means the same on every message |
| A Logon that resets the sequence numbers does not change the heartbeat interval. When its HeartBtInt differs from the session's, the session keeps the interval agreed at logon, states it in its answer, and records a `ValueIsIncorrect` problem (`A Logon that resets the sequence numbers has HeartBtInt 90; keeping 20`, action `Ignored`) | A server checks HeartBtInt against its allowed range before the session exists (`heartbeat`, or what `accept()` returns); adopting another interval mid-session would get round that range, and a very long one switches liveness off |
| A code set FIX leaves open takes the values FIX leaves it open to. FIX reserves whole numbers from 100 up (from 1000 or 4000 up for some fields) for counterparties to agree on, and lets a few fields take a quantity or a tenor (`D5`, `M3`) beside their codes. Such a value is accepted, is read as its text (`message.SecurityIDSource === '100'`), and is written as it is, as text: `SecurityIDSource: '100'`, never the number 100 (that throws, and the error says to write it as text). The field's type is its names or numeric text (``'CUSIP' \| `${number}` ``; a tenor field takes `'D5'`-style text), so the code above compiles without a cast; the constants (`SecurityIDSource.CUSIP`) are as they were. Nine FIX 4.4 fields are open this way, SecurityIDSource (22) and PartySubIDType (803) among them; in FIX 4.2 one is, IOIShares (27), which takes a number beside S, M and L. FIX 4.2's other code sets are as its Orchestra file has them, so IDSource (22) still takes only its codes | Rejecting a value two firms agreed on, as FIX provides for, would make a test tool refuse real traffic |
| `version: Version['FIXT.1.1']` on `connect()`, and in `versions` on `listen()` (where it is now among the default, every version): a FIXT.1.1 session, which carries FIX 5.0 and later. `session.id` is `{ version: 'FIXT.1.1', sender, target }` and `session.key` `FIXT.1.1:SENDER:TARGET`: the application version is a setting of the session, not part of its identity, so a store keeps one log for it | FIX 5.0 SP2 |
| The application version is named in the Logon, by DefaultApplVerID (1137), with FIX's own names, exported as `ApplVerID`: `FIX50`, `FIX50SP1`, `FIX50SP2`, `FIXLatest`. A session fills it into every Logon it sends unless it is written: `FIX50SP2` for `connect()`, or what `logon: { DefaultApplVerID: ApplVerID.FIXLatest }` says; a server answers with the version the counterparty named, except in `manual` mode, where the program sends the Logon itself and one that does not write DefaultApplVerID names FIX50SP2 (9), whatever the counterparty named. A mid-session reset is sent as in any version, `session.send(MsgType.Logon, { EncryptMethod, HeartBtInt, ResetSeqNumFlag: true })` | It is a Logon field, and the auto-fill rule covers it: left out, it is filled in; written, it is sent as written; `null` leaves it out |
| All four application versions are read with one dictionary: FIX Latest as of Extension Pack 312, which is FIX 5.0 SP2 with every extension pack since. It is exact for `FIXLatest`, and for `FIX50SP2` as FIX defines it today. For `FIX50` and `FIX50SP1` it is the nearest there is, and not theirs: a value FIX has since removed (AllocTransType 3, say) is rejected, a field that later moved (TradingSessionID at the top of a FIX 5.0 SecurityDefinition) is rejected where it used to be, and whatever a later extension pack added is accepted | FIX Orchestra has no file for the older versions |
| A Logon that does not name an application version fix.js reads is refused. A server refuses it before any session exists, like an unsupported BeginString: a `rejected` entry (`LogonRefused`) and a Logout, with `accept()` and the store not asked. It goes by the frame itself, which must carry DefaultApplVerID once, as the text FIX sends for one of the four (7, 8, 9 or 10). Another value (`FIX44`, say: FIX 4 messages over FIXT.1.1 are not supported) gets `DefaultApplVerID FIX44 is not supported; use FIX50, FIX50SP1, FIX50SP2 or FIXLatest`; none, or an empty one, `DefaultApplVerID (1137) is required in a FIXT.1.1 Logon`; the field twice, `Tag 1137 appears more than once`; a version's name where its number belongs, `DefaultApplVerID (1137) has no value 'FIX50SP2': FIX50SP2 is sent as 9`. `connect()` refuses such a reply to its Logon with a Logout, and the Problem says which it was: the new code `InvalidUnsupportedAppVersion` for a version FIX defines and fix.js does not read (`DefaultApplVerID FIX44 is not supported; use …`); `RequiredTagMissing` for none (`DefaultApplVerID (1137) is required`); `TagSpecifiedWithoutAValue` for an empty one; `ValueIsIncorrect` for a value FIX does not define (`DefaultApplVerID (1137) has no value '33'`); `TagAppearsMoreThanOnce` for two. A reply that names another of the four than `connect()` named is taken, and the session keeps naming its own. A server that wants fewer versions refuses in `accept()`, which sees `logon.DefaultApplVerID` | The session must know how to read what follows |
| A message may name its own application version in ApplVerID (1128). On an application message, one of the four is taken; another value gets a session-level Reject (SessionRejectReason 18, RefTagID 1128, Problem code `InvalidUnsupportedAppVersion`), and the session carries on: a version FIX defines and fix.js does not read (`1128=6`), a number FIX has no version for (`33`), and text that is not the name of one of the four (`1128=FIX44` written as a name, or `ZZ`). One that is empty, sent twice, or the name of one of the four written where its number belongs (`1128=FIX50SP2`) is rejected by the rule it breaks, as on any field (SessionRejectReason 4, 13 or 5). A session message is not held to the version it names (a Heartbeat with `1128=6` is delivered), but its ApplVerID is read as any field is: `1128=ZZ`, or `1128=FIX44` written as a name, gets a Reject for its value (SessionRejectReason 5) | FIXT.1.1's rule for a version a side does not support |
| Stores and `entryFromJSON()` read a FIXT.1.1 message back by its BeginString, with no session at hand, as they read FIX 4.2 and FIX 4.4; files written before load as before. `StoreContext` is unchanged | One dictionary answers to BeginString FIXT.1.1 |
| `redact`'s default also hides EncryptedPassword (1402) and EncryptedNewPassword (1404), which a FIXT.1.1 Logon can carry | Credentials stay out of everything recorded |
| A custom dictionary works over FIXT.1.1, and may list a message only FIX 5.0 SP2 has (`messages: { ExecutionAck: […] }`; the type lists FIX 4.4's message names, so such a name needs a cast). Tags from 5000 up are still taken anywhere, with or without a dictionary, although FIX now defines standard fields from 40000 up, which are named and typed like any other. A definition that cannot extend a version's dictionary is a RangeError naming the version: `dictionary can't be used with FIXT.1.1: Custom field RateSource has the same name as a standard field` (from `listen()` without `versions` it goes on: `. List the versions this server speaks in versions`) | Custom fields are first-class in every version |
| `fix.js/fix50sp2`: the constants and types of FIX Latest, which is FIX 5.0 SP2 with every extension pack since and what the library reads for FIXT.1.1, for every message type and enum value it has (181 message types; `import { MsgType, Side } from 'fix.js/fix50sp2'`). The root's constants stay FIX 4.4's. A name both sets have is the same constant (`Side.Buy` is `'Buy'` in both), and each version's dictionary sends it as its own code, which differs for a few (`PartyRole.GiveupClearingFirm` is 14 in FIX 4.4 and 97 in FIX Latest): use each entry's constants with its own sessions. The types check a value annotated with them (`Messages['NewOrderSingle']`); the session's methods take any message type and fields today, and the spec's `Session` describes messages by FIX 4.4's names, so against the spec a name FIX 4.4 lacks needs a cast: `session.send(MsgType.ExecutionAck as MsgTypeName, fields as Fields<MsgTypeName>)`, where `MsgTypeName` and `Fields` come from the root (`fix.js`); the entry exports a `MsgTypeName` of its own (FIX Latest's), which `Fields` does not take. Typing messages by version is an open question of the spec. Use the root's `ApplVerID` (four names, the versions the library reads); the entry's is FIX's whole list, and a `FIX44` in it is refused at Logon | FIX 5.0 SP2 has message types and values FIX 4.4 lacks, and nobody else should pay for loading them |
| In an entry given to `entryFromJSON()`, a name that is both a group and a field (RateSource, in FIX 5.0 SP2) is the group where its value is a list of entries | FIX 5.0 SP2 has such names |
| A FIXT.1.1 Logon may list the application messages its sender sends and receives (the MsgTypeGrp group: RefMsgType, MsgDirection). `accept()` reads each RefMsgType by its message name (`'NewOrderSingle'`), as the session does afterwards: the FIXT.1.1 session layer, which reads a Logon before any session exists, names every message type | `accept()` and the session read one Logon the same way |
| A custom field may not have the name of a group of a version's standard dictionary: `Custom field Parties has the same name as a group of FIX.4.4`, from `defineDictionary()` for FIX 4.2 and FIX 4.4, and inside the RangeError of `connect()` and `listen()` for FIXT.1.1. `entryFromJSON()` given a dictionary that cannot extend the dictionary of the entry's version is a RangeError as well: `entryFromJSON: dictionary can't be used with FIXT.1.1: …` | A message that holds the group could not carry the field under the same name |

### Changes

Code written against revision 8 needs these changes:

- A reset Logon on a logged-on session with another EncryptMethod (`EncryptMethod DES is not supported`), a negative HeartBtInt (`HeartBtInt must be a whole number of seconds, not -5`), or PossDupFlag=Y without a sound OrigSendingTime (`PossDupFlag=Y without OrigSendingTime`, `OrigSendingTime is later than SendingTime`) used to be answered; the session now logs it out, and a test that sends one needs changing. A reset Logon whose message an incoming route replaced used to be answered even with a missing, empty or malformed HeartBtInt, since no problems were handed over for it; its own fields are now looked at, so one that fails any check is refused.
- A reset Logon with a missing HeartBtInt was refused before and still is, but the Logout's Text and the problem's text are now `HeartBtInt is missing`, not `HeartBtInt (108) is required` (the code, `RequiredTagMissing`, is the same). One with an empty or malformed HeartBtInt is refused with the same code and text as before (`HeartBtInt (108) has no value`, `TagSpecifiedWithoutAValue`; `HeartBtInt (108) has a malformed value 'abc'`, `IncorrectDataFormatForValue`).
- A first Logon marked PossDupFlag=Y without a sound OrigSendingTime used to log on; it is now refused with the same two texts. A first Logon with an empty or malformed HeartBtInt was refused before and still is, but with the decoder's text and code (`HeartBtInt (108) has no value` with `TagSpecifiedWithoutAValue`, where it was `HeartBtInt must be a whole number of seconds, not ` with `IncorrectDataFormatForValue`; `HeartBtInt (108) has a malformed value 'abc'`, where it was `HeartBtInt must be a whole number of seconds, not abc`).
- `listen()` without `versions` now takes FIXT.1.1 sessions too. A server that must not, lists the versions it speaks: `versions: [Version['FIX.4.2'], Version['FIX.4.4']]`.
- `listen()` with a `dictionary` and without `versions` now also checks the definition against the FIXT.1.1 dictionary, which has some 5,000 more field names: a custom field named like one of them or like one of its groups (or using a field's tag) is a RangeError saying so. Rename the field, or list the versions the server speaks.
- `connect()` and `listen()` word an unsupported version as `use FIX.4.2, FIX.4.4 or FIXT.1.1`; a definition that cannot extend a version's dictionary used to be a plain Error from `connect()` and `listen()` and is now a RangeError that begins `dictionary can't be used with <version>:`.
- A `redact` list replaces the default, as before: a list written to add tags to the default needs 1402 and 1404 too.
- A custom field named like a group of FIX 4.2 or FIX 4.4 (`Parties`, say) used to be accepted by `defineDictionary()`, though a message that holds the group could not then be sent with the field. It is now refused when the dictionary is defined. Rename the field.
- A message carrying a value in the open range of a code set (SecurityIDSource=100, say) used to be rejected with SessionRejectReason 5 (`ValueIsIncorrect`); it is now delivered, with the value as text. On FIX 4.2 this holds for IOIShares (27) only (`IOIShares: '15000'`); a FIX 4.2 IDSource (22) of 100 is still rejected. The root's types are FIX 4.4's, which has no IOIShares (its IOI has IOIQty), so a FIX 4.2 message typed with them needs a cast: `{ …, IOIShares: '15000' } as unknown as Fields<'IOI'>` (this snippet is for FIX 4.2's own dictionary, the generated one: the spec's stand-in dictionary has no IOI message, so it does not compile against it). The session's own methods take any fields today.
- A frame that carries MsgType (35) twice used to be read by its first MsgType with no problem recorded; it is now a repeated tag like any other (`TagAppearsMoreThanOnce`, tag 35): a Logon like that is refused, any other message is rejected with SessionRejectReason 13 and the session carries on. A negative length for a raw data field (`RawDataLength=-1`, `EncryptedPasswordLen=-1`, in FIX 4.2, FIX 4.4 and FIXT.1.1, with the data field after it or not) used to be accepted; it is now a malformed value (`IncorrectDataFormatForValue`), as a length that is not a number already was.
- A reset Logon with another HeartBtInt was already answered with the session's own interval, and `heartbeat` stayed what it was. What is new is the record: a test that looks through `session.history` for problems now finds the `ValueIsIncorrect` entry (action `Ignored`).

## Revision 10 changes (2026-10-06)

A ResendRequest is answered by reading the store. A session's history in
memory is a view for `session.history` and `watch()`, and nothing else depends
on it.

| Change | Why |
|---|---|
| `Store` has one more method, `sent(id, { from, to }, context?)`: the messages the session sent in its current epoch with those MsgSeqNums, originals only (not marked PossDupFlag), in MsgSeqNum order, at most one for each number (the latest where several were sent with one), read as they are asked for. `Store`'s comment in `index.d.ts` is the whole contract for a store of your own | A session's historical data has one home |
| A resend reaches back as far as the store does: to the start of the epoch with a `fileStore`, to the entries it keeps with a `memoryStore` (1,000 entries / 1 MiB by default, counting every kind of entry in both directions). `memory.history` no longer limits it: it sizes `session.history` and what `load()` returns | `memory.history` can be sized for what a program looks at |
| A `memoryStore` does not keep a message sent with PossDupFlag (a copy sent again, the SequenceReset-GapFill sent in its place, or a message your program itself sends with PossDupFlag); the record's sequence numbers still count. A `fileStore` keeps them, and a store of your own may do either. With any store, a message your program sent with PossDupFlag is not resent: a gap fill answers its MsgSeqNum | Answering a ResendRequest never pushes out the originals another one may ask for |
| Before it reads the store, a resend waits until every record queued for the store so far has settled | The store then holds every message numbered before the request, one an outgoing route dropped included |
| A resend is read and written one message at a time: the next entry is asked of the store once the one before is on the socket. Its size does not count toward `memory.outgoingBytes`, and a range of any length holds one entry in memory | A counterparty may ask for everything since the start of the day |
| The answer to a ResendRequest takes its turn among outgoing messages: it begins once every message numbered before it is written, and messages sent while it runs are written after it | The counterparty gets its sequence in order |
| One ResendRequest is answered at a time and 16 more may wait; another closes the session, `Too many ResendRequests waiting` | Every queue has a limit |
| A store that fails while it is read for a resend, or gives more entries than the range holds MsgSeqNums, closes the session, `Store could not be read for a resend`, with the store's own error as an `'error'` entry (and given to `onHandlerError`) before it; the rest of the range is not gap-filled. One that takes longer than `storeTimeout` to give an entry closes it with a `TimeoutError` (`waitingFor: { kind: 'store' }`), `Store read took longer than N s` | A gap fill tells the counterparty the messages are gone for good, when they may only be out of reach for a moment |
| The answer stops, with nothing more sent, when the sequences are reset while it runs (a Logon with ResetSeqNumFlag=Y either way, or `setSeqNums` moving `next` back); a ResendRequest still waiting then is not answered | The numbers it was asked for now mean other messages |
| `storeContract(name, make, { cleanup })` in `fix.js/test` defines the tests every `Store` must pass, the ones `memoryStore` and `fileStore` pass, for a store of your own | A session closes when its store breaks the contract, so a store is checked before a session meets it |

A store of your own is checked in a test file, run with `node --test`:

```ts
import { storeContract } from 'fix.js/test';
import { databaseStore } from './database-store.ts';

storeContract('databaseStore', () => databaseStore(':memory:'), { cleanup: store => store.close() });
```

`make` gives each test a store of its own, or a promise of one, with nothing
kept for the three sessions the tests use (sender `EXCHANGE`: FIX.4.4 with
targets `CLIENT` and `NOBODY`, and FIX.4.2 with target `CLIENT`). `cleanup` is optional, and is called once with what
`make` gave when its test is over, however it ended; what it gives back is
not used. A test has 10 s and fails when it takes longer, and its `cleanup`
has 10 s after it; the limit is fixed. The tests are `node:test` tests and
use `node:assert`; importing `fix.js/test` loads `node:test` and defines none
of them, and `fix.js` itself does not load `node:test`. See
`09b-store-contract.test.ts`.

### Changes

Code written against revision 9 needs these changes:

- A custom `Store` needs `sent()`: `connect()`, `listen()` and `accept()` refuse a store without it (`store must have load, append, read, sent, list and reset functions`). A store that wraps another (`{ ...memoryStore(), append }`) has it already. It must give each entry back as it was appended, its message with every value of the type it had (a time as a Date): the copy sent again is encoded from that message, and one that does not encode is gap-filled. A store that keeps text can use `entryToJSON()` and `entryFromJSON()`. `storeContract()` in `fix.js/test` checks all of it.
- To resend more than a `memoryStore` holds, use a `fileStore`, or raise `memoryStore({ history, historyBytes })`. Raising `memory.history` no longer does it.
- A message kept with a value hidden (see `redact`) is gap-filled when it is asked for again, in a live session as it already was after a restart. At the default that is a message carrying Password, NewPassword, EncryptedPassword or EncryptedNewPassword (a Logon is gap-filled anyway). A test that expects such a message to be resent must send it with `redact: false`. What decides is the stored message, not the session reading it: one with a value that is exactly `*****`, in any field at any depth, is gap-filled whatever the session's `redact` is, and one stored with its real values is resent as stored even by a session that hides them. Redaction never changes the wire.
- A `memoryStore`'s `read()` and `load()` do not show the copies sent again or their gap fills, nor a message your program sent with PossDupFlag; `session.history` and `watch()` show them as before. A session that logs on again in the same process starts its history without them.
- A resend carries the message as the store was given it, which is after outgoing routes: one a route rewrote goes again as rewritten (it used to go again as it was before the route, and through the route a second time), and one whose MsgSeqNum a route changed is found under the new number. A message a route dropped is still kept, and still resent. The copy sent again passes through the routes like any message: a route that must leave resent copies alone checks `PossDupFlag`.
- Where several messages were sent with one MsgSeqNum in an epoch (after `setSeqNums` moved `next` back, or by writing MsgSeqNum by hand), the latest is the one resent. After `setSeqNums` moves `next` back to a number other than 1, a MsgSeqNum at or past it that is not used again still has the message it carried before, and a resend sends that (it used to be gap-filled until a restart). `setSeqNums({ next: 1 })` begins a new epoch, and nothing from before it is resent.
- A message your program sends while a resend is being answered is written after the resend, however long that takes. Its promise settles then. A resend still gives its store one record at a time and waits for each (see "Memory, backpressure and failures").
- `fileStore` files are read as before. Lines written from now on name the MsgSeqNum of a sent message (`"seq"`), which an earlier version of the library ignores.

## Revision 11 changes (2026-10-07)

| Change | Why |
|---|---|
| `Store.append(id, records, context?)` takes a list of records and keeps them in order. A record with `newEpoch` begins the next epoch wherever it is in the list, and the sequence numbers of the last record are the session's. `storeContract()` covers lists | A store can keep many records with one write |
| A session has one `append()` in flight, and gives its store the records made meanwhile as one list: at most 256 records and 1 MiB of entries (a larger record alone). `storeTimeout` is the limit for one call | Waiting for a store costs a turn of the event loop or more whatever it keeps; one wait now keeps everything that gathered during the one before |
| A sent message's record is handed to the store as soon as its outgoing routes have run. The message is written once its record is kept and every message numbered before it has been written | The messages a session sends reach its store together, where each used to wait for the one before to be kept and written |
| `fileStore` keeps the current epoch's file of each session it writes open (closed at a new epoch, a reset, a failed append, and within 4 s of its last append once 2 s have passed with nothing appended) and writes a list with one write | One trip to the thread pool for a list, where a record took three |
| `fileStore(dir, { openFiles })`: how many files it keeps open to append to, 256 unless given. A session without a place among them waits for one, and sessions are given places in the order they asked | A server with more sessions written at the same time than the store has places pays an open and a close for every list of a session that had to wait: give it as many places as it has busy sessions |
| `storeContract()` also gives a store a new SessionId object for every call, appends to two sessions at the same moment, and uses two sessions that differ in version alone (a third session, FIX.4.2 `EXCHANGE` to `CLIENT`) | A store can pass tests of one session at a time and still mix sessions up under a server |
| `memory.pendingBytes`: a session stops reading once the received messages it has not processed, and the records of what it received that its store has not kept, pass it, and reads again below a quarter of it. What the session sends is not counted | A server whose store or incoming routes cannot keep up with what it is sent slows its counterparties down instead of queueing what they send |
| A new session for a counterparty begins only once the last session with it has had every record it made settled by the store: a Logon (and `connect()` with the store of a session just closed) waits for that, for `storeTimeout` at most, and is then refused as when the store cannot be loaded (`Store unavailable`; `connect()` rejects with a `TimeoutError`). A Logon still waiting when `limits.logonTimeout` ends is refused then (`Logon timed out`): at the defaults both are 10 s and the logon timeout, counted from when the connection opened, ends first. Whichever refuses it, `server.watch()` has one `'error'` entry before the refusal saying that the store has not settled the records of the last session with that counterparty and how long the Logon waited (`onHandlerError` is given a `TimeoutError`, `waitingFor: { kind: 'store' }`). The wait is kept for each store object, so an `accept()` that returns a new store object for each Logon gets none | The records a closed session had still to hand over would otherwise reach the store after the next session's, and bring the sequence numbers it holds back down: a restart would then use MsgSeqNums again |
| Each message to be written counts toward `memory.outgoingBytes` once, at the size it is written with: one an outgoing route changes counts as the route left it, each message a route makes of one counts (the one they were made of does not), and one a route drops stops counting | What a route gives is held, encoded, from when its records are handed to the store until it is written |
| `examples/13b-store-load.ts` measures what a server answers with each store | The numbers depend on the machine and the load: measure yours |

### Changes

Code written against revision 10 needs these changes:

- A custom `Store`: `append` takes a list, `append(id, records, context?)`, never empty. Keep every record of it in order, resolve once all are kept, and reject when any could not be. fix.js cannot tell a store written for one record from one written for a list (both are a function named `append`): run `storeContract()` against yours. A store that wraps another and passes what it is given on (`append: (id, records, context) => inner.append(id, records, context)`) needs no change; one that looks at the record now looks at each record of the list.
- A wrapper written in JavaScript that reads `record.entry` or `record.seqNums` of what it is given now reads them of an array: both are `undefined`, nothing is thrown, and `storeContract()` passes because the store it wraps does the keeping. TypeScript reports it; in JavaScript, look at every `append` you wrote.
- `memoryStore` and `fileStore` refuse anything but a list with a record in it, and a list with a hole or something that is not a record in it (a RangeError that says which record). Both take their own copy of the list when called.
- A store's `append` is given up to 256 records at once, and `storeTimeout` is the limit for the whole call. When it rejects, the session closes with its error (one `'error'` entry for the list) and none of the list's messages is written. A store need not undo what it had kept of a list it then rejects: the session treats none of it as kept, and one that starts again begins from the sequence numbers the store gives, so MsgSeqNums are passed over and never used twice. A `memoryStore` keeps the records before one whose entry it cannot keep; a `fileStore` keeps the whole lines of a write that failed part-way, and nothing of a list one of whose records cannot be written as a line.
- The order in which records reach a store has changed for sent messages: the records of messages queued to be sent, and of a `setSeqNums` after them, are handed over without waiting for the writes before them, so a store may see them before a message received meanwhile, and may hold the record of a message that was never written because the write of an earlier one failed. A restart resends or gap-fills such a message, as it does one kept and then not written. A route that gives several messages has all their records handed over before the first is written. The order on the wire is the order of numbering, as before.
- Reads pause far sooner (at `memory.pendingBytes`; they used to pause at half of `storeBytes`, 2 MiB). A program that counted on a session reading megabytes ahead of a slow store or a slow incoming route raises `memory.pendingBytes`. And they pause for what was received alone: the records of what a session sends, which used to count toward half of `storeBytes`, pause nothing, so a session whose own messages wait for a slow store goes on reading.
- A burst of sends in one turn now counts toward `memory.storeBytes` as well as `memory.outgoingBytes`: every message's record is handed to the store at once, where one used to wait for the message before it. A program that raised `outgoingBytes` to send more than 4 MiB at once raises `storeBytes` with it, or its session closes with `Store is not keeping up` (with a `fileStore`, or any store that waits; it used to close with `Outgoing queue over N bytes` past the same size at the defaults).
- A Logon that comes while the store still has a call of the last session with that counterparty waits for it, and is refused after `storeTimeout` (`Store unavailable`) or when `limits.logonTimeout` ends (`Logon timed out`), whichever comes first: the logon timeout at the defaults, where both are 10 s. Either way `server.watch()` has one `'error'` entry before the refusal, `The store has not settled the records of the last session with "CLIENT": a Logon has waited N s for it`, so a store call that does not return shows in the feed even when the refusal is `Logon timed out`. So is every later one until that call returns: a store whose `append` never settles keeps its counterparty out, where it used to let the next session begin and then write the old session's records over the new one's sequence numbers. `connect()` waits in the same way for a session closed a moment ago on the same store. The wait is kept for each store object: give a counterparty the same store object each time (an `accept()` that makes a new `fileStore(dir)` for each Logon gets no wait).
- A `fileStore` holds up to `openFiles` files open to append to (256 unless given): the process's limit on open files must be above that, with room for its sockets and for reads (`read()`, `sent()` and `load()` each open the file they read, and are not counted). With more sessions written at the same time than that, a session without a place waits for one, in the order sessions asked, and its list costs an open and a close besides the write: the store keeps far fewer records a second and each waits longer. Give `fileStore(dir, { openFiles })` as many as the server has busy sessions, and measure with `examples/13b-store-load.ts` (`CLIENTS`, `OPEN_FILES`). A file that cannot be opened (the process out of descriptors, say) refuses its append with the error, so that session closes, and the sessions waiting behind it go on. Because a file stays open, a session's folder that something other than the store removes or renames under it is not noticed until the file is next closed: 2 to 4 s after the last append to it, and never while the session is appended to more often than every 2 s and keeps its place. What is appended meanwhile resolves and goes to the removed file, and `load()`, `read()` and `sent()` find nothing of the session. Use `store.reset(id)` to remove a session.

## Revision 12 changes (2026-10-08)

| Change | Why |
|---|---|
| A session holds what it receives as bytes and takes messages from them only as far as it can finish them: up to `memory.pendingBytes` of messages not yet processed and kept, and the rest waits as bytes, in the order received. One message is always taken when nothing waits, so a message larger than `pendingBytes` is still processed | A read of up to 64 KiB used to be split and queued whole, whatever `pendingBytes` said: the pause only stopped the next read. A server offered more than it could answer worked through a whole read of every socket before one store write could complete, and ran out of memory |
| Between two slices of one read the event loop turns, with any store | A `memoryStore` keeps at once, so nothing ever waited for it and a burst was worked through in one go, while every other session, every timer and every store completion waited for it |
| `memory.pendingBytes` is 4 KiB unless given (it was 16 KiB) | Measured at both with this intake: at ordinary load a server answers the same. Offered more than it can answer, it takes in a quarter as much at a time and its event loop stands still about a quarter as long; with a `fileStore`, 200 sessions, two execution reports of about 150 bytes for each order and a heap of 768 MiB it lived through that at 4 KiB and ran out of memory at 16 KiB. More or larger answers need more room: see the small server below |
| `memory.inboxBytes` is the most a session may have received and not processed, bytes held and messages taken in together; past it the session closes (`Too many unprocessed incoming messages`). `memory.inbox`, the count, closes no session any more: the session takes in no more past half of it | What waits is bytes now, not messages |
| While a session holds bytes it has not taken in, or has paused reads, it sends no TestRequest, closes no counterparty for a heartbeat timeout, and does not ask again for a resend it awaits; its own Heartbeats go on. Silence, and the wait for the resend, count again from when it reads again | The counterparty's Heartbeat, its answer to a TestRequest or the resend asked for may be among what the session has not read: a server that was behind took live counterparties for dead, or asked twice more for a resend it held and then logged out |
| A received message's SendingTime is compared with the time the session read its bytes from the connection, not with the time it is processed | The time a message waits in the session, as bytes held or taken in and not yet processed, is the session's own and not the message's age. The time it waited before the session read it, in the socket's buffers, still is: see below |

### Changes

Code written against revision 11 needs no change. What behaves differently:

- `memory.pendingBytes` is 4 KiB unless given, where it was 16 KiB. A program that set it keeps what it set.
- A burst from one counterparty is processed a slice at a time, in the same order, with the program's other work between the slices. A test that pushed more than `memory.pendingBytes` at a session in one go and looked at the result without letting the event loop turn sees only the first slice.
- A burst of received messages against a slow store waits as bytes and no longer closes a session with `Store is not keeping up`: that text now means the session's own sends, or one message by itself, passed `memory.storeBytes`.
- `Too many unprocessed incoming messages` is about bytes alone (`memory.inboxBytes`). A socket stays under it as long as `inboxBytes` is above one read of the socket (up to 64 KiB) plus `pendingBytes` and one message, as the default is; set below that, one full read closes the session. A link that goes on delivering after `pause()`, or has none, reaches it whatever it is.
- A session that is behind with what it received (it holds bytes it has not taken in, or has paused reads: more than `memory.pendingBytes` received and not finished) sends no TestRequest, does not close with `Heartbeat timeout`, and does not ask again for a resend it awaits, for as long as that lasts. Below that point nothing has changed: messages that wait at an incoming route while reads are not paused are not heard until they are processed. So what ends a session whose incoming route never returns depends on how much it has received and not finished:
  - no more than `pendingBytes`: the counterparty's Heartbeats wait at the route, it is sent a TestRequest 1.2 heartbeat intervals after the last message the session processed, and the session closes with `Heartbeat timeout` one interval later. A server closes it at `limits.processingTimeout` (`No progress on received messages for N s`) when that comes first, as it does at the defaults (60 s against 66 s);
  - more than that: a server closes it at `limits.processingTimeout`. A session from `connect()` has no processing timeout, and nothing in the session ends it: it stays, with reads paused and its own Heartbeats going out, until the program closes it, the connection is lost, or its store or its outgoing queue fails. A program whose incoming route may never return gives the route a timeout of its own.
- A message is not refused for the time it waited in the session: `SendingTime is N s from our clock` measures from when the session read the message's last byte. The time it waited before that, unread in the socket's buffers while the session's reads were paused, still counts as its age: a session more than 120 s behind a counterparty that goes on sending as fast as the socket takes it logs that counterparty out with this text.
- A session that closes, or whose connection is lost, drops the bytes it holds. Messages received and not yet processed were dropped at a close before, too; a whole read may be among them now. None of them was recorded, so the counterparty is asked for them again by their MsgSeqNums when the session next logs on.

## Memory, backpressure and failures

- `session.history` keeps the newest 1,000 entries / 1 MiB (`memory.history`, `memory.historyBytes`). A `fileStore` keeps everything, and logging on reads only the end of the current epoch.
- A resend is read from the store an entry at a time and holds one message in memory whatever its range. It is not counted in `memory.outgoingBytes`; a counterparty that stops reading stalls it on the socket, and what the program sends meanwhile queues behind it and closes the session past `outgoingBytes`, as any stalled write does. A `memoryStore` keeps no message sent with PossDupFlag, so the answers do not push out its originals.
- To answer a resend near where it begins, a `fileStore` remembers at most 1,024 places in a session's current epoch file, for at most the 1,000 sessions it remembers. The first `sent()` for a session after the store is created reads the epoch through once to find them, in the session's turn, so appends to that session wait for it (a fraction of a second for 200,000 records). The places are in the latest run of messages written in MsgSeqNum order: the whole epoch, unless a MsgSeqNum stepped backward in it (`setSeqNums` moved `next` back, a message was sent with a MsgSeqNum written by hand, or the counterparty's Logon reset the sequences while messages numbered before it were still waiting to be kept, which puts them at the head of the new epoch). The lines before that run are read only for a MsgSeqNum they could hold and the run is not known to hold, in passes of 4,096 originals, holding at most 8,192 places; of them the store remembers only the lowest and highest MsgSeqNum.
- A resend waits for every record queued for the store to settle before it reads, and a store that takes longer than `storeTimeout` to give an entry closes the session (`Store read took longer than N s`).
- A resend is the one thing a session still sends a message at a time: each copy is read from the store, handed back to it as a record, kept and written before the next is read. So each copy costs a wait for the store, where ordinary sends share one. On an idle server a thousand copies take a fraction of a second; on a server that is busy with other sessions each wait is as long as the store's turn comes round, a long resend can take tens of seconds, and what that session sends meanwhile waits behind it. Past what the server can answer, a store that takes longer than `storeTimeout` to give an entry closes the session. While a server is offered more than it can answer, a ResendRequest is still answered, each message as it was, and slowly: about three messages a second for a session in one measurement, the rest once the load had ended.
- Every sequence reset begins a new epoch, and a `fileStore` writes each epoch to a file of its own that it never removes (only `reset()` removes a session, all of it). So a session reset every day keeps a file a day, and `list()` and `read()` take longer as sessions × epochs grow. For now, remove old epoch files yourself (never a session's last one).
- [`examples/13b-store-load.ts`](../examples/13b-store-load.ts) measures what a server answers with each store on your machine: `node examples/13b-store-load.ts` for a `memoryStore`, `STORE=file node examples/13b-store-load.ts` for a `fileStore`; `RATE`, `CLIENTS`, `SECONDS` and `PROFILE=baskets` change the load, `PENDING_BYTES` the server's `memory.pendingBytes`, `HISTORY` its `memory.history` (and the `memoryStore`'s), `OPEN_FILES` the store's `openFiles`, and `PORT` the port it uses. `PROFILE=overload` offers the server more than it can answer (150 messages a second from each client for 10 s, the server's heap limited to `HEAP_MB`, 768) and says, each apart, whether the server process lived (`serverLived`), whether every order got both its reports (`everyOrderAnswered`) and how many sessions closed (`sessionsClosed`, with the reasons as each side saw them); `passed` is true only when the server lived, every order was answered, no session closed and each client's reports came in the order the server made them, and the program ends with status 1 when it is not. The line also has the most heap the server used, the longest its event loop stood still, and how long the answers still owed took once the sending stopped. Stopped part-way, it ends the processes it started and removes its folder.
- Every per-session budget is counted in wire bytes. The heap holds about 5–15× the wire bytes per history entry, more inside a live session.
- `memoryStore()` keeps its own copy of up to 1,000 entries per session (`history`, `historyBytes`), separately from `session.history`. At its defaults it can hold about 1 GiB of wire bytes (1,000 sessions × 1 MiB), so roughly 5–15 GiB of heap.
- A session takes in what it receives only as far as it can finish it. What a socket delivers (up to 64 KiB at a time) is held as bytes; messages are taken from them, in order, until the pause point below is passed, and the rest waits as bytes until what was taken has been processed and kept. One message is always taken when nothing waits. Between two such slices of one read the event loop turns, so a session with a burst to work through does not keep the others, the timers or the store waiting. Reads stay paused while a session holds bytes it has not looked at.
- While a session holds bytes it has not taken in, or has paused reads, it does not count its counterparty's silence: no TestRequest is sent and no heartbeat timeout closes the session, because the Heartbeat it would be waiting for may be among what it has not read. Its own Heartbeats go on. Once it reads again, a counterparty that stays silent is asked after 1.2 heartbeat intervals and given up one interval later, as ever.
  - The same holds for a resend the session awaits: while it is behind it does not ask again, because the answer may be among what it has not read. The requests already made still count. A counterparty that never answers is asked again one heartbeat interval after the session has caught up and once more an interval later, and is logged out an interval after that (`Resend from N still incomplete after 3 requests`). One that never answers and keeps the session behind, by sending faster than the session finishes what it sends, is neither asked again nor given up for as long as it does; what the session holds for it stays within `memory.pendingBytes` and `memory.inboxBytes`, as for any counterparty.
  - A message's SendingTime is compared with the time the session read its last byte from the connection, not with the time it is processed: the time a message waits in the session, as bytes held or taken in and not yet processed, is not counted as its age.
    - What this covers is the bytes the session holds. With reads paused that is about one read of the socket (up to 64 KiB). Whatever else the counterparty has sent waits unread in the socket buffers of the two machines (megabytes, where the system lets them grow) and is noted as arrived when the session reads it, so that wait does count as its age.
    - So a session that falls more than 120 s behind (the most a SendingTime may be from the session's clock) a counterparty that goes on sending as fast as the socket takes it, each message stamped as it is written, still logs that counterparty out, with `SendingTime is N s from our clock`. In one measurement (one counterparty, a store that took 150 ms a list) that came 194 s into the load.
    - A session keeps one time of arrival for each second in which bytes it still holds arrived, and 128 at most, however much it holds and however slowly it came: past 128, the two times closest together become one, the later. A message is never judged as arrived before its last byte did. It is judged to the second while the bytes held arrived in 128 different seconds or fewer, and otherwise up to a sixtieth of the time across which they arrived later than it did, and never later than the moment it is processed.
  - All of this begins at the pause point, not below it. Messages that wait at an incoming route while reads are not paused (no more than `memory.pendingBytes` received and not finished) are not heard until they are processed: a route that holds a few small messages for longer than 2.2 heartbeat intervals ends the session with `Heartbeat timeout`. Past the pause point a server ends a session whose received messages make no progress at `limits.processingTimeout`; a session from `connect()` has no processing timeout, and one whose incoming route never returns is then not ended by anything in the session.
  - Bytes held count whatever they turn out to be: a counterparty that floods garbled frames faster than the session finishes them is kept for as long as it does, as one that floods Heartbeats is. Garbled frames a session keeps up with are silence, as ever.
- The bytes a session holds are kept in a few buffers, not one for each chunk received: what is held costs about what it weighs however small the chunks (the buffers have room for at most twice the bytes), also for the beginning of one large message that arrives a byte at a time.
- Reads pause, and resume once everything is below a quarter, when:
  - what the session has received and not finished passes `memory.pendingBytes` (4 KiB), or half of `memory.storeBytes` when that is less: received messages not yet processed, plus the records of what was received (messages, and the problems found in them) that the store has not yet kept. This is the one that comes first at the defaults. Only what was received is counted, because only that falls while reads are paused. The records of what the session sends pause nothing, so a program whose own messages wait for a slow store goes on reading (and goes on hearing its counterparty's Heartbeats): they are bounded by `memory.storeBytes`, past which the session is closed (`Store is not keeping up`), and by `memory.outgoingBytes`. Nor is what waits to be written to the network counted, so a session never stops reading because its counterparty has; or
  - received messages not yet processed pass half of `memory.inbox` / `inboxBytes`.
- So a server whose store, or whose incoming routes, cannot keep up with what it is sent slows its counterparties down: each session stops reading and its counterparty's writes wait. What that bounds, and what it does not:
  - `pendingBytes` bounds what a session takes in ahead of its store and its incoming routes: for what it has received, a session holds about `pendingBytes` taken in, one message past it, and one read of the socket (64 KiB) as bytes. What Node and the operating system keep for a paused socket is beside that. The answers on their way out are bounded separately, below.
  - A counterparty that sends requests and does not read the answers has them queued up to `memory.outgoingBytes` (4 MiB), and is closed only past it: nothing closes a session that stays just under. Lower `outgoingBytes` on a server that many strangers can reach.
  - Messages your own handlers are still working on are not counted: handlers are not waited for. A server whose handlers are the slow part takes in everything it is sent.
  - A `memoryStore` keeps at once, so no session waits for it. `pendingBytes` is then how much of one counterparty's burst a server works through before the event loop turns: a server short of processor time, not of its store, serves its sessions a slice each in turn, and each counterparty's socket stays paused until its bytes are taken in.
  - For received work a server holds at most about sessions × (`pendingBytes` + one read of 64 KiB + one message), and `limits.maxSessions` bounds the sessions. There is no other bound across sessions: beside that, each session can hold its history and inbox, and up to `storeBytes` of records and `outgoingBytes` of messages on their way out (and the heap holds several times the wire bytes).
  - `storeBytes`, `outgoingBytes` and `inboxBytes` are the points where a session is closed. `memory.inbox`, the count, closes none.
- A small server (a couple of processors, a heap under a gigabyte) with many sessions:
  - What a session keeps is the largest fixed cost, and it is paid for each session: its history (`memory.history` / `historyBytes`, 1,000 entries / 1 MiB at the defaults) and its inbox (`memory.inbox` / `inboxBytes`, the last 1,000 received messages / 1 MiB, kept for `next()` and `messages()` whether or not the program calls them), each several times its wire bytes in memory. Measured on one machine with sessions exchanging orders and execution reports of about 150 bytes, once both were full and with nothing waiting, each session cost about 3 MiB of heap (about 2 MiB for the history, about 1 MiB for an inbox of 1,000 orders; less when much of what is received is small session messages) and about 1.3 MiB of buffers, which are outside the heap. 200 such sessions: about 630 MiB of heap and 250 MiB of buffers. With `memory.history` 250: about 1.9 MiB of heap and 0.3 MiB of buffers a session; with `memory.inbox` 100: about 2.1 MiB of heap. The figures are approximate and grow with the size of the messages: measure yours.
  - Nothing but `limits.maxSessions` bounds, across sessions, what sessions keep: sessions × that figure must fit in Node's heap (`--max-old-space-size`) with room beside it for the work in progress, and the default `maxSessions`, 1,000, is about 3 GiB of heap at the other defaults, more than a small server has. Measured with a heap of 768 MiB, at the defaults and an ordinary load of orders and TestRequests in equal number (no overload at all): 250 sessions fit and 300 do not; with `memory.history` between 250 and 500, or `memory.inbox` 100, 300 and 400 sessions fit. Choose `maxSessions`, `history` and `inbox` together so that the product fits, or give Node a larger heap. A `memoryStore` holds the same entries as the histories of the sessions that are open (about 2% more heap in that measurement) and goes on holding them once a session has closed: give it the same limits (`memoryStore({ history, historyBytes })`).
  - What it is offered beyond what it can answer waits with its counterparties, whose sockets it pauses: for received work it holds what the bound above says and no more, and its answers take longer. What it sends in answer to a slice still waits for its store and its sockets, for every session at once, so leave the heap room for that beside what the sessions keep. Measured with 200 sessions offered two and a half times what the server answers, every order answered with two execution reports of about 150 bytes, a `fileStore` and a heap of 768 MiB: the server lived through it at the default `memory.pendingBytes` and ran out of memory with 16 KiB; with `memory.history` 250 it lived through both.
  - That measurement has a limit. What a session takes in for a slice is bounded; the answers to a slice are not, and grow with how many messages answer each one and how large they are. With four or eight reports for an order, the same `fileStore` server ran out of memory again at the default history; with messages of about 1.2 KB both stores did, as they do with no overload, for what the sessions keep alone. A server that answers with more or larger messages needs a smaller history, or a smaller `memory.pendingBytes` (1 KiB lived through it at four reports an order; `memory.history` 250 at eight).
  - Nothing bounds, across sessions, the answers waiting to be written. Each session may hold up to `memory.storeBytes` of records and `memory.outgoingBytes` of messages (4 MiB each at the defaults) before it is closed, so 200 sessions may hold 1.6 GiB of wire bytes between them with none closed. Taking in a slice at a time slows that down for answers sent from a handler, and does not bound it: answers a program sends later, or to counterparties that read slowly, are not paced by what is taken in. On a small server lower `outgoingBytes` and `storeBytes` until sessions × both fits beside what the sessions keep.
  - Give `fileStore(dir, { openFiles })` at least as many places as there are sessions written at the same time, the quiet ones that only heartbeat included: a session without a place pays an open and a close for each list, and its Heartbeats wait in the queue for one.
  - A `fileStore` costs more processor time than a `memoryStore`: about 40% more for the whole process at the same load (measured at 9,000 execution reports a second on two processors), about half of it on the event loop's thread and half in Node's thread pool. The fewer processors a server has, the more of that comes out of what it answers.
  - The size of Node's thread pool is not a knob for this: `UV_THREADPOOL_SIZE` 1, 2, 4 or 8 measured the same.
  - `PROFILE=overload node examples/13b-store-load.ts` (and `STORE=file`) shows what yours does when it is offered more than it can answer.
- The store is given a sent message before it is written to the network; history and `watch()` show it once it has been written. So their order can differ: a message received while a send is being written can come before it in history and after it in the store. A sent message's record is handed to the store as soon as its outgoing routes have run, without waiting for the message before it to be kept or written: the store backlog (`memory.storeBytes`) holds the records of sent messages waiting to be kept, and each message to be written counts toward `memory.outgoingBytes` once, from when it is sent until it is written, at the size it is written with (what an outgoing route made of it, when one changed it; nothing, once one has dropped it). A burst of sends in one turn therefore needs room in both: raise `storeBytes` and `outgoingBytes` together to send more than 4 MiB at once. Messages are written in the order they were numbered, each once its record is kept.
- A sent message's record waits behind the records already in the store backlog, received messages included, and goes to the store in the next list with them. Reads pause at `memory.pendingBytes`, which bounds how much received work can be ahead of it. `storeTimeout` ('10s') catches a store that stops: one write taking longer closes the session with `Store write took longer than N s`. It is checked on a once-a-second tick, so it can fire up to 1 s late.
- `memory.inboxBytes` is also the most a session may have received and not processed, the bytes it holds and the messages it has taken in together: past it the session closes. A socket is paused as soon as bytes are held, so a session on one holds one read of it (up to 64 KiB) beside what it has taken in (`pendingBytes` and one message): keep `inboxBytes` above the three together, as the default is, or one full read closes the session. A link that goes on delivering after `pause()`, or has none, reaches it whatever it is. `memory.inbox` / `inboxBytes` are also how far a `messages()` iterator may fall behind (past that it throws once, then ends).
- Past a budget the session closes with one of these texts: `Too many unprocessed incoming messages`, `Store is not keeping up`, `Outgoing queue over N bytes: …`, `Too many ResendRequests waiting`. A server session whose received messages make no progress for `limits.processingTimeout` closes with `No progress on received messages for N s`, sent first as a Logout once it is logged on.
- `connect({ manual: true })` resolves as soon as TCP connects.
- A server closes connections past `limits.connectionsPerAddress` (10) or `limits.pendingLogons` (100) at once, refuses a Logon past `limits.maxSessions` (1,000) with a Logout, and closes a session whose received messages make no progress for `limits.processingTimeout` ('60s'). Each refusal is a `rejected` entry in `server.watch()`, with problem code:
  - `ConnectionLimit` for these limits;
  - `LogonRefused` for a Logon the server won't take (an unsupported BeginString, a TargetCompID that isn't ours, a HeartBtInt outside the allowed range, a counterparty already logged on, `accept()` refusing it, or the server shutting down);
  - `LogonTimeout` when no Logon completes within `limits.logonTimeout`: a Logon still waiting for `accept()` or the store is refused with a Logout, `Logon timed out` (after an `'error'` entry naming the store, when it was waiting for the store to settle the last session with its counterparty); on a TLS listener, a handshake not done by then is `No TLS handshake within N s`;
  - `MessageTooLarge` for more than `limits.maxMessageSize` bytes without a Logon;
  - `TLSMismatch` for a TLS handshake on a listener without `tls` (`TLS on the plain port: this port does not use TLS`), and on a listener with `tls`, for bytes that aren't TLS (`No TLS on the TLS port: this port uses TLS`) or a handshake that fails (`TLS handshake failed: …`, OpenSSL's reason). A client that refuses our certificate does so after our side of the handshake is done, so `watch()` shows only `opened` then `closed`.
- For a server open to the internet, set `tls: { minVersion: 'TLSv1.3', … }`. `connect({ tls: true })` checks the server's certificate against Node's default CAs (its bundled list plus the system's and `NODE_EXTRA_CA_CERTS`).
- `listen()` and `connect()` check their options up front: a key they don't know, or a value of the wrong kind (`heartbeat: 30` where `{ min, max }` is meant, `store: 42`), is a RangeError, before anything is opened.
- `server.close()` refuses any Logon from the moment it's called (`Server shutting down`), and resolves once every connection has closed.
  - `connectionsPerAddress` counts logged-on sessions too: raise it when many counterparties share an address (a gateway, NAT, or a test harness running many clients). It counts each exact address: every IPv6 address has its own count, so one /64 network gets many. `pendingLogons` is the backstop across all addresses.
  - `pendingLogons` is one cap for all addresses, and silent connections hold their places until `logonTimeout`: a shorter `logonTimeout` makes holding them costlier.
  - processingTimeout counts only received messages being processed (and store writes, while reads are paused for the store). Our own outgoing messages are not progress, and a handler holding a message (an order waiting for a person) doesn't hold anything up. It is checked on a once-a-second tick, so it can fire up to 1 s late.

## Open questions

1. **Handler concurrency.** Proposed: handlers run independently per message, so a slow fill loop doesn't block a cancel.
2. **Per-version types.** With codegen, `version` can select that version's message types.
3. **Prices as numbers.** Friendly but binary floats; exact text is always available via numeric tags.
4. **Default timeouts.** 5s for `next` and `until`, unless given.
