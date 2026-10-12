/**
 * Compiled by `npm run check:api`, never executed: proves the implementation
 * (src/) matches this spec for everything implemented so far. Each Later*
 * list names what isn't implemented yet; shrink it when that lands.
 *
 * TypeScript can list a module's values (`keyof typeof`) but not its types, so
 * the type exports are named in TypeExports and TestTypeExports below, and
 * scripts/check-exports.ts (also run by `npm run check:api`) checks those lists
 * against what src/index.ts, src/test.ts and the spec actually export.
 */
import type * as Spec from './index';
import type * as SpecTest from './test';
import type * as Impl from '../src/index.ts';
import type * as ImplTest from '../src/test.ts';
import type * as SpecFix50sp2 from './fix50sp2';
import type * as ImplFix50sp2 from '../src/fix50sp2.ts';
import type * as Generated from '../src/dictionary/fix44.ts';
import type { MessageObject } from '../src/wire/message.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
/** Every A is a valid B. */
type Fits<A, B> = [A] extends [B] ? true : false;
/** Names in A missing from B. */
type Missing<A, B> = Exclude<keyof A, keyof B>;
type Both<A extends boolean, B extends boolean> = [A, B] extends [true, true] ? true : false;
type Fn = (...args: never[]) => unknown;
/** Argument N of a spec function and its implementation: each accepts exactly what the other does. */
type SameArg<S extends Fn, I extends Fn, N extends number> = Both<Fits<Parameters<S>[N], Parameters<I>[N]>, Fits<Parameters<I>[N], Parameters<S>[N]>>;
/** The same number of arguments, with the same ones optional. */
type SameArity<S extends Fn, I extends Fn> = Equal<Parameters<S>['length'], Parameters<I>['length']>;

// ─── Exports ────────────────────────────────────────────────────────────────

/** Orders: not implemented yet. */
type LaterExports = 'OrderRejectedError' | 'CancelRejectedError';
type _specExportsExist = Assert<Equal<Exclude<Missing<typeof Spec, typeof Impl>, LaterExports>, never>>;
/** Nothing is exported that the spec doesn't describe (the generated FIX 4.4 constants stand for the spec's dictionary). */
type _noUndocumentedExports = Assert<Equal<Exclude<Missing<typeof Impl, typeof Spec>, keyof typeof Generated>, never>>;
/** fix.js/test: expectNone and within come with the test helpers. */
type _testExports = Assert<Equal<Exclude<Missing<typeof SpecTest, typeof ImplTest>, 'expectNone' | 'within'>, never>>;
type _noUndocumentedTestExports = Assert<Equal<Missing<typeof ImplTest, typeof SpecTest>, never>>;
/**
 * fix.js/fix50sp2: the spec's file is a stand-in that names a few of the generated constants. Each
 * one it names is exported, with every value the stand-in lists for it.
 */
type _fix50sp2Exports = Assert<Equal<Missing<typeof SpecFix50sp2, typeof ImplFix50sp2>, never>>;
type _fix50sp2Values = Assert<Fits<Pick<typeof ImplFix50sp2, keyof typeof SpecFix50sp2 & keyof typeof ImplFix50sp2>, typeof SpecFix50sp2>>;
/** The message shapes the stand-in declares are the generated ones, as far as it goes: a value of the spec's type is a value of the generated type, and what it requires is what the generated type requires. */
type _fix50sp2Shapes = Assert<Both<Fits<SpecFix50sp2.Messages['NewOrderSingle'], ImplFix50sp2.Messages['NewOrderSingle']>, Fits<SpecFix50sp2.Messages['ExecutionAck'], ImplFix50sp2.Messages['ExecutionAck']>>>;
type _fix50sp2Group = Assert<Fits<SpecFix50sp2.RateSourceGroup, ImplFix50sp2.RateSourceGroup>>;
type _fix50sp2Required = Assert<Both<
  Equal<RequiredKeys<SpecFix50sp2.Messages['NewOrderSingle']>, RequiredKeys<ImplFix50sp2.Messages['NewOrderSingle']>>,
  Equal<RequiredKeys<SpecFix50sp2.Messages['ExecutionAck']>, RequiredKeys<ImplFix50sp2.Messages['ExecutionAck']>>>>;
type _fix50sp2Names = Assert<Fits<SpecFix50sp2.MsgTypeName, ImplFix50sp2.MsgTypeName>>;

// ─── Type exports ───────────────────────────────────────────────────────────
// Every type src/index.ts exports by name, as [spec, implementation]: naming
// both makes each one an error if either side stops exporting it.
// scripts/check-exports.ts checks that this list is exactly src/index.ts's
// named type exports, and that every type the spec exports by name is here or
// in LaterTypes.

type TypeExports = {
  AcceptOptions: [Spec.AcceptOptions, Impl.AcceptOptions];
  AutoFilledBodyField: [Spec.AutoFilledBodyField, Impl.AutoFilledBodyField];
  Clock: [Spec.Clock, Impl.Clock];
  CloseReason: [Spec.CloseReason, Impl.CloseReason];
  ConnectionEntry: [Spec.ConnectionEntry, Impl.ConnectionEntry];
  ConnectOptions: [Spec.ConnectOptions, Impl.ConnectOptions];
  CustomFields: [Spec.CustomFields<{}, 'Logon'>, Impl.CustomFields<{}, 'Logon'>];
  Dictionary: [Spec.Dictionary, Impl.Dictionary];
  DictionaryDef: [Spec.DictionaryDef, Impl.DictionaryDef];
  Duration: [Spec.Duration, Impl.Duration];
  Entry: [Spec.Entry, Impl.Entry];
  EntryJSON: [Spec.EntryJSON, Impl.EntryJSON];
  ErrorEntry: [Spec.ErrorEntry, Impl.ErrorEntry];
  FieldDef: [Spec.FieldDef, Impl.FieldDef];
  FileStoreOptions: [Spec.FileStoreOptions, Impl.FileStoreOptions];
  Fields: [Spec.Fields<'Logon'>, Impl.Fields<'Logon'>];
  ListenOptions: [Spec.ListenOptions, Impl.ListenOptions];
  LogonIds: [Spec.LogonIds, Impl.LogonIds];
  MemoryOptions: [Spec.MemoryOptions, Impl.MemoryOptions];
  MemoryStoreOptions: [Spec.MemoryStoreOptions, Impl.MemoryStoreOptions];
  Message: [Spec.Message, Impl.Message];
  Peer: [Spec.Peer, Impl.Peer];
  Problem: [Spec.Problem, Impl.Problem];
  RawTags: [Spec.RawTags, Impl.RawTags];
  Remove: [Spec.Remove, Impl.Remove];
  RouteFn: [Spec.RouteFn, Impl.RouteFn];
  Server: [Spec.Server, Impl.Server];
  Session: [Spec.Session, Impl.Session];
  SessionId: [Spec.SessionId, Impl.SessionId];
  Store: [Spec.Store, Impl.Store];
  StoreContext: [Spec.StoreContext, Impl.StoreContext];
  StoredEpoch: [Spec.StoredEpoch, Impl.StoredEpoch];
  StoredSession: [Spec.StoredSession, Impl.StoredSession];
  StoreReadOptions: [Spec.StoreReadOptions, Impl.StoreReadOptions];
  StoreRecord: [Spec.StoreRecord, Impl.StoreRecord];
  WaitingFor: [Spec.WaitingFor, Impl.WaitingFor];
};
/** Spec types not implemented yet: typed messages and orders, and faults. */
type LaterTypes = 'AppMessage' | 'Where' | 'Incoming' | 'IncomingOrder' | 'IncomingCancel' | 'IncomingReplace' | 'OutgoingOrder' | 'OrderState' | 'Fault';
type TestTypeExports = {
  CloseReason: [SpecTest.CloseReason, ImplTest.CloseReason];
  FakeClock: [SpecTest.FakeClock, ImplTest.FakeClock];
};

/** The same declaration on both sides. */
type _sameTypes = Assert<Equal<
  | Equal<Spec.Peer, Impl.Peer> | Equal<Spec.Duration, Impl.Duration> | Equal<Spec.Remove, Impl.Remove>
  | Equal<Spec.Clock, Impl.Clock> | Equal<Spec.WaitingFor, Impl.WaitingFor> | Equal<Spec.MemoryStoreOptions, Impl.MemoryStoreOptions>
  | Equal<Spec.FieldDef, Impl.FieldDef> | Equal<Spec.RawTags, Impl.RawTags> | Equal<Spec.ErrorEntry, Impl.ErrorEntry>
  | Equal<Spec.LogonIds, Impl.LogonIds> | Equal<Spec.StoreReadOptions, Impl.StoreReadOptions> | Equal<Spec.StoredEpoch, Impl.StoredEpoch>
  | Equal<SpecTest.FakeClock, ImplTest.FakeClock>,
  true>>;
/**
 * storeContract(): a name, a function that gives each side's own Store or a promise of it, and
 * options with `cleanup` alone, which is given the store `make` gave; nothing back.
 */
type SpecStoreContract = typeof SpecTest.storeContract<Spec.Store>;
type ImplStoreContract = typeof ImplTest.storeContract<Impl.Store>;
type _storeContract = Assert<Both<
  Both<SameArity<SpecStoreContract, ImplStoreContract>, SameArg<SpecStoreContract, ImplStoreContract, 0>>,
  Both<Equal<Parameters<SpecStoreContract>[1], () => Spec.Store | Promise<Spec.Store>>, Equal<Parameters<ImplStoreContract>[1], () => Impl.Store | Promise<Impl.Store>>>>>;
type _storeContractOptions = Assert<Both<
  Equal<Parameters<SpecStoreContract>[2], { cleanup?: (store: Spec.Store) => unknown } | undefined>,
  Equal<Parameters<ImplStoreContract>[2], { readonly cleanup?: (store: Impl.Store) => unknown } | undefined>>>;
type _storeContractReturn = Assert<Both<Equal<ReturnType<SpecStoreContract>, void>, Equal<ReturnType<ImplStoreContract>, void>>>;
/** The store `cleanup` is given is the kind `make` gave, with whatever it has beyond Store. */
type Closable<S> = S & { close(): void };
type _storeContractOwnStore = Assert<Both<
  Equal<Parameters<typeof SpecTest.storeContract<Closable<Spec.Store>>>[2], { cleanup?: (store: Closable<Spec.Store>) => unknown } | undefined>,
  Equal<Parameters<typeof ImplTest.storeContract<Closable<Impl.Store>>>[2], { readonly cleanup?: (store: Closable<Impl.Store>) => unknown } | undefined>>>;
/** `cleanup` may give anything back, so `store => store.close()` fits whatever close() returns: a value, or a promise of one. */
type SpecCleanup = NonNullable<NonNullable<Parameters<SpecStoreContract>[2]>['cleanup']>;
type ImplCleanup = NonNullable<NonNullable<Parameters<ImplStoreContract>[2]>['cleanup']>;
type _storeContractCleanupGives = Assert<Both<
  Both<Fits<(store: Spec.Store) => boolean, SpecCleanup>, Fits<(store: Spec.Store) => Promise<{ closed: true }>, SpecCleanup>>,
  Both<Fits<(store: Impl.Store) => boolean, ImplCleanup>, Fits<(store: Impl.Store) => Promise<{ closed: true }>, ImplCleanup>>>>;
/** Differs only where the spec has more: Problem.bytes (the connection feed). */
type _sessionId = Assert<Fits<Impl.SessionId, Spec.SessionId>>;
type _problem = Assert<Fits<Impl.Problem, Spec.Problem>>;
/** Options are read-only in the implementation; the spec writes them as plain properties. Same keys, same values. */
type _memoryOptions = Assert<Both<Equal<keyof Spec.MemoryOptions, keyof Impl.MemoryOptions>, Fits<Spec.MemoryOptions, Impl.MemoryOptions>>>;
type _memoryStoreOptions = Assert<Equal<keyof Spec.MemoryStoreOptions, keyof Impl.MemoryStoreOptions>>;
type _fileStoreOptions = Assert<Both<Equal<keyof Spec.FileStoreOptions, keyof Impl.FileStoreOptions>, Fits<Spec.FileStoreOptions, Impl.FileStoreOptions>>>;
/** The store: the same methods, taking the same number of arguments. Its entries gain 'fault' when faults are implemented. */
type _storeMethods = Assert<Equal<keyof Spec.Store, keyof Impl.Store>>;
type StoreArity<S> = { [K in keyof S]: S[K] extends Fn ? Parameters<S[K]>['length'] : never };
type _storeArity = Assert<Equal<StoreArity<Spec.Store>, StoreArity<Impl.Store>>>;
type _storeContext = Assert<Equal<keyof Spec.StoreContext, keyof Impl.StoreContext>>;
type _storeContextHistory = Assert<Equal<Spec.StoreContext['history'], Impl.StoreContext['history']>>;
/** The same sessions and epochs on both sides. */
type _storedSession = Assert<Fits<Impl.StoredSession, Spec.StoredSession>>;
/** read() and sent() give each side's own Entry; list() each side's own StoredSession. */
/** append() takes a list of records. */
type _storeAppend = Assert<Both<Equal<Parameters<Spec.Store['append']>[1], readonly Spec.StoreRecord[]>, Equal<Parameters<Impl.Store['append']>[1], readonly Impl.StoreRecord[]>>>;
type _storeRead = Assert<Both<Equal<ReturnType<Spec.Store['read']>, AsyncIterable<Spec.Entry>>, Equal<ReturnType<Impl.Store['read']>, AsyncIterable<Impl.Entry>>>>;
type _storeSent = Assert<Both<Equal<ReturnType<Spec.Store['sent']>, AsyncIterable<Spec.Entry>>, Equal<ReturnType<Impl.Store['sent']>, AsyncIterable<Impl.Entry>>>>;
type _storeSentRange = Assert<Equal<Parameters<Spec.Store['sent']>[1], Parameters<Impl.Store['sent']>[1]>>;
type _storeList = Assert<Both<Equal<ReturnType<Spec.Store['list']>, Promise<Spec.StoredSession[]>>, Equal<ReturnType<Impl.Store['list']>, Promise<Impl.StoredSession[]>>>>;
/** A record: the same fields; its entry is each side's own Entry. */
type _storeRecord = Assert<Both<Equal<keyof Spec.StoreRecord, keyof Impl.StoreRecord>, Fits<Omit<Impl.StoreRecord, 'entry'>, Omit<Spec.StoreRecord, 'entry'>>>>;
/** RouteFn: one message in; its messages are typed when orders are implemented. */
type _routeFn = Assert<Equal<Impl.RouteFn, (message: MessageObject) => MessageObject | null | readonly MessageObject[] | Promise<MessageObject | null | readonly MessageObject[]>>>;
type _routeFnArity = Assert<SameArity<Spec.RouteFn, Impl.RouteFn>>;

/** Spec-shaped code names Session<D, C>, Server<D, C>, ConnectOptions<D>, ListenOptions<D, C> and AcceptOptions<C>. */
type AcmeDef = { fields: { DeskName: { tag: 9703 } }; messages: { NewOrderSingle: ['DeskName'] } };
type Tier = { tier: string };
type _generics = [Impl.Session<AcmeDef, Tier>, Impl.Server<AcmeDef, Tier>, Impl.ConnectOptions<AcmeDef>, Impl.ListenOptions<AcmeDef, Tier>, Impl.AcceptOptions<Tier>];
/** C is session.context on both sides (absent when accept() gave none), and what accept() gives it. */
type _context = Assert<Both<
  Both<Equal<Spec.Session<{}, Tier>['context'], Tier | undefined>, Equal<Impl.Session<{}, Tier>['context'], Tier | undefined>>,
  Both<Equal<Spec.Server<{}, Tier>['sessions'], readonly Spec.Session<{}, Tier>[]>, Equal<Impl.Server<{}, Tier>['sessions'], readonly Impl.Session<{}, Tier>[]>>>>;
type Verdict<O> = O extends { accept?: (...args: never[]) => infer R } ? Exclude<Awaited<R>, true | string> : never;
type _acceptVerdict = Assert<Both<Equal<Verdict<Spec.ListenOptions<{}, Tier>>, Spec.AcceptOptions<Tier>>, Equal<Verdict<Impl.ListenOptions<{}, Tier>>, Impl.AcceptOptions<Tier>>>>;
type _acceptArity = Assert<SameArity<NonNullable<Spec.ListenOptions['accept']>, NonNullable<Impl.ListenOptions['accept']>>>;

// ─── Functions and constructors ─────────────────────────────────────────────
// Argument by argument: the whole signatures differ where the spec's Session,
// Store and options carry what isn't implemented yet (Later*). Option and
// return types are pinned here and compared member by member below.

type SpecConnect = typeof Spec.connect<{}>;
type ImplConnect = typeof Impl.connect<{}>;
type _connect = Assert<Both<Both<SameArity<SpecConnect, ImplConnect>, SameArg<SpecConnect, ImplConnect, 0>>, Both<
  Both<Equal<Parameters<SpecConnect>[1], Spec.ConnectOptions>, Equal<Parameters<ImplConnect>[1], Impl.ConnectOptions>>,
  Both<Equal<ReturnType<SpecConnect>, Promise<Spec.Session>>, Equal<ReturnType<ImplConnect>, Promise<Impl.Session>>>>>>;

type SpecListen = typeof Spec.listen<{}>;
type ImplListen = typeof Impl.listen<{}>;
type _listen = Assert<Both<Both<SameArity<SpecListen, ImplListen>, SameArg<SpecListen, ImplListen, 0>>, Both<
  Both<Equal<Parameters<SpecListen>[1], Spec.ListenOptions>, Equal<Parameters<ImplListen>[1], Impl.ListenOptions>>,
  Both<Equal<ReturnType<SpecListen>, Promise<Spec.Server>>, Equal<ReturnType<ImplListen>, Promise<Impl.Server>>>>>>;

type _memoryStore = Assert<Both<Both<SameArity<typeof Spec.memoryStore, typeof Impl.memoryStore>, SameArg<typeof Spec.memoryStore, typeof Impl.memoryStore, 0>>,
  Both<Equal<ReturnType<typeof Spec.memoryStore>, Spec.Store>, Equal<ReturnType<typeof Impl.memoryStore>, Impl.Store>>>>;
type _fileStore = Assert<Both<Both<SameArity<typeof Spec.fileStore, typeof Impl.fileStore>, SameArg<typeof Spec.fileStore, typeof Impl.fileStore, 0>>,
  Both<Equal<ReturnType<typeof Spec.fileStore>, Spec.Store>, Equal<ReturnType<typeof Impl.fileStore>, Impl.Store>>>>;
type _fileStoreOptionsArg = Assert<Both<Equal<Parameters<typeof Spec.fileStore>[1], Spec.FileStoreOptions | undefined>, Equal<Parameters<typeof Impl.fileStore>[1], Impl.FileStoreOptions | undefined>>>;
type _defineDictionary = Assert<Both<Fits<typeof Spec.defineDictionary<{}>, typeof Impl.defineDictionary<{}>>, Fits<typeof Impl.defineDictionary<{}>, typeof Spec.defineDictionary<{}>>>>;

type Constructor = abstract new (...args: never[]) => unknown;
/** Each accepts exactly the arguments the other does, and the implementation's instances are valid spec instances. */
type SameClass<S extends Constructor, I extends Constructor> = Both<
  Both<Equal<ConstructorParameters<S>['length'], ConstructorParameters<I>['length']>, Both<Fits<ConstructorParameters<S>, ConstructorParameters<I>>, Fits<ConstructorParameters<I>, ConstructorParameters<S>>>>,
  Fits<InstanceType<I>, InstanceType<S>>>;
type _errors = Assert<Equal<
  | SameClass<typeof Spec.FIXEncodeError, typeof Impl.FIXEncodeError> | SameClass<typeof Spec.FIXDecodeError, typeof Impl.FIXDecodeError>
  | SameClass<typeof Spec.FIXStateError, typeof Impl.FIXStateError> | SameClass<typeof Spec.FIXLogonError, typeof Impl.FIXLogonError>
  | SameClass<typeof Spec.TimeoutError, typeof Impl.TimeoutError>,
  true>>;

// ─── Session ────────────────────────────────────────────────────────────────

/** Orders: not implemented yet. */
type LaterSession = 'newOrder' | 'orders';
type _sessionMembers = Assert<Equal<Exclude<Missing<Spec.Session, Impl.Session>, LaterSession>, never>>;
/** No transport wiring (attach, start, receiveBytes, linkClosed, active) is reachable through the public type. */
type _sessionNoExtras = Assert<Equal<Missing<Impl.Session, Spec.Session>, never>>;
/** Members whose types don't depend on typed messages (not implemented yet) agree. */
type SessionPlain = 'id' | 'key' | 'connectionId' | 'peer' | 'connectedAt' | 'loggedOnAt' | 'context' | 'state' | 'heartbeat' | 'seqNums' | 'closed' | 'logout' | 'close' | 'sendBytes' | 'setSeqNums';
type _sessionPlain = Assert<Fits<Pick<Impl.Session, SessionPlain>, Pick<Spec.Session, SessionPlain>>>;

/** history and watch(): each side's own Entry (compared below), in the same shape. */
type _history = Assert<Both<Equal<Spec.Session['history'], readonly Spec.Entry[]>, Equal<Impl.Session['history'], readonly Impl.Entry[]>>>;
type _watch = Assert<Both<Equal<Spec.Session['watch'], (fn: (entry: Spec.Entry) => void) => Spec.Remove>, Equal<Impl.Session['watch'], (fn: (entry: Impl.Entry) => void) => Impl.Remove>>>;
/** outgoing() and incoming(): a RouteFn (a Fault too, once faults are implemented). */
type Route<S> = S extends { outgoing: infer O; incoming: infer I } ? [O, I] : never;
type _routes = Assert<Both<
  Equal<Route<Spec.Session>, [(fault: Spec.Fault | Spec.RouteFn) => Spec.Remove, (fault: Spec.Fault | Spec.RouteFn) => Spec.Remove]>,
  Equal<Route<Impl.Session>, [(fn: Impl.RouteFn) => Impl.Remove, (fn: Impl.RouteFn) => Impl.Remove]>>>;
/** encode(): any message type the spec names, and fields; bytes back. */
type SpecEncode = Spec.Session['encode'];
type ImplEncode = Impl.Session['encode'];
type _encode = Assert<Both<Both<Fits<Parameters<SpecEncode>[0], Parameters<ImplEncode>[0]>, Fits<Parameters<SpecEncode>[1], Parameters<ImplEncode>[1]>>,
  Both<Equal<ReturnType<SpecEncode>, Uint8Array>, Equal<ReturnType<ImplEncode>, Uint8Array>>>>;

/** next(): its timeout is a Duration on both sides. */
type NextTimeout<S extends { next: Fn }> = NonNullable<Parameters<S['next']>[1]> extends { timeout?: infer T } ? T : never;
type _nextTimeout = Assert<Both<Equal<NextTimeout<Spec.Session>, Spec.Duration>, Equal<NextTimeout<Impl.Session>, Impl.Duration>>>;

// ─── Server ─────────────────────────────────────────────────────────────────

/** Orders: not implemented yet. */
type LaterServer = 'orders';
type _serverMembers = Assert<Equal<Exclude<Missing<Spec.Server, Impl.Server>, LaterServer>, never>>;
type _serverNoExtras = Assert<Equal<Missing<Impl.Server, Spec.Server>, never>>;
type ServerPlain = 'port' | 'close' | 'watch';
type _serverPlain = Assert<Fits<Pick<Impl.Server, ServerPlain>, Pick<Spec.Server, ServerPlain>>>;
type _connectionEntry = Assert<Fits<Impl.ConnectionEntry, Spec.ConnectionEntry>>;
/** server.watch(): the same arguments, each side's own ConnectionEntry (they differ only in Problem.bytes). */
type _serverWatch = Assert<Both<
  Equal<Spec.Server['watch'], (fn: (entry: Spec.ConnectionEntry) => void, options?: { replay?: boolean }) => Spec.Remove>,
  Equal<Impl.Server['watch'], (fn: (entry: Impl.ConnectionEntry) => void, options?: { replay?: boolean }) => Impl.Remove>>>;
/** Every event and field of a connection entry is on both sides. */
type _connectionEvents = Assert<Equal<Impl.ConnectionEntry['event'], Spec.ConnectionEntry['event']>>;
type _connectionKeys = Assert<Equal<keyof Impl.ConnectionEntry, keyof Spec.ConnectionEntry>>;
/** Each event carries the same fields, and requires the same ones (whether it has a connection, too). */
type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
type PresentKeys<T> = { [K in keyof T]-?: [T[K]] extends [undefined] ? never : K }[keyof T];
type EventShapes<E> = E extends { event: infer V } ? [V, RequiredKeys<E>, PresentKeys<E>] : never;
type _connectionEventShapes = Assert<Equal<EventShapes<Impl.ConnectionEntry>, EventShapes<Spec.ConnectionEntry>>>;
/** server.on(): its handler is given the session the message arrived on, as Session<D, C>. */
type HandlerSession<S extends { on: Fn }> = Parameters<Extract<Parameters<S['on']>[1], Fn>>[1];
type _serverOnSession = Assert<Both<
  Equal<HandlerSession<Spec.Server<AcmeDef, Tier>>, Spec.Session<AcmeDef, Tier>>,
  Equal<HandlerSession<Impl.Server<AcmeDef, Tier>>, Impl.Session<AcmeDef, Tier>>>>;
/** sessions, session() and whenConnected(): the same arguments, each side's own Session back. */
type _sessions = Assert<Both<Equal<Spec.Server['sessions'], readonly Spec.Session[]>, Equal<Impl.Server['sessions'], readonly Impl.Session[]>>>;
type _session = Assert<Both<Equal<Parameters<Spec.Server['session']>, Parameters<Impl.Server['session']>>,
  Both<Equal<ReturnType<Spec.Server['session']>, Spec.Session | undefined>, Equal<ReturnType<Impl.Server['session']>, Impl.Session | undefined>>>>;
type _whenConnected = Assert<Both<Equal<Parameters<Spec.Server['whenConnected']>, Parameters<Impl.Server['whenConnected']>>,
  Both<Equal<ReturnType<Spec.Server['whenConnected']>, Promise<Spec.Session>>, Equal<ReturnType<Impl.Server['whenConnected']>, Promise<Impl.Session>>>>>;

// ─── Options ────────────────────────────────────────────────────────────────
// Whatever the spec allows, the implementation accepts. Left out until they're
// implemented: marketPrice (with orders), store (its
// entries gain 'fault' with faults), accept (typed messages, with orders).

/** The same BeginStrings, and the same application versions over FIXT.1.1, on both sides. */
type _versions = Assert<Both<Equal<Impl.Version, Spec.Version>, Equal<Impl.ApplVerID, Spec.ApplVerID>>>;
type _connectVersion = Assert<Fits<Spec.ConnectOptions['version'], Impl.ConnectOptions['version']>>;
type _listenVersions = Assert<Fits<Spec.ListenOptions['versions'], Impl.ListenOptions['versions']>>;

type _connectKeys = Assert<Equal<Missing<Spec.ConnectOptions, Impl.ConnectOptions>, never>>;
type _connectNoExtras = Assert<Equal<Missing<Impl.ConnectOptions, Spec.ConnectOptions>, never>>;
type ConnectPlain = 'sender' | 'target' | 'heartbeat' | 'logon' | 'manual' | 'clock' | 'dictionary' | 'logonTimeout' | 'logoutTimeout' | 'connectTimeout' | 'storeTimeout' | 'onHandlerError' | 'memory' | 'redact' | 'tls';
type _connectPlain = Assert<Fits<Pick<Spec.ConnectOptions, ConnectPlain>, Pick<Impl.ConnectOptions, ConnectPlain>>>;

type LaterListen = 'marketPrice';
type _listenKeys = Assert<Equal<Exclude<Missing<Spec.ListenOptions, Impl.ListenOptions>, LaterListen>, never>>;
type _listenNoExtras = Assert<Equal<Missing<Impl.ListenOptions, Spec.ListenOptions>, never>>;
type ListenPlain = 'compID' | 'host' | 'heartbeat' | 'manual' | 'clock' | 'dictionary' | 'limits' | 'logoutTimeout' | 'storeTimeout' | 'onHandlerError' | 'memory' | 'redact' | 'tls';
type _listenPlain = Assert<Fits<Pick<Spec.ListenOptions, ListenPlain>, Pick<Impl.ListenOptions, ListenPlain>>>;
type _acceptKeys = Assert<Equal<keyof Spec.AcceptOptions, keyof Impl.AcceptOptions>>;
type _acceptOptions = Assert<Fits<Omit<Spec.AcceptOptions, 'store'>, Omit<Impl.AcceptOptions, 'store'>>>;

/**
 * Sub-objects whose members are all optional accept any object with one
 * matching key, so Fits alone misses a renamed member: compare the keys too.
 */
type _memoryKeys = Assert<Both<
  Equal<keyof NonNullable<Spec.ConnectOptions['memory']>, keyof NonNullable<Impl.ConnectOptions['memory']>>,
  Equal<keyof NonNullable<Spec.ListenOptions['memory']>, keyof NonNullable<Impl.ListenOptions['memory']>>>>;
type _limitsKeys = Assert<Equal<keyof NonNullable<Spec.ListenOptions['limits']>, keyof NonNullable<Impl.ListenOptions['limits']>>>;
type _heartbeatKeys = Assert<Both<
  Equal<keyof NonNullable<Spec.ListenOptions['heartbeat']>, keyof NonNullable<Impl.ListenOptions['heartbeat']>>,
  Equal<keyof NonNullable<Spec.AcceptOptions['heartbeat']>, keyof NonNullable<Impl.AcceptOptions['heartbeat']>>>>;
type _acceptMemoryKeys = Assert<Equal<keyof NonNullable<Spec.AcceptOptions['memory']>, keyof NonNullable<Impl.AcceptOptions['memory']>>>;

// ─── History and errors ─────────────────────────────────────────────────────

/** The 'fault' entry comes with faults. */
type _entryKinds = Assert<Equal<Impl.Entry['kind'], Exclude<Spec.Entry['kind'], 'fault'>>>;
type _errorEntry = Assert<Fits<Impl.ErrorEntry, Spec.ErrorEntry>>;
/** Each kind of entry agrees; a message entry's message is typed when orders are implemented. */
type EntryOf<E, K> = Extract<E, { kind: K }>;
type _problemEntry = Assert<Fits<EntryOf<Impl.Entry, 'problem'>, EntryOf<Spec.Entry, 'problem'>>>;
type _messageEntry = Assert<Both<
  Equal<keyof EntryOf<Impl.Entry, 'message'>, keyof EntryOf<Spec.Entry, 'message'>>,
  Fits<Omit<EntryOf<Impl.Entry, 'message'>, 'message'>, Omit<EntryOf<Spec.Entry, 'message'>, 'message'>>>>;
type _closeReason = Assert<Fits<Impl.CloseReason, Spec.CloseReason>>;
type _problemCodes = Assert<Equal<Impl.Problem['code'], Spec.Problem['code']>>;
type _timeoutError = Assert<Fits<InstanceType<typeof Impl.TimeoutError>, InstanceType<typeof Spec.TimeoutError>>>;
type _logonError = Assert<Fits<InstanceType<typeof Impl.FIXLogonError>, InstanceType<typeof Spec.FIXLogonError>>>;

// ─── Entries as JSON ────────────────────────────────────────────────────────

/** The same JSON shape; the spec's kinds include 'fault' (not implemented yet). */
type _entryJSON = Assert<Both<Equal<keyof Spec.EntryJSON, keyof Impl.EntryJSON>, Fits<Impl.EntryJSON, Spec.EntryJSON>>>;
/** entryToJSON(): each side's own entries in, its own EntryJSON out. */
type _entryToJSON = Assert<Both<
  Equal<typeof Spec.entryToJSON, (entry: Spec.Entry | Spec.ConnectionEntry) => Spec.EntryJSON>,
  Equal<typeof Impl.entryToJSON, (entry: Impl.Entry | Impl.ConnectionEntry) => Impl.EntryJSON>>>;
/** entryFromJSON(): anything in, with an optional dictionary; each side's own entries out. */
type _entryFromJSON = Assert<Both<
  Both<SameArity<typeof Spec.entryFromJSON, typeof Impl.entryFromJSON>, SameArg<typeof Spec.entryFromJSON, typeof Impl.entryFromJSON, 0>>,
  Both<Equal<ReturnType<typeof Spec.entryFromJSON>, Spec.Entry | Spec.ConnectionEntry>, Equal<ReturnType<typeof Impl.entryFromJSON>, Impl.Entry | Impl.ConnectionEntry>>>>;
