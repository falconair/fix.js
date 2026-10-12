import type { IndexedDictionary } from '../dictionary/index.ts';
import { INTEGER_TYPES } from '../dictionary/datatypes.ts';
import type { FieldInfo, GroupInfo, Member } from '../dictionary/model.ts';
import { FIXEncodeError } from '../errors.ts';
import { suggest } from '../util/suggest.ts';
import type { FramingOverrides, RawField } from './frame.ts';
import { decodeValue, encodeValue, valueProblem } from './values.ts';

/** A decoded message: named fields, groups as arrays of entries, unknown tags under their number. */
export type MessageObject = Readonly<Record<string, unknown>>;

const BEGIN_STRING = 8;
const BODY_LENGTH = 9;
const MSG_TYPE = 35;
const CHECK_SUM = 10;
const FRAMING: ReadonlySet<number> = new Set([BODY_LENGTH, CHECK_SUM]);

// ─── Decoding ───────────────────────────────────────────────────────────────

/**
 * Why a received message breaks the dictionary's rules. The names are
 * SessionRejectReason values. A runtime list, so entryFromJSON() (json.ts) can
 * check a stored or received Problem.code against it without duplicating the
 * names as a second, hand-written list.
 */
export const DECODE_PROBLEM_CODES = [
  'InvalidTagNumber', 'RequiredTagMissing', 'TagNotDefinedForThisMessageType',
  'TagSpecifiedWithoutAValue', 'ValueIsIncorrect', 'IncorrectDataFormatForValue',
  'InvalidMsgType', 'TagAppearsMoreThanOnce', 'TagSpecifiedOutOfRequiredOrder',
  'RepeatingGroupFieldsOutOfOrder', 'IncorrectNumInGroupCountForRepeatingGroup',
] as const;
export type DecodeProblemCode = typeof DECODE_PROBLEM_CODES[number];

export interface DecodeProblem {
  readonly code: DecodeProblemCode;
  /** The tag concerned (a Reject's RefTagID), when there is one. */
  readonly tag?: number;
  readonly text: string;
}

export interface Inspected {
  readonly message: MessageObject;
  readonly problems: readonly DecodeProblem[];
}

/** A member of a level (a message or a group); `index` is its place among the level's members. */
type LevelEntry =
  | { kind: 'field'; field: FieldInfo; required: boolean; index: number }
  | { kind: 'group'; group: GroupInfo; required: boolean; index: number };
const levels = new WeakMap<object, Map<number, LevelEntry>>();
const groupNames = new WeakMap<object, ReadonlySet<string>>();

/** Tags from this number up are a firm's own, not FIX's. */
export const FIRST_USER_DEFINED_TAG = 5000;

/** The parts of a message, in the order they must come. */
const HEADER = 0;
const BODY = 1;
const TRAILER = 2;
interface Parts { readonly header: ReadonlySet<number>; readonly trailer: ReadonlySet<number> }
const parts = new WeakMap<IndexedDictionary, Parts>();

/**
 * The tags that belong to the header and to the trailer; every other tag is the body's.
 * A group there (the header's HopGrp) belongs with its count tag and every field of its entries.
 */
function partsOf(dict: IndexedDictionary): Parts {
  const cached = parts.get(dict);
  if (cached) return cached;
  const tagsOf = (members: readonly Member[]): number[] => members.flatMap(member => {
    if (member.kind === 'field') return [member.tag];
    const group = dict.groupByName.get(member.name);
    return group ? [group.countTag, ...tagsOf(group.members)] : [];
  });
  const found = { header: new Set(tagsOf(dict.data.header)), trailer: new Set(tagsOf(dict.data.trailer)) };
  parts.set(dict, found);
  return found;
}

/** A field as problems name it: `Symbol (55)`, or `Tag 999` for one no dictionary knows. */
function label(tag: number, dict: IndexedDictionary): string {
  const name = dict.fieldByTag.get(tag)?.name;
  return name === undefined ? `Tag ${tag}` : `${name} (${tag})`;
}

const RAW = Symbol('fix.js raw values');

/**
 * Name and type a frame's fields using the dictionary. Never throws: anything
 * that breaks the dictionary's rules is listed in `problems`.
 */
export function inspectMessage(fields: readonly RawField[], dict: IndexedDictionary): Inspected {
  const msgType = fields.find(field => field.tag === MSG_TYPE)?.value;
  const message = msgType === undefined ? undefined : dict.messageByMsgType.get(msgType);
  const problems: DecodeProblem[] = [];
  if (msgType !== undefined && !message) {
    problems.push({ code: 'InvalidMsgType', tag: MSG_TYPE, text: `MsgType '${msgType}' is not defined in ${dict.version}` });
  }
  const members = [...dict.data.header, ...(message?.members ?? []), ...dict.data.trailer];
  const byTag = level(message ?? dict, members, dict);
  const out: Record<string, unknown> = {};
  readLevel(fields, { pos: 0 }, byTag, dict, out, undefined, problems);
  checkRequired(byTag, out, problems);
  out.MsgType = message?.name ?? msgType;
  const raw = new Map<number, string>();
  for (const field of fields) if (!raw.has(field.tag)) raw.set(field.tag, field.value);
  Object.defineProperty(out, RAW, { value: raw });
  return { message: Object.freeze(out), problems };
}

/** Name and type a frame's fields using the dictionary. */
export function toMessage(fields: readonly RawField[], dict: IndexedDictionary): MessageObject {
  return inspectMessage(fields, dict).message;
}

/** The exact wire text a received message carried for a tag (its first occurrence), e.g. to echo an ID byte for byte. */
export function rawValue(message: MessageObject, tag: number): string | undefined {
  return (message as { readonly [RAW]?: ReadonlyMap<number, string> })[RAW]?.get(tag);
}

/**
 * Read one level: a whole message (`within` undefined), or one entry of the
 * group `within`, which ends where the next entry or a field of another level
 * begins. Fields out of order are reported, once per level, and still read.
 * A user-defined tag (5000 and up) may come anywhere among a message's fields.
 */
function readLevel(
  fields: readonly RawField[], cursor: { pos: number }, byTag: Map<number, LevelEntry>,
  dict: IndexedDictionary, out: Record<string, unknown>, within: { readonly name: string; readonly first: number } | undefined, problems: DecodeProblem[],
): void {
  let started = false;
  let sawMsgType = false;
  /** A message: the part reached (header, body, trailer). A group entry: the place of the last member read. */
  let reached = 0;
  let inOrder = true;
  while (cursor.pos < fields.length) {
    const field = fields[cursor.pos]!;
    if (within && started && field.tag === within.first) return;      // the next entry begins
    const entry = byTag.get(field.tag);
    const place = within ? entry?.index : partOf(field.tag, dict);
    if (place !== undefined) {
      if (place < reached && inOrder) {
        inOrder = false;
        problems.push(within
          ? { code: 'RepeatingGroupFieldsOutOfOrder', tag: field.tag, text: `${label(field.tag, dict)} is out of order in its ${within.name} entry` }
          : { code: 'TagSpecifiedOutOfRequiredOrder', tag: field.tag, text: `${label(field.tag, dict)} is out of order: the header comes first, then the body, then the trailer` });
      }
      reached = Math.max(reached, place);
    }
    if (!entry) {
      if (within) return;                                              // the group has ended
      cursor.pos++;
      if (FRAMING.has(field.tag)) continue;
      problems.push(dict.fieldByTag.has(field.tag)
        ? { code: 'TagNotDefinedForThisMessageType', tag: field.tag, text: `${label(field.tag, dict)} is not defined for this message type` }
        : { code: 'InvalidTagNumber', tag: field.tag, text: `${label(field.tag, dict)} is not defined in ${dict.version}` });
      put(out, String(field.tag), field.value, field.tag, problems);
      continue;
    }
    started = true;
    cursor.pos++;
    if (entry.kind === 'field') {
      const tag = entry.field.tag;
      if (FRAMING.has(tag)) continue;
      if (tag === MSG_TYPE) {
        // MsgType is named once, by inspectMessage(), from its first occurrence: a repeat is a repeated tag like any other.
        if (sawMsgType) problems.push({ code: 'TagAppearsMoreThanOnce', tag, text: `Tag ${tag} appears more than once` });
        sawMsgType = true;
        continue;
      }
      const bad = valueProblem(entry.field, field.value) ?? lengthProblem(entry.field, field.value, dict);
      if (bad) problems.push({ ...bad, tag });
      put(out, entry.field.name, decodeValue(entry.field, field.value), tag, problems);
      continue;
    }
    const group = entry.group;
    const declared = Number(field.value);
    const groupLevel = level(group, group.members, dict);
    const first = firstTag(group, dict);
    const entries: MessageObject[] = [];
    while (entries.length < declared && fields[cursor.pos]?.tag === first) {
      const item: Record<string, unknown> = {};
      readLevel(fields, cursor, groupLevel, dict, item, { name: group.name, first }, problems);
      checkRequired(groupLevel, item, problems);
      entries.push(Object.freeze(item));
    }
    const next = fields[cursor.pos];
    if (entries.length < declared && next !== undefined && groupLevel.has(next.tag)) {
      // More entries were promised, and what follows is of this group, but not its first field.
      problems.push({
        code: 'RepeatingGroupFieldsOutOfOrder', tag: next.tag,
        text: `Each ${group.name} entry must begin with ${label(first, dict)}, not ${label(next.tag, dict)}`,
      });
    } else if (!Number.isInteger(declared) || entries.length !== declared) {
      problems.push({
        code: 'IncorrectNumInGroupCountForRepeatingGroup', tag: group.countTag,
        text: `${label(group.countTag, dict)} says ${field.value} but ${entries.length} ${group.name} entries follow`,
      });
    }
    put(out, group.name, Object.freeze(entries), group.countTag, problems);
  }
}

/** The tags of the fields that give the length of a raw data field: each stands right before it in its message, group, header or trailer. Cached per dictionary. */
const lengthTags = new WeakMap<IndexedDictionary, ReadonlySet<number>>();
function lengthTagsOf(dict: IndexedDictionary): ReadonlySet<number> {
  let found = lengthTags.get(dict);
  if (!found) {
    const tags = new Set<number>();
    const lists = [dict.data.header, dict.data.trailer, ...dict.data.messages.map(message => message.members), ...dict.data.groups.map(group => group.members)];
    for (const members of lists) {
      members.forEach((member, index) => {
        const before = members[index - 1];
        if (member.kind === 'field' && dict.dataTags.has(member.tag) && before?.kind === 'field') tags.add(before.tag);
      });
    }
    lengthTags.set(dict, found = tags);
  }
  return found;
}

/**
 * A length is a count of bytes: a whole-number field that gives the length of a raw data field must have no sign.
 * (valueProblem() takes a Length so; FIX 4.2 types such a field as an int, which may be negative.)
 */
function lengthProblem(field: FieldInfo, text: string, dict: IndexedDictionary): { code: 'IncorrectDataFormatForValue'; text: string } | undefined {
  if (!INTEGER_TYPES.has(field.type) || !lengthTagsOf(dict).has(field.tag) || !/^-\d+$/.test(text)) return undefined;
  return { code: 'IncorrectDataFormatForValue', text: `${field.name} (${field.tag}) has a malformed value '${text}'` };
}

/** Every required member of a level must be present. BodyLength, CheckSum and MsgType are checked elsewhere. */
function checkRequired(byTag: Map<number, LevelEntry>, out: Record<string, unknown>, problems: DecodeProblem[]): void {
  for (const [tag, entry] of byTag) {
    if (!entry.required || FRAMING.has(tag) || tag === MSG_TYPE) continue;
    const name = entry.kind === 'field' ? entry.field.name : entry.group.name;
    if (!(name in out)) problems.push({ code: 'RequiredTagMissing', tag, text: `${name} (${tag}) is required` });
  }
}

/** The names of the groups a level (a message with its header and trailer, or a group) holds, cached per definition. */
function groupsHeld(key: object, members: () => readonly Member[]): ReadonlySet<string> {
  let names = groupNames.get(key);
  if (!names) {
    names = new Set(members().flatMap(member => (member.kind === 'group' ? [member.name] : [])));
    groupNames.set(key, names);
  }
  return names;
}

/** Tag → member lookup for one level (a message or a group), cached per definition. */
function level(key: object, members: readonly Member[], dict: IndexedDictionary): Map<number, LevelEntry> {
  const cached = levels.get(key);
  if (cached) return cached;
  const byTag = new Map<number, LevelEntry>();
  members.forEach((member, index) => {
    if (member.kind === 'field') {
      const field = dict.fieldByTag.get(member.tag);
      if (field && !byTag.has(field.tag)) byTag.set(field.tag, { kind: 'field', field, required: member.required, index });
    } else {
      const group = dict.groupByName.get(member.name);
      if (group && !byTag.has(group.countTag)) byTag.set(group.countTag, { kind: 'group', group, required: member.required, index });
    }
  });
  levels.set(key, byTag);
  return byTag;
}

/** The part of a message a tag belongs to; a user-defined tag belongs to none, so it may come anywhere. */
function partOf(tag: number, dict: IndexedDictionary): number | undefined {
  if (tag >= FIRST_USER_DEFINED_TAG) return undefined;
  const { header, trailer } = partsOf(dict);
  return trailer.has(tag) ? TRAILER : header.has(tag) ? HEADER : BODY;
}

function firstTag(group: GroupInfo, dict: IndexedDictionary): number {
  const first = group.members[0];
  if (!first) throw new Error(`Group ${group.name} has no members`);
  if (first.kind === 'field') return first.tag;
  const nested = dict.groupByName.get(first.name);
  if (!nested) throw new Error(`Group ${group.name} starts with unknown group ${first.name}`);
  return nested.countTag;
}

/** Keep the first value of a repeated tag, and report the repeat. */
function put(out: Record<string, unknown>, key: string, value: unknown, tag: number, problems: DecodeProblem[]): void {
  if (key in out) {
    problems.push({ code: 'TagAppearsMoreThanOnce', tag, text: `Tag ${tag} appears more than once` });
    return;
  }
  out[key] = value;
}

// ─── Encoding ───────────────────────────────────────────────────────────────

export interface EncodeContext {
  /** BeginString when the message doesn't give one. */
  version: string;
  /** Clock for TransactTime. Default: the current time. */
  now?: () => Date;
}

export interface Encoded {
  /** In wire order, without BodyLength (9) and CheckSum (10). */
  readonly fields: RawField[];
  readonly framing: FramingOverrides;
}

interface Given {
  /** Fields by tag. `raw` means the value is wire text from a numeric key. */
  readonly byTag: Map<number, { value: unknown; raw: boolean }>;
  readonly groups: Map<string, unknown>;
  readonly framing: FramingOverrides;
}

/** Order and encode a message's fields. Doesn't add session fields (CompIDs, MsgSeqNum, SendingTime). */
export function fromMessage(type: string, input: Readonly<Record<string, unknown>>, dict: IndexedDictionary, context: EncodeContext): Encoded {
  const message = dict.messageByName.get(type);
  if (!message) {
    const hint = suggest(type, dict.messageByName.keys());
    throw new FIXEncodeError(`Unknown message type '${type}'${hint ? `. Did you mean '${hint}'?` : ''}`);
  }
  const given = collect(input, dict, type, groupsHeld(message, () => [...dict.data.header, ...message.members, ...dict.data.trailer]));
  const transactTime = dict.fieldByName.get('TransactTime');
  if (transactTime && !given.byTag.has(transactTime.tag) && message.members.some(m => m.kind === 'field' && m.tag === transactTime.tag)) {
    given.byTag.set(transactTime.tag, { value: (context.now ?? (() => new Date()))(), raw: false });
  }

  const out: RawField[] = [];
  const begin = given.byTag.get(BEGIN_STRING);
  given.byTag.delete(BEGIN_STRING);
  if (begin === undefined) out.push({ tag: BEGIN_STRING, value: context.version });
  else if (begin.value !== null) out.push({ tag: BEGIN_STRING, value: String(begin.value) });

  const msgType = given.byTag.get(MSG_TYPE);
  given.byTag.delete(MSG_TYPE);
  if (msgType === undefined) out.push({ tag: MSG_TYPE, value: message.msgType });
  else if (msgType.value !== null) out.push({ tag: MSG_TYPE, value: String(msgType.value) });

  emitMembers(dict.data.header, given, dict, out, undefined);
  emitMembers(message.members, given, dict, out, type);
  emitRest(given, dict, out, partsOf(dict).trailer);
  emitMembers(dict.data.trailer, given, dict, out, undefined);
  return { fields: out, framing: given.framing };
}

/**
 * Sort the input's keys into fields (by tag), groups and framing, rejecting unknown names.
 * `groupsHere`: the names of the groups this level (a message, or a group entry) holds. A name that
 * is both a group and a field (RateSource, in FIX 5.0 SP2) is the group where the level holds that group.
 */
function collect(input: Readonly<Record<string, unknown>>, dict: IndexedDictionary, type: string | undefined, groupsHere: ReadonlySet<string>): Given {
  const byTag = new Map<number, { value: unknown; raw: boolean }>();
  const groups = new Map<string, unknown>();
  const framing: FramingOverrides = {};
  let hasBodyLength = false;
  let hasCheckSum = false;
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (/^\d+$/.test(key)) {
      const tag = Number(key);
      if (tag === BODY_LENGTH) {
        if (hasBodyLength) throw new FIXEncodeError(`BodyLength is given twice (also as tag ${BODY_LENGTH})`);
        hasBodyLength = true;
        framing.bodyLength = value === null ? null : String(value);
      } else if (tag === CHECK_SUM) {
        if (hasCheckSum) throw new FIXEncodeError(`CheckSum is given twice (also as tag ${CHECK_SUM})`);
        hasCheckSum = true;
        framing.checkSum = value === null ? null : String(value);
      } else {
        if (byTag.has(tag)) throw new FIXEncodeError(`Tag ${tag} is given twice`);
        byTag.set(tag, { value, raw: true });
      }
    } else if (key === 'MsgType' && type !== undefined) {
      if (value !== type) throw new FIXEncodeError(`MsgType '${String(value)}' doesn't match the message type '${type}'`);
    } else if (key === 'BodyLength') {
      if (hasBodyLength) throw new FIXEncodeError(`BodyLength is given twice (also as tag ${BODY_LENGTH})`);
      hasBodyLength = true;
      framing.bodyLength = value === null ? null : String(value);
    } else if (key === 'CheckSum') {
      if (hasCheckSum) throw new FIXEncodeError(`CheckSum is given twice (also as tag ${CHECK_SUM})`);
      hasCheckSum = true;
      framing.checkSum = value === null ? null : String(value);
    } else if (groupsHere.has(key)) {
      groups.set(key, value);
    } else if (dict.fieldByName.has(key)) {
      const field = dict.fieldByName.get(key)!;
      if (byTag.has(field.tag)) throw new FIXEncodeError(`${key} is given twice (also as tag ${field.tag})`);
      byTag.set(field.tag, { value, raw: false });
    } else if (dict.groupByName.has(key)) {
      groups.set(key, value);
    } else {
      const hint = suggest(key, [...dict.fieldByName.keys(), ...dict.groupByName.keys()]);
      throw new FIXEncodeError(`Unknown field '${key}'${hint ? `. Did you mean '${hint}'?` : ''}`);
    }
  }
  return { byTag, groups, framing };
}

/** Emit members in order. `requiredBy` names the message or group whose required members must be present. */
function emitMembers(members: readonly Member[], given: Given, dict: IndexedDictionary, out: RawField[], requiredBy: string | undefined): void {
  for (const member of members) {
    if (member.kind === 'field') {
      if (member.tag === BEGIN_STRING || member.tag === MSG_TYPE || FRAMING.has(member.tag)) continue;
      const field = dict.fieldByTag.get(member.tag);
      const entry = given.byTag.get(member.tag);
      if (!field) continue;
      if (entry === undefined) {
        if (requiredBy && member.required) throw missing(requiredBy, field.name, label(field.tag, dict));
        continue;
      }
      given.byTag.delete(member.tag);
      if (entry.value !== null) out.push({ tag: field.tag, value: entry.raw ? String(entry.value) : encodeValue(field, entry.value) });
      continue;
    }
    const group = dict.groupByName.get(member.name);
    const entries = given.groups.get(member.name);
    if (!group) continue;
    if (entries === undefined) {
      if (requiredBy && member.required) throw missing(requiredBy, member.name, member.name);
      continue;
    }
    given.groups.delete(member.name);
    if (entries === null) continue;
    if (!Array.isArray(entries)) throw new FIXEncodeError(`${member.name} must be an array of entries`);
    out.push({ tag: group.countTag, value: String(entries.length) });
    for (const item of entries) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new FIXEncodeError(`Each ${member.name} entry must be an object of fields`);
      }
      const nested = collect(item as Readonly<Record<string, unknown>>, dict, undefined, groupsHeld(group, () => group.members));
      emitMembers(group.members, nested, dict, out, `Each ${member.name} entry`);
      emitRest(nested, dict, out, new Set());
    }
  }
}

/** Fields given that aren't members here: known fields first, then custom tags. */
function emitRest(given: Given, dict: IndexedDictionary, out: RawField[], keep: ReadonlySet<number>): void {
  for (const [tag, entry] of given.byTag) {
    if (keep.has(tag)) continue;
    given.byTag.delete(tag);
    if (entry.value === null) continue;
    const field = dict.fieldByTag.get(tag);
    out.push({ tag, value: entry.raw || !field ? String(entry.value) : encodeValue(field, entry.value) });
  }
  const leftover = [...given.groups.keys()];
  if (leftover.length) throw new FIXEncodeError(`${leftover.join(', ')} is not a group of this message`);
}

function missing(requiredBy: string, name: string, label: string): FIXEncodeError {
  return new FIXEncodeError(`${requiredBy} requires ${label}. Write ${name}: null to leave it out on purpose.`);
}
