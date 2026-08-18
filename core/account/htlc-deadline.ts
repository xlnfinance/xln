export type HtlcEnforcementClock = Readonly<{
  timestamp: number;
  jHeight: number;
}>;

export type HtlcDeadline = Readonly<{
  timelock: bigint;
  revealBeforeHeight: number;
}>;

/** An HTLC is active only while the Entity timestamp is strictly before its timelock. */
export const isHtlcTimelockExpired = (entityTimestamp: number, timelock: bigint): boolean =>
  BigInt(entityTimestamp) >= timelock;

/**
 * One canonical predicate for both speculative admission and Account mutation.
 * The time boundary is exclusive while the J-height boundary is inclusive:
 * a secret is still valid at revealBeforeHeight and invalid above it.
 */
export const isHtlcDeadlineExpired = (
  deadline: HtlcDeadline,
  clock: HtlcEnforcementClock,
): boolean =>
  clock.jHeight > deadline.revealBeforeHeight
  || isHtlcTimelockExpired(clock.timestamp, deadline.timelock);
