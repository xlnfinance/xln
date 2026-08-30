import type { HtlcLock } from '../../types/account';
import type { EntityCandidateEffect, EntityState, PaybookEntry } from '../types';
import { cancelHook, scheduleHook } from '../scheduler/hook-state';
import { hasInboundPayment } from './views';
import { getEntityCollectionValueForWrite } from '../state/persistent-collection-map';

export const HTLC_SECRET_ACK_TIMEOUT_MS = 120_000;

const assertCanonicalPaymentId = (lock: HtlcLock): void => {
  if (lock.lockId.toLowerCase() !== lock.hashlock.toLowerCase()) {
    throw new Error(`PAYBOOK_LOCK_ID_MUST_EQUAL_HASHLOCK:${lock.lockId}:${lock.hashlock}`);
  }
};

const assertEndpoint = (
  actual: string | undefined,
  expected: string,
  hashlock: string,
): void => {
  if (actual && actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`PAYBOOK_ENTITY_CONFLICT:${hashlock}`);
  }
};

export function persistVerifiedPaymentSecret(
  state: EntityState,
  counterpartyId: string,
  lock: HtlcLock,
  secret: string,
): PaybookEntry {
  assertCanonicalPaymentId(lock);
  const existing = state.paybook.entries.get(lock.hashlock);
  const entry = existing
    ? getEntityCollectionValueForWrite(state.paybook.entries, lock.hashlock)
    : {
        hashlock: lock.hashlock,
        tokenId: lock.tokenId,
        amount: lock.amount,
        createdTimestamp: state.timestamp,
      };
  if (!entry) throw new Error(`PAYBOOK_ENTRY_WRITE_MISSING:${lock.hashlock}`);
  if (entry.secret && entry.secret.toLowerCase() !== secret.toLowerCase()) {
    throw new Error(`PAYBOOK_SECRET_CONFLICT:${lock.hashlock}`);
  }
  if (entry.tokenId !== undefined && entry.tokenId !== lock.tokenId) {
    throw new Error(`PAYBOOK_TOKEN_CONFLICT:${lock.hashlock}`);
  }
  if (entry.amount !== undefined && entry.amount !== lock.amount) {
    throw new Error(`PAYBOOK_AMOUNT_CONFLICT:${lock.hashlock}`);
  }

  const account = state.accounts.get(counterpartyId)!;
  const localSentLock = lock.senderIsLeft === (account.state.leftEntity.toLowerCase() === state.entityId.toLowerCase());
  assertEndpoint(
    localSentLock ? entry.outboundEntity : entry.inboundEntity,
    counterpartyId,
    lock.hashlock,
  );
  Object.assign(entry, localSentLock
    ? { secret, outboundEntity: counterpartyId }
    : { secret, inboundEntity: counterpartyId });
  state.paybook.entries.set(lock.hashlock, entry);
  return entry;
}

export function armPaymentSecretAckTimeout(
  state: EntityState,
  entry: PaybookEntry,
): void {
  if (!hasInboundPayment(entry)) {
    throw new Error(`PAYBOOK_SECRET_ACK_INBOUND_REQUIRED:${entry.hashlock}`);
  }
  if (!state.crontabState) {
    throw new Error(`PAYBOOK_SECRET_ACK_CRONTAB_MISSING:${entry.hashlock}`);
  }

  const deadline = state.timestamp + HTLC_SECRET_ACK_TIMEOUT_MS;
  entry.secretAckPending = true;
  entry.secretAckStartedAt = state.timestamp;
  entry.secretAckDeadlineAt = deadline;
  scheduleHook(state.crontabState, {
    id: `htlc-secret-ack:${entry.hashlock}`,
    triggerAt: deadline,
    type: 'htlc_secret_ack_timeout',
    data: {
      hashlock: entry.hashlock,
      counterpartyEntityId: entry.inboundEntity,
    },
  });
}

export function terminatePayment(state: EntityState, hashlock: string): void {
  const entry = state.paybook.entries.get(hashlock);
  if (!entry) return;
  if (state.crontabState) cancelHook(state.crontabState, `htlc-secret-ack:${hashlock}`);
  state.paybook.entries.delete(hashlock);
}

export function failOriginatedPayment(
  state: EntityState,
  candidateEffects: EntityCandidateEffect[],
  hashlock: string,
  reason: string,
): boolean {
  const entry = state.paybook.entries.get(hashlock);
  if (!entry || hasInboundPayment(entry)) return false;
  candidateEffects.push({
    kind: 'runtimeEvent',
    eventName: 'HtlcFailed',
    data: {
      hashlock,
      lockId: hashlock,
      reason,
      entityId: state.entityId,
      ...(entry.description ? { description: entry.description } : {}),
    },
  });
  terminatePayment(state, hashlock);
  return true;
}
