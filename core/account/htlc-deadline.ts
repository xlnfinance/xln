import { ASYNC_PAYMENT_EXPIRY_MS } from '../types/finance/payment';
import { HTLC, HTLC_ENFORCEMENT_RESERVE_MS } from '../config/constants';

// One day plus the full routing ladder and recipient enforcement/transit reserve.
export const MAX_HTLC_HORIZON_MS = ASYNC_PAYMENT_EXPIRY_MS + HTLC.MAX_HOPS * HTLC.MIN_TIMELOCK_DELTA_MS + HTLC_ENFORCEMENT_RESERVE_MS + HTLC.MIN_TIMELOCK_DELTA_MS;

export type HtlcEnforcementClock = Readonly<{
  timestamp: number;
  jHeight: number;
}>;

type HtlcDeadline = Readonly<{
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
