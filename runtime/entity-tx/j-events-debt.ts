import type { DebtEntry, DebtEventType, EntityState, JurisdictionEvent } from '../types';
import { addMessage } from '../state-helpers';

const normalizeDebtEntityId = (value: unknown): string => String(value || '').trim().toLowerCase();

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
    if (preferred) return preferred;
  }

  candidates.sort((left, right) =>
    left.createdDebtIndex - right.createdDebtIndex ||
    left.createdAtBlock - right.createdAtBlock ||
    (left.debtId === right.debtId ? 0 : left.debtId < right.debtId ? -1 : 1),
  );
  return candidates[0] ?? null;
}

function noteDebtLedgerDivergence(
  state: EntityState,
  kind: DebtEventType,
  debtor: string,
  creditor: string,
  tokenId: number,
  detail: string,
): void {
  const message = `⚠️ DEBT_LEDGER_DIVERGENCE ${kind} token=${tokenId} debtor=${debtor.slice(-8)} creditor=${creditor.slice(-8)} ${detail}`;
  console.warn(message);
  addMessage(state, message);
}

export function applyDebtCreated(state: EntityState, event: Extract<JurisdictionEvent, { type: 'DebtCreated' }>): void {
  const { debtor, creditor, tokenId, amount, debtIndex } = event.data;
  const debtAmount = BigInt(amount);
  const block = Number(event.blockNumber || 0);
  const txHash = String(event.transactionHash || '');
  const debtId = buildDebtId(debtor, tokenId, debtIndex, block, txHash);
  const entityId = normalizeDebtEntityId(state.entityId);
  if (entityId !== normalizeDebtEntityId(debtor) && entityId !== normalizeDebtEntityId(creditor)) return;

  const direction = entityId === normalizeDebtEntityId(debtor) ? 'out' : 'in';
  const counterparty = direction === 'out' ? creditor : debtor;
  const bucket = ensureDebtBucket(state, direction, tokenId);
  if (bucket.has(debtId)) return;

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
    forgivenAmount: 0n,
    createdDebtIndex: debtIndex,
    currentDebtIndex: debtIndex,
    status: 'open',
    createdAtBlock: block,
    createdTxHash: txHash,
    lastUpdatedBlock: block,
    lastUpdatedTxHash: txHash,
    lastEventType: 'DebtCreated',
    updates: [{
      eventType: 'DebtCreated',
      blockNumber: block,
      transactionHash: txHash,
      amountDelta: debtAmount,
      remainingAmount: debtAmount,
    }],
  });
}

export function applyDebtEnforced(state: EntityState, event: Extract<JurisdictionEvent, { type: 'DebtEnforced' }>): void {
  const { debtor, creditor, tokenId, amountPaid, remainingAmount, newDebtIndex } = event.data;
  const entityId = normalizeDebtEntityId(state.entityId);
  if (entityId !== normalizeDebtEntityId(debtor) && entityId !== normalizeDebtEntityId(creditor)) return;

  const direction = entityId === normalizeDebtEntityId(debtor) ? 'out' : 'in';
  const debt = findEarliestOutstandingDebt(state, direction, tokenId, debtor, creditor);
  if (!debt) {
    noteDebtLedgerDivergence(state, 'DebtEnforced', debtor, creditor, tokenId, `missing-open-debt amountPaid=${amountPaid} remaining=${remainingAmount}`);
    return;
  }

  const paidDelta = BigInt(amountPaid);
  const nextRemaining = BigInt(remainingAmount);
  const block = Number(event.blockNumber || 0);
  const txHash = String(event.transactionHash || '');
  debt.paidAmount += paidDelta;
  debt.remainingAmount = nextRemaining;
  debt.currentDebtIndex = nextRemaining > 0n ? newDebtIndex : null;
  debt.status = nextRemaining === 0n ? 'paid' : 'open';
  debt.lastUpdatedBlock = block;
  debt.lastUpdatedTxHash = txHash;
  debt.lastEventType = 'DebtEnforced';
  debt.updates.push({
    eventType: 'DebtEnforced',
    blockNumber: block,
    transactionHash: txHash,
    amountDelta: paidDelta,
    remainingAmount: nextRemaining,
  });
}

export function applyDebtForgiven(state: EntityState, event: Extract<JurisdictionEvent, { type: 'DebtForgiven' }>): void {
  const { debtor, creditor, tokenId, amountForgiven, debtIndex } = event.data;
  const entityId = normalizeDebtEntityId(state.entityId);
  if (entityId !== normalizeDebtEntityId(debtor) && entityId !== normalizeDebtEntityId(creditor)) return;

  const direction = entityId === normalizeDebtEntityId(debtor) ? 'out' : 'in';
  const debt = findEarliestOutstandingDebt(state, direction, tokenId, debtor, creditor, debtIndex);
  if (!debt) {
    noteDebtLedgerDivergence(state, 'DebtForgiven', debtor, creditor, tokenId, `missing-open-debt forgiven=${amountForgiven} debtIndex=${debtIndex}`);
    return;
  }

  const requestedForgiven = BigInt(amountForgiven);
  const forgivenDelta = debt.remainingAmount;
  if (requestedForgiven !== debt.remainingAmount) {
    noteDebtLedgerDivergence(
      state,
      'DebtForgiven',
      debtor,
      creditor,
      tokenId,
      `forgive-mismatch requested=${requestedForgiven} remaining=${debt.remainingAmount} debtIndex=${debtIndex}`,
    );
  }
  const nextRemaining = 0n;
  const block = Number(event.blockNumber || 0);
  const txHash = String(event.transactionHash || '');
  debt.forgivenAmount += forgivenDelta;
  debt.remainingAmount = nextRemaining;
  debt.currentDebtIndex = nextRemaining > 0n ? debtIndex : null;
  debt.status = nextRemaining === 0n ? 'forgiven' : 'open';
  debt.lastUpdatedBlock = block;
  debt.lastUpdatedTxHash = txHash;
  debt.lastEventType = 'DebtForgiven';
  debt.updates.push({
    eventType: 'DebtForgiven',
    blockNumber: block,
    transactionHash: txHash,
    amountDelta: forgivenDelta,
    remainingAmount: nextRemaining,
  });
}
