import type { AccountTx, EntityState } from '../../types';
import { cancelHook as cancelScheduledHook } from '../scheduler';

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

function accountFrameHasLock(txs: AccountTx[] | undefined, lockId: string): boolean {
  return Boolean(txs?.some((tx) => tx.type === 'htlc_lock' && tx.data.lockId === lockId));
}

function accountHasLiveLockReference(state: EntityState, counterpartyId: string | undefined, lockId: string): boolean {
  if (!counterpartyId) return false;
  const account = state.accounts.get(counterpartyId);
  if (!account) return false;
  return Boolean(
    account.locks?.has(lockId) ||
    accountFrameHasLock(account.mempool, lockId) ||
    accountFrameHasLock(account.pendingFrame?.accountTxs, lockId)
  );
}

export function pruneSettledOriginatedHtlcRoutes(state: EntityState, timestamp: number): number {
  let pruned = 0;
  for (const [hashlock, route] of state.htlcRoutes.entries()) {
    if (route.inboundEntity || !route.outboundLockId) continue;
    if (accountHasLiveLockReference(state, route.outboundEntity, route.outboundLockId)) continue;
    state.lockBook.delete(route.outboundLockId);
    terminateHtlcRoute(state, hashlock, timestamp);
    pruned += 1;
  }
  return pruned;
}
