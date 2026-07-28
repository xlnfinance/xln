import type { JBatch } from '../../jurisdiction/batch';

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
