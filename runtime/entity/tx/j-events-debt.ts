import type { DebtEntry, DebtEventType, EntityState, JurisdictionEvent } from '../../types';
import { createStructuredLogger, shortId } from '../../infra/logger';

const debtLog = createStructuredLogger('entity.debt');

const normalizeDebtEntityId = (value: unknown): string => String(value || '').trim().toLowerCase();

const debtLedgerDivergence = (
  kind: DebtEventType,
  debtor: string,
  creditor: string,
  tokenId: number,
  detail: string,
): Error => {
  debtLog.error('ledger.divergence', {
    kind,
    tokenId,
    debtor: shortId(debtor, 8),
    creditor: shortId(creditor, 8),
    detail,
  });
  return new Error(`DEBT_LEDGER_DIVERGENCE:${kind}:${detail}:${tokenId}:${debtor}:${creditor}`);
};

function ensureDebtMaps(state: EntityState, direction: 'out' | 'in'): Map<number, Map<string, DebtEntry>> {
  const key = direction === 'out' ? 'outDebtsByToken' : 'inDebtsByToken';
  if (!state[key]) {
    state[key] = new Map();
  }
  return state[key]!;
}

function ensureDebtBucket(
  state: EntityState,
  direction: 'out' | 'in',
  tokenId: number,
): Map<string, DebtEntry> {
  const ledger = ensureDebtMaps(state, direction);
  const existing = ledger.get(tokenId);
  if (existing) return existing;
  const created = new Map<string, DebtEntry>();
  ledger.set(tokenId, created);
  return created;
}

function buildDebtId(
  debtor: string,
  tokenId: number,
  createdDebtIndex: number,
  createdAtBlock: number,
  createdTxHash: string,
): string {
  return `${normalizeDebtEntityId(debtor)}:${tokenId}:${createdDebtIndex}:${createdAtBlock}:${String(createdTxHash || '').toLowerCase()}`;
}

function appendDebtEntry(state: EntityState, direction: 'out' | 'in', entry: DebtEntry): void {
  ensureDebtBucket(state, direction, entry.tokenId).set(entry.debtId, entry);
}

function retireDebtEntry(state: EntityState, direction: 'out' | 'in', entry: DebtEntry): void {
  const ledger = direction === 'out' ? state.outDebtsByToken : state.inDebtsByToken;
  const bucket = ledger?.get(entry.tokenId);
  if (!bucket?.delete(entry.debtId)) {
    throw new Error(`DEBT_LEDGER_RETIRE_MISSING:${entry.debtId}`);
  }
  if (bucket.size === 0) ledger!.delete(entry.tokenId);
  if (ledger!.size > 0) return;
  if (direction === 'out') delete state.outDebtsByToken;
  else delete state.inDebtsByToken;
}

function findEarliestOutstandingDebt(
  state: EntityState,
  direction: 'out' | 'in',
  tokenId: number,
  debtor: string,
  creditor: string,
  preferredDebtIndex?: number | null,
): DebtEntry | null {
  const bucket = (direction === 'out' ? state.outDebtsByToken : state.inDebtsByToken)?.get(tokenId);
  if (!bucket) return null;

  const normalizedDebtor = normalizeDebtEntityId(debtor);
  const normalizedCreditor = normalizeDebtEntityId(creditor);
  const candidates = Array.from(bucket.values()).filter((entry) =>
    entry.status === 'open' &&
    normalizeDebtEntityId(entry.debtor) === normalizedDebtor &&
    normalizeDebtEntityId(entry.creditor) === normalizedCreditor,
  );

  if (preferredDebtIndex != null) {
    const preferred = candidates.find((entry) => Number(entry.currentDebtIndex ?? -1) === preferredDebtIndex);
    return preferred ?? null;
  }

  candidates.sort((left, right) =>
    left.createdDebtIndex - right.createdDebtIndex ||
    left.createdAtBlock - right.createdAtBlock ||
    (left.debtId === right.debtId ? 0 : left.debtId < right.debtId ? -1 : 1),
  );
  return candidates[0] ?? null;
}

export function applyDebtCreated(state: EntityState, event: Extract<JurisdictionEvent, { type: 'DebtCreated' }>): void {
  const { debtor, creditor, tokenId, amount, debtIndex } = event.data;
  const debtAmount = BigInt(amount);
  if (debtAmount <= 0n) throw new Error(`DEBT_CREATED_AMOUNT_INVALID:${amount}`);
  if (!Number.isSafeInteger(tokenId) || tokenId < 0) throw new Error(`DEBT_CREATED_TOKEN_INVALID:${tokenId}`);
  if (!Number.isSafeInteger(debtIndex) || debtIndex < 0) throw new Error(`DEBT_CREATED_INDEX_INVALID:${debtIndex}`);
  const block = Number(event.blockNumber || 0);
  const txHash = String(event.transactionHash || '');
  const debtId = buildDebtId(debtor, tokenId, debtIndex, block, txHash);
  const entityId = normalizeDebtEntityId(state.entityId);
  if (entityId !== normalizeDebtEntityId(debtor) && entityId !== normalizeDebtEntityId(creditor)) return;

  const direction = entityId === normalizeDebtEntityId(debtor) ? 'out' : 'in';
  const counterparty = direction === 'out' ? creditor : debtor;
  const bucket = ensureDebtBucket(state, direction, tokenId);
  const existing = bucket.get(debtId);
  if (existing) {
    const exactDuplicate =
      existing.lastEventType === 'DebtCreated' &&
      existing.createdAmount === debtAmount &&
      existing.remainingAmount === debtAmount &&
      existing.paidAmount === 0n;
    if (!exactDuplicate) throw new Error(`DEBT_CREATED_ID_CONFLICT:${debtId}`);
    return;
  }

  appendDebtEntry(state, direction, {
    debtId,
    tokenId,
    debtor,
    creditor,
    counterparty,
    direction,
    createdAmount: debtAmount,
    paidAmount: 0n,
    remainingAmount: debtAmount,
    createdDebtIndex: debtIndex,
    currentDebtIndex: debtIndex,
    status: 'open',
    createdAtBlock: block,
    createdTxHash: txHash,
    lastUpdatedBlock: block,
    lastUpdatedTxHash: txHash,
    lastEventType: 'DebtCreated',
  });
}

export function applyDebtEnforced(state: EntityState, event: Extract<JurisdictionEvent, { type: 'DebtEnforced' }>): void {
  const { debtor, creditor, tokenId, amountPaid, remainingAmount, newDebtIndex } = event.data;
  const entityId = normalizeDebtEntityId(state.entityId);
  if (entityId !== normalizeDebtEntityId(debtor) && entityId !== normalizeDebtEntityId(creditor)) return;

  const direction = entityId === normalizeDebtEntityId(debtor) ? 'out' : 'in';
  const debt = findEarliestOutstandingDebt(state, direction, tokenId, debtor, creditor);
  if (!debt) {
    throw debtLedgerDivergence('DebtEnforced', debtor, creditor, tokenId, 'missing-open-debt');
  }

  const paidDelta = BigInt(amountPaid);
  const nextRemaining = BigInt(remainingAmount);
  if (paidDelta <= 0n || nextRemaining < 0n || paidDelta + nextRemaining !== debt.remainingAmount) {
    throw new Error(
      `DEBT_ENFORCED_AMOUNT_MISMATCH:${debt.debtId}:before=${debt.remainingAmount}:paid=${paidDelta}:after=${nextRemaining}`,
    );
  }
  const expectedDebtIndex = nextRemaining === 0n ? debt.currentDebtIndex + 1 : debt.currentDebtIndex;
  if (!Number.isSafeInteger(newDebtIndex) || newDebtIndex !== expectedDebtIndex) {
    throw new Error(
      `DEBT_ENFORCED_INDEX_MISMATCH:${debt.debtId}:expected=${expectedDebtIndex}:actual=${newDebtIndex}`,
    );
  }
  const block = Number(event.blockNumber || 0);
  const txHash = String(event.transactionHash || '');
  if (nextRemaining === 0n) {
    retireDebtEntry(state, direction, debt);
    return;
  }
  debt.paidAmount += paidDelta;
  debt.remainingAmount = nextRemaining;
  debt.currentDebtIndex = newDebtIndex;
  debt.lastUpdatedBlock = block;
  debt.lastUpdatedTxHash = txHash;
  debt.lastEventType = 'DebtEnforced';
}

export function applyDebtForgiven(state: EntityState, event: Extract<JurisdictionEvent, { type: 'DebtForgiven' }>): void {
  const { debtor, creditor, tokenId, amountForgiven, debtIndex } = event.data;
  const entityId = normalizeDebtEntityId(state.entityId);
  if (entityId !== normalizeDebtEntityId(debtor) && entityId !== normalizeDebtEntityId(creditor)) return;

  const direction = entityId === normalizeDebtEntityId(debtor) ? 'out' : 'in';
  const debt = findEarliestOutstandingDebt(state, direction, tokenId, debtor, creditor, debtIndex);
  if (!debt) {
    throw debtLedgerDivergence('DebtForgiven', debtor, creditor, tokenId, `missing-open-debt:index=${debtIndex}`);
  }

  const requestedForgiven = BigInt(amountForgiven);
  if (requestedForgiven !== debt.remainingAmount) {
    throw new Error(
      `DEBT_FORGIVEN_AMOUNT_MISMATCH:${debt.debtId}:expected=${debt.remainingAmount}:actual=${requestedForgiven}`,
    );
  }
  retireDebtEntry(state, direction, debt);
}
