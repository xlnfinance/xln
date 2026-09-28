// Order book draws: same-j swaps, and the cross-j book and swap kinds. Owner: the "order book" area thread.
import { arises, pending, type Moves } from "./areas.ts";

export const ORDERBOOK: Moves<"orderbook"> = {
  initOrderbookExt: pending("a second token on the hub Accounts (same-j swaps)"),
  placeSwapOffer: pending("a hub order book over two tokens"),
  proposeCancelSwap: pending("a resting swap offer"),
  prepareCrossJurisdictionSwap: arises("scenario-cross-j.test.ts (two Runtimes)"),
  requestCrossJurisdictionClear: arises("scenario-cross-j.test.ts (two Runtimes)"),
  registerCrossJurisdictionSwap: arises("cross-j swap routing"),
  materializeCrossJurisdictionSwap: arises("cross-j swap routing"),
  materializeCrossJurisdictionClear: arises("cross-j clear routing"),
  admitCrossJurisdictionBookOrder: arises("cross-j book routing"),
  removeCrossJurisdictionBookOrder: arises("cross-j book routing"),
  crossJurisdictionBookOrderRemoved: arises("cross-j book routing"),
  crossJurisdictionFillNotice: arises("cross-j fills"),
  crossPullClose: arises("cross-j pull settlement"),
  orderbookSweepCrossJurisdiction: arises("the hub's cross-j book sweep"),
};
