import { readFileSync } from 'node:fs';
import { FIXT11 } from '../version.ts';
import { DATA_TYPES } from './datatypes.ts';
import type { DictionaryData, FieldInfo, GroupInfo, MessageInfo } from './model.ts';
import { data as fix42 } from './fix42.data.ts';
import { data as fix44 } from './fix44.data.ts';
import { data as fixt11 } from './fixt11.data.ts';

/** A dictionary with lookup tables. */
export interface IndexedDictionary {
  readonly version: string;
  readonly data: DictionaryData;
  readonly fieldByTag: ReadonlyMap<number, FieldInfo>;
  readonly fieldByName: ReadonlyMap<string, FieldInfo>;
  readonly groupByName: ReadonlyMap<string, GroupInfo>;
  readonly messageByName: ReadonlyMap<string, MessageInfo>;
  readonly messageByMsgType: ReadonlyMap<string, MessageInfo>;
  /** Tags whose values are raw data (length given by the preceding field). */
  readonly dataTags: ReadonlySet<number>;
}

export function indexDictionary(data: DictionaryData): IndexedDictionary {
  return {
    version: data.version,
    data,
    fieldByTag: new Map(data.fields.map(field => [field.tag, field])),
    fieldByName: new Map(data.fields.map(field => [field.name, field])),
    groupByName: new Map(data.groups.map(group => [group.name, group])),
    messageByName: new Map(data.messages.map(message => [message.name, message])),
    messageByMsgType: new Map(data.messages.map(message => [message.msgType, message])),
    dataTags: new Set(data.fields.filter(field => DATA_TYPES.has(field.type)).map(field => field.tag)),
  };
}

export const DEFAULT_VERSION = 'FIX.4.4';

const standard = new Map([fix42, fix44].map(data => [data.version, indexDictionary(data)]));

/**
 * FIXT.1.1's session layer on its own: its header, trailer and session messages. It names every
 * message type in RefMsgType, which a Logon lists the application messages of its sender by.
 */
const fixtSession = indexDictionary(fixt11);

let fixt: IndexedDictionary | undefined;

/**
 * FIXT.1.1 with the application messages it carries: FIX 5.0 SP2 and every
 * extension pack since. Its tables are large, so they are read from their file
 * the first time a FIXT.1.1 session, store or entry needs them, and kept.
 */
function fixtDictionary(): IndexedDictionary {
  fixt ??= indexDictionary(JSON.parse(readFileSync(new URL('./fix50sp2.data.json', import.meta.url), 'utf8')) as DictionaryData);
  return fixt;
}

/** The standard dictionary for a BeginString. Versions without a dictionary use FIX.4.4. */
export function dictionaryFor(version: string = DEFAULT_VERSION): IndexedDictionary {
  if (version === FIXT11) return fixtDictionary();
  const dict = standard.get(version) ?? standard.get(DEFAULT_VERSION);
  if (!dict) throw new Error(`No dictionary for ${DEFAULT_VERSION}`);
  return dict;
}

/**
 * The dictionary a Logon is read with, and a Logout that refuses one is
 * written with, before a session exists: the version's session layer. For
 * FIXT.1.1 that is the session layer on its own, so a connection that is
 * refused never has the application messages' tables read for it. A FIX 4
 * version has one dictionary for both layers.
 */
export function sessionLayerFor(version: string = DEFAULT_VERSION): IndexedDictionary {
  return version === FIXT11 ? fixtSession : dictionaryFor(version);
}

/** Tags whose values are raw data in any version's session layer: what a first frame may hold, before its version is known. */
export const SESSION_DATA_TAGS: ReadonlySet<number> = new Set([...standard.values(), fixtSession].flatMap(dict => [...dict.dataTags]));
