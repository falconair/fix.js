import type { DictionaryData, FieldInfo, Member, UnionType } from '../src/dictionary/model.ts';
import { kindOf } from '../src/dictionary/datatypes.ts';
import { inUnion, unionDescription } from '../src/wire/values.ts';

/** Header fields that are not message fields: BodyLength, MsgType, CheckSum. */
const NOT_IN_HEADER: ReadonlySet<number> = new Set([9, 35, 10]);
const NONE: ReadonlySet<number> = new Set();
/** Generated names that would shadow globals the generated file itself uses. */
const RESERVED = new Set(['Date', 'Readonly', 'Record', 'Array', 'String', 'Number', 'Boolean', 'Object', 'Symbol']);

/** The type of the values an open code set takes beside its names. */
const OPEN_FORM: Readonly<Record<UnionType, string>> = {
  Reserved100Plus: '`${number}`',
  Reserved1000Plus: '`${number}`',
  Reserved4000Plus: '`${number}`',
  Qty: '`${number}`',
  Tenor: "`${'D' | 'M' | 'W' | 'Y'}${number}`",
};

/** The dictionary tables as a TypeScript module. */
export function generateData(data: DictionaryData): string {
  for (const field of data.fields) checkOpenCodeSet(field);
  return `import type { DictionaryData } from './model.ts';\n\nexport const data: DictionaryData = ${JSON.stringify(data, null, 1)};\n`;
}

/** The name of a code in an open code set must not be a text of the form it is open to: wire text 5 would be read as the name '5' and written back as that code's value. */
function checkOpenCodeSet(field: FieldInfo): void {
  if (!field.union) return;
  for (const code of field.codes ?? []) {
    if (inUnion(field, code.name)) {
      throw new Error(`${field.name} (${field.tag}) is open to ${unionDescription(field.union)}, and its code ${code.name} (${code.value}) has a name that is one`);
    }
  }
}

/**
 * The dictionary tables as JSON, for a dictionary too large to load as a
 * module: one field, group or message to a line, so a change to the source
 * shows as the lines that changed.
 */
export function generateJson(data: DictionaryData): string {
  for (const field of data.fields) checkOpenCodeSet(field);
  const list = (items: readonly unknown[]): string => `[\n${items.map(item => JSON.stringify(item)).join(',\n')}\n]`;
  return `{"version":${JSON.stringify(data.version)},\n"fields":${list(data.fields)},\n"groups":${list(data.groups)},\n`
    + `"messages":${list(data.messages)},\n"header":${JSON.stringify(data.header)},\n"trailer":${JSON.stringify(data.trailer)}}\n`;
}

const BEGIN_STRING = 8;
/** MsgType (35) and RefMsgType (372): their values are the messages there are. */
const MSG_TYPE_TAGS: ReadonlySet<number> = new Set([35, 372]);

/**
 * A session layer and the application layer it carries, as one dictionary
 * (FIXT.1.1 with FIX 5.0 SP2). The header, the trailer and the session
 * messages are the session layer's; every other message is the application
 * layer's (its own session messages are left out). A field or group both
 * define is the session layer's. MsgType and RefMsgType take one value for
 * each message of the result, named as the message is. BeginString is plain
 * text: a session compares it with its version.
 *
 * Throws where the two cannot be told apart safely: an application message
 * that is also a session message, two fields of one name, or a group the two
 * layers define differently.
 */
export function composeDictionary(session: DictionaryData, application: DictionaryData): DictionaryData {
  const sessionTypes = new Set(session.messages.map(message => message.msgType));
  const sessionNames = new Set(session.messages.map(message => message.name));
  const carried = application.messages.filter(message => !message.admin);
  for (const message of carried) {
    if (sessionTypes.has(message.msgType) || sessionNames.has(message.name)) {
      throw new Error(`Application message ${message.name} (${message.msgType}) is also a session message`);
    }
  }
  const messages = [...session.messages, ...carried];
  const codes = messages.map(message => ({ name: message.name, value: message.msgType }));
  const sessionTags = new Set(session.fields.map(field => field.tag));
  const fields = [...session.fields, ...application.fields.filter(field => !sessionTags.has(field.tag))].map((field): FieldInfo => {
    if (MSG_TYPE_TAGS.has(field.tag)) return { tag: field.tag, name: field.name, type: field.type, codes };
    if (field.tag === BEGIN_STRING) return { tag: field.tag, name: field.name, type: field.type };
    return field;
  });
  const tagByName = new Map<string, number>();
  for (const field of fields) {
    const other = tagByName.get(field.name);
    if (other !== undefined) throw new Error(`Fields ${other} and ${field.tag} are both named ${field.name}`);
    tagByName.set(field.name, field.tag);
  }
  const sessionGroups = new Map(session.groups.map(group => [group.name, group]));
  for (const group of application.groups) {
    const own = sessionGroups.get(group.name);
    if (own && JSON.stringify(own) !== JSON.stringify(group)) {
      throw new Error(`Group ${group.name} differs between the session layer and the application layer`);
    }
  }
  const groups = [...session.groups, ...application.groups.filter(group => !sessionGroups.has(group.name))];
  return { version: session.version, fields, groups, messages, header: session.header, trailer: session.trailer };
}

const REF_MSG_TYPE = 372;

/**
 * A session layer as it is used on its own, to read a Logon before a session
 * exists. A Logon may list the application messages its sender sends and
 * receives, each by RefMsgType: here RefMsgType takes one value for each
 * message of `composed` (this session layer with the application layer it
 * carries), so on its own the layer reads them by the names the composed
 * dictionary does. Nothing else changes: its MsgType is the session messages'.
 */
export function sessionLayerAlone(session: DictionaryData, composed: DictionaryData): DictionaryData {
  const codes = composed.messages.map(message => ({ name: message.name, value: message.msgType }));
  const fields = session.fields.map((field): FieldInfo => (field.tag === REF_MSG_TYPE ? { tag: field.tag, name: field.name, type: field.type, codes } : field));
  return { ...session, fields };
}

/** Types and enum constants for a dictionary, as a TypeScript module. */
export function generateTypes(data: DictionaryData): string {
  const fieldsByTag = new Map(data.fields.map(field => [field.tag, field]));
  const claimed = new Set<string>();
  const claim = (name: string) => {
    if (RESERVED.has(name)) throw new Error(`Generated name '${name}' would shadow a global`);
    if (claimed.has(name)) throw new Error(`Generated name '${name}' is used twice`);
    claimed.add(name);
    return name;
  };
  const out: string[] = [];

  for (const field of data.fields) {
    const kind = kindOf(field);
    if (kind !== 'enum' && kind !== 'multiEnum') continue;
    const names = (field.codes ?? []).map(code => code.name);
    claim(field.name);
    const forms = [...names.map(n => `'${n}'`), ...(field.union ? [OPEN_FORM[field.union]] : [])];
    out.push(`export type ${field.name} = ${forms.length ? forms.join(' | ') : 'string'};`);
    out.push(`export const ${field.name} = { ${names.map(n => `${n}: '${n}'`).join(', ')} } as const;`);
  }

  claim('Header');
  out.push(`export interface Header {\n${memberLines([...data.header, ...data.trailer], fieldsByTag, NOT_IN_HEADER, '  ').join('\n')}\n}`);
  claim('Framing');
  out.push('export interface Framing {\n  BodyLength: number;\n  CheckSum: string;\n}');

  for (const group of data.groups) {
    const name = claim(`${group.name}Group`);
    out.push(`export interface ${name} {\n${memberLines(group.members, fieldsByTag, NONE, '  ').join('\n')}\n}`);
  }

  claim('Messages');
  const bodies = data.messages.map(message =>
    `  ${message.name}: {\n${memberLines(message.members, fieldsByTag, NONE, '    ').join('\n')}\n  };`);
  out.push(`export interface Messages {\n${bodies.join('\n')}\n}`);

  claim('MsgTypeName');
  out.push('export type MsgTypeName = keyof Messages;');
  claim('AdminMsgType');
  const admin = data.messages.filter(message => message.admin).map(message => `'${message.name}'`);
  out.push(`export type AdminMsgType = ${admin.length ? admin.join(' | ') : 'never'};`);

  return `${out.join('\n\n')}\n`;
}

function memberLines(members: readonly Member[], fieldsByTag: ReadonlyMap<number, FieldInfo>, skip: ReadonlySet<number>, indent: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const member of members) {
    if (member.kind === 'field' && skip.has(member.tag)) continue;
    const name = member.kind === 'field' ? fieldNamed(fieldsByTag, member.tag).name : member.name;
    if (seen.has(name)) continue;
    seen.add(name);
    const type = member.kind === 'field' ? tsType(fieldNamed(fieldsByTag, member.tag)) : `readonly ${member.name}Group[]`;
    lines.push(`${indent}${name}${member.required ? '' : '?'}: ${type};`);
  }
  return lines;
}

function fieldNamed(fieldsByTag: ReadonlyMap<number, FieldInfo>, tag: number): FieldInfo {
  const field = fieldsByTag.get(tag);
  if (!field) throw new Error(`A member refers to tag ${tag}, which isn't a defined field`);
  return field;
}

function tsType(field: FieldInfo): string {
  switch (kindOf(field)) {
    case 'boolean': return 'boolean';
    case 'enum': return field.name;
    case 'multiEnum': return `readonly ${field.name}[]`;
    case 'number': return 'number';
    case 'timestamp': return 'Date';
    case 'data':
    case 'string': return 'string';
  }
}
