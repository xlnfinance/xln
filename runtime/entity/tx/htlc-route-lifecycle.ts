import type { AccountTx, EntityState, HtlcLock, HtlcNoteKey, HtlcRoute } from '../../types';
import { LIMITS } from '../../constants';
import {
  cancelHook as cancelScheduledHook,
  HTLC_SECRET_ACK_TIMEOUT_MS,
  scheduleHook as scheduleCrontabHook,
} from '../scheduler';

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
  const localSentLock = lock.senderIsLeft === (account.leftEntity.toLowerCase() === state.entityId.toLowerCase());
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
  if (!route.inboundEntity || !route.inboundLockId) {
    throw new Error(`HTLC_SECRET_ACK_INBOUND_ROUTE_REQUIRED:${route.hashlock}`);
  }
  if (!state.crontabState) {
    throw new Error(`HTLC_SECRET_ACK_CRONTAB_MISSING:${route.hashlock}`);
  }

  const deadline = state.timestamp + HTLC_SECRET_ACK_TIMEOUT_MS;
  route.secretAckPending = true;
  route.secretAckStartedAt = state.timestamp;
  route.secretAckDeadlineAt = deadline;
  scheduleCrontabHook(state.crontabState, {
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

export function setHtlcRouteNote(
  state: EntityState,
  hashlock: string,
  lockId: string,
  note: string,
): void {
  if (note.length === 0 || note.length > LIMITS.MAX_ENTITY_HTLC_NOTE_LENGTH) {
    throw new Error(`ENTITY_HTLC_NOTE_INVALID_LENGTH:${note.length}`);
  }
  const notes = state.htlcNotes instanceof Map
    ? state.htlcNotes
    : new Map<HtlcNoteKey, string>();
  const keys = [`hashlock:${hashlock}`, `lock:${lockId}`] as const satisfies readonly HtlcNoteKey[];
  const newKeyCount = keys.filter((key) => !notes.has(key)).length;
  if (notes.size + newKeyCount > LIMITS.MAX_ENTITY_HTLC_NOTES) {
    throw new Error(
      `ENTITY_HTLC_NOTE_LIMIT_EXCEEDED:size=${notes.size + newKeyCount}:max=${LIMITS.MAX_ENTITY_HTLC_NOTES}`,
    );
  }
  for (const key of keys) notes.set(key, note);
  state.htlcNotes = notes;
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
    cancelScheduledHook(state.crontabState, `htlc-secret-ack:${route.hashlock}`);
  }
  const notes = state.htlcNotes;
  if (notes) {
    notes.delete(`hashlock:${hashlock}`);
    if (route.inboundLockId) notes.delete(`lock:${route.inboundLockId}`);
    if (route.outboundLockId) notes.delete(`lock:${route.outboundLockId}`);
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
    // A durable Account ACK has accepted the encrypted offer, but the exact
    // ACK-bound reveal still needs this route in the same Entity replay.
    if (route.acceptedOfferHash) continue;
    if (accountHasLiveLockReference(state, route.outboundEntity, route.outboundLockId)) continue;
    state.lockBook.delete(route.outboundLockId);
    terminateHtlcRoute(state, hashlock, timestamp);
    pruned += 1;
  }
  return pruned;
}
