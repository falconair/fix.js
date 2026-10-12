/** fix.js/test: helpers for tests. Importing it defines no test: storeContract() defines its tests when it is called. */
export { fakeClock, type FakeClock } from './transport/clock.ts';
export { storeContract } from './transport/store-contract.ts';
export type { CloseReason } from './transport/types.ts';
