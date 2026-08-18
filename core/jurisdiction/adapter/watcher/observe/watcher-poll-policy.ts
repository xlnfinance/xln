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
