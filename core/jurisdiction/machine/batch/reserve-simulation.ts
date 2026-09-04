import type { JBatch } from './';
import { normalizeEntityId } from '../../../entity/id';

type DraftBatchReserveOpType =
  | 'reserveToReserve'
  | 'settlement'
  | 'reserveToCollateral'
  | 'reserveToExternalToken';

export interface DraftBatchReserveIssue {
  tokenId: number;
  opType: DraftBatchReserveOpType;
  opIndex: number;
  failureMode: 'batchRevert';
  requiredAmount: bigint;
  availableAfterDebt: bigint;
  debtClaimPaid: bigint;
  remainingDebtAfterSweep: bigint;
  /**
   * Implicit flash credit this op opened that the batch never repaid
   * (Depository._processBatch reverts unless every deficit is zero at the
   * end). Zero when the op itself is rejected on the spot.
   */
  unrepaidDeficit: bigint;
}

export interface DraftBatchReserveSimulation {
  issues: DraftBatchReserveIssue[];
  reservesByToken: Map<number, bigint>;
  outgoingDebtByToken: Map<number, bigint>;
  /**
   * Implicit flash credit still open per token (Types.BatchScratch.deficit).
   * The batch initiator may spend a token it does not hold while it owes no
   * debt in that token; inflows repay the deficit first, and the contract
   * reverts the whole batch unless every deficit is zero at the end.
   */
  deficitByToken: Map<number, bigint>;
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

/** The op that first overdrew a token; reported if its deficit is never repaid. */
type DeficitOrigin = DebtSweep & {
  opType: DraftBatchReserveOpType;
  opIndex: number;
  requiredAmount: bigint;
};

type Simulation = {
  state: DraftBatchReserveSimulation;
  deficitOrigins: Map<number, DeficitOrigin>;
};

const readAmount = (source: Map<number, bigint> | null | undefined, tokenId: number): bigint =>
  source?.get(tokenId) ?? 0n;

function writeAmount(target: Map<number, bigint>, tokenId: number, amount: bigint): void {
  if (amount === 0n) target.delete(tokenId);
  else target.set(tokenId, amount);
}

/** Inflow to the initiator: repays the open deficit first (Account._increaseReserve). */
function creditInitiator(state: DraftBatchReserveSimulation, tokenId: number, amount: bigint): void {
  if (amount <= 0n) return;
  const owed = readAmount(state.deficitByToken, tokenId);
  const repaid = amount < owed ? amount : owed;
  writeAmount(state.deficitByToken, tokenId, owed - repaid);
  const remaining = amount - repaid;
  if (remaining > 0n) writeAmount(state.reservesByToken, tokenId, readAmount(state.reservesByToken, tokenId) + remaining);
}

type DebitOutcome = 'spent' | 'deficit' | 'rejected';

/**
 * Outflow from the initiator (Account._decreaseReserve + _canSpend): the plain
 * reserve first; the shortfall becomes deficit only when the initiator has no
 * outstanding debt in that token. Intermediate reserve shows 0 while in deficit.
 */
function debitInitiator(
  state: DraftBatchReserveSimulation,
  tokenId: number,
  amount: bigint,
  remainingDebt: bigint,
): DebitOutcome {
  const reserve = readAmount(state.reservesByToken, tokenId);
  if (reserve >= amount) {
    writeAmount(state.reservesByToken, tokenId, reserve - amount);
    return 'spent';
  }
  if (remainingDebt !== 0n) return 'rejected';
  writeAmount(state.deficitByToken, tokenId, readAmount(state.deficitByToken, tokenId) + (amount - reserve));
  writeAmount(state.reservesByToken, tokenId, 0n);
  return 'deficit';
}

function recordDeficitOrigin(
  simulation: Simulation,
  tokenId: number,
  sweep: DebtSweep,
  opType: DraftBatchReserveOpType,
  opIndex: number,
  amount: bigint,
): void {
  if (simulation.deficitOrigins.has(tokenId)) return;
  simulation.deficitOrigins.set(tokenId, { ...sweep, opType, opIndex, requiredAmount: amount });
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

/** Depository._enforceDebts before every reserve outflow: FIFO debt is senior. */
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

function pushRevertIssue(
  issues: DraftBatchReserveIssue[],
  sweep: DebtSweep,
  tokenId: number,
  opType: DraftBatchReserveOpType,
  opIndex: number,
  amount: bigint,
  unrepaidDeficit: bigint,
): void {
  issues.push({
    tokenId,
    opType,
    opIndex,
    failureMode: 'batchRevert',
    requiredAmount: amount,
    ...sweep,
    unrepaidDeficit,
  });
}

function spendOrRecordRevert(
  simulation: Simulation,
  tokenId: number,
  amount: bigint,
  opType: DraftBatchReserveOpType,
  opIndex: number,
): boolean {
  const { state } = simulation;
  const sweep = sweepOutgoingDebt(state.reservesByToken, state.outgoingDebtByToken, tokenId);
  const outcome = debitInitiator(state, tokenId, amount, sweep.remainingDebtAfterSweep);
  if (outcome === 'rejected') {
    pushRevertIssue(state.issues, sweep, tokenId, opType, opIndex, amount, 0n);
    return false;
  }
  if (outcome === 'deficit') recordDeficitOrigin(simulation, tokenId, sweep, opType, opIndex, amount);
  return true;
}

function applySettlement(
  simulation: Simulation,
  entityId: string,
  settlement: JBatch['settlements'][number],
  opIndex: number,
  debtSweeps: Map<number, DebtSweep>,
): void {
  const { state } = simulation;
  const isLeft = normalizeEntityId(settlement.leftEntity) === entityId;
  const isRight = normalizeEntityId(settlement.rightEntity) === entityId;
  if (!isLeft && !isRight) return;
  for (const diff of settlement.diffs) {
    const ownDiff = isLeft ? diff.leftDiff : diff.rightDiff;
    if (ownDiff >= 0n) continue;
    const available = spendableReserve(state.reservesByToken, state.outgoingDebtByToken, diff.tokenId);
    if (available >= -ownDiff) continue;
    // Account.processSettlements gates on _canSpend: a debt-free initiator may
    // overdraw into deficit; any remaining debt makes the settlement revert.
    if (readAmount(state.outgoingDebtByToken, diff.tokenId) === 0n) continue;
    const sweep = debtSweeps.get(diff.tokenId);
    pushRevertIssue(state.issues, {
      availableAfterDebt: available,
      debtClaimPaid: sweep?.debtClaimPaid ?? 0n,
      remainingDebtAfterSweep: readAmount(state.outgoingDebtByToken, diff.tokenId),
    }, diff.tokenId, 'settlement', opIndex, -ownDiff, 0n);
    return;
  }
  for (const diff of settlement.diffs) {
    const ownDiff = isLeft ? diff.leftDiff : diff.rightDiff;
    if (ownDiff >= 0n) {
      creditInitiator(state, diff.tokenId, ownDiff);
      continue;
    }
    const sweep: DebtSweep = {
      availableAfterDebt: readAmount(state.reservesByToken, diff.tokenId),
      debtClaimPaid: debtSweeps.get(diff.tokenId)?.debtClaimPaid ?? 0n,
      remainingDebtAfterSweep: readAmount(state.outgoingDebtByToken, diff.tokenId),
    };
    const outcome = debitInitiator(state, diff.tokenId, -ownDiff, sweep.remainingDebtAfterSweep);
    if (outcome === 'deficit') recordDeficitOrigin(simulation, diff.tokenId, sweep, 'settlement', opIndex, -ownDiff);
  }
}

/** Depository._processBatch tail: every deficit the initiator opened must be repaid. */
function finalizeImplicitFlash(simulation: Simulation): void {
  const { state } = simulation;
  for (const [tokenId, deficit] of state.deficitByToken) {
    if (deficit === 0n) continue;
    const origin = simulation.deficitOrigins.get(tokenId);
    if (!origin) throw new Error(`DRAFT_BATCH_DEFICIT_WITHOUT_ORIGIN:${tokenId}`);
    const { opType, opIndex, requiredAmount, ...sweep } = origin;
    pushRevertIssue(state.issues, sweep, tokenId, opType, opIndex, requiredAmount, deficit);
    return;
  }
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

/**
 * Mirror Depository._processBatch for the batch initiator's own reserves,
 * including the implicit flash credit. Non-initiator entities never go
 * negative on chain and are not simulated here.
 */
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
    deficitByToken: new Map(),
  };
  if (!batch) return state;
  const simulation: Simulation = { state, deficitOrigins: new Map() };
  const entityId = normalizeEntityId(entityIdInput);
  const settlementDebtSweeps = new Map<number, DebtSweep>();

  for (const op of batch.externalTokenToReserve) {
    const target = op.entity ? normalizeEntityId(op.entity) : entityId;
    if (target === entityId) creditInitiator(state, op.internalTokenId, op.amount);
  }
  for (const [index, op] of batch.reserveToReserve.entries()) {
    if (!spendOrRecordRevert(simulation, op.tokenId, op.amount, 'reserveToReserve', index)) continue;
    if (normalizeEntityId(op.receivingEntity) === entityId) creditInitiator(state, op.tokenId, op.amount);
  }
  for (const op of batch.collateralToReserve) creditInitiator(state, op.tokenId, op.amount);

  // Depository._enforceSettlementOutflowDebts: every outflow token is swept
  // once, before any settlement diff is applied.
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
    applySettlement(simulation, entityId, settlement, index, settlementDebtSweeps);
  }
  for (const [index, op] of batch.reserveToCollateral.entries()) {
    const amount = op.pairs.reduce((sum, pair) => sum + pair.amount, 0n);
    spendOrRecordRevert(simulation, op.tokenId, amount, 'reserveToCollateral', index);
  }
  for (const [index, op] of batch.reserveToExternalToken.entries()) {
    spendOrRecordRevert(simulation, op.tokenId, op.amount, 'reserveToExternalToken', index);
  }
  finalizeImplicitFlash(simulation);
  if (state.issues.length > 0) {
    state.reservesByToken = startingReserves;
    state.outgoingDebtByToken = startingDebts;
    state.deficitByToken = new Map();
  }
  return state;
}
