import type { AccountFrame, AccountState, AccountTx } from '../../../../types/account';
import type { EntityState } from '../../../types';
import type { LendingState } from '../../../../types/lending';
import {
  buildLendingLoanId,
  computeLendingInterest,
  ensureLendingState,
  getCreditGrantedByAccountOwner,
  LENDING_TERM_MS,
  selectBestLendingPool,
} from '../../../../extensions/lending';
import type { AccountTxTarget } from './orderbook-queue';
import {
  applyLendingClosePayout,
  applyLendingCloseRequest,
} from './committed-lending-close';

const normalizeEntityRef = (value: unknown): string =>
  String(value || '').toLowerCase();

export type LendingFollowupContext = {
  account: AccountState;
  lending: LendingState;
  hubEntityId: string;
  counterpartyId: string;
  proposer: string;
  now: number;
  accountTxs: AccountTxTarget[];
};

const lendingCreditOp = (
  accountId: string,
  data: Extract<AccountTx, { type: 'lending_credit' }>['data'],
): AccountTxTarget => ({
  accountId,
  tx: { type: 'lending_credit', data },
});

function applyLendingFund(
  context: LendingFollowupContext,
  tx: Extract<AccountTx, { type: 'lending_fund' }>,
): void {
  const { lending, hubEntityId, counterpartyId, proposer, now } = context;
  if (
    proposer !== normalizeEntityRef(tx.data.lenderEntityId) ||
    proposer !== counterpartyId
  ) {
    throw new Error(`LENDING_FUND_PROPOSER_MISMATCH:${tx.data.positionId}`);
  }
  if (lending.pools.has(tx.data.positionId)) {
    throw new Error(`LENDING_POSITION_ALREADY_EXISTS:${tx.data.positionId}`);
  }
  lending.pools.set(tx.data.positionId, {
    positionId: tx.data.positionId,
    hubEntityId,
    lenderEntityId: proposer,
    tokenId: tx.data.tokenId,
    principalAmount: tx.data.amount,
    availableAmount: tx.data.amount,
    borrowedAmount: 0n,
    interestBps: tx.data.interestBps,
    termId: tx.data.termId,
    termMs: LENDING_TERM_MS[tx.data.termId],
    createdAt: now,
    updatedAt: now,
    status: 'open',
  });
}

function applyLendingBorrow(
  context: LendingFollowupContext,
  tx: Extract<AccountTx, { type: 'lending_borrow_request' }>,
): void {
  const { account, lending, hubEntityId, counterpartyId, proposer, now, accountTxs } = context;
  if (
    proposer !== normalizeEntityRef(tx.data.borrowerEntityId) ||
    proposer !== counterpartyId
  ) {
    throw new Error(`LENDING_BORROW_PROPOSER_MISMATCH:${tx.data.requestId}`);
  }
  const pool = selectBestLendingPool(
    lending,
    tx.data.tokenId,
    tx.data.amount,
    tx.data.termId,
    tx.data.maxInterestBps,
  );
  if (!pool) throw new Error(`LENDING_LIQUIDITY_UNAVAILABLE:${tx.data.requestId}`);
  const loanId = buildLendingLoanId({
    hubEntityId,
    borrowerEntityId: proposer,
    tokenId: tx.data.tokenId,
    amount: tx.data.amount,
    termId: tx.data.termId,
    openedAt: now,
    requestId: tx.data.requestId,
  });
  if (lending.loans.has(loanId)) {
    throw new Error(`LENDING_LOAN_ALREADY_EXISTS:${loanId}`);
  }
  const interestAmount = computeLendingInterest(tx.data.amount, pool.interestBps);
  pool.availableAmount -= tx.data.amount;
  pool.borrowedAmount += tx.data.amount;
  pool.updatedAt = now;
  lending.loans.set(loanId, {
    requestId: tx.data.requestId,
    loanId,
    hubEntityId,
    borrowerEntityId: proposer,
    lenderEntityId: pool.lenderEntityId,
    positionId: pool.positionId,
    tokenId: tx.data.tokenId,
    principalAmount: tx.data.amount,
    interestAmount,
    repaymentAmount: tx.data.amount + interestAmount,
    repaidAmount: 0n,
    interestBps: pool.interestBps,
    termId: pool.termId,
    termMs: pool.termMs,
    openedAt: now,
    dueAt: now + pool.termMs,
    updatedAt: now,
    status: 'opening',
  });
  const currentLimit = getCreditGrantedByAccountOwner(
    account,
    hubEntityId,
    tx.data.tokenId,
  );
  accountTxs.push(lendingCreditOp(proposer, {
    action: 'grant',
    loanId,
    hubEntityId,
    borrowerEntityId: proposer,
    tokenId: tx.data.tokenId,
    creditLimit: currentLimit + tx.data.amount,
  }));
}

function applyLendingCredit(
  context: LendingFollowupContext,
  tx: Extract<AccountTx, { type: 'lending_credit' }>,
): void {
  const { lending, hubEntityId, proposer, now } = context;
  if (proposer !== hubEntityId) {
    throw new Error(`LENDING_CREDIT_PROPOSER_MISMATCH:${tx.data.loanId}`);
  }
  const loan = lending.loans.get(tx.data.loanId);
  if (!loan) throw new Error(`LENDING_CREDIT_LOAN_MISSING:${tx.data.loanId}`);
  if (tx.data.action === 'grant') {
    if (loan.status !== 'opening') {
      throw new Error(`LENDING_GRANT_STATUS_INVALID:${loan.loanId}:${loan.status}`);
    }
    loan.status = 'active';
    loan.updatedAt = now;
    return;
  }
  if (loan.status !== 'closing') {
    throw new Error(`LENDING_REVOKE_STATUS_INVALID:${loan.loanId}:${loan.status}`);
  }
  const pool = lending.pools.get(loan.positionId);
  if (!pool) throw new Error(`LENDING_POOL_MISSING_FOR_LOAN:${loan.loanId}`);
  if (pool.borrowedAmount < loan.principalAmount) {
    throw new Error(`LENDING_POOL_BORROWED_UNDERFLOW:${pool.positionId}`);
  }
  loan.repaidAmount = loan.repaymentAmount;
  loan.status = 'repaid';
  loan.updatedAt = now;
  pool.borrowedAmount -= loan.principalAmount;
  pool.availableAmount += loan.repaymentAmount;
  pool.updatedAt = now;
}

function applyLendingRepay(
  context: LendingFollowupContext,
  tx: Extract<AccountTx, { type: 'lending_repay' }>,
): void {
  const { account, lending, hubEntityId, counterpartyId, proposer, now, accountTxs } = context;
  if (
    proposer !== normalizeEntityRef(tx.data.borrowerEntityId) ||
    proposer !== counterpartyId
  ) {
    throw new Error(`LENDING_REPAY_PROPOSER_MISMATCH:${tx.data.loanId}`);
  }
  const loan = lending.loans.get(tx.data.loanId);
  if (!loan || loan.status !== 'active') {
    throw new Error(`LENDING_REPAY_LOAN_NOT_ACTIVE:${tx.data.loanId}`);
  }
  const remaining = loan.repaymentAmount - loan.repaidAmount;
  if (
    loan.borrowerEntityId !== proposer ||
    loan.tokenId !== tx.data.tokenId ||
    tx.data.amount !== remaining
  ) {
    throw new Error(`LENDING_REPAYMENT_MISMATCH:${tx.data.loanId}`);
  }
  loan.status = 'closing';
  loan.updatedAt = now;
  const currentLimit = getCreditGrantedByAccountOwner(account, hubEntityId, loan.tokenId);
  accountTxs.push(lendingCreditOp(proposer, {
    action: 'revoke',
    loanId: loan.loanId,
    hubEntityId,
    borrowerEntityId: proposer,
    tokenId: loan.tokenId,
    creditLimit:
      currentLimit > loan.principalAmount
        ? currentLimit - loan.principalAmount
        : 0n,
  }));
}

export function applyCommittedLendingFollowup(
  state: EntityState,
  counterpartyIdRaw: string,
  tx: AccountTx,
  frame: AccountFrame,
  accountTxs: AccountTxTarget[],
): void {
  const hubEntityId = normalizeEntityRef(state.entityId);
  if (state.profile?.isHub !== true) return;
  if (!('hubEntityId' in tx.data) || normalizeEntityRef(tx.data.hubEntityId) !== hubEntityId) {
    return;
  }
  const counterpartyId = normalizeEntityRef(counterpartyIdRaw);
  const account = state.accounts.get(counterpartyId);
  if (!account) throw new Error(`LENDING_ACCOUNT_MISSING:${counterpartyIdRaw}`);
  const context: LendingFollowupContext = {
    account,
    lending: ensureLendingState(state),
    hubEntityId,
    counterpartyId,
    proposer: normalizeEntityRef(frame.byLeft ? account.leftEntity : account.rightEntity),
    now: Math.max(
      Math.floor(Number(frame.timestamp || 0)),
      Math.floor(Number(state.timestamp || 0)),
    ),
    accountTxs,
  };
  if (tx.type === 'lending_fund') return applyLendingFund(context, tx);
  if (tx.type === 'lending_borrow_request') return applyLendingBorrow(context, tx);
  if (tx.type === 'lending_credit') return applyLendingCredit(context, tx);
  if (tx.type === 'lending_repay') return applyLendingRepay(context, tx);
  if (tx.type === 'lending_close_request') return applyLendingCloseRequest(context, tx);
  if (tx.type === 'lending_close_payout') applyLendingClosePayout(context, tx);
}
