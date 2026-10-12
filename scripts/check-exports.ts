/**
 * Part of `npm run check:api`. TypeScript can list a module's values but not
 * its types, so api/conformance.ts names the type exports itself (TypeExports,
 * TestTypeExports); this checks those lists against the source:
 *
 * - every type src/index.ts (src/test.ts) exports by name is listed, and every
 *   listed name is exported;
 * - every type the spec (api/index.d.ts, api/test.d.ts) exports by name is
 *   listed or marked as later (LaterTypes), and every later name is in the spec.
 *
 * `export *` is left out on both sides: the generated FIX 4.4 types stand for
 * the spec's dictionary. Whether each listed type agrees is up to tsc.
 */
import { readFileSync } from 'node:fs';

/** The types a module's source exports by name: interfaces, type aliases, and `type` re-exports. */
export function typeExports(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/^\s*export\s+(?:declare\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/gm)) names.add(match[1]!);
  for (const match of source.matchAll(/^\s*export\s+(type\s+)?\{([^}]*)\}/gm)) {
    const allTypes = match[1] !== undefined;
    for (const part of match[2]!.split(',')) {
      const item = part.trim();
      if (!item) continue;
      const isType = allTypes || item.startsWith('type ');
      if (!isType) continue;
      const name = item.replace(/^type\s+/, '').split(/\s+as\s+/).at(-1)!.trim();
      names.add(name);
    }
  }
  return names;
}

/** The keys of `type <name> = { … };` in a source file. */
export function listedNames(source: string, name: string): Set<string> {
  const block = new RegExp(`^type ${name} = \\{([\\s\\S]*?)^\\};`, 'm').exec(source);
  if (!block) throw new Error(`api/conformance.ts has no type ${name} = { … }`);
  return new Set([...block[1]!.matchAll(/^\s+([A-Za-z_$][\w$]*):/gm)].map(match => match[1]!));
}

/** The quoted names in `type <name> = 'A' | 'B';`. */
export function quotedNames(source: string, name: string): Set<string> {
  const line = new RegExp(`^type ${name} = ([^;]*);`, 'm').exec(source);
  if (!line) throw new Error(`api/conformance.ts has no type ${name} = '…'`);
  return new Set([...line[1]!.matchAll(/'([^']+)'/g)].map(match => match[1]!));
}

export interface ExportLists {
  /** Named type exports of the implementation module. */
  readonly impl: ReadonlySet<string>;
  /** What api/conformance.ts lists for it. */
  readonly listed: ReadonlySet<string>;
  /** Named type exports of the spec module. */
  readonly spec: ReadonlySet<string>;
  /** Spec types marked as not implemented yet. */
  readonly later: ReadonlySet<string>;
}

/** Every disagreement between the lists, as a sentence; empty when they agree. */
export function checkExports(lists: ExportLists, implFile: string): string[] {
  const problems: string[] = [];
  for (const name of lists.impl) if (!lists.listed.has(name)) problems.push(`${implFile} exports type ${name}, which api/conformance.ts does not list`);
  for (const name of lists.listed) if (!lists.impl.has(name)) problems.push(`api/conformance.ts lists ${name}, which ${implFile} does not export`);
  for (const name of lists.spec) {
    if (!lists.listed.has(name) && !lists.later.has(name)) problems.push(`the spec exports type ${name}, which api/conformance.ts neither lists nor marks as later`);
  }
  for (const name of lists.later) {
    if (!lists.spec.has(name)) problems.push(`api/conformance.ts marks ${name} as later, but the spec does not export it`);
    if (lists.listed.has(name)) problems.push(`api/conformance.ts both lists ${name} and marks it as later`);
  }
  return problems;
}

if (import.meta.main) {
  const read = (path: string) => readFileSync(path, 'utf8');
  const conformance = read('api/conformance.ts');
  const later = quotedNames(conformance, 'LaterTypes');
  const problems = [
    ...checkExports({ impl: typeExports(read('src/index.ts')), listed: listedNames(conformance, 'TypeExports'), spec: typeExports(read('api/index.d.ts')), later }, 'src/index.ts'),
    ...checkExports({ impl: typeExports(read('src/test.ts')), listed: listedNames(conformance, 'TestTypeExports'), spec: typeExports(read('api/test.d.ts')), later: new Set() }, 'src/test.ts'),
  ];
  for (const problem of problems) console.error(problem);
  process.exitCode = problems.length > 0 ? 1 : 0;
}
