// The money rules of one Account and one token (spec/money/ledger.scm): seven transitions, each a function
// Ledger -> Result<Ledger, AccountFault>. Every transition that can push the allocation out of its credit is the same
// thing written once: take the step, keep it only if RCPAN still holds.
import { err, flatMap, map, ok, type Result } from "../kernel/core/result.ts";
import type { AccountFault, Hold, Ledger, Side } from "./model.ts";
import { other } from "./model.ts";

/** Amounts and credit limits are uint256 on the chain and in every signed message. */
export const MAX_AMOUNT = 2n ** 256n - 1n;

export const emptyLedger: Ledger =
  { collateral: 0n, ondelta: 0n, offdelta: 0n, limit: { left: 0n, right: 0n }, holds: [] };

export const allocation = (l: Ledger): bigint => l.ondelta + l.offdelta;

/** What `side` has open in holds: what the ledger must still be able to cover if they all pay. */
export const held = (l: Ledger, side: Side): bigint =>
  l.holds.filter((h) => h.payer === side).reduce((sum, h) => sum + h.amount, 0n);

/** RCPAN: in the worst case over every open hold, the allocation stays in [-limit.left, collateral + limit.right]. */
const staysWithinCredit = (l: Ledger): boolean =>
  allocation(l) - held(l, "left") >= -l.limit.left && allocation(l) + held(l, "right") <= l.collateral + l.limit.right;

const atLeastZero = (n: bigint): bigint => (n > 0n ? n : 0n);

/** How much `side` may still pay or lock: its allocation plus the credit extended to it, less what it has held. */
export const room = (l: Ledger, side: Side): bigint =>
  atLeastZero(side === "left"
    ? allocation(l) + l.limit.left - held(l, "left")
    : l.collateral + l.limit.right - allocation(l) - held(l, "right"));

type Step = Result<Ledger, AccountFault>;

const keptIfRcpan = (next: Ledger, refusal: AccountFault): Step => (staysWithinCredit(next) ? ok(next) : err(refusal));

const amountInRange = (amount: bigint): Result<bigint, AccountFault> =>
  (amount >= 1n && amount <= MAX_AMOUNT ? ok(amount) : err({ _tag: "bad_amount", amount }));

const creditInRange = (limit: bigint): Result<bigint, AccountFault> =>
  (limit >= 0n && limit <= MAX_AMOUNT ? ok(limit) : err({ _tag: "bad_credit", limit }));

/** Left's allocation falls when Left pays and rises when Right pays. */
const afterPayment = (l: Ledger, payer: Side, n: bigint): Ledger =>
  ({ ...l, offdelta: payer === "left" ? l.offdelta - n : l.offdelta + n });

const lacksRoom = (l: Ledger, payer: Side, requested: bigint): AccountFault =>
  ({ _tag: "insufficient_capacity", available: room(l, payer), requested });

export const pay = (l: Ledger, payer: Side, amount: bigint): Step =>
  flatMap(amountInRange(amount), (n) => keptIfRcpan(afterPayment(l, payer, n), lacksRoom(l, payer, n)));

const beyondCollateral = (l: Ledger, requested: bigint): AccountFault =>
  ({ _tag: "withdrawal_beyond_collateral", collateral: l.collateral, requested });

/** `by` extends `limit` to its peer, so the limit that changes is the peer's. */
export const setCredit = (l: Ledger, by: Side, limit: bigint): Step =>
  flatMap(creditInRange(limit), (n) =>
    keptIfRcpan({ ...l, limit: { ...l.limit, [other(by)]: n } }, { _tag: "credit_below_usage" }));

export const lock = (l: Ledger, payer: Side, amount: bigint): Step =>
  flatMap(amountInRange(amount), (n) =>
    held(l, payer) + n > MAX_AMOUNT
      ? err({ _tag: "hold_overflow", held: held(l, payer), requested: n })
      : keptIfRcpan({ ...l, holds: [...l.holds, { payer, amount: n }] }, lacksRoom(l, payer, n)));

const holdAt = (l: Ledger, index: number): Result<Hold, AccountFault> => {
  const hold = l.holds[index];
  return hold === undefined ? err({ _tag: "no_such_hold", index }) : ok(hold);
};

const without = (l: Ledger, index: number): Ledger => ({ ...l, holds: l.holds.filter((_, i) => i !== index) });

/** The hold pays: its payer's allocation falls by its amount. It was already counted as worst case. */
export const resolve = (l: Ledger, index: number): Step =>
  map(holdAt(l, index), (h) => afterPayment(without(l, index), h.payer, h.amount));

/** The hold lapses: the allocation stays. */
export const expire = (l: Ledger, index: number): Step => map(holdAt(l, index), () => without(l, index));

/** R2C: `side` moves `amount` into the collateral; a Left deposit is Left's allocation, so ondelta rises with it. */
export const deposit = (l: Ledger, side: Side, amount: bigint): Step =>
  map(amountInRange(amount), (n) =>
    ({ ...l, collateral: l.collateral + n, ondelta: side === "left" ? l.ondelta + n : l.ondelta }));

/**
 * C2R: `side` takes `amount` out of the collateral; a Left withdrawal lowers ondelta with it. Smaller collateral can
 * leave a side outside its credit, which is the refusal (R-SETTLE-CREDIT).
 */
export const withdraw = (l: Ledger, side: Side, amount: bigint): Step =>
  flatMap(amountInRange(amount), (n) =>
    n > l.collateral
      ? err(beyondCollateral(l, n))
      : keptIfRcpan(
        { ...l, collateral: l.collateral - n, ondelta: side === "left" ? l.ondelta - n : l.ondelta },
        { _tag: "settlement_breaks_credit" }));
