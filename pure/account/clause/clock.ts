// The clock rule for clauses (R-HTLC-CLOCK, R-CLOCK). Every time judgment about a clause is made in J height, on the
// deciding party's own view of the chain, and never on the Account clock or on a timestamp a counterparty wrote: no
// function here can take a frame stamp, so a decision made on one does not type check.
//
// Each party's view lags the chain by at most `lag`, so two views differ by at most `lag` (R-DRIFT; the Runtime refuses
// to sign on a view that lags more). The reserve is what an expiry adds to the deciding party's view so that the other
// party's view is past the deadline too.
import { err, ok, type Result } from "../../kernel/core/result.ts";
import type { Tagged } from "../../kernel/core/tagged.ts";

export type ClockParams = Readonly<{ lag: bigint; reserve: bigint; maxLockHorizon: bigint }>;

export type ParamsFault =
  | Tagged<"reserve_below_lag", { lag: bigint; reserve: bigint }>
  | Tagged<"horizon_not_positive", { maxLockHorizon: bigint }>;

/** The reserve is in J heights and at least `lag`; less lets an expiry land while the payee can still resolve. */
export const clockParams = (lag: bigint, reserve: bigint, maxLockHorizon: bigint): Result<ClockParams, ParamsFault> => {
  if (reserve < lag) return err({ _tag: "reserve_below_lag", lag, reserve });
  if (maxLockHorizon < 1n) return err({ _tag: "horizon_not_positive", maxLockHorizon });
  return ok({ lag, reserve, maxLockHorizon });
};

/** The host door: the chain height a party acts on is the later of the host's finalized height and the context's. */
export const ownView = (finalizedJHeight: bigint, contextJHeight: bigint): bigint =>
  (finalizedJHeight > contextJHeight ? finalizedJHeight : contextJHeight);

/** A clause is live through its deadline height: a resolve is on time while the view is at or before it. */
export const liveAt = (deadline: bigint, view: bigint): boolean => view <= deadline;

/** An expiry needs the view strictly past deadline plus reserve, for the payer proposing it and the payee accepting. */
export const expirableAt = (p: ClockParams, deadline: bigint, view: bigint): boolean => view > deadline + p.reserve;

/** The latest deadline a party admits for a new clause (N2, R-HORIZON-RESERVE). */
export const latestDeadline = (p: ClockParams, view: bigint): bigint => view + p.maxLockHorizon + p.reserve;

/** A payee whose resolve is still unacked reveals the secret on chain once its view reaches `deadline - lag`. */
export const revealOnChainDue = (p: ClockParams, deadline: bigint, view: bigint): boolean => view + p.lag >= deadline;
