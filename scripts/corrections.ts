import type { DictionaryData, FieldInfo, UnionType } from '../src/dictionary/model.ts';

/** A place where a FIX Orchestra file is wrong or silent and the FIX specification for that version is not: the field is open to this datatype. */
export interface Correction {
  readonly version: string;
  readonly tag: number;
  readonly union: UnionType;
  readonly reason: string;
}

export const CORRECTIONS: readonly Correction[] = [
  {
    version: 'FIX.4.2',
    tag: 27,
    union: 'Qty',
    reason: 'FIX 4.2 defines IOIShares as a number or S, M, L, and the Orchestra file lists only S, M and L (it has no unionDataType at all)',
  },
];

/** The dictionary with the corrections for its version applied. A correction that no longer fits stops the generator. */
export function correct(data: DictionaryData, corrections: readonly Correction[] = CORRECTIONS): DictionaryData {
  const mine = corrections.filter(c => c.version === data.version);
  if (mine.length === 0) return data;
  const fields = data.fields.map((field): FieldInfo => {
    const fix = mine.find(c => c.tag === field.tag);
    if (!fix) return field;
    if (!field.codes) throw new Error(`Correction for ${data.version}: ${field.name} (${field.tag}) has no code set to open`);
    if (field.union) throw new Error(`Correction for ${data.version}: ${field.name} (${field.tag}) is open already`);
    return { ...field, union: fix.union };
  });
  for (const fix of mine) {
    if (!data.fields.some(field => field.tag === fix.tag)) throw new Error(`Correction for ${data.version}: ${data.version} has no field ${fix.tag}`);
  }
  return { ...data, fields };
}

/** The generator reads files of these `versions`; a correction for any other version fits no file, and stops it. */
export function checkCorrectionsApply(versions: readonly string[], corrections: readonly Correction[] = CORRECTIONS): void {
  for (const fix of corrections) {
    if (!versions.includes(fix.version)) throw new Error(`Correction for ${fix.version}: none of the files generated is ${fix.version} (they are ${versions.join(', ')})`);
  }
}
