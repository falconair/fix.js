import type { FieldInfo } from './model.ts';

/** Orchestra datatypes whose values are numbers. */
export const NUMBER_TYPES: ReadonlySet<string> = new Set([
  'int', 'Length', 'SeqNum', 'NumInGroup', 'TagNum', 'DayOfMonth',
  'float', 'Qty', 'Price', 'PriceOffset', 'Amt', 'Percentage',
]);

/** Orchestra datatypes whose values are whole numbers. */
export const INTEGER_TYPES: ReadonlySet<string> = new Set([
  'int', 'Length', 'SeqNum', 'NumInGroup', 'TagNum', 'DayOfMonth',
]);

/** Code-set base types whose values are space-separated lists. */
export const MULTI_VALUE_TYPES: ReadonlySet<string> = new Set([
  'MultipleValueString', 'MultipleCharValue', 'MultipleStringValue',
]);

/** Datatypes whose values are raw data: any byte, a field delimiter included, as many as the field before says. */
export const DATA_TYPES: ReadonlySet<string> = new Set(['data', 'XMLData']);

export type ValueKind = 'boolean' | 'enum' | 'multiEnum' | 'number' | 'timestamp' | 'data' | 'string';

/** How a field's values are represented in a message object. */
export function kindOf(field: FieldInfo): ValueKind {
  if (field.type === 'Boolean') return 'boolean';
  if (field.codes) return MULTI_VALUE_TYPES.has(field.type) ? 'multiEnum' : 'enum';
  if (NUMBER_TYPES.has(field.type)) return 'number';
  if (field.type === 'UTCTimestamp') return 'timestamp';
  if (DATA_TYPES.has(field.type)) return 'data';
  return 'string';
}
