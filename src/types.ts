import type { Framing, Header, Messages, MsgTypeName } from './dictionary/fix44.ts';

export type { MsgTypeName, AdminMsgType } from './dictionary/fix44.ts';

type FieldValue<F> =
  F extends { values: infer V } ? keyof V & string :
  F extends { type: 'int' | 'number' } ? number :
  F extends { type: 'boolean' } ? boolean :
  F extends { type: 'timestamp' } ? Date :
  string;

/** The custom fields dictionary D adds to message K (all optional). */
export type CustomFields<D, K> =
  D extends { fields: infer F; messages: infer M }
    ? K extends keyof M
      ? M[K] extends readonly (infer N)[]
        ? { [P in N & keyof F]?: FieldValue<F[P]> }
        : {}
      : {}
    : {};

/** Tags no dictionary knows: number → raw wire text. */
export interface RawTags {
  readonly [tag: number]: string;
}

/** A message of type K. BodyLength and CheckSum are not message fields. */
export type Message<K extends MsgTypeName = MsgTypeName, D = {}> =
  K extends MsgTypeName
    ? Readonly<{ MsgType: K } & Header & Messages[K] & CustomFields<D, K>> & RawTags
    : never;

type Nullable<T> = { [P in keyof T]: T[P] | null };
type Optional<T, F extends PropertyKey> = Omit<T, F & keyof T> & Partial<Pick<T, F & keyof T>>;

/** Body fields that are filled in automatically when left out. */
export type AutoFilledBodyField = 'TransactTime';

/**
 * The fields you write when sending message K: required body fields are
 * required (null to leave one out on purpose); header, framing and computable
 * fields are optional; numeric tags are raw wire text.
 */
export type Fields<K extends MsgTypeName, D = {}> =
  Nullable<Optional<Messages[K], AutoFilledBodyField>>
  & Partial<Nullable<Header & Framing>>
  & Partial<Nullable<CustomFields<D, K>>>
  & { [tag: number]: string | number | null };
