/**
 * fix.js/test — the few helpers tests need beyond the session itself.
 * Waiting for a message is session.next(); waiting for an order is order.until().
 * Importing fix.js/test loads node:test, which storeContract() defines its
 * tests with; importing fix.js does not.
 */

import type { Session, Store, Clock, Duration, Where, CloseReason } from './index';
import type { MsgTypeName } from './dictionary';

/** Assert that no message of this type (with these field values) arrives for `duration`. */
export declare function expectNone<K extends MsgTypeName>(
  session: Session<any>, type: K, options: { where?: Where<K>; for: Duration },
): Promise<void>;

/** Fail if `promise` doesn't settle within `duration`. `await within(session.closed, '60s')`. */
export declare function within<T>(promise: Promise<T>, duration: Duration): Promise<T>;

/** A clock moved by hand, so heartbeat and timeout tests run instantly. */
export interface FakeClock extends Clock {
  advance(duration: Duration): Promise<void>;
}
export declare function fakeClock(start?: Date): FakeClock;

/**
 * Defines the tests every Store must pass, for a store of your own: the ones
 * the library's memoryStore and fileStore pass. A session closes when its
 * store breaks the contract, so run these before a session meets the store.
 *
 * The tests are node:test tests and use node:assert. Call storeContract at
 * the top level of a test file and run the file with `node --test`. Importing
 * fix.js/test defines no test: the tests are defined when storeContract is
 * called. Every test's name begins with `name`.
 *
 * Each test calls `make` once, for a store of its own, and uses nothing of
 * the store beyond the Store interface. `make` may give the store or a
 * promise of it. `cleanup` is called once with what `make` gave, when its
 * test is over, however it ended (passed, failed, out of time, or refused
 * because what `make` gave is not a store): close the store and remove what
 * it wrote there. What `cleanup` gives back is awaited when it is a promise,
 * and is not used, so `store => store.close()` will do whatever close()
 * returns. A test whose `make` throws fails with what it threw.
 *
 * A test has 10 s and fails when it takes longer; the limit is fixed. Its
 * `cleanup` has 10 s after it. A `cleanup` that throws, or has not settled
 * by then, fails its test; when the test had failed already, the test's own
 * failure is the one reported.
 *
 * The tests use three sessions, all with sender EXCHANGE: FIX.4.4 with target
 * CLIENT, FIX.4.4 with target NOBODY, and FIX.4.2 with target CLIENT. What
 * `make` gives must keep nothing for any of them. A store that is new each
 * time does; one that keeps what it is given between calls (a database file,
 * say) needs a new file each time, or `reset()` of the three sessions in
 * `make`. A test given a store whose load() shows something kept for one of
 * them fails, and says so.
 *
 * They cover append(), which is given records in lists, and sent(), which
 * answers a ResendRequest; and what a server's sessions ask of a store that
 * one session at a time does not: a SessionId that is a new object for every
 * call, two sessions appended to at the same moment, and two sessions that
 * differ in version alone. RangeError, when it is called, for a name that is
 * not text or is empty, a `make` or a `cleanup` that is not a function, and an
 * option it does not know.
 */
export declare function storeContract<S extends Store>(
  name: string,
  make: () => S | Promise<S>,
  options?: { cleanup?: (store: S) => unknown },
): void;

export type { CloseReason };
