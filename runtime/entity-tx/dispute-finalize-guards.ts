import type { EntityState } from '../types';
import type { JBatch } from '../j-batch';

const normalizeCounterpartyId = (value: unknown): string => String(value || '').trim().toLowerCase();

function findAccountByCounterparty(state: EntityState, counterpartyEntityId: unknown) {
  const normalized = normalizeCounterpartyId(counterpartyEntityId);
  if (!normalized) return null;
  for (const [accountId, account] of state.accounts.entries()) {
    const accountIdNorm = normalizeCounterpartyId(accountId);
    const leftNorm = normalizeCounterpartyId(account.leftEntity);
    const rightNorm = normalizeCounterpartyId(account.rightEntity);
    if (accountIdNorm === normalized || leftNorm === normalized || rightNorm === normalized) {
      return account;
    }
  }
  return null;
}

function isFinalizeOpStillLive(
  state: EntityState,
  counterpartyEntityId: unknown,
  initialNonceRaw: unknown,
): boolean {
  const account = findAccountByCounterparty(state, counterpartyEntityId);
  if (!account?.activeDispute) return false;
  const initialNonce = Number(initialNonceRaw ?? 0);
  if (!Number.isFinite(initialNonce) || initialNonce <= 0) return false;
  const onChainSettlementNonce = Number(account.onChainSettlementNonce ?? 0);
  return initialNonce > onChainSettlementNonce;
}

export function hasActiveDisputeForCounterparty(state: EntityState, counterpartyEntityId: unknown): boolean {
  return Boolean(findAccountByCounterparty(state, counterpartyEntityId)?.activeDispute);
}

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

export function filterActiveDisputeFinalizations(
  state: EntityState,
  batch: JBatch | null | undefined,
): { removed: number; droppedCounterparties: Set<string> } {
  const droppedCounterparties = new Set<string>();
  if (!batch || !Array.isArray(batch.disputeFinalizations) || batch.disputeFinalizations.length === 0) {
    return { removed: 0, droppedCounterparties };
  }
  const before = batch.disputeFinalizations.length;
  batch.disputeFinalizations = batch.disputeFinalizations.filter((entry) => {
    const counterpartyId = normalizeCounterpartyId(entry?.counterentity);
    const keep = isFinalizeOpStillLive(state, counterpartyId, entry?.initialNonce);
    if (!keep && counterpartyId) {
      droppedCounterparties.add(counterpartyId);
    }
    return keep;
  });
  return {
    removed: before - batch.disputeFinalizations.length,
    droppedCounterparties,
  };
}
