// The money rules of one Account and one token (spec/money/ledger.scm): seven transitions, each a function
// Ledger -> Result<Ledger, AccountFault>. Every transition that can push the allocation out of its credit is the same
// thing written once: take the step, keep it only if RCPAN still holds. Every transition assumes the ledger it is given
// already satisfies RCPAN: one that left it through an event outside these rules (a rebase on the J layer) is not this
// file's to repair, and `room` then reads 0 rather than a negative number.
import { err, flatMap, map, ok, type Result } from "../kernel/core/result.ts";
import type { AccountFault, ClauseHold, Hold, HoldId, Ledger, Side } from "./model.ts";
import { other } from "./model.ts";

/** Amounts and credit limits are uint256 on the chain and in every signed message. */
export const MAX_AMOUNT = 2n ** 256n - 1n;

/** The most open holds a ledger carries: a dispute proof with more reverts (Account.sol MAX_DISPUTE_TRANSFORMERS). */
export const MAX_HOLDS = 32;

const NOTHING_RESERVED = { left: 0n, right: 0n };

export const emptyLedger: Ledger =
  { collateral: 0n, ondelta: 0n, offdelta: 0n, limit: { left: 0n, right: 0n }, holds: [], reserved: NOTHING_RESERVED };

export const allocation = (l: Ledger): bigint => l.ondelta + l.offdelta;

/** What `side` has open in holds and swap offers: what the ledger must still be able to cover if they all pay. */
const held = (l: Ledger, side: Side): bigint =>
  l.holds.filter((h) => h.payer === side).reduce((sum, h) => sum + h.amount, 0n) + l.reserved[side];

/** RCPAN: in the worst case over every open hold, the allocation stays in [-limit.left, collateral + limit.right]. */
const staysWithinCredit = (l: Ledger): boolean =>
  allocation(l) - held(l, "left") >= -l.limit.left && allocation(l) + held(l, "right") <= l.collateral + l.limit.right;

const atLeastZero = (n: bigint): bigint => (n > 0n ? n : 0n);

/** How much `side` may still pay or lock: its allocation plus the credit extended to it, less what it has held. */
export const room = (l: Ledger, side: Side): bigint => {
  const unused = side === "left"
    ? allocation(l) + l.limit.left - held(l, "left")
    : l.collateral + l.limit.right - allocation(l) - held(l, "right");
  return atLeastZero(unused);
};

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

/** A hold opens in a free slot while fewer than `MAX_HOLDS` are open. */
const slotFree = (l: Ledger, hold: Hold): Result<Hold, AccountFault> => {
  if (l.holds.some((h) => h.id === hold.id)) return err({ _tag: "lock_exists", id: hold.id });
  return l.holds.length >= MAX_HOLDS ? err({ _tag: "too_many_holds", max: MAX_HOLDS }) : ok(hold);
};

const withinHoldSum = (l: Ledger, hold: Hold): Result<Hold, AccountFault> =>
  (held(l, hold.payer) + hold.amount > MAX_AMOUNT
    ? err({ _tag: "hold_overflow", held: held(l, hold.payer), requested: hold.amount })
    : ok(hold));

/** The checks on the hold itself, in order: its amount, a free slot, a sum that fits; capacity is RCPAN's. */
const admitted = (l: Ledger, hold: Hold): Result<Hold, AccountFault> =>
  flatMap(amountInRange(hold.amount), () => flatMap(slotFree(l, hold), () => withinHoldSum(l, hold)));

/** Only a `ClauseHold` opens: the clause rules (clause/clause.ts `lockClause`) are the one door into the holds. */
export const lock = (l: Ledger, hold: ClauseHold): Step =>
  flatMap(admitted(l, hold), () =>
    keptIfRcpan({ ...l, holds: [...l.holds, hold] }, lacksRoom(l, hold.payer, hold.amount)));

/** A swap offer reserves `n` of what `side` may pay in this token: counted as held, kept only if RCPAN still holds. */
export const reserve = (l: Ledger, side: Side, n: bigint): Step =>
  (held(l, side) + n > MAX_AMOUNT
    ? err({ _tag: "hold_overflow", held: held(l, side), requested: n })
    : keptIfRcpan({ ...l, reserved: { ...l.reserved, [side]: l.reserved[side] + n } }, lacksRoom(l, side, n)));

/** An offer gives up `n` of its reservation on `side` (it lapsed, was withdrawn, or `n` of it was filled). */
export const release = (l: Ledger, side: Side, n: bigint): Ledger =>
  ({ ...l, reserved: { ...l.reserved, [side]: l.reserved[side] - n } });

/** A fill moves `n` from the payer's reservation into its payment: the worst case is unchanged. */
export const payReserved = (l: Ledger, payer: Side, n: bigint): Ledger => afterPayment(release(l, payer, n), payer, n);

const holdAt = (l: Ledger, id: HoldId): Result<Hold, AccountFault> => {
  const hold = l.holds.find((h) => h.id === id);
  return hold === undefined ? err({ _tag: "no_such_hold", id }) : ok(hold);
};

const without = (l: Ledger, id: HoldId): Ledger => ({ ...l, holds: l.holds.filter((h) => h.id !== id) });

/** The hold pays: its payer's allocation falls by its amount. It was already counted as worst case. */
export const resolve = (l: Ledger, id: HoldId): Step =>
  map(holdAt(l, id), (h) => afterPayment(without(l, id), h.payer, h.amount));

/** The hold lapses: the allocation stays. */
export const expire = (l: Ledger, id: HoldId): Step => map(holdAt(l, id), () => without(l, id));

/**
 * R2C: `side` moves `amount` into the collateral; a Left deposit is Left's allocation, so ondelta rises with it. The
 * collateral itself is not bounded here: it is what reserves paid in, and they are uint256 on the chain.
 */
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
