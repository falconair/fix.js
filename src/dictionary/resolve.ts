import { extendDictionary, type DictionaryDef } from './define.ts';
import { dictionaryFor, sessionLayerFor, type IndexedDictionary } from './index.ts';

type Custom = { readonly definition: DictionaryDef };

const extended = new WeakMap<object, Map<IndexedDictionary, IndexedDictionary>>();

/** `base` with a firm's custom fields added when given. Extended dictionaries are cached. */
function extend(base: IndexedDictionary, custom: Custom | undefined): IndexedDictionary {
  if (!custom) return base;
  let byBase = extended.get(custom);
  if (!byBase) extended.set(custom, (byBase = new Map()));
  let dict = byBase.get(base);
  if (!dict) byBase.set(base, (dict = extendDictionary(base, custom.definition)));
  return dict;
}

/** The dictionary for a BeginString, with a firm's custom fields added when given. */
export function resolveDictionary(version: string, custom?: Custom): IndexedDictionary {
  return extend(dictionaryFor(version), custom);
}

/**
 * The dictionary a Logon is read with before a session exists, and a Logout
 * that refuses one is written with (see sessionLayerFor), with a firm's custom
 * fields added when given.
 */
export function resolveSessionLayer(version: string, custom?: Custom): IndexedDictionary {
  return extend(sessionLayerFor(version), custom);
}
