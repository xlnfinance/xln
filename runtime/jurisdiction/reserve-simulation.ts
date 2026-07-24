import type { JBatch } from './batch';
import { normalizeEntityId } from '../entity/id';

export type DraftBatchReserveOpType =
  | 'reserveToReserve'
  | 'settlement'
  | 'reserveToCollateral'
  | 'reserveToExternalToken'
  | 'flashloan';

export interface DraftBatchReserveIssue {
  tokenId: number;
  opType: DraftBatchReserveOpType;
  opIndex: number;
  failureMode: 'skipped' | 'batchRevert';
  requiredAmount: bigint;
  availableAfterDebt: bigint;
  debtClaimPaid: bigint;
  remainingDebtAfterSweep: bigint;
}

export interface DraftBatchReserveSimulation {
  issues: DraftBatchReserveIssue[];
  reservesByToken: Map<number, bigint>;
  outgoingDebtByToken: Map<number, bigint>;
}

export type OpenOutgoingDebtLedger = ReadonlyMap<
  number,
  ReadonlyMap<string, { status: string; remainingAmount: bigint | string | number }>
>;

type DebtSweep = {
  availableAfterDebt: bigint;
  debtClaimPaid: bigint;
  remainingDebtAfterSweep: bigint;
};

const readAmount = (source: Map<number, bigint> | null | undefined, tokenId: number): bigint =>
  source?.get(tokenId) ?? 0n;

function writeAmount(target: Map<number, bigint>, tokenId: number, amount: bigint): void {
  if (amount === 0n) target.delete(tokenId);
  else target.set(tokenId, amount);
}

function addAmount(target: Map<number, bigint>, tokenId: number, amount: bigint): void {
  writeAmount(target, tokenId, readAmount(target, tokenId) + amount);
}

function spendableReserve(
  reservesByToken: Map<number, bigint>,
  outgoingDebtByToken: Map<number, bigint>,
  tokenId: number,
): bigint {
  const reserve = readAmount(reservesByToken, tokenId);
  const debt = readAmount(outgoingDebtByToken, tokenId);
  return reserve > debt ? reserve - debt : 0n;
}

function sweepOutgoingDebt(
  reservesByToken: Map<number, bigint>,
  outgoingDebtByToken: Map<number, bigint>,
  tokenId: number,
): DebtSweep {
  const reserve = readAmount(reservesByToken, tokenId);
  const debt = readAmount(outgoingDebtByToken, tokenId);
  const paid = reserve < debt ? reserve : debt;
  writeAmount(reservesByToken, tokenId, reserve - paid);
  writeAmount(outgoingDebtByToken, tokenId, debt - paid);
  return {
    availableAfterDebt: reserve - paid,
    debtClaimPaid: paid,
    remainingDebtAfterSweep: debt - paid,
  };
}

function pushSkipIssue(
  issues: DraftBatchReserveIssue[],
  sweep: DebtSweep,
  tokenId: number,
  opType: DraftBatchReserveOpType,
  opIndex: number,
  amount: bigint,
): void {
  issues.push({
    tokenId,
    opType,
    opIndex,
    failureMode: 'skipped',
    requiredAmount: amount,
    ...sweep,
  });
}

function spendBestEffort(
  state: DraftBatchReserveSimulation,
  tokenId: number,
  amount: bigint,
  opType: DraftBatchReserveOpType,
  opIndex: number,
): boolean {
  const sweep = sweepOutgoingDebt(state.reservesByToken, state.outgoingDebtByToken, tokenId);
  if (sweep.availableAfterDebt < amount) {
    pushSkipIssue(state.issues, sweep, tokenId, opType, opIndex, amount);
    return false;
  }
  writeAmount(state.reservesByToken, tokenId, sweep.availableAfterDebt - amount);
  return true;
}

function applySettlement(
  state: DraftBatchReserveSimulation,
  entityId: string,
  settlement: JBatch['settlements'][number],
  opIndex: number,
  debtSweeps: Map<number, DebtSweep>,
): void {
  const isLeft = normalizeEntityId(settlement.leftEntity) === entityId;
  const isRight = normalizeEntityId(settlement.rightEntity) === entityId;
  if (!isLeft && !isRight) return;
  for (const diff of settlement.diffs) {
    const ownDiff = isLeft ? diff.leftDiff : diff.rightDiff;
    if (ownDiff >= 0n) continue;
    const available = spendableReserve(state.reservesByToken, state.outgoingDebtByToken, diff.tokenId);
    if (available >= -ownDiff) continue;
    const sweep = debtSweeps.get(diff.tokenId);
    pushSkipIssue(state.issues, {
      availableAfterDebt: available,
      debtClaimPaid: sweep?.debtClaimPaid ?? 0n,
      remainingDebtAfterSweep: readAmount(state.outgoingDebtByToken, diff.tokenId),
    }, diff.tokenId, 'settlement', opIndex, -ownDiff);
    return;
  }
  for (const diff of settlement.diffs) {
    addAmount(state.reservesByToken, diff.tokenId, isLeft ? diff.leftDiff : diff.rightDiff);
  }
}

function finalizeFlashloans(
  state: DraftBatchReserveSimulation,
  startingReserves: Map<number, bigint>,
  flashloansByToken: Map<number, bigint>,
): boolean {
  for (const [tokenId, loan] of flashloansByToken) {
    const required = readAmount(startingReserves, tokenId) + loan;
    const available = readAmount(state.reservesByToken, tokenId);
    if (available >= required) continue;
    state.issues.push({
      tokenId,
      opType: 'flashloan',
      opIndex: 0,
      failureMode: 'batchRevert',
      requiredAmount: required,
      availableAfterDebt: available,
      debtClaimPaid: 0n,
      remainingDebtAfterSweep: readAmount(state.outgoingDebtByToken, tokenId),
    });
    return false;
  }
  for (const [tokenId, loan] of flashloansByToken) {
    addAmount(state.reservesByToken, tokenId, -loan);
  }
  return true;
}

export function getOpenOutgoingDebtTotals(
  ledger: OpenOutgoingDebtLedger | null | undefined,
): Map<number, bigint> {
  const totals = new Map<number, bigint>();
  for (const [tokenId, bucket] of ledger ?? []) {
    let total = 0n;
    for (const debt of bucket.values()) {
      if (debt.status === 'open') total += BigInt(debt.remainingAmount);
    }
    if (total > 0n) totals.set(tokenId, total);
  }
  return totals;
}

export function simulateDraftBatchReserveAvailability(
  entityIdInput: string,
  currentReserves: Map<number, bigint> | null | undefined,
  batch: JBatch | null | undefined,
  outgoingDebtInput: Map<number, bigint> | null | undefined,
): DraftBatchReserveSimulation {
  const startingReserves = new Map(currentReserves ?? []);
  const startingDebts = new Map(outgoingDebtInput ?? []);
  const state: DraftBatchReserveSimulation = {
    issues: [],
    reservesByToken: new Map(startingReserves),
    outgoingDebtByToken: new Map(startingDebts),
  };
  if (!batch) return state;
  const entityId = normalizeEntityId(entityIdInput);
  const flashloansByToken = new Map<number, bigint>();
  const settlementDebtSweeps = new Map<number, DebtSweep>();

  for (const op of batch.flashloans) addAmount(flashloansByToken, op.tokenId, op.amount);
  for (const [tokenId, amount] of flashloansByToken) addAmount(state.reservesByToken, tokenId, amount);
  for (const op of batch.externalTokenToReserve) {
    const target = op.entity ? normalizeEntityId(op.entity) : entityId;
    if (target === entityId) addAmount(state.reservesByToken, op.internalTokenId, op.amount);
  }
  for (const [index, op] of batch.reserveToReserve.entries()) {
    if (!spendBestEffort(state, op.tokenId, op.amount, 'reserveToReserve', index)) continue;
    if (normalizeEntityId(op.receivingEntity) === entityId) addAmount(state.reservesByToken, op.tokenId, op.amount);
  }
  for (const op of batch.collateralToReserve) addAmount(state.reservesByToken, op.tokenId, op.amount);

  for (const settlement of batch.settlements) {
    const isLeft = normalizeEntityId(settlement.leftEntity) === entityId;
    const isRight = normalizeEntityId(settlement.rightEntity) === entityId;
    for (const diff of settlement.diffs) {
      const ownDiff = isLeft ? diff.leftDiff : isRight ? diff.rightDiff : 0n;
      if (ownDiff >= 0n) continue;
      const swept = sweepOutgoingDebt(state.reservesByToken, state.outgoingDebtByToken, diff.tokenId);
      const prior = settlementDebtSweeps.get(diff.tokenId);
      settlementDebtSweeps.set(diff.tokenId, {
        availableAfterDebt: swept.availableAfterDebt,
        debtClaimPaid: (prior?.debtClaimPaid ?? 0n) + swept.debtClaimPaid,
        remainingDebtAfterSweep: swept.remainingDebtAfterSweep,
      });
    }
  }
  for (const [index, settlement] of batch.settlements.entries()) {
    applySettlement(state, entityId, settlement, index, settlementDebtSweeps);
  }
  for (const [index, op] of batch.reserveToCollateral.entries()) {
    const amount = op.pairs.reduce((sum, pair) => sum + pair.amount, 0n);
    spendBestEffort(state, op.tokenId, amount, 'reserveToCollateral', index);
  }
  for (const [index, op] of batch.reserveToExternalToken.entries()) {
    spendBestEffort(state, op.tokenId, op.amount, 'reserveToExternalToken', index);
  }
  if (!finalizeFlashloans(state, startingReserves, flashloansByToken)) {
    state.reservesByToken = startingReserves;
    state.outgoingDebtByToken = startingDebts;
  }
  return state;
}
