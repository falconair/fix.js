/** The BeginString of the session layer that carries FIX 5.0 and later. */
export const FIXT11 = 'FIXT.1.1';

/** The BeginStrings fix.js speaks. FIXT.1.1 carries FIX 5.0 and later: see ApplVerID. */
export const Version = { 'FIX.4.2': 'FIX.4.2', 'FIX.4.4': 'FIX.4.4', 'FIXT.1.1': 'FIXT.1.1' } as const;
export type Version = keyof typeof Version;

export const VERSIONS: readonly Version[] = ['FIX.4.2', 'FIX.4.4', 'FIXT.1.1'];

export function isVersion(value: unknown): value is Version {
  return typeof value === 'string' && Object.hasOwn(Version, value);
}

/**
 * The application versions fix.js reads over FIXT.1.1, by the names FIX gives
 * the values of ApplVerID (1128) and DefaultApplVerID (1137). All four are
 * read with one dictionary: FIX 5.0 SP2 with every extension pack since.
 */
export const ApplVerID = { FIX50: 'FIX50', FIX50SP1: 'FIX50SP1', FIX50SP2: 'FIX50SP2', FIXLatest: 'FIXLatest' } as const;
export type ApplVerID = keyof typeof ApplVerID;

export const APPL_VER_IDS: readonly ApplVerID[] = ['FIX50', 'FIX50SP1', 'FIX50SP2', 'FIXLatest'];

/** The application versions by the text FIX puts on the wire for DefaultApplVerID (1137) and ApplVerID (1128). */
export const APPL_VER_ID_WIRE: Readonly<Record<ApplVerID, string>> = { FIX50: '7', FIX50SP1: '8', FIX50SP2: '9', FIXLatest: '10' };

/** What a Logon of ours names as DefaultApplVerID unless told otherwise. */
export const DEFAULT_APPL_VER_ID: ApplVerID = 'FIX50SP2';

export function isApplVerID(value: unknown): value is ApplVerID {
  return typeof value === 'string' && Object.hasOwn(ApplVerID, value);
}

/** A list in words: 'a, b or c'. */
export function oneOf(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}

/**
 * A value a counterparty sent, as a text of ours quotes it: plain ASCII, at most its first 32 characters
 * (then "..." when there is more), and every character outside the printable ones (0x20 to 0x7e) a "?".
 */
export function excerpt(value: unknown): string {
  const text = String(value);
  const head = text.length > 32 ? text.slice(0, 32) : text;
  return head.replace(/[^\x20-\x7e]/g, '?') + (text.length > 32 ? '...' : '');
}
