import type { JBatch } from '../../jurisdiction/machine/batch';
import { hashProofBodyStruct } from '../../protocol/dispute/proof-builder';

const normalizeCounterpartyId = (value: unknown): string => String(value || '').trim().toLowerCase();

export function scrubDisputeFinalizationsForCounterparty(
  batch: JBatch | null | undefined,
  counterpartyEntityId: unknown,
): number {
  if (!batch || !Array.isArray(batch.disputeFinalizations) || batch.disputeFinalizations.length === 0) {
    return 0;
  }
  const counterpartyId = normalizeCounterpartyId(counterpartyEntityId);
  if (!counterpartyId) return 0;
  const before = batch.disputeFinalizations.length;
  batch.disputeFinalizations = batch.disputeFinalizations.filter(
    (entry) => normalizeCounterpartyId(entry?.counterentity) !== counterpartyId,
  );
  return before - batch.disputeFinalizations.length;
}

/**
 * Once either party starts an Account dispute, every queued start for that
 * bilateral Account is unmineable because Account reverts E6. Hash-ladder
 * registrations are independent public evidence and MUST remain untouched:
 * their later financial meaning is decided only by a signed Pull and timestamp.
 */
export function scrubDisputeStartsForCounterparty(
  batch: JBatch | null | undefined,
  counterpartyEntityId: unknown,
): number {
  if (!batch) return 0;
  const counterpartyId = normalizeCounterpartyId(counterpartyEntityId);
  if (!counterpartyId) return 0;
  const startsBefore = batch.disputeStarts.length;
  batch.disputeStarts = batch.disputeStarts.filter(
    start => normalizeCounterpartyId(start.counterentity) !== counterpartyId,
  );
  return startsBefore - batch.disputeStarts.length;
}

/** Remove counter-proof responses that cannot bind to the authoritative start. */
export function scrubCounterDisputesForActiveStart(
  batch: JBatch | null | undefined,
  counterpartyEntityId: unknown,
  activeInitialProofbodyHash: unknown,
): number {
  if (!batch) return 0;
  const counterpartyId = normalizeCounterpartyId(counterpartyEntityId);
  const initialHash = String(activeInitialProofbodyHash || '').toLowerCase();
  const before = batch.counterDisputes.length;
  batch.counterDisputes = batch.counterDisputes.filter(item => !(
    normalizeCounterpartyId(item.counterentity) === counterpartyId
    && item.initialProofbodyHash.toLowerCase() !== initialHash
  ));
  return before - batch.counterDisputes.length;
}

export function scrubCounterDisputesForCounterparty(
  batch: JBatch | null | undefined,
  counterpartyEntityId: unknown,
): number {
  if (!batch) return 0;
  const counterpartyId = normalizeCounterpartyId(counterpartyEntityId);
  const before = batch.counterDisputes.length;
  batch.counterDisputes = batch.counterDisputes.filter(
    item => normalizeCounterpartyId(item.counterentity) !== counterpartyId,
  );
  return before - batch.counterDisputes.length;
}

/**
 * An observed counter-proof does not invalidate a strictly better queued
 * bilateral branch. Higher nonce wins; at equal nonce LEFT wins over RIGHT.
 * Exact retries are harmless in an immutable sent batch (and may still own its
 * Hanko ACK), but are redundant in editable/recovery queues.
 */
export function scrubCounterDisputesSupersededByObserved(
  batch: JBatch | null | undefined,
  counterpartyEntityId: unknown,
  observedNonce: number,
  observedProposerIsLeft: boolean,
  observedProofbodyHash: string,
  preserveExact: boolean,
): number {
  if (!batch) return 0;
  const counterpartyId = normalizeCounterpartyId(counterpartyEntityId);
  const observedHash = observedProofbodyHash.toLowerCase();
  const before = batch.counterDisputes.length;
  batch.counterDisputes = batch.counterDisputes.filter(item => {
    if (normalizeCounterpartyId(item.counterentity) !== counterpartyId) return true;
    if (item.counterNonce > observedNonce) return true;
    if (item.counterNonce < observedNonce) return false;
    if (item.proposerIsLeft !== observedProposerIsLeft) {
      return item.proposerIsLeft && !observedProposerIsLeft;
    }
    const exact = hashProofBodyStruct(item.counterProofbody).toLowerCase() === observedHash;
    return preserveExact && exact;
  });
  return before - batch.counterDisputes.length;
}

/**
 * A first Source write is admitted only while this bilateral dispute is
 * active. Once finality clears the Account clock, retrying an unmined Source
 * registration can only revert and poison its whole Entity batch. Target
 * evidence is intentionally preserved because its replaceable slot remains a
 * useful public observation independent of this finished clock.
 */
export function scrubSourceHashLadderRegistrationsForCounterparty(
  batch: JBatch | null | undefined,
  counterpartyEntityId: unknown,
): number {
  if (!batch) return 0;
  const counterpartyId = normalizeCounterpartyId(counterpartyEntityId);
  if (!counterpartyId) return 0;
  const before = batch.hashLadderRegistrations.length;
  batch.hashLadderRegistrations = batch.hashLadderRegistrations.filter(
    registration => !(
      registration.targetRole === false
      && normalizeCounterpartyId(registration.counterpartyEntity) === counterpartyId
    ),
  );
  return before - batch.hashLadderRegistrations.length;
}
