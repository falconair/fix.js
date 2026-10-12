# How fix.js is built

fix.js is a FIX library for tools: test harnesses, monitors, simulators and the
like. It aims to be easy to use correctly and hard to knock over, not to be
fast. This page is the map; the API itself is described in
[`../api/README.md`](../api/README.md).

## Layers

Each layer uses only the ones above it in this list.

| Layer | Folder | What it does |
|---|---|---|
| Dictionary | `src/dictionary` | The fields, messages and groups of each FIX version, and the constants for enum values (`Side.Buy`). Generated from the FIX Orchestra files in `dictionaries/orchestra` by `npm run generate`. `defineDictionary()` adds a firm's own fields. A BeginString names one dictionary (see "FIX versions" below). |
| Wire | `src/wire` | Bytes to messages and back: splitting a stream into frames, BodyLength and CheckSum, and turning tag=value pairs into an object with FIX names. It reports what is wrong with a message as data (a list of problems) and leaves the decision to the session. Exported as `fix.js/wire`. |
| Session engine | `src/session` | The FIX session protocol as one pure function, `step(state, config, event, now)`, which returns the new state and a list of actions (send this, deliver that, ask for a resend, disconnect). It never touches a socket, a timer, the clock or a store, so every rule of the protocol can be tested without any of them. |
| Transport | `src/transport` | Everything the engine does not touch: `connect()` and `listen()`, sockets and TLS, the timer that feeds the engine its ticks, the stores, the history and the feeds a program watches, and the limits a server puts on each counterparty. It carries out the engine's actions. |

`src/index.ts` is the package's front door. `api/` holds the API as TypeScript
declarations, written before the code; `npm run check:api` checks the
implementation against them and type-checks the programs in `examples/`.

## FIX versions

FIX 4.2 and FIX 4.4 each have one Orchestra file, and one dictionary for the
session layer and the application layer together. Where an Orchestra file is
wrong about a field's datatype, the generator corrects it from a small table,
`scripts/corrections.ts`, which has one entry: in FIX 4.2, IOIShares takes a
quantity beside S, M and L, and the file lists only S, M and L. A correction
that no longer fits its file, or whose version is none of the files read,
stops the generator.

FIX 5.0 and later travel over FIXT.1.1, a session layer of its own, and the
Logon says which application version the session carries (DefaultApplVerID).
Two Orchestra files are put together when the dictionaries are generated: the
header, the trailer and the session messages come from the FIXT.1.1 file, and
every other message from FIX Latest, which is FIX 5.0 SP2 with every extension
pack since. So BeginString `FIXT.1.1` names one dictionary too, and everything
that chooses a dictionary by BeginString (the wire layer, a session, a store,
`entryFromJSON()`) needs to know nothing more. fix.js reads the application
versions FIX50, FIX50SP1, FIX50SP2 and FIXLatest with that one dictionary, and
refuses any other.

That dictionary is large (6,203 fields, 181 messages), so its tables are a JSON
file (`src/dictionary/fix50sp2.data.json`) read the first time a FIXT.1.1
session, store or entry needs them: a program that speaks only FIX 4 never
loads them. The FIXT.1.1 session layer on its own (`fixt11.data.ts`: its
header, trailer and eight session messages) is small and always loaded; a
server reads a Logon with it, and writes the Logout that refuses one, so a
connection that is refused costs no more. It still names every message type
where a Logon lists the application messages its sender sends (RefMsgType).
The constants of FIX Latest have an entry of their own, `fix.js/fix50sp2`, for
the same reason; the root's are FIX 4.4's.

## How a message travels

**Received:** bytes from the socket are held by the session and split into
frames only as far as the session can finish them (see "A session takes in
only what it can finish" below); a frame is decoded with the session's
dictionary into a message and a list of problems; the engine is given both and
decides (deliver it, reject it, ask for a resend, log out); the transport
records what happened, then runs the program's handlers.

**Sent:** the program's fields go to the engine, which numbers the message; the
transport encodes it and gives it its place in the order of outgoing messages.
In that order, each message's outgoing routes run and what they give is handed
to the store as a record; and in that order each is written to the socket,
once the store has kept its record and every message numbered before it has
been written. A record does not wait for the message before it to be written;
only the write does.

**Kept:** a session has one `append()` to its store in flight. The records made
meanwhile, of messages received and sent and of problems and errors, wait in
order and go in the next call as one list, at most 256 records and 1 MiB of
entries. So one wait for the store keeps everything that gathered during the
one before. A `fileStore` writes a list with one write, to a file it keeps
open, for as many sessions as it has places (`openFiles`). A session without
a place is handed one in the order sessions asked: a place that comes free is
never left for whichever session looks first.

**Resent:** the engine reads a ResendRequest and says which MsgSeqNums to send
again; the transport waits until every record queued for the store has
settled, asks the store for the messages it sent with those numbers
(`sent()`), one at a time, and sends each again as a possible duplicate, or a
gap fill for what must not go again (a session message, a message kept with a
value hidden) and for what the store does not have. Each goes the way of any
sent message: routes, store, socket. The answer takes one place in the order
of outgoing messages, so it begins after every message numbered before it has
been written, and what is sent later waits for it. Each copy is kept and
written before the next is read: a resend holds one message in memory
whatever its range, and pays one wait for the store a copy, where ordinary
sends share a wait, so on a busy server a long resend is slow.

## Rules the code keeps

- **No runtime dependencies.** Node 24 or later runs the TypeScript source as it
  is; there is no build step.
- **Nothing that arrives from the network may crash the process.** A malformed
  message is a problem to report, never an exception to throw. An error in a
  program's own handler is recorded in the session's history and the session
  carries on.
- **Every buffer has a limit**, by count and by bytes: partial frames, queued
  messages, history, what a store loads, and the files a store keeps open. Past
  a limit, the oldest history is dropped or the session is ended with a reason;
  nothing grows without end.
- **A session stops reading before it queues.** Once the received messages it
  has not processed, and the records of what it received that its store has
  not kept, pass a small amount (`memory.pendingBytes`, or half of
  `memory.storeBytes` when that is less), it reads no more until they are
  below a quarter of it. A server whose store or incoming routes cannot keep
  up slows its counterparties down. Only what was received is counted, because
  only a count that falls while reads are paused may pause them: with reads
  paused nothing more is received, so the amount can only fall and reads
  always resume. The records of what the session sends pause nothing, however
  many wait for the store: they are bounded by `memory.storeBytes`, past which
  the session closes, and by `memory.outgoingBytes`. So a session whose own
  messages wait for a slow store still hears its counterparty's Heartbeats.
  This does not bound what waits to be written to a counterparty that does
  not read (`memory.outgoingBytes` does, by closing the session), nor work
  inside a program's handlers.
- **A session takes in only what it can finish.** What a socket delivers is
  held as bytes. Messages are split off them and handed on, in the order
  received, only until the amount above is passed; the rest stays as bytes
  until what was taken is processed and kept, and reads stay paused while
  bytes are held that have not been looked at. One message is always taken
  when nothing waits, whatever its size. After a slice the session takes no
  more until the event loop has turned (`setImmediate`: this is scheduling,
  not time, so not the session's clock), though a store that keeps at once
  has left nothing waiting: store completions, timers and the other sessions
  run between two slices of one read. The beginning of a message, with its
  end still to come, holds nothing back: a pause for it would keep its own
  end away. So for received work a server holds at most about
  sessions x (`memory.pendingBytes` + one socket read + one message), the
  server limits its sessions, and there is no other limit across sessions.
  The bytes held and the messages not yet processed may not pass
  `memory.inboxBytes` between them. A socket is paused as soon as bytes are
  held, so it stays under that when `inboxBytes` is above one read plus what
  is taken in, as the default is (a smaller one is passed by one full read);
  a link that goes on delivering after it was told to pause closes the
  session there. The bytes held are kept in a few buffers, not one for each
  chunk: a chunk smaller than what is held goes into the room left in the
  last buffer, or into a new one with room for as much as is held (64 KiB at
  most), so what is held costs at most about twice what it weighs however
  small the chunks, and each byte is copied once when it is added and once
  more when its message is whole. Bytes held at a close are dropped, as
  messages not yet processed are.
  What each session keeps, not this, is the largest fixed cost of a server
  with many sessions: its history and its inbox, several times their wire
  bytes in memory (about 3 MiB of heap and 1.3 MiB of buffers a session,
  measured with messages of about 150 bytes), bounded across sessions by
  `limits.maxSessions` alone. The answers to a slice grow with how many
  messages answer each one and how large they are, and nothing bounds across
  sessions the answers waiting to be written: `api/README.md` says what to
  set on a small server.
- **One session for an id hands records to a store at a time.** A session
  that closes may still have records for its store. The next session for the
  same id on that store is not loaded until they have settled, so the store's
  sequence numbers never go back to an older session's; a Logon that has
  waited `storeTimeout` for that, or is still waiting when the time its
  connection has to log on ends, is refused. The wait is kept for each store
  object, so a counterparty is given the same object each time.
- **A session that is behind does not take that for its counterparty's
  silence.** While it holds bytes it has not taken in, or has paused reads,
  the engine is told at each tick that the counterparty was heard: no
  TestRequest is sent for silence, a TestRequest still unanswered is
  forgotten, and a resend that is awaited is not asked for again (the
  requests already made still count), because the Heartbeat or the resend
  that would answer may be among what is unread. A counterparty with nothing
  held and reads not paused is judged as ever, and so is every counterparty
  once the session reads again. The session's own Heartbeats, and its own
  timeouts (a store write, no progress on received messages), are not held
  back by this.
  This begins at the pause point and not below it: messages that wait at an
  incoming route while reads are not paused are not heard until they are
  processed, so a route that holds a few small messages ends the session with
  `Heartbeat timeout` as it always did. Past the pause point a server ends a
  session whose received messages make no progress at its processing
  timeout; a session from `connect()` has none, and one whose incoming route
  never returns is then not ended by anything in the session.
  Bytes held count whatever they turn out to be: a counterparty that floods
  garbled frames faster than the session finishes them is kept while it does,
  as one that floods Heartbeats is, and what the session holds for it stays
  within the same bounds; garbled frames a session keeps up with are silence.
  It is the same for a resend that is awaited: a counterparty that never
  answers the ResendRequest, and keeps the session behind by sending faster
  than the session finishes, is neither asked again nor given up for as long
  as it does, within the same bounds; once the session has caught up it is
  asked again and given up as any counterparty that does not answer is.
- **A message's age is judged when the session read its bytes, not when it
  is processed.** The session notes when the bytes it holds reached it from
  its link and gives the engine, with each message, the time its last byte
  did; the engine compares SendingTime with that and stays a function of its
  arguments. The time a message then waits in the session, as bytes held or
  taken in and not yet processed, is not counted as its age.
  One time is kept for each second of the clock in which bytes still held
  arrived, and 128 at most for a session, however much it holds and however
  slowly it came: when one more would be kept, the two neighbours whose bytes
  arrived closest together share the later one's time. So a message is never
  judged as arrived before its last byte did, nor after the moment it is
  processed; it is judged to the second while the bytes held arrived in 128
  different seconds or fewer, and otherwise up to a sixtieth of the time
  across which they arrived later than it did (two seconds for a session two
  minutes behind). Taking a message in drops the times no longer needed
  together, at a cost that does not grow with how long its bytes took to come.
  This covers the bytes the session holds and nothing before them. A session
  that has paused reads holds about one read of its socket (up to 64 KiB);
  whatever else the counterparty has sent waits in the socket buffers of the
  two machines, megabytes where the system lets them grow, and is noted as
  arrived when the session reads it. That wait counts as the message's age.
  So a session that falls more than `maxClockSkew` (120 s) behind a
  counterparty that goes on writing as fast as the socket takes it, each
  message stamped as it is written, still ends by logging that counterparty
  out, with `SendingTime is N s from our clock`: in one measurement, on one
  machine, 194 s into such a load against a store that took 150 ms a list.
- **A session never stops reading because it cannot write.** What waits to be
  written counts toward the limit that closes a session, never toward the one
  that pauses its reads: two sessions that each waited for the other to read
  would wait for ever.
- **A server sets nothing up for a session until its Logon has been accepted**,
  and holds each counterparty to limits (sessions, connections per address,
  pending logons, message size, time to log on).
- **Credentials are hidden in everything recorded**: Password, NewPassword,
  EncryptedPassword and EncryptedNewPassword always, RawData in a Logon. The
  wire is not changed.
- **Time comes from a clock that is passed in**, so tests use a fake one
  (`fakeClock` in `fix.js/test`). Timeouts are checked once a second.
- **A sent message is stored before it is written**, so a restarted session can
  always resend what the other side may have seen. It is written only once the
  `append()` that carried its record has resolved; a list that fails writes
  none of its messages. "Stored" is what the store says it is: a `fileStore`
  resolves once the operating system has the bytes, and does not wait for the
  disk.
- **A resend is read from the store**, an entry at a time, and from nowhere
  else: the same before and after a restart, and never from before a sequence
  reset. A session's history in memory is for the program to look at; nothing
  the session does depends on it. A message kept with a value hidden is never
  sent again. While a server is offered more than it can answer a resend is
  answered correctly and slowly (about three messages a second for a session
  in one measurement).
- **A CompID is never used as a file name as it arrived.** A store names a
  session's folder from the CompIDs only when they are made of safe characters,
  and always adds a hash.
- **The texts fix.js writes are plain ASCII, and say why.** A refused connection
  gets a Logout with a reason where another engine would only close.

## Tests

- `npm test` runs the unit tests, which sit beside the code they test
  (`*.test.ts`), with Node's own test runner.
- What a store must do is written as tests any store can be put through,
  `storeContract()` in `fix.js/test`. The library's own stores run them from
  that entry, so the tests a program is given are the ones the library passes.
  It is the one part of the package that loads Node's test runner, and only
  `fix.js/test` loads it.
- `npm run check:api` checks the implementation against the declared API.
- `npm run test:interop` runs fix.js against another FIX engine, QuickFIX/J,
  in FIX 4.2, FIX 4.4 and FIXT.1.1 carrying FIX 5.0 SP2: see
  [`../interop/README.md`](../interop/README.md), which also lists every place
  where fix.js behaves differently on purpose, and why.
