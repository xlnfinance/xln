import type { AccountTx, EntityInput, EntityState, EntityTx, Env } from '../../types';
import { createStructuredLogger, shortId } from '../../logger';
import { addMessage, cloneEntityState } from '../../state-helpers';
import type { MempoolOp } from './account';
import {
  buildLendingFundingMemo,
  buildLendingLoanId,
  buildLendingPositionId,
  buildLendingRepayMemo,
  computeLendingInterest,
  ensureLendingState,
  getAccountOutCapacity,
  getCreditGrantedByAccountOwner,
  isLendingEntityId,
  LENDING_TERM_MS,
  normalizeInterestBps,
  normalizeLendingTerm,
  selectBestLendingPool,
} from '../../lending';

type EntityTxOf<T extends EntityTx['type']> = Extract<EntityTx, { type: T }>;

type LendingResult = {
  newState: EntityState;
  outputs: EntityInput[];
  mempoolOps?: MempoolOp[];
};

const log = createStructuredLogger('entity.tx.lending');

const processingTrigger = (state: EntityState): EntityInput[] => {
  const firstValidator = state.config.validators[0];
  return firstValidator
    ? [{ entityId: state.entityId, signerId: firstValidator, entityTxs: [] }]
    : [];
};

const requireHub = (state: EntityState): void => {
  if (state.profile?.isHub !== true) {
    throw new Error(`LENDING_HUB_REQUIRED: entity=${state.entityId}`);
  }
};

const requirePositiveAmount = (value: bigint, context: string): void => {
  if (value <= 0n) throw new Error(`${context}_AMOUNT_MUST_BE_POSITIVE`);
};

const requireLogicalNow = (env: Env, context: string): number => {
  const timestamp = Number(env.timestamp);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${context}_TIMESTAMP_INVALID`);
  }
  return Math.max(0, Math.floor(timestamp));
};

const setCreditLimitOp = (
  accountId: string,
  tokenId: number,
  amount: bigint,
): MempoolOp => ({
  accountId,
  tx: {
    type: 'set_credit_limit',
    data: { tokenId, amount },
  } satisfies AccountTx,
});

const directPaymentOp = (
  accountId: string,
  tokenId: number,
  amount: bigint,
  fromEntityId: string,
  toEntityId: string,
  description: string,
): MempoolOp => ({
  accountId,
  tx: {
    type: 'direct_payment',
    data: {
      tokenId,
      amount,
      route: [fromEntityId, toEntityId],
      description,
      fromEntityId,
      toEntityId,
    },
  } satisfies AccountTx,
});

export const handleLendingOfferEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: EntityTxOf<'lendingOffer'>,
): LendingResult => {
  requireHub(entityState);
  const newState = cloneEntityState(entityState);
  const lending = ensureLendingState(newState);
  const lenderEntityId = String(entityTx.data.lenderEntityId || '').toLowerCase();
  if (!isLendingEntityId(lenderEntityId)) throw new Error(`LENDING_INVALID_LENDER: ${String(entityTx.data.lenderEntityId)}`);
  const tokenId = Math.floor(Number(entityTx.data.tokenId));
  if (!Number.isFinite(tokenId) || tokenId <= 0) throw new Error(`LENDING_INVALID_TOKEN: ${String(entityTx.data.tokenId)}`);
  const amount = BigInt(entityTx.data.amount);
  requirePositiveAmount(amount, 'LENDING_OFFER');
  const account = newState.accounts.get(lenderEntityId);
  if (!account) {
    addMessage(newState, `🏦 Lending pool rejected: account with ${shortId(lenderEntityId)} is not open`);
    return { newState, outputs: [] };
  }
  if (!account.deltas.has(tokenId)) {
    addMessage(newState, `🏦 Lending pool rejected: token ${tokenId} is not enabled on account ${shortId(lenderEntityId)}`);
    return { newState, outputs: [] };
  }
  const outCapacity = getAccountOutCapacity(account, lenderEntityId, tokenId);
  if (outCapacity < amount) {
    addMessage(newState, `🏦 Lending pool rejected: insufficient account capacity (${outCapacity}/${amount})`);
    return { newState, outputs: [] };
  }
  const termId = normalizeLendingTerm(entityTx.data.termId);
  const interestBps = normalizeInterestBps(entityTx.data.interestBps);
  const now = requireLogicalNow(env, 'LENDING_OFFER');
  const positionId = entityTx.data.positionId || buildLendingPositionId({
    hubEntityId: newState.entityId,
    lenderEntityId,
    tokenId,
    amount,
    termId,
    interestBps,
    createdAt: now,
  });

  const existing = lending.pools.get(positionId);
  if (existing) {
    if (
      existing.lenderEntityId === lenderEntityId &&
      existing.tokenId === tokenId &&
      existing.principalAmount === amount &&
      existing.termId === termId &&
      existing.interestBps === interestBps
    ) {
      return { newState: entityState, outputs: [] };
    }
    throw new Error(`LENDING_POSITION_ID_CONFLICT: ${positionId}`);
  }

  lending.pools.set(positionId, {
    positionId,
    hubEntityId: newState.entityId,
    lenderEntityId,
    tokenId,
    principalAmount: amount,
    availableAmount: 0n,
    borrowedAmount: 0n,
    interestBps,
    termId,
    termMs: LENDING_TERM_MS[termId],
    createdAt: now,
    updatedAt: now,
    status: 'funding',
  });
  addMessage(newState, `🏦 Lending pool funding queued ${amount} token=${tokenId} term=${termId} rate=${interestBps}bps`);
  log.info('pool.offer', {
    hub: shortId(newState.entityId),
    lender: shortId(lenderEntityId),
    tokenId,
    amount,
    termId,
    interestBps,
  });
  return {
    newState,
    outputs: processingTrigger(newState),
    mempoolOps: [
      directPaymentOp(
        lenderEntityId,
        tokenId,
        amount,
        lenderEntityId,
        newState.entityId,
        buildLendingFundingMemo(positionId),
      ),
    ],
  };
};

export const handleLendingBorrowEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: EntityTxOf<'lendingBorrow'>,
): LendingResult => {
  requireHub(entityState);
  const newState = cloneEntityState(entityState);
  const lending = ensureLendingState(newState);
  const borrowerEntityId = String(entityTx.data.borrowerEntityId || '').toLowerCase();
  if (!isLendingEntityId(borrowerEntityId)) throw new Error(`LENDING_INVALID_BORROWER: ${String(entityTx.data.borrowerEntityId)}`);
  const tokenId = Math.floor(Number(entityTx.data.tokenId));
  if (!Number.isFinite(tokenId) || tokenId <= 0) throw new Error(`LENDING_INVALID_TOKEN: ${String(entityTx.data.tokenId)}`);
  const amount = BigInt(entityTx.data.amount);
  requirePositiveAmount(amount, 'LENDING_BORROW');
  const termId = normalizeLendingTerm(entityTx.data.termId);
  const maxInterestBps = normalizeInterestBps(entityTx.data.maxInterestBps ?? 10_000);
  const account = newState.accounts.get(borrowerEntityId);
  if (!account) {
    addMessage(newState, `🏦 Loan rejected: account with ${shortId(borrowerEntityId)} is not open`);
    return { newState, outputs: [] };
  }
  if (!account.deltas.has(tokenId)) {
    addMessage(newState, `🏦 Loan rejected: token ${tokenId} is not enabled on account ${shortId(borrowerEntityId)}`);
    return { newState, outputs: [] };
  }

  const now = requireLogicalNow(env, 'LENDING_BORROW');
  const loanId = entityTx.data.loanId || buildLendingLoanId({
    hubEntityId: newState.entityId,
    borrowerEntityId,
    tokenId,
    amount,
    termId,
    openedAt: now,
  });
  const existingLoan = lending.loans.get(loanId);
  if (existingLoan) {
    if (
      existingLoan.borrowerEntityId === borrowerEntityId &&
      existingLoan.tokenId === tokenId &&
      existingLoan.principalAmount === amount &&
      existingLoan.termId === termId
    ) {
      return { newState: entityState, outputs: [] };
    }
    throw new Error(`LENDING_LOAN_ID_CONFLICT: ${loanId}`);
  }

  const pool = selectBestLendingPool(lending, tokenId, amount, termId, maxInterestBps);
  if (!pool) {
    addMessage(newState, `🏦 Loan rejected: no ${termId} liquidity for token ${tokenId}`);
    return { newState, outputs: [] };
  }

  const interestAmount = computeLendingInterest(amount, pool.interestBps);
  const repaymentAmount = amount + interestAmount;
  pool.availableAmount -= amount;
  pool.borrowedAmount += amount;
  pool.updatedAt = now;

  lending.loans.set(loanId, {
    loanId,
    hubEntityId: newState.entityId,
    borrowerEntityId,
    lenderEntityId: pool.lenderEntityId,
    positionId: pool.positionId,
    tokenId,
    principalAmount: amount,
    interestAmount,
    repaymentAmount,
    repaidAmount: 0n,
    interestBps: pool.interestBps,
    termId,
    termMs: pool.termMs,
    openedAt: now,
    dueAt: now + pool.termMs,
    updatedAt: now,
    status: 'active',
  });

  const currentLimit = getCreditGrantedByAccountOwner(account, newState.entityId, tokenId);
  const nextLimit = currentLimit + amount;
  addMessage(newState, `🏦 Loan opened ${amount} token=${tokenId} due=${termId} rate=${pool.interestBps}bps`);
  return {
    newState,
    outputs: processingTrigger(newState),
    mempoolOps: [setCreditLimitOp(borrowerEntityId, tokenId, nextLimit)],
  };
};

export const handleLendingRepayEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: EntityTxOf<'lendingRepay'>,
): LendingResult => {
  requireHub(entityState);
  const newState = cloneEntityState(entityState);
  const lending = ensureLendingState(newState);
  const borrowerEntityId = String(entityTx.data.borrowerEntityId || '').toLowerCase();
  if (!isLendingEntityId(borrowerEntityId)) throw new Error(`LENDING_INVALID_BORROWER: ${String(entityTx.data.borrowerEntityId)}`);
  const loan = lending.loans.get(entityTx.data.loanId);
  if (!loan || loan.borrowerEntityId !== borrowerEntityId || (loan.status !== 'active' && loan.status !== 'repaying')) {
    addMessage(newState, `🏦 Loan repay ignored: active loan not found`);
    return { newState, outputs: [] };
  }
  if (loan.status === 'repaying') {
    addMessage(newState, `🏦 Loan repayment already pending`);
    return { newState, outputs: [] };
  }
  const remainingAmount = loan.repaymentAmount - loan.repaidAmount;
  const amount = entityTx.data.amount ?? remainingAmount;
  requirePositiveAmount(amount, 'LENDING_REPAY');
  if (amount < remainingAmount) {
    addMessage(newState, `🏦 Loan repay rejected: partial repayments are not enabled`);
    return { newState, outputs: [] };
  }
  const repayApplied = remainingAmount;
  const now = Math.max(loan.updatedAt, Math.floor(Number(env.timestamp || 0)));
  const account = newState.accounts.get(borrowerEntityId);
  if (!account) {
    addMessage(newState, `🏦 Loan repay rejected: account with ${shortId(borrowerEntityId)} is not open`);
    return { newState, outputs: [] };
  }
  if (!account.deltas.has(loan.tokenId)) {
    addMessage(newState, `🏦 Loan repay rejected: token ${loan.tokenId} is not enabled on account ${shortId(borrowerEntityId)}`);
    return { newState, outputs: [] };
  }
  const outCapacity = getAccountOutCapacity(account, borrowerEntityId, loan.tokenId);
  if (outCapacity < repayApplied) {
    addMessage(newState, `🏦 Loan repay rejected: insufficient account capacity (${outCapacity}/${repayApplied})`);
    return { newState, outputs: [] };
  }
  loan.status = 'repaying';
  loan.updatedAt = now;

  addMessage(newState, `🏦 Loan repayment queued ${repayApplied} on ${loan.loanId}`);

  return {
    newState,
    outputs: processingTrigger(newState),
    mempoolOps: [
      directPaymentOp(
        borrowerEntityId,
        loan.tokenId,
        repayApplied,
        borrowerEntityId,
        newState.entityId,
        buildLendingRepayMemo(loan.loanId),
      ),
    ],
  };
};

export const handleLendingClosePositionEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: EntityTxOf<'lendingClosePosition'>,
): LendingResult => {
  requireHub(entityState);
  const newState = cloneEntityState(entityState);
  const lending = ensureLendingState(newState);
  const lenderEntityId = String(entityTx.data.lenderEntityId || '').toLowerCase();
  if (!isLendingEntityId(lenderEntityId)) throw new Error(`LENDING_INVALID_LENDER: ${String(entityTx.data.lenderEntityId)}`);
  const position = lending.pools.get(entityTx.data.positionId);
  if (!position || position.lenderEntityId !== lenderEntityId) {
    addMessage(newState, `🏦 Lending position close ignored: position not found`);
    return { newState, outputs: [] };
  }
  if (position.status === 'funding') {
    addMessage(newState, `🏦 Lending position funding is still pending`);
    return { newState, outputs: [] };
  }
  if (position.borrowedAmount > 0n) {
    addMessage(newState, `🏦 Lending position still has active loans`);
    return { newState, outputs: [] };
  }
  position.status = 'closed';
  position.updatedAt = Math.max(position.updatedAt, Math.floor(Number(env.timestamp || 0)));
  addMessage(newState, `🏦 Lending position closed ${position.positionId}`);
  return { newState, outputs: [] };
};
