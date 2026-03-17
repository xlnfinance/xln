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
