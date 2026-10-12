/**
 * fix.js — a friendly FIX protocol library for building test tools.
 * This entry exposes the FIX 4.4 enum constants (Side.Buy, MsgType.Logon, …),
 * custom dictionaries, errors and message types, and the transport: connect(),
 * listen() and the session stores. The wire layer is 'fix.js/wire'; test helpers
 * are 'fix.js/test'; the FIX Latest constants (FIX 5.0 SP2 and every extension
 * pack since) are 'fix.js/fix50sp2'.
 */
export * from './dictionary/fix44.ts';
export { defineDictionary, type Dictionary, type DictionaryDef, type FieldDef } from './dictionary/define.ts';
export { FIXEncodeError, FIXDecodeError, FIXStateError, FIXLogonError, TimeoutError, type WaitingFor } from './errors.ts';
export type { Message, Fields, CustomFields, RawTags, AutoFilledBodyField } from './types.ts';

export { ApplVerID, Version } from './version.ts';

export { connect, type ConnectOptions } from './transport/net.ts';
export { listen, type ListenOptions } from './transport/server.ts';
export { memoryStore, fileStore, type FileStoreOptions, type MemoryStoreOptions } from './transport/store.ts';
export { entryToJSON, entryFromJSON, type EntryJSON } from './transport/json.ts';
export type { Session, Server, AcceptOptions } from './transport/api.ts';
export type { MemoryOptions } from './transport/session.ts';
export type {
  Entry, ErrorEntry, ConnectionEntry, LogonIds, CloseReason, Peer, SessionId,
  Store, StoreContext, StoreRecord, StoreReadOptions, StoredEpoch, StoredSession, RouteFn, Remove,
} from './transport/types.ts';
export type { Problem } from './session/types.ts';
export type { Clock } from './transport/clock.ts';
export type { Duration } from './util/duration.ts';
