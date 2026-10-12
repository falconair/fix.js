import { XMLParser } from 'fast-xml-parser';
import { UNION_TYPES, type CodeInfo, type DictionaryData, type FieldInfo, type GroupInfo, type Member, type MessageInfo, type UnionType } from '../src/dictionary/model.ts';

/** A node as fast-xml-parser returns it with preserveOrder: { tag: children, ':@': attributes }. */
type XmlNode = { [tag: string]: unknown; ':@'?: Record<string, string> };

const HEADER = 'StandardHeader';
const TRAILER = 'StandardTrailer';
/** Session-level MsgTypes (Heartbeat, TestRequest, ResendRequest, Reject, SequenceReset, Logout, Logon, XMLnonFIX). */
const ADMIN_MSG_TYPES = new Set(['0', '1', '2', '3', '4', '5', 'A', 'n']);

/** Parse a FIX Orchestra repository file into the dictionary data fix.js uses. */
export function parseOrchestra(xml: string): DictionaryData {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', preserveOrder: true });
  const repository = one(parser.parse(xml) as XmlNode[], 'fixr:repository');
  const sections = children(repository);
  const items = (section: string, item: string) => all(children(one(sections, section)), item);

  const codeSets = new Map<string, { type: string; codes: CodeInfo[] }>();
  for (const node of items('fixr:codeSets', 'fixr:codeSet')) {
    const codes = all(children(node), 'fixr:code').map(code => ({ name: attr(code, 'name'), value: attr(code, 'value') }));
    codeSets.set(attr(node, 'name'), { type: attr(node, 'type'), codes });
  }

  const fields: FieldInfo[] = items('fixr:fields', 'fixr:field').map(node => {
    const base = { tag: Number(attr(node, 'id')), name: attr(node, 'name') };
    const codeSet = codeSets.get(attr(node, 'type'));
    if (!codeSet) return { ...base, type: attr(node, 'type') };
    // A code set may be open: the field also takes any value of its union datatype.
    const union = node[':@']?.unionDataType;
    if (union === undefined) return { ...base, type: codeSet.type, codes: codeSet.codes };
    if (!(UNION_TYPES as readonly string[]).includes(union)) {
      throw new Error(`Field ${base.name} (${base.tag}) has the union datatype ${union}, which this parser does not know`);
    }
    return { ...base, type: codeSet.type, codes: codeSet.codes, union: union as UnionType };
  });

  const components = byId(items('fixr:components', 'fixr:component'));
  const groupNodes = byId(items('fixr:groups', 'fixr:group'));

  /** Members in order; components are inlined. A member is required only if every reference down to it is. */
  const flatten = (nodes: XmlNode[], required: boolean, skipHeaderAndTrailer: boolean): Member[] =>
    nodes.flatMap((node): Member[] => {
      const isRequired = required && node[':@']?.presence === 'required';
      switch (tagOf(node)) {
        case 'fixr:fieldRef':
          return [{ kind: 'field', tag: Number(attr(node, 'id')), required: isRequired }];
        case 'fixr:groupRef':
          return [{ kind: 'group', name: attr(lookup(groupNodes, attr(node, 'id')), 'name'), required: isRequired }];
        case 'fixr:componentRef': {
          const component = lookup(components, attr(node, 'id'));
          const name = attr(component, 'name');
          if (skipHeaderAndTrailer && (name === HEADER || name === TRAILER)) return [];
          return flatten(children(component), isRequired, skipHeaderAndTrailer);
        }
        default:
          return [];
      }
    });

  const groups: GroupInfo[] = [...groupNodes.values()].map(node => ({
    name: attr(node, 'name'),
    countTag: Number(attr(one(children(node), 'fixr:numInGroup'), 'id')),
    members: flatten(children(node), true, false),
  }));

  const messages: MessageInfo[] = items('fixr:messages', 'fixr:message').map(node => ({
    name: attr(node, 'name'),
    msgType: attr(node, 'msgType'),
    admin: ADMIN_MSG_TYPES.has(attr(node, 'msgType')),
    members: flatten(children(one(children(node), 'fixr:structure')), true, true),
  }));

  const componentNamed = (name: string) => {
    const component = [...components.values()].find(node => attr(node, 'name') === name);
    if (!component) throw new Error(`Orchestra file has no ${name} component`);
    return component;
  };

  return {
    version: attr(repository, 'name'),
    fields,
    groups,
    messages,
    header: flatten(children(componentNamed(HEADER)), true, false),
    trailer: flatten(children(componentNamed(TRAILER)), true, false),
  };
}

function tagOf(node: XmlNode): string | undefined {
  return Object.keys(node).find(key => key !== ':@');
}

function children(node: XmlNode): XmlNode[] {
  const tag = tagOf(node);
  return tag ? (node[tag] as XmlNode[]) : [];
}

function all(nodes: XmlNode[], tag: string): XmlNode[] {
  return nodes.filter(node => tagOf(node) === tag);
}

function one(nodes: XmlNode[], tag: string): XmlNode {
  const node = nodes.find(n => tagOf(n) === tag);
  if (!node) throw new Error(`Orchestra file has no <${tag}>`);
  return node;
}

function attr(node: XmlNode, name: string): string {
  const value = node[':@']?.[name];
  if (value === undefined) throw new Error(`<${tagOf(node)}> has no '${name}' attribute`);
  return value;
}

function byId(nodes: XmlNode[]): Map<string, XmlNode> {
  return new Map(nodes.map(node => [attr(node, 'id'), node]));
}

function lookup(nodes: Map<string, XmlNode>, id: string): XmlNode {
  const node = nodes.get(id);
  if (!node) throw new Error(`Orchestra file refers to id ${id}, which isn't defined`);
  return node;
}
