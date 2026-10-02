// The clock rule for clauses (R-HTLC-CLOCK, R-CLOCK). Every time judgment about a clause is made in J height, on the
// deciding party's own view of the chain, and never on the Account clock or on a timestamp a counterparty wrote. The
// view is a `JView`, which `ownView` alone makes, and a deadline is a `JHeight`, which `jHeight` alone makes: a frame
// stamp is a plain bigint, so a decision made on one has to cast its way past the types.
//
// Each party's view lags the chain by at most `lag`, so two views differ by at most `lag` (R-DRIFT; the Runtime refuses
// to sign on a view that lags more). The reserve is what an expiry adds to the deciding party's view so that the other
// party's view is past the deadline too.
import { err, ok, type Result } from "../../kernel/core/result.ts";
import type { Brand, Tagged } from "../../kernel/core/tagged.ts";

/** Heights and deadlines are uint256 on the chain and in every signed body. */
export const MAX_HEIGHT = 2n ** 256n - 1n;

/** A height of the J chain: 0 .. 2^256-1. A clause's deadline is one. */
export type JHeight = Brand<bigint, "JHeight">;

/** The height a party acts on: its own view of the chain, made only by `ownView`. */
export type JView = Brand<bigint, "JView">;

export type HeightFault = Tagged<"bad_height", { height: bigint }>;

export const jHeight = (height: bigint): Result<JHeight, HeightFault> =>
  (height >= 0n && height <= MAX_HEIGHT ? ok(height as JHeight) : err({ _tag: "bad_height", height }));

/**
 * `depth` is how many blocks behind the chain's head the node's view is held (the depth its J loop reads at), or
 * undefined for a view that is the head, as the Arrival clock page has it: the page's reveal lands at once. A node that
 * reads at a depth asks for its reveal `depth + 1` heights earlier (see `revealOnChainDue`).
 */
export type ClockParams = Readonly<{
  lag: bigint; reserve: bigint; maxLockHorizon: bigint; depth: bigint | undefined;
}>;

export type ParamsFault =
  | Tagged<"lag_negative", { lag: bigint }>
  | Tagged<"depth_negative", { depth: bigint }>
  | Tagged<"reserve_below_lag", { lag: bigint; reserve: bigint }>
  | Tagged<"horizon_not_positive", { maxLockHorizon: bigint }>;

/**
 * The lag is not negative and the reserve is in J heights and at least `lag`; less lets an expiry land while the payee
 * can still resolve (a negative lag admits a negative reserve: a clause is then live and expirable at its deadline).
 */
export const clockParams = (
  lag: bigint, reserve: bigint, maxLockHorizon: bigint, depth?: bigint,
): Result<ClockParams, ParamsFault> => {
  if (lag < 0n) return err({ _tag: "lag_negative", lag });
  if (depth !== undefined && depth < 0n) return err({ _tag: "depth_negative", depth });
  if (reserve < lag) return err({ _tag: "reserve_below_lag", lag, reserve });
  if (maxLockHorizon < 1n) return err({ _tag: "horizon_not_positive", maxLockHorizon });
  return ok({ lag, reserve, maxLockHorizon, depth });
};

/** The host door: the chain height a party acts on is the later of the host's finalized height and the context's. */
export const ownView = (finalizedJHeight: JHeight, contextJHeight: JHeight): JView =>
  (finalizedJHeight > contextJHeight ? finalizedJHeight : contextJHeight) as bigint as JView;

/** A clause is live through its deadline height: a resolve is on time while the view is at or before it. */
export const liveAt = (deadline: JHeight, view: JView): boolean => view <= deadline;

/** An expiry needs the view strictly past deadline plus reserve, for the payer proposing it and the payee accepting. */
export const expirableAt = (p: ClockParams, deadline: JHeight, view: JView): boolean => view > deadline + p.reserve;

/** The latest deadline a party admits for a new clause (N2, R-HORIZON-RESERVE). */
export const latestDeadline = (p: ClockParams, view: JView): bigint => view + p.maxLockHorizon + p.reserve;

const ONE_BLOCK = 1n;

/**
 * A payee whose resolve is still unacked reveals the secret on chain once its view reaches `deadline - lag` (the page).
 * A node that reads at a `depth` has a view that far behind the head and its reveal, sent at the head, lands one block
 * after it: it asks for the reveal at `deadline - lag - depth - 1`, so the reveal lands `lag` blocks before the
 * deadline whatever the depth is (a reveal one block early costs nothing; one that misses costs the whole clause, and
 * this does not depend on whether the contract's deadline check is strict or inclusive).
 */
export const revealOnChainDue = (p: ClockParams, deadline: JHeight, view: JView): boolean =>
  view + p.lag + (p.depth === undefined ? 0n : p.depth + ONE_BLOCK) >= deadline;
