// Checks over what the fork shim handed the chain in one walk (fork-shim.ts Sent): the epoch every dispute start declared, and the gas
// the heaviest batch spent against the shim's signed budget. The walk runs them after its last frame; sent-checks.test.ts turns each red.
import type { Sent } from "./fork-shim.ts";

/** The shim's signed budget must be at least this many times the gas of the largest batch a walk sent (measured: about 35 times, fork-shim.ts). */
export const GAS_HEADROOM = 8n;

/** What a walk over an area has to have sent for its checks to mean anything. */
export type SentScope = { readonly tag: string; readonly disputes: boolean; readonly budget: bigint };

/**
 * C1 (ondeltaEpoch, J2 reason 11): every dispute start declares the epoch the Account holds when it is sent; a start bound to another epoch is
 * skipped or fails its signature. A disputes walk must have started one on an Account whose epoch had moved, or the check never ran.
 */
export const startEpochLines = (scope: SentScope, sent: Pick<Sent, "landed" | "starts">): readonly string[] => {
  const starts = sent.starts();
  const stale = starts
    .filter((s) => s.declared !== s.current)
    .map((s) => `${scope.tag} C1: a dispute start declared epoch ${s.declared} but the Account held ${s.current} (J2 reason 11)`);
  const moved = starts.some((s) => s.current > 0n);
  const never = scope.disputes && sent.landed() > 0 && !moved
    ? [`${scope.tag} C1: no dispute started on an Account whose epoch had moved, so the start's epoch was never checked`]
    : [];
  return [...stale, ...never];
};

/**
 * J5: the shim's signed gas budget is a ceiling, not a fit. The largest batch the walk sent stays under 1 / GAS_HEADROOM of it, so a heavier
 * draw is refused by a rule and never starved by the shim's own number.
 */
export const gasHeadroomLines = (scope: SentScope, sent: Pick<Sent, "peakGas">): readonly string[] => {
  const peak = sent.peakGas();
  return peak * GAS_HEADROOM > scope.budget
    ? [`${scope.tag} J5: the largest batch spent ${peak} gas, within ${GAS_HEADROOM}x of the shim's signed budget ${scope.budget}`]
    : [];
};
