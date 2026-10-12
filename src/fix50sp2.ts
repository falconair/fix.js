/**
 * fix.js/fix50sp2: the constants and types of FIX Latest, which is FIX 5.0 SP2
 * with every extension pack since, and what the library reads for a FIXT.1.1
 * session: a constant for every enum value and message type (Side.Buy,
 * MsgType.NewOrderSingle, ApplVerID.FIX50SP2, …) and the types of every
 * message, group and field. Generated from FIX Orchestra: the session layer
 * from FIXT.1.1, the application messages from FIX Latest.
 *
 * A value annotated with these types (`Messages['NewOrderSingle']`) is checked
 * against FIX Latest. A session's methods take any message type and any fields
 * today, so nothing a `send()` is given is checked.
 */
export * from './dictionary/fix50sp2.ts';
