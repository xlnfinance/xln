import { BLOCKCHAIN } from '../../../../config/constants';

export const J_WATCHER_IDLE_CANONICAL_AUDIT_MS = 30_000;

export const shouldAuditCanonicalWatcherState = (input: {
  currentHead: number;
  lastObservedHead: number;
  nowMs: number;
  lastAuditAtMs: number;
  hasRangeWork: boolean;
  hasPendingHistory: boolean;
  hasPendingReorg: boolean;
}): boolean =>
  input.currentHead !== input.lastObservedHead ||
  input.hasRangeWork ||
  input.hasPendingHistory ||
  input.hasPendingReorg ||
  input.nowMs - input.lastAuditAtMs >= J_WATCHER_IDLE_CANONICAL_AUDIT_MS;

/**
 * The poll window halves under RPC or Runtime mempool pressure and doubles
 * back only after a complete authenticated window is admitted.
 */
export const nextWatcherPollWindow = (current: number, committed: boolean): number =>
  committed
    ? Math.min(BLOCKCHAIN.J_WATCHER_MAX_BLOCKS_PER_POLL, current * 2)
    : Math.max(1, Math.floor(current / 2));

// Local transport policy, not finality or a promise of upstream capacity.
// One success retains pressure: alternating success/429 must increase pacing
// instead of repeatedly restoring the burst that exceeded the provider quota.
export const nextWatcherRpcBackoffMs = (current: number, committed: boolean): number =>
  committed ? Math.floor(current * 0.75) : Math.min(30_000, Math.max(1_000, current * 2));
