// The money of one Account, in the spec's words (spec/money/ledger.scm, spec/quint/account_core.qnt).
//
// An Account has two sides, Left and Right, and one Ledger per token. The chain holds `collateral` and `ondelta`; the
// parties agree `offdelta` off-chain. Their sum, delta, is LEFT's allocation: a payment by Left lowers it, a payment
// by Right raises it. Credit is off-chain: each side states how far the other may owe it (`limit`), and the chain
// never sees it. RCPAN is the rule that keeps credit true: in the worst case over every open hold, delta stays inside
// [-limit.left, collateral + limit.right]. Every transition is a function Ledger -> Result<Ledger, AccountFault>.
import { err, ok, type Result } from "../kernel/core/result.ts";
import type { Brand, Tagged } from "../kernel/core/tagged.ts";
import type { HeightFault, JHeight } from "./clause/clock.ts";

export type Side = "left" | "right";

export const other = (side: Side): Side => (side === "left" ? "right" : "left");

/** A token of the Account; each has its own Ledger. */
export type TokenId = Brand<bigint, "TokenId">;

/** The contract's token id is a uint256. */
export const MAX_TOKEN = 2n ** 256n - 1n;

/** The one maker of a TokenId: a token is 0 .. 2^256-1, whatever a decoder was handed. */
export const tokenId = (n: bigint): Result<TokenId, Tagged<"bad_token", { token: bigint }>> =>
  (n >= 0n && n <= MAX_TOKEN ? ok(n as TokenId) : err({ _tag: "bad_token", token: n }));

/** The slot a hold sits in: the caller names it, it stays while the hold is open, and no two open holds share one. */
export type HoldId = Brand<bigint, "HoldId">;

export const holdId = (n: bigint): HoldId => n as HoldId;

/** keccak256 of a 32-byte secret: 0x and 64 lowercase hex digits. It names a clause: one is open per hashlock. */
export type Hashlock = string;

/**
 * An open hold (the spec's conditional clause) in slot `id`: `payer` owes `amount` if its payee shows the preimage of
 * `hashlock` while the chain's height, in the deciding party's own view, is at or before `deadline`. The money rules
 * read only id, payer and amount; the clause rules (clause/) read the rest.
 */
export type Hold = Readonly<{ id: HoldId; payer: Side; amount: bigint; hashlock: Hashlock; deadline: JHeight }>;

/** A hold the clause rules have admitted: `lockClause` alone makes one, and the ledger opens no other (one door). */
export type ClauseHold = Brand<Hold, "ClauseHold">;

/** One side of a swap: an amount of a token. */
export type Leg = Readonly<{ token: TokenId; amount: bigint }>;

/**
 * An open swap offer (R-SWAP-*): `maker` gives `give` for `want`, in whole or in parts, until its `deadline` in J
 * height (off-chain only: the chain's clause has no expiry), in a slot of its own among the quotes and offers of the
 * Account. It is a quote until the taker's first fill and a clause of the proof body after it (R-SWAP-CONSENT).
 * `give` and `want` are what remains: every fill shrinks them (R-SWAP-CLAUSE-WITH-FILL).
 */
export type Offer = Readonly<{ id: HoldId; maker: Side; give: Leg; want: Leg; deadline: JHeight }>;

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
  /** What each side's open swap offers could still take from it in this token: counted as held, like a hold. */
  reserved: Readonly<Record<Side, bigint>>;
}>;

/**
 * Everything one Account agrees on: a Ledger per token it has used, and the swap quotes and offers that span two of
 * them. A token with no entry reads as the empty ledger. The caps that span tokens (open clauses, open hashlocks) are
 * the Account's, so they are read here and not in a Ledger.
 */
export type AccountState = Readonly<{
  ledgers: ReadonlyMap<TokenId, Ledger>;
  /** Quotes (R-SWAP-CONSENT): offers no taker has filled; each reserves only its maker's give and is no clause. */
  quotes: readonly Offer[];
  /** Accepted offers: a taker has filled at least once; each reserves both legs and is a clause of the proof body. */
  offers: readonly Offer[];
}>;

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
  | Tagged<"settlement_breaks_credit">
  | Tagged<"not_own_funds">
  | Tagged<"not_payee">
  | Tagged<"bad_hashlock">
  | Tagged<"bad_secret">
  | Tagged<"wrong_secret">
  | Tagged<"no_such_lock">
  | HeightFault
  | Tagged<"deadline_past", { deadline: bigint; view: bigint }>
  | Tagged<"deadline_too_far", { deadline: bigint; latest: bigint }>
  | Tagged<"past_deadline", { deadline: bigint; view: bigint }>
  | Tagged<"not_expired", { deadline: bigint; earliest: bigint }>
  | Tagged<"unsignable", { fault: string }>
  | Tagged<"same_token", { token: TokenId }>
  | Tagged<"offer_exists", { id: HoldId }>
  | Tagged<"too_many_quotes", { max: number }>
  | Tagged<"no_such_offer", { id: HoldId }>
  | Tagged<"not_maker">
  | Tagged<"not_taker">
  | Tagged<"bad_ratio", { ratio: number }>
  | Tagged<"fill_too_small", { give: bigint; want: bigint }>;
