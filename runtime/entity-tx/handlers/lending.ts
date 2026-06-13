import type { AccountTx, EntityInput, EntityState, EntityTx, Env } from '../../types';
import { createStructuredLogger, shortId } from '../../logger';
import { addMessage, cloneEntityState } from '../../state-helpers';
import type { MempoolOp } from './account';
import {
  buildLendingLoanId,
  buildLendingPositionId,
  computeLendingInterest,
  ensureLendingState,
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
  const termId = normalizeLendingTerm(entityTx.data.termId);
  const interestBps = normalizeInterestBps(entityTx.data.interestBps);
  const now = Math.max(0, Math.floor(Number(env.timestamp || Date.now())));
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
    availableAmount: amount,
    borrowedAmount: 0n,
    interestBps,
    termId,
    termMs: LENDING_TERM_MS[termId],
    createdAt: now,
    updatedAt: now,
    status: 'open',
  });
  addMessage(newState, `🏦 Lending pool funded ${amount} token=${tokenId} term=${termId} rate=${interestBps}bps`);
  log.info('pool.offer', {
    hub: shortId(newState.entityId),
    lender: shortId(lenderEntityId),
    tokenId,
    amount,
    termId,
    interestBps,
  });
  return { newState, outputs: [] };
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

  const now = Math.max(0, Math.floor(Number(env.timestamp || Date.now())));
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
  if (!loan || loan.borrowerEntityId !== borrowerEntityId || loan.status !== 'active') {
    addMessage(newState, `🏦 Loan repay ignored: active loan not found`);
    return { newState, outputs: [] };
  }
  const amount = entityTx.data.amount ?? (loan.repaymentAmount - loan.repaidAmount);
  requirePositiveAmount(amount, 'LENDING_REPAY');
  const repayApplied = amount > loan.repaymentAmount - loan.repaidAmount
    ? loan.repaymentAmount - loan.repaidAmount
    : amount;
  const now = Math.max(loan.updatedAt, Math.floor(Number(env.timestamp || 0)));
  loan.repaidAmount += repayApplied;
  loan.updatedAt = now;

  const mempoolOps: MempoolOp[] = [];
  if (loan.repaidAmount >= loan.repaymentAmount) {
    loan.status = 'repaid';
    const pool = lending.pools.get(loan.positionId);
    if (!pool) throw new Error(`LENDING_POOL_MISSING_FOR_LOAN: ${loan.loanId}`);
    if (pool.borrowedAmount < loan.principalAmount) {
      throw new Error(`LENDING_POOL_BORROWED_UNDERFLOW: ${loan.positionId}`);
    }
    pool.borrowedAmount -= loan.principalAmount;
    pool.availableAmount += loan.repaymentAmount;
    pool.updatedAt = now;

    const account = newState.accounts.get(borrowerEntityId);
    if (account?.deltas.has(loan.tokenId)) {
      const currentLimit = getCreditGrantedByAccountOwner(account, newState.entityId, loan.tokenId);
      const nextLimit = currentLimit > loan.principalAmount ? currentLimit - loan.principalAmount : 0n;
      mempoolOps.push(setCreditLimitOp(borrowerEntityId, loan.tokenId, nextLimit));
    }
    addMessage(newState, `🏦 Loan repaid ${loan.loanId}`);
  } else {
    addMessage(newState, `🏦 Loan repayment recorded ${repayApplied} on ${loan.loanId}`);
  }

  return {
    newState,
    outputs: mempoolOps.length > 0 ? processingTrigger(newState) : [],
    ...(mempoolOps.length > 0 ? { mempoolOps } : {}),
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
  if (position.borrowedAmount > 0n) {
    addMessage(newState, `🏦 Lending position still has active loans`);
    return { newState, outputs: [] };
  }
  position.status = 'closed';
  position.updatedAt = Math.max(position.updatedAt, Math.floor(Number(env.timestamp || 0)));
  addMessage(newState, `🏦 Lending position closed ${position.positionId}`);
  return { newState, outputs: [] };
};
