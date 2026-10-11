import type { AccountFrame, AccountReplica, AccountTx } from '../../../../types/account';
import type { EntityState } from '../../../types';
import { addMessage } from '../../../frame-events';
import { approvedLendingDraw } from '../../../lending-policy';
import type { LendingState } from '../../../../types/finance/lending';
import {
  buildLendingLoanId,
  computeLendingInterest,
  lendingLoanRepaymentAmount,
  lendingLoanClock,
  ensureLendingState,
  LENDING_TERM_MS,
} from '../../../../extensions/lending';
import type { AccountTxTarget } from './orderbook/queue';
import { assertLendingCovenant, settleLendingPayment } from '../../../../protocol/dispute/lending-covenant';
import {
  applyLendingClosePayout,
  applyLendingCloseRequest,
} from './committed-lending-close';

const normalizeEntityRef = (value: unknown): string =>
  String(value || '').toLowerCase();

export type LendingFollowupContext = {
  state: EntityState;
  account: AccountReplica;
  lending: LendingState;
  hubEntityId: string;
  counterpartyId: string;
  proposer: string;
  now: number;
  accountTimestamp: number;
  accountTxs: AccountTxTarget[];
};

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
  if (lending.savings.has(tx.data.positionId)) {
    throw new Error(`LENDING_POSITION_ALREADY_EXISTS:${tx.data.positionId}`);
  }
  const covenant = context.account.state.subcontracts?.get(tx.data.positionId);
  assertLendingCovenant(covenant);
  lending.savings.set(tx.data.positionId, {
    positionId: tx.data.positionId,
    hubEntityId,
    lenderEntityId: proposer,
    tokenId: tx.data.tokenId,
    principalAmount: tx.data.amount,
    interestBps: tx.data.interestBps,
    termId: tx.data.termId,
    termMs: LENDING_TERM_MS[tx.data.termId],
    createdAt: covenant.openedAt,
    updatedAt: now,
    status: 'open',
  });
}

function applyLendingBorrow(
  context: LendingFollowupContext,
  tx: Extract<AccountTx, { type: 'lending_borrow_request' }>,
): { status: 'opening' } | { status: 'declined'; reason: string } {
  const { lending, hubEntityId, counterpartyId, proposer, now, accountTxs } = context;
  if (
    proposer !== normalizeEntityRef(tx.data.borrowerEntityId) ||
    proposer !== counterpartyId
  ) {
    throw new Error(`LENDING_BORROW_PROPOSER_MISMATCH:${tx.data.requestId}`);
  }
  if (now >= tx.data.expiresAt) return { status: 'declined', reason: 'borrower authorization expired' };
  const authorized = approvedLendingDraw(context.state, context.account, proposer, tx.data, now);
  if (!authorized.ok) return { status: 'declined', reason: authorized.reason };
  // The bank's signed facility authorizes its own credit exposure. Depositors
  // are creditors of the bank, never counterparties or funding slots of a draw.
  // Actual disbursement still passes the canonical Account payment/risk checks.
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
  const interestAmount = computeLendingInterest(tx.data.amount, authorized.interestBps);
  lending.loans.set(loanId, {
    requestId: tx.data.requestId,
    loanId,
    hubEntityId,
    borrowerEntityId: proposer,
    tokenId: tx.data.tokenId,
    principalAmount: tx.data.amount,
    accruedAt: now, accruedInterest: 0n, interestRemainder: 0n,
    repaymentAmount: tx.data.amount + interestAmount,
    repaidAmount: 0n,
    interestBps: authorized.interestBps,
    termId: tx.data.termId,
    termMs: LENDING_TERM_MS[tx.data.termId],
    openedAt: now,
    lateMs: authorized.lateMs,
    dueAt: now + LENDING_TERM_MS[tx.data.termId],
    updatedAt: now,
    status: 'opening',
    approval: { ...authorized.approval },
  });
  accountTxs.push({ accountId: proposer, tx: { type: 'lending_disburse', data: {
    loanId, requestId: tx.data.requestId, maxInterestBps: tx.data.maxInterestBps, maxLateMs: tx.data.maxLateMs, lateMs: authorized.lateMs, expiresAt: tx.data.expiresAt,
    hubEntityId, borrowerEntityId: proposer, tokenId: tx.data.tokenId, amount: tx.data.amount,
    termId: tx.data.termId, interestBps: authorized.interestBps,
  } } });
  return { status: 'opening' };
}

function applyLendingDisburse(
  context: LendingFollowupContext,
  tx: Extract<AccountTx, { type: 'lending_disburse' }>,
): void {
  const { lending, hubEntityId, proposer, now } = context;
  if (proposer !== hubEntityId) throw new Error(`LENDING_DISBURSE_PROPOSER_MISMATCH:${tx.data.loanId}`);
  const loan = lending.loans.get(tx.data.loanId);
  if (!loan || loan.status !== 'opening') throw new Error(`LENDING_DISBURSE_LOAN_NOT_OPENING:${tx.data.loanId}`);
  if (loan.borrowerEntityId !== tx.data.borrowerEntityId || loan.tokenId !== tx.data.tokenId || loan.principalAmount !== tx.data.amount || loan.termId !== tx.data.termId || loan.interestBps !== tx.data.interestBps || loan.lateMs !== tx.data.lateMs) {
    throw new Error(`LENDING_DISBURSE_MISMATCH:${loan.loanId}`);
  }
  loan.status = 'active';
  const covenant = context.account.state.subcontracts?.get(loan.loanId);
  assertLendingCovenant(covenant);
  loan.openedAt = covenant.openedAt;
  loan.accruedAt = covenant.accruedAt;
  loan.dueAt = covenant.openedAt + covenant.termMs;
  loan.updatedAt = now;
}

function applyLendingRepay(
  context: LendingFollowupContext,
  tx: Extract<AccountTx, { type: 'lending_repay' }>,
): void {
  const { lending, counterpartyId, proposer, now } = context;
  if (
    proposer !== normalizeEntityRef(tx.data.borrowerEntityId) ||
    proposer !== counterpartyId
  ) {
    throw new Error(`LENDING_REPAY_PROPOSER_MISMATCH:${tx.data.loanId}`);
  }
  const loan = lending.loans.get(tx.data.loanId);
  if (!loan || (loan.status !== 'active' && loan.status !== 'defaulted')) {
    throw new Error(`LENDING_REPAY_LOAN_NOT_REPAYABLE:${tx.data.loanId}`);
  }
  if (
    loan.borrowerEntityId !== proposer ||
    loan.tokenId !== tx.data.tokenId
  ) {
    throw new Error(`LENDING_REPAYMENT_MISMATCH:${tx.data.loanId}`);
  }
  // The bilateral repayment already moved principal plus interest. Its commit
  // settles the book; no second payment or credit-limit rewrite is needed.
  const paid = settleLendingPayment(lendingLoanClock(loan), tx.data.amount, context.accountTimestamp);
  loan.principalAmount = paid.clock.principal;
  loan.accruedAt = paid.clock.accruedAt;
  loan.accruedInterest = paid.clock.accruedInterest;
  loan.interestRemainder = paid.clock.interestRemainder;
  loan.repaidAmount += paid.amount;
  loan.repaymentAmount = loan.repaidAmount + lendingLoanRepaymentAmount(loan, context.accountTimestamp);
  if (loan.principalAmount === 0n) loan.status = 'repaid';
  loan.updatedAt = now;
}

export function applyCommittedLendingFollowup(
  state: EntityState,
  counterpartyIdRaw: string,
  tx: AccountTx,
  frame: AccountFrame,
  proposerIsLeft: boolean,
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
    state,
    account,
    lending: ensureLendingState(state),
    hubEntityId,
    counterpartyId,
    proposer: normalizeEntityRef(proposerIsLeft ? account.state.leftEntity : account.state.rightEntity),
    now: Math.max(
      Math.floor(Number(frame.timestamp || 0)),
      Math.floor(Number(state.timestamp || 0)),
    ),
    accountTimestamp: frame.timestamp,
    accountTxs,
  };
  if (tx.type === 'lending_fund') return applyLendingFund(context, tx);
  if (tx.type === 'lending_borrow_request') {
    const result = applyLendingBorrow(context, tx);
    if (result.status === 'declined') {
      addMessage(state, `Lending request ${tx.data.requestId} declined: ${result.reason}`);
    }
    return;
  }
  if (tx.type === 'lending_disburse') return applyLendingDisburse(context, tx);
  if (tx.type === 'lending_repay') return applyLendingRepay(context, tx);
  if (tx.type === 'lending_close_request') {
    const result = applyLendingCloseRequest(context, tx);
    if (result === 'payout-capacity') {
      addMessage(state, `Lending close ${tx.data.positionId} deferred: insufficient payout capacity`);
    }
    return;
  }
  if (tx.type === 'lending_close_payout') applyLendingClosePayout(context, tx);
}
