import type { AccountReplica, AccountTx } from '../types/account';
import type { EntityState } from '../entity/types';
import type { LendingLoan } from '../types/finance/lending';
import { lendingLoanRepaymentAmount, lendingPositionCloseAmount } from './state';
import type { LendingFollowupContext } from './committed';
import type { AccountTxTarget } from '../entity/tx/handlers/account/orderbook/queue';
import { createStructuredLogger, shortId } from '../support/logger';
import { normalizeEntityRef } from '../support/boundary-guards';

const lendingLog = createStructuredLogger('entity.lending');

const retireDisputedLoan = (state: EntityState, loan: LendingLoan): void => {
  if (loan.status === 'repaid' || loan.status === 'disputed') return;
  loan.status = 'disputed';
  loan.updatedAt = state.timestamp;
};

/** Authenticated J finality replaces this Account epoch with reserves/on-chain
 * debt. Its saver principal can no longer fund another loan or a second payout.
 * Borrower receivables stay with the bank; finality creates no synthetic cash.
 */
export const retireDisputedLendingClaims = (state: EntityState, account: AccountReplica): void => {
  const borrower = state.entityId === account.state.leftEntity ? account.state.rightEntity : account.state.leftEntity;
  // Only authenticated J finality makes every old-epoch pending draw unusable.
  // A timeout cannot release this reservation: the peer may still possess our
  // signed disbursement. Finality settles that evidence through reserves/debt,
  // so release the allocation even when no covenant committed locally.
  for (const loan of state.lending?.loans.values() ?? []) {
    if (loan.status === 'opening' && loan.borrowerEntityId === borrower) retireDisputedLoan(state, loan);
  }
  for (const [id, claim] of account.state.subcontracts ?? []) {
    if (!('kind' in claim)) continue;
    if (claim.kind === 'loan') {
      const loan = state.lending?.loans.get(id);
      if (loan) retireDisputedLoan(state, loan);
      continue;
    }
    const pool = state.lending?.savings.get(id);
    if (!pool || (pool.status !== 'open' && pool.status !== 'queued')) continue;
    pool.status = 'disputed';
    pool.updatedAt = state.timestamp;
  }
};

export function applyLendingCloseRequest(
  context: LendingFollowupContext,
  tx: Extract<AccountTx, { type: 'lending_close_request' }>,
): void {
  const { lending, counterpartyId, proposer, accountTimestamp } = context;
  if (proposer !== normalizeEntityRef(tx.data.lenderEntityId) || proposer !== counterpartyId) {
    throw new Error(`LENDING_CLOSE_PROPOSER_MISMATCH:${tx.data.positionId}`);
  }
  const pool = lending.savings.get(tx.data.positionId);
  if (!pool || pool.lenderEntityId !== proposer) {
    throw new Error(`LENDING_CLOSE_POSITION_NOT_OPEN:${tx.data.positionId}`);
  }
  if (pool.status === 'queued') return;
  if (pool.status !== 'open') throw new Error(`LENDING_CLOSE_POSITION_NOT_OPEN:${tx.data.positionId}`);
  let lastOrder = 0;
  for (const position of lending.savings.values()) lastOrder = Math.max(lastOrder, position.closeOrder ?? 0);
  const order = lastOrder + 1;
  if (!Number.isSafeInteger(order)) throw new Error('LENDING_WITHDRAWAL_ORDER_OVERFLOW');
  // The saver signed the Account clock, not its later Entity observation time.
  // A delayed ACK across maturity must not turn early cancellation into a full
  // coupon. Record once; retries cannot reprice the claim or change priority.
  pool.status = 'queued';
  pool.closeOrder = order;
  pool.updatedAt = accountTimestamp;
}

export function applyLendingClosePayout(
  context: LendingFollowupContext,
  tx: Extract<AccountTx, { type: 'lending_close_payout' }>,
): void {
  const { lending, hubEntityId, proposer, now } = context;
  if (proposer !== hubEntityId) {
    throw new Error(`LENDING_PAYOUT_PROPOSER_MISMATCH:${tx.data.positionId}`);
  }
  const pool = lending.savings.get(tx.data.positionId);
  if (!pool || pool.status !== 'queued') {
    throw new Error(`LENDING_PAYOUT_POSITION_NOT_QUEUED:${tx.data.positionId}`);
  }
  if (
    pool.lenderEntityId !== normalizeEntityRef(tx.data.lenderEntityId) ||
    pool.tokenId !== tx.data.tokenId ||
    (pool.termId !== 'demand' && lendingPositionCloseAmount(pool, now) !== tx.data.amount)
  ) {
    throw new Error(`LENDING_PAYOUT_MISMATCH:${tx.data.positionId}`);
  }
  pool.status = 'closed';
  pool.updatedAt = now;
}

/** Default marks an unpaid receivable; it cannot create cash or alter savings. */
export const settleOverdueLendingLoan = (state: EntityState, loanId: string, _accountTxs: AccountTxTarget[]): void => {
  const lending = state.lending;
  const loan = lending?.loans.get(loanId);
  if (!lending || !loan || loan.status !== 'active' || loan.dueAt > state.timestamp) return;
  const account = state.accounts.get(loan.borrowerEntityId);
  if (!account) throw new Error(`LENDING_OVERDUE_ACCOUNT_MISSING:${loanId}`);
  const now = state.timestamp;
  loan.status = 'defaulted';
  loan.updatedAt = now;
  lendingLog.warn('lending_overdue.defaulted', {
    loanId,
    borrower: shortId(loan.borrowerEntityId),
    outstanding: lendingLoanRepaymentAmount(loan, now).toString(),
  });
};
