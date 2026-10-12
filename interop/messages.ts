// The application messages the interop tests send from the fix.js side.

export type InteropVersion = 'FIX.4.2' | 'FIX.4.4' | 'FIXT.1.1';

/** FIXT.1.1 carries FIX 5.0 SP2, whose order and fill are written as FIX 4.4's are. */
export const INTEROP_VERSIONS: readonly InteropVersion[] = ['FIX.4.2', 'FIX.4.4', 'FIXT.1.1'];

type Fields = Readonly<Record<string, unknown>>;

/** A NewOrderSingle: buy 100 IBM at 10, as a limit order. FIX 4.2 requires HandlInst. */
export function newOrder(version: InteropVersion, clOrdID: string): Fields {
  return {
    ClOrdID: clOrdID, Symbol: 'IBM', Side: 'Buy', OrderQty: 100, OrdType: 'Limit', Price: 10,
    ...(version === 'FIX.4.2' ? { HandlInst: 'AutomatedExecutionNoIntervention' } : {}),
  };
}

/** An ExecutionReport filling `order` in full at its price. FIX 4.2 requires ExecTransType, and calls the ExecType Fill. */
export function fill(version: InteropVersion, order: Fields, execID: string): Fields {
  return {
    OrderID: `ORDER-${String(order.ClOrdID)}`, ClOrdID: order.ClOrdID, ExecID: execID,
    ExecType: version === 'FIX.4.2' ? 'Fill' : 'Trade', OrdStatus: 'Filled',
    Symbol: order.Symbol, Side: order.Side, OrderQty: order.OrderQty,
    LastPx: order.Price, LeavesQty: 0, CumQty: order.OrderQty, AvgPx: order.Price,
    ...(version === 'FIX.4.2' ? { ExecTransType: 'New', LastShares: order.OrderQty } : { LastQty: order.OrderQty }),
  };
}
