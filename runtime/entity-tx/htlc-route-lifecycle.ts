import type { EntityState } from '../types';
import { cancelHook as cancelScheduledHook } from '../entity-crontab';

export function terminateHtlcRoute(
  state: EntityState,
  hashlock: string,
  timestamp: number,
): void {
  const route = state.htlcRoutes.get(hashlock);
  if (!route) return;
  route.secretAckPending = false;
  route.secretAckedAt = timestamp;
  if (state.crontabState) {
    cancelScheduledHook(state.crontabState, `htlc-secret-ack:${route.hashlock}`);
  }
  state.htlcRoutes.delete(hashlock);
}

function accountHasLock(state: EntityState, counterpartyId: string | undefined, lockId: string): boolean {
  if (!counterpartyId) return false;
  return Boolean(state.accounts.get(counterpartyId)?.locks?.has(lockId));
}

export function pruneSettledOriginatedHtlcRoutes(state: EntityState, timestamp: number): number {
  let pruned = 0;
  for (const [hashlock, route] of state.htlcRoutes.entries()) {
    if (route.inboundEntity || !route.outboundLockId) continue;
    if (accountHasLock(state, route.outboundEntity, route.outboundLockId)) continue;
    state.lockBook.delete(route.outboundLockId);
    terminateHtlcRoute(state, hashlock, timestamp);
    pruned += 1;
  }
  return pruned;
}
