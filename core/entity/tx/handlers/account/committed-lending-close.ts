import type { AccountTx } from '../../../../types/account';
import type { EntityState } from '../../../types';
import { getAccountOutCapacity } from '../../../../extensions/lending';
import type { LendingFollowupContext } from './committed-lending-followup';
import type { AccountTxTarget } from './orderbook/queue';
import { createStructuredLogger, shortId } from '../../../../support/logger';

const lendingLog = createStructuredLogger('entity.lending');

const normalizeEntityRef = (value: unknown): string =>
  String(value || '').toLowerCase();

export function applyLendingCloseRequest(
  context: LendingFollowupContext,
  tx: Extract<AccountTx, { type: 'lending_close_request' }>,
): void {
  const {
    account,
    lending,
    hubEntityId,
    counterpartyId,
    proposer,
    now,
    accountTxs,
  } = context;
  if (
    proposer !== normalizeEntityRef(tx.data.lenderEntityId) ||
    proposer !== counterpartyId
  ) {
    throw new Error(`LENDING_CLOSE_PROPOSER_MISMATCH:${tx.data.positionId}`);
  }
  const pool = lending.pools.get(tx.data.positionId);
  if (!pool || pool.status !== 'open' || pool.lenderEntityId !== proposer) {
    throw new Error(`LENDING_CLOSE_POSITION_NOT_OPEN:${tx.data.positionId}`);
  }
  if (pool.borrowedAmount !== 0n) {
    throw new Error(`LENDING_CLOSE_ACTIVE_LOANS:${pool.positionId}`);
  }
  if (pool.availableAmount === 0n) {
    pool.status = 'closed';
    pool.updatedAt = now;
    return;
  }
  const payoutCapacity = getAccountOutCapacity(account.state, hubEntityId, pool.tokenId);
  if (payoutCapacity < pool.availableAmount) {
    throw new Error(
      `LENDING_CLOSE_PAYOUT_CAPACITY: available=${payoutCapacity} ` +
      `required=${pool.availableAmount}`,
    );
  }
  pool.status = 'closing';
  pool.updatedAt = now;
  accountTxs.push({
    accountId: proposer,
    tx: {
      type: 'lending_close_payout',
      data: {
        positionId: pool.positionId,
        hubEntityId,
        lenderEntityId: proposer,
        tokenId: pool.tokenId,
        amount: pool.availableAmount,
      },
    },
  });
}

export function applyLendingClosePayout(
  context: LendingFollowupContext,
  tx: Extract<AccountTx, { type: 'lending_close_payout' }>,
): void {
  const { lending, hubEntityId, proposer, now } = context;
  if (proposer !== hubEntityId) {
    throw new Error(`LENDING_PAYOUT_PROPOSER_MISMATCH:${tx.data.positionId}`);
  }
  const pool = lending.pools.get(tx.data.positionId);
  if (!pool || pool.status !== 'closing') {
    throw new Error(`LENDING_PAYOUT_POSITION_NOT_CLOSING:${tx.data.positionId}`);
  }
  if (
    pool.lenderEntityId !== normalizeEntityRef(tx.data.lenderEntityId) ||
    pool.tokenId !== tx.data.tokenId ||
    pool.availableAmount !== tx.data.amount
  ) {
    throw new Error(`LENDING_PAYOUT_MISMATCH:${tx.data.positionId}`);
  }
  pool.availableAmount = 0n;
  pool.status = 'closed';
  pool.updatedAt = now;
}

/** The hub retains its obligation to the depositor after borrower default.
 * Releasing the claim does not create cash: withdrawal still requires actual
 * bilateral payout capacity. The unpaid loan remains a hub receivable.
 */
export const settleOverdueLendingLoan = (
  state: EntityState,
  loanId: string,
  _accountTxs: AccountTxTarget[],
): void => {
  const lending = state.lending;
  const loan = lending?.loans.get(loanId);
  if (!lending || !loan || loan.status !== 'active' || loan.dueAt > state.timestamp) return;
  const pool = lending.pools.get(loan.positionId);
  const account = state.accounts.get(loan.borrowerEntityId);
  if (!pool || !account || pool.borrowedAmount < loan.principalAmount) {
    lendingLog.warn('lending_overdue.unsettled', {
      loanId,
      borrower: shortId(loan.borrowerEntityId),
      reason: !pool ? 'pool-missing' : !account ? 'account-missing' : 'pool-borrowed-underflow',
    });
    return;
  }
  const now = state.timestamp;
  loan.status = 'defaulted';
  loan.updatedAt = now;
  pool.borrowedAmount -= loan.principalAmount;
  pool.availableAmount += loan.principalAmount;
  pool.updatedAt = now;
  lendingLog.warn('lending_overdue.defaulted', {
    loanId,
    borrower: shortId(loan.borrowerEntityId),
    outstanding: (loan.repaymentAmount - loan.repaidAmount).toString(),
    releasedPrincipal: loan.principalAmount.toString(),
  });
};
