import type { HtlcLock } from '../../types/account';
import type { EntityCandidateEffect, EntityState, PaybookEntry } from '../types';
import { hasInboundPayment } from './views';
import type { BookIntentSlotWriter } from '../books/book-intents';

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
  bookIntentSlot: BookIntentSlotWriter,
): PaybookEntry {
  assertCanonicalPaymentId(lock);
  const existing = bookIntentSlot.getPaybookEntry(state, lock.hashlock);
  const entry = existing
    ? bookIntentSlot.getPaybookEntryForWrite(state, lock.hashlock)
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
  if (!existing) bookIntentSlot.putPaybookEntry(state, lock.hashlock, entry);
  return entry;
}

export function armPaymentSecretAckTimeout(
  state: EntityState,
  entry: PaybookEntry,
): void {
  if (!hasInboundPayment(entry)) {
    throw new Error(`PAYBOOK_SECRET_ACK_INBOUND_REQUIRED:${entry.hashlock}`);
  }
  // The deadline lives on the entry; the scheduler derives the wake from it.
  entry.secretAckPending = true;
  entry.secretAckStartedAt = state.timestamp;
  entry.secretAckDeadlineAt = state.timestamp + HTLC_SECRET_ACK_TIMEOUT_MS;
}

export function programPaymentTermination(
  state: EntityState,
  hashlock: string,
  bookIntentSlot: BookIntentSlotWriter,
): void {
  const entry = bookIntentSlot.getPaybookEntry(state, hashlock);
  if (!entry) return;
  bookIntentSlot.deletePaybookEntry(state, hashlock);
}

/** Existing Stage-3 proposal-rejection cleanup, which is discovered after Books. */
export function terminatePayment(
  state: EntityState,
  hashlock: string,
): void {
  if (!state.paybook.entries.has(hashlock)) return;
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
