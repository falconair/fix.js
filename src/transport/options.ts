import type { DictionaryDef } from '../dictionary/define.ts';
import type { IndexedDictionary } from '../dictionary/index.ts';
import { resolveDictionary } from '../dictionary/resolve.ts';
import { fillLogon } from '../session/context.ts';
import { initiatorLogon } from '../session/handshake.ts';
import { engineConfig, type EngineConfig } from '../session/types.ts';
import { timeoutMs } from '../util/duration.ts';
import { isVersion, oneOf, VERSIONS, type Version } from '../version.ts';
import { fromMessage } from '../wire/message.ts';
import type { AcceptOptions } from './api.ts';
import { systemClock, type Clock } from './clock.ts';
import type { ConnectOptions } from './net.ts';
import type { ListenOptions, ServerLimits } from './server.ts';
import type { MemoryOptions } from './session.ts';

/**
 * The checks on connect(), listen() and accept() options, in one place and in
 * one wording. Each throws a RangeError naming the option and what it got.
 */

// ─── Kinds of value ─────────────────────────────────────────────────────────

export const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';

/** An object literal (or Object.create(null)): not an array, a Date or a class instance. */
export const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!isObject(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** A value as an error message shows it: strings quoted, objects by their kind. Never throws. */
export function describe(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  if (Array.isArray(value)) return 'an array';
  if (isObject(value)) {
    if (isPlainObject(value)) return 'an object';
    const name: unknown = (value as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof name === 'string' && name !== '' && name !== 'Object' ? `an instance of ${name}` : 'an object with a custom prototype';
  }
  if (typeof value === 'function') return 'a function';
  return String(value);
}

/** A plain object, else a RangeError saying what it must be (`shape`). */
export function plainObject(value: unknown, name: string, shape: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new RangeError(`${name} must be ${shape}, got ${describe(value)}`);
  return value;
}

/** Settings the spec describes that aren't implemented yet: refused with a clearer message than an unknown key. */
const NOT_YET: Readonly<Record<string, string>> = {
  marketPrice: 'marketPrice is not supported yet',
};

/** Every key of `value` is one of `known`. */
export function checkKnownKeys(value: Record<string, unknown>, known: readonly string[], name: string): void {
  const unknown = Object.keys(value).find(key => !known.includes(key));
  if (unknown === undefined) return;
  const later = Object.hasOwn(NOT_YET, unknown) ? NOT_YET[unknown] : undefined;
  throw new RangeError(later === undefined ? `${name}: unknown setting '${unknown}'` : `${name}: ${later}`);
}

export function wholeNumber(value: unknown, name: string, min: number): number {
  if (!(typeof value === 'number' && Number.isSafeInteger(value) && value >= min)) {
    throw new RangeError(`${name} must be a whole number of at least ${min}, got ${describe(value)}`);
  }
  return value;
}

export function checkBoolean(value: unknown, name: string): void {
  if (typeof value !== 'boolean') throw new RangeError(`${name} must be true or false, got ${describe(value)}`);
}

export function checkFunction(value: unknown, name: string): void {
  if (typeof value !== 'function') throw new RangeError(`${name} must be a function, got ${describe(value)}`);
}

/** A CompID: text, not empty. */
export function checkCompID(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new RangeError(`${name} must be a CompID (text, not empty), got ${describe(value)}`);
  return value;
}

const STORE_METHODS = ['load', 'append', 'read', 'sent', 'list', 'reset'] as const;

export function checkStore(value: unknown, name: string): void {
  if (!(isObject(value) && STORE_METHODS.every(method => typeof value[method] === 'function'))) {
    throw new RangeError(`${name} must have load, append, read, sent, list and reset functions`);
  }
}

export function checkDictionary(value: unknown, name: string): void {
  if (!(isObject(value) && isObject(value.definition))) throw new RangeError(`${name} must be one from defineDictionary()`);
}

/**
 * The dictionary for a version with a custom definition added. A definition that cannot extend it (a
 * custom field with the tag of one of that version's fields, or the name of one of its fields or groups)
 * is a RangeError naming the version.
 */
export function usableDictionary(version: Version, custom: { readonly definition: DictionaryDef } | undefined, advice = ''): IndexedDictionary {
  try {
    return resolveDictionary(version, custom);
  } catch (error) {
    throw new RangeError(`dictionary can't be used with ${version}: ${error instanceof Error ? error.message : String(error)}${advice}`);
  }
}

export function checkClock(value: unknown, name: string): void {
  if (!(isObject(value) && ['now', 'setTimeout', 'clearTimeout'].every(method => typeof value[method] === 'function'))) {
    throw new RangeError(`${name} must have now, setTimeout and clearTimeout functions`);
  }
}

// ─── Option objects ─────────────────────────────────────────────────────────

const MEMORY_KEYS: readonly string[] = Object.keys({ history: 1, historyBytes: 1, inbox: 1, inboxBytes: 1, outgoingBytes: 1, storeBytes: 1, pendingBytes: 1 } satisfies Record<keyof MemoryOptions, 1>);

/** Memory bounds: an object of known keys, each a whole number of at least 1. */
export function checkMemoryOptions(memory: unknown, name: string): void {
  const bounds = plainObject(memory, name, 'an object of bounds');
  checkKnownKeys(bounds, MEMORY_KEYS, name);
  for (const [key, value] of Object.entries(bounds)) {
    if (value !== undefined) wholeNumber(value, `${name}.${key}`, 1);
  }
}

/** A `redact` option: a list of tag numbers, or false. */
export function checkRedact(option: unknown, name: string): void {
  if (option === undefined || option === false) return;
  if (!Array.isArray(option)) throw new RangeError(`${name} must be a list of tag numbers, or false, got ${describe(option)}`);
  for (const tag of option) wholeNumber(tag, `${name}: each tag`, 1);
}

export interface HeartbeatBounds {
  readonly min: number;
  readonly max: number;
}

const HEARTBEAT_KEYS: readonly string[] = ['min', 'max'];

/** A HeartBtInt range in whole seconds, min ≤ max; a missing end comes from `fallback`. */
export function heartbeatRange(range: unknown, fallback: HeartbeatBounds, name: string): HeartbeatBounds {
  if (range !== undefined) {
    checkKnownKeys(plainObject(range, name, '{ min, max } in whole seconds'), HEARTBEAT_KEYS, name);
  }
  const given = range as { min?: unknown; max?: unknown } | undefined;
  const min = given?.min ?? fallback.min;
  const max = given?.max ?? fallback.max;
  if (!(typeof min === 'number' && typeof max === 'number' && Number.isSafeInteger(min) && Number.isSafeInteger(max) && min >= 0 && min <= max)) {
    throw new RangeError(`${name} must be whole seconds with min ≤ max, got ${String(min)}–${String(max)}`);
  }
  return { min, max };
}

// ─── connect() ──────────────────────────────────────────────────────────────

const CONNECT_KEYS: readonly string[] = Object.keys({
  sender: 1, target: 1, version: 1, heartbeat: 1, logon: 1, manual: 1, store: 1, clock: 1, dictionary: 1,
  onHandlerError: 1, memory: 1, logonTimeout: 1, logoutTimeout: 1, connectTimeout: 1, storeTimeout: 1, redact: 1, tls: 1,
} satisfies Record<keyof ConnectOptions, 1>);

/**
 * Check connect()'s options before any store or socket is touched, so a mistake rejects at once. The
 * Logon is encoded here with the fields the engine will send.
 */
export function checkConnectOptions(options: unknown): { version: Version; config: EngineConfig; dictionary: IndexedDictionary; connectTimeout: number; storeTimeoutMs: number } {
  const o = plainObject(options, 'connect() options', 'an object of options');
  checkKnownKeys(o, CONNECT_KEYS, 'connect() options');
  const sender = checkCompID(o.sender, 'sender');
  const target = checkCompID(o.target, 'target');
  const version = o.version ?? 'FIX.4.4';
  if (!isVersion(version)) throw new RangeError(`version ${String(version)} is not supported; use ${oneOf(VERSIONS)}`);
  const heartbeat = wholeNumber(o.heartbeat ?? 30, 'heartbeat', 0);
  const logon = o.logon === undefined ? undefined : plainObject(o.logon, 'logon', 'an object of Logon fields');
  if (o.manual !== undefined) checkBoolean(o.manual, 'manual');
  if (o.store !== undefined) checkStore(o.store, 'store');
  if (o.clock !== undefined) checkClock(o.clock, 'clock');
  if (o.dictionary !== undefined) checkDictionary(o.dictionary, 'dictionary');
  if (o.onHandlerError !== undefined) checkFunction(o.onHandlerError, 'onHandlerError');
  if (o.memory !== undefined) checkMemoryOptions(o.memory, 'memory');
  checkRedact(o.redact, 'redact');
  if (o.tls !== undefined && typeof o.tls !== 'boolean' && !isPlainObject(o.tls)) {
    throw new RangeError(`tls must be true, false, or Node's TLS connection options (ca, …), got ${describe(o.tls)}`);
  }
  const config = engineConfig({
    version, sender, target, role: 'initiator', heartbeat,
    ...(o.manual === undefined ? {} : { manual: o.manual as boolean }),
    ...(logon === undefined ? {} : { logon }),
    logonTimeout: timeoutMs((o.logonTimeout ?? '10s') as never, 'logonTimeout') / 1000,
    logoutTimeout: timeoutMs((o.logoutTimeout ?? '10s') as never, 'logoutTimeout') / 1000,
  });
  const connectTimeout = timeoutMs((o.connectTimeout ?? '10s') as never, 'connectTimeout');
  const storeTimeoutMs = timeoutMs((o.storeTimeout ?? '10s') as never, 'storeTimeout');
  const dictionary = usableDictionary(version, o.dictionary as ConnectOptions['dictionary']);
  const clock = (o.clock ?? systemClock) as Clock;
  // The Logon as the session will send it: under FIXT.1.1 with the application version filled in.
  fromMessage('Logon', {
    BeginString: version, SenderCompID: sender, TargetCompID: target,
    MsgSeqNum: 1, SendingTime: clock.now(), ...fillLogon(version, initiatorLogon(config), undefined),
  }, dictionary, { version });
  return { version, config, dictionary, connectTimeout, storeTimeoutMs };
}

// ─── listen() ───────────────────────────────────────────────────────────────

/** listen()'s options, checked once, up front, instead of failing on the first connection. */
export interface ListenSettings {
  readonly compIDs: readonly string[];
  readonly versions: readonly Version[];
  readonly heartbeat: HeartbeatBounds;
  readonly maxMessageSize: number;
  readonly logonTimeoutMs: number;
  readonly maxSessions: number;
  readonly connectionsPerAddress: number;
  readonly pendingLogons: number;
  readonly processingTimeoutMs: number;
  readonly storeTimeoutMs: number;
  /** The engine counts this one in seconds. */
  readonly logoutTimeoutS: number;
}

export const DEFAULT_HEARTBEAT: HeartbeatBounds = { min: 1, max: 120 };

const LISTEN_KEYS: readonly string[] = Object.keys({
  compID: 1, host: 1, versions: 1, accept: 1, heartbeat: 1, manual: 1, store: 1, clock: 1, dictionary: 1,
  limits: 1, logoutTimeout: 1, storeTimeout: 1, onHandlerError: 1, memory: 1, redact: 1, tls: 1,
} satisfies Record<keyof ListenOptions, 1>);

const LIMIT_KEYS: readonly string[] = Object.keys({
  maxSessions: 1, connectionsPerAddress: 1, pendingLogons: 1, maxMessageSize: 1, logonTimeout: 1, processingTimeout: 1,
} satisfies Record<keyof ServerLimits, 1>);

export function checkListenOptions(options: unknown): ListenSettings {
  const o = plainObject(options, 'listen() options', 'an object of options');
  checkKnownKeys(o, LISTEN_KEYS, 'listen() options');
  const compID = o.compID;
  const compIDs = typeof compID === 'string' ? [compID] : Array.isArray(compID) ? [...compID as unknown[]] : [];
  if (compIDs.length === 0 || compIDs.some(id => typeof id !== 'string' || id === '')) throw new RangeError('compID must be a CompID or a list of CompIDs');
  if (o.host !== undefined && typeof o.host !== 'string') throw new RangeError(`host must be text, got ${describe(o.host)}`);
  const versions = o.versions ?? VERSIONS;
  if (!Array.isArray(versions) || versions.length === 0) throw new RangeError('versions must list at least one version');
  for (const version of versions) {
    if (!isVersion(version)) throw new RangeError(`versions: ${String(version)} is not supported; use ${oneOf(VERSIONS)}`);
  }
  if (o.accept !== undefined) checkFunction(o.accept, 'accept');
  const heartbeat = heartbeatRange(o.heartbeat, DEFAULT_HEARTBEAT, 'heartbeat');
  if (o.manual !== undefined) checkBoolean(o.manual, 'manual');
  if (o.store !== undefined) checkStore(o.store, 'store');
  if (o.clock !== undefined) checkClock(o.clock, 'clock');
  if (o.dictionary !== undefined) {
    checkDictionary(o.dictionary, 'dictionary');
    // A definition that can't extend a version's dictionary fails here, not on the first Logon. A server
    // that listed no versions speaks them all, and may not mean to: then the error says how to speak fewer.
    const advice = o.versions === undefined ? '. List the versions this server speaks in versions' : '';
    for (const version of versions as Version[]) usableDictionary(version, o.dictionary as ListenOptions['dictionary'], advice);
  }
  if (o.onHandlerError !== undefined) checkFunction(o.onHandlerError, 'onHandlerError');
  if (o.memory !== undefined) checkMemoryOptions(o.memory, 'memory');
  checkRedact(o.redact, 'redact');
  if (o.tls !== undefined) plainObject(o.tls, 'tls', "Node's TLS server options (key, cert, …)");
  const limits = o.limits === undefined ? {} : plainObject(o.limits, 'limits', 'an object of limits');
  checkKnownKeys(limits, LIMIT_KEYS, 'limits');
  return {
    compIDs: compIDs as string[],
    versions: versions as Version[],
    heartbeat,
    maxMessageSize: wholeNumber(limits.maxMessageSize ?? 64 * 1024, 'limits.maxMessageSize', 64),
    logonTimeoutMs: timeoutMs((limits.logonTimeout ?? '10s') as never, 'limits.logonTimeout'),
    maxSessions: wholeNumber(limits.maxSessions ?? 1_000, 'limits.maxSessions', 1),
    connectionsPerAddress: wholeNumber(limits.connectionsPerAddress ?? 10, 'limits.connectionsPerAddress', 1),
    pendingLogons: wholeNumber(limits.pendingLogons ?? 100, 'limits.pendingLogons', 1),
    processingTimeoutMs: timeoutMs((limits.processingTimeout ?? '60s') as never, 'limits.processingTimeout'),
    storeTimeoutMs: timeoutMs((o.storeTimeout ?? '10s') as never, 'storeTimeout'),
    logoutTimeoutS: timeoutMs((o.logoutTimeout ?? '10s') as never, 'logoutTimeout') / 1000,
  };
}

// ─── accept() ───────────────────────────────────────────────────────────────

const ACCEPT_KEYS: readonly string[] = Object.keys({ heartbeat: 1, manual: 1, store: 1, memory: 1, dictionary: 1, context: 1 } satisfies Record<keyof AcceptOptions, 1>);

/** What's wrong with settings accept() returned, or undefined when they can be used. */
export function acceptOptionsProblem(value: unknown, heartbeat: HeartbeatBounds): string | undefined {
  if (!isPlainObject(value)) {
    return `accept() must return true, the text of a refusal, or a plain settings object, not ${describe(value)}`;
  }
  try {
    checkKnownKeys(value, ACCEPT_KEYS, 'accept() settings');
    if (value.heartbeat !== undefined) heartbeatRange(value.heartbeat, heartbeat, 'accept() heartbeat');
    if (value.memory !== undefined) checkMemoryOptions(value.memory, 'accept() memory');
    if (value.manual !== undefined) checkBoolean(value.manual, 'accept() manual');
    if (value.store !== undefined) checkStore(value.store, 'accept() store');
    if (value.dictionary !== undefined) checkDictionary(value.dictionary, 'accept() dictionary');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}
