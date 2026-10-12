import type { FieldInfo, Member } from './model.ts';
import type { MsgTypeName } from './fix44.ts';
import { FIXT11 } from '../version.ts';
import { dictionaryFor, indexDictionary, type IndexedDictionary } from './index.ts';

export interface FieldDef {
  readonly tag: number;
  /** Default 'string'. A field with `values` is an enum and gets constants. */
  readonly type?: 'string' | 'int' | 'number' | 'boolean' | 'timestamp';
  /** Enum values: name → wire value. */
  readonly values?: Readonly<Record<string, string>>;
}

export interface DictionaryDef {
  readonly fields?: Readonly<Record<string, FieldDef>>;
  /** Which custom fields each message may carry. */
  readonly messages?: { readonly [K in MsgTypeName]?: readonly string[] };
}

type EnumConstants<D> =
  D extends { fields: infer F }
    ? { readonly [P in keyof F as F[P] extends { values: object } ? P : never]:
          F[P] extends { values: infer V } ? { readonly [N in keyof V & string]: N } : never }
    : {};

export type Dictionary<D extends DictionaryDef = {}> = { readonly definition: D } & EnumConstants<D>;

/**
 * Declare a firm's custom fields once. They then behave like standard FIX
 * fields: named, typed, and with constants for their values.
 */
export function defineDictionary<const D extends DictionaryDef>(definition: D): Dictionary<D> {
  // Validate eagerly, the same way extendDictionary would, against the FIX 4.2 and FIX 4.4 dictionaries.
  // FIXT.1.1's is large and read only when needed: here, for a message neither of those has; otherwise
  // when a FIXT.1.1 session, or a server that speaks FIXT.1.1, is given the definition.
  const versions = [dictionaryFor('FIX.4.2'), dictionaryFor('FIX.4.4')];
  for (const message of Object.keys(definition.messages ?? {})) {
    if (!versions.some(version => version.messageByName.has(message)) && !dictionaryFor(FIXT11).messageByName.has(message)) {
      throw new Error(`Custom dictionary lists unknown message ${message}`);
    }
  }
  for (const version of versions) extendDictionary(version, definition);
  const constants: Record<string, Record<string, string>> = {};
  for (const [name, field] of Object.entries(definition.fields ?? {})) {
    if (field.values) constants[name] = Object.freeze(Object.fromEntries(Object.keys(field.values).map(value => [value, value])));
  }
  return Object.freeze({ definition, ...constants }) as unknown as Dictionary<D>;
}

const DATATYPE = { string: 'String', int: 'int', number: 'float', boolean: 'Boolean', timestamp: 'UTCTimestamp' } as const;

/** A standard dictionary plus a firm's custom fields. The standard dictionary is not modified. */
export function extendDictionary(base: IndexedDictionary, definition: DictionaryDef): IndexedDictionary {
  const seenTags = new Map<number, string>();
  const custom: FieldInfo[] = Object.entries(definition.fields ?? {}).map(([name, field]) => {
    const existing = base.fieldByTag.get(field.tag);
    if (existing) throw new Error(`Custom field ${name} uses tag ${field.tag}, which is ${existing.name}`);
    if (base.fieldByName.has(name)) throw new Error(`Custom field ${name} has the same name as a standard field`);
    // A message that holds the group could not carry the field too: both would be written under the one name.
    if (base.groupByName.has(name)) throw new Error(`Custom field ${name} has the same name as a group of ${base.version}`);
    const dup = seenTags.get(field.tag);
    if (dup) throw new Error(`Custom fields ${dup} and ${name} both use tag ${field.tag}`);
    seenTags.set(field.tag, name);
    const info: FieldInfo = { tag: field.tag, name, type: DATATYPE[field.type ?? 'string'] };
    return field.values ? { ...info, codes: Object.entries(field.values).map(([code, value]) => ({ name: code, value })) } : info;
  });
  const tagOf = new Map(custom.map(field => [field.name, field.tag]));
  const extra = new Map(Object.entries(definition.messages ?? {}) as [string, readonly string[]][]);
  for (const [message, names] of extra) {
    if (!base.messageByName.has(message)) continue;   // belongs to a version other than this base
    for (const name of names) if (!tagOf.has(name)) throw new Error(`${message} lists ${name}, which isn't a custom field`);
  }
  const messages = base.data.messages.map(message => {
    const names = extra.get(message.name);
    if (!names) return message;
    const added: Member[] = names.map(name => ({ kind: 'field', tag: tagOf.get(name)!, required: false }));
    return { ...message, members: [...message.members, ...added] };
  });
  return indexDictionary({ ...base.data, fields: [...base.data.fields, ...custom], messages });
}
