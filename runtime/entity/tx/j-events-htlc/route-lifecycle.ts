import type { AccountTx, HtlcLock, HtlcRoute } from '../../../types/account';
import type { EntityState } from '../../types';
import { cancelHook, scheduleHook } from '../../scheduler/hook-state';
import { hasInboundHtlcRoute } from '../../htlc/route-views';

/** Auto-dispute when the upstream peer never acknowledges a returned secret. */
export const HTLC_SECRET_ACK_TIMEOUT_MS = 30_000;

const assertEndpoint = (
  actual: readonly [string | undefined, string | undefined],
  expected: readonly [string, string],
  hashlock: string,
): void => {
  if (actual[0] && actual[0].toLowerCase() !== expected[0].toLowerCase()) {
    throw new Error(`HTLC_ROUTE_ENTITY_CONFLICT:${hashlock}`);
  }
  if (actual[1] && actual[1].toLowerCase() !== expected[1].toLowerCase()) {
    throw new Error(`HTLC_ROUTE_LOCK_CONFLICT:${hashlock}`);
  }
};

export function persistVerifiedHtlcSecret(
  state: EntityState,
  counterpartyId: string,
  lock: HtlcLock,
  secret: string,
): void {
  // The Account proposal may never reach an offline peer. Persist the verified
  // preimage in this signed Entity-frame replay so a later dispute can reveal
  // it; mutating replica state after frame certification would fork lineage.
  const route = state.htlcRoutes.get(lock.hashlock) ?? {
    hashlock: lock.hashlock,
    tokenId: lock.tokenId,
    amount: lock.amount,
    createdTimestamp: state.timestamp,
  };
  if (route.secret && route.secret.toLowerCase() !== secret.toLowerCase()) {
    throw new Error(`HTLC_ROUTE_SECRET_CONFLICT:${lock.hashlock}`);
  }
  if (route.tokenId !== undefined && route.tokenId !== lock.tokenId) {
    throw new Error(`HTLC_ROUTE_TOKEN_CONFLICT:${lock.hashlock}`);
  }
  if (route.amount !== undefined && route.amount !== lock.amount) {
    throw new Error(`HTLC_ROUTE_AMOUNT_CONFLICT:${lock.hashlock}`);
  }

  const account = state.accounts.get(counterpartyId)!;
  const localSentLock = lock.senderIsLeft === (account.state.leftEntity.toLowerCase() === state.entityId.toLowerCase());
  const endpoint: readonly [string | undefined, string | undefined] = localSentLock
    ? [route.outboundEntity, route.outboundLockId]
    : [route.inboundEntity, route.inboundLockId];
  assertEndpoint(endpoint, [counterpartyId, lock.lockId], lock.hashlock);
  Object.assign(route, localSentLock
    ? { secret, outboundEntity: counterpartyId, outboundLockId: lock.lockId }
    : { secret, inboundEntity: counterpartyId, inboundLockId: lock.lockId });
  state.htlcRoutes.set(lock.hashlock, route);
}

export function armHtlcSecretAckTimeout(
  state: EntityState,
  route: HtlcRoute,
): void {
  if (!hasInboundHtlcRoute(route)) {
    throw new Error(`HTLC_SECRET_ACK_INBOUND_ROUTE_REQUIRED:${route.hashlock}`);
  }
  if (!state.crontabState) {
    throw new Error(`HTLC_SECRET_ACK_CRONTAB_MISSING:${route.hashlock}`);
  }

  const deadline = state.timestamp + HTLC_SECRET_ACK_TIMEOUT_MS;
  route.secretAckPending = true;
  route.secretAckStartedAt = state.timestamp;
  route.secretAckDeadlineAt = deadline;
  scheduleHook(state.crontabState, {
    id: `htlc-secret-ack:${route.hashlock}`,
    triggerAt: deadline,
    type: 'htlc_secret_ack_timeout',
    data: {
      hashlock: route.hashlock,
      counterpartyEntityId: route.inboundEntity,
      inboundLockId: route.inboundLockId,
    },
  });
}

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
    cancelHook(state.crontabState, `htlc-secret-ack:${route.hashlock}`);
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
    account.state.locks?.has(lockId) ||
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
