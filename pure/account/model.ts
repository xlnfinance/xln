// The money of one Account, in the spec's words (spec/money/ledger.scm, spec/quint/account_core.qnt).
//
// An Account has two sides, Left and Right, and one Ledger per token. The chain holds `collateral` and `ondelta`; the
// parties agree `offdelta` off-chain. Their sum, delta, is LEFT's allocation: a payment by Left lowers it, a payment
// by Right raises it. Credit is off-chain: each side states how far the other may owe it (`limit`), and the chain
// never sees it. RCPAN is the rule that keeps credit true: in the worst case over every open hold, delta stays inside
// [-limit.left, collateral + limit.right]. Every transition is a function Ledger -> Result<Ledger, AccountFault>.
import type { Brand, Tagged } from "../kernel/core/tagged.ts";

export type Side = "left" | "right";

export const other = (side: Side): Side => (side === "left" ? "right" : "left");

export type TokenId = Brand<bigint, "TokenId">;

/** The slot a hold sits in: the caller names it, it stays while the hold is open, and no two open holds share one. */
export type HoldId = Brand<bigint, "HoldId">;

export const holdId = (n: bigint): HoldId => n as HoldId;

/** An open hold, what the spec calls a conditional clause: `payer` owes `amount` if its payee claims it in time. */
export type Hold = Readonly<{ id: HoldId; payer: Side; amount: bigint }>;

/**
 * `limit.left` is the credit extended TO Left (how far Left's allocation may fall below zero); Right is the side that
 * extends it. `limit.right` is the mirror: how far Left's allocation may rise above the collateral.
 */
export type Ledger = Readonly<{
  collateral: bigint;
  ondelta: bigint;
  offdelta: bigint;
  limit: Readonly<Record<Side, bigint>>;
  holds: readonly Hold[];
}>;

export type AccountState = Readonly<{ ledgers: ReadonlyMap<TokenId, Ledger> }>;

/** One case per refusal; none of them halts anything. */
export type AccountFault =
  | Tagged<"bad_amount", { amount: bigint }>
  | Tagged<"bad_credit", { limit: bigint }>
  | Tagged<"insufficient_capacity", { available: bigint; requested: bigint }>
  | Tagged<"hold_overflow", { held: bigint; requested: bigint }>
  | Tagged<"lock_exists", { id: HoldId }>
  | Tagged<"too_many_holds", { max: number }>
  | Tagged<"credit_below_usage">
  | Tagged<"no_such_hold", { id: HoldId }>
  | Tagged<"withdrawal_beyond_collateral", { collateral: bigint; requested: bigint }>
  | Tagged<"settlement_breaks_credit">;
