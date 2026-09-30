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

/** An open hold, what the spec calls a conditional clause: `payer` owes `amount` if its payee claims it in time. */
export type Hold = Readonly<{ payer: Side; amount: bigint }>;

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
  | Tagged<"credit_below_usage">
  | Tagged<"no_such_hold", { index: number }>
  | Tagged<"withdrawal_beyond_collateral", { collateral: bigint; requested: bigint }>
  | Tagged<"settlement_breaks_credit">;
