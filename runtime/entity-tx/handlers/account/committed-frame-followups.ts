import type { AccountFrame, AccountTx, EntityState } from '../../../types';
import { HEAVY_LOGS } from '../../../utils';
import { swapKey } from '../../../swap-execution';
import { cancelHook as cancelScheduledHook } from '../../../entity-crontab';
import { terminateHtlcRoute } from '../../htlc-route-lifecycle';
import {
  ensureLendingState,
  getCreditGrantedByAccountOwner,
  parseLendingPaymentMemo,
} from '../../../lending';
import type { MempoolOp } from './orderbook-queue';

const normalizeEntityRef = (value: unknown): string => String(value || '').toLowerCase();

const setCreditLimitOp = (
  accountId: string,
  tokenId: number,
  amount: bigint,
): MempoolOp => ({
  accountId,
  tx: {
    type: 'set_credit_limit',
    data: { tokenId, amount },
  },
});

function applyCommittedLendingPaymentFollowup(
  newState: EntityState,
  counterpartyId: string,
  accountTx: AccountTx,
  committedFrame: AccountFrame,
  mempoolOps: MempoolOp[],
): void {
  if (accountTx.type !== 'direct_payment') return;
  const memo = parseLendingPaymentMemo(accountTx.data.description);
  if (!memo) return;

  const fromEntityId = normalizeEntityRef(accountTx.data.fromEntityId);
  const toEntityId = normalizeEntityRef(accountTx.data.toEntityId);
  const hubEntityId = normalizeEntityRef(newState.entityId);
  const isHubRecipient = toEntityId === hubEntityId;
  const hasLendingState = Boolean(newState.lending);

  if (!isHubRecipient && !hasLendingState) return;
  const lending = ensureLendingState(newState);
  const now = Math.max(
    Math.floor(Number(committedFrame.timestamp || 0)),
    Math.floor(Number(newState.timestamp || 0)),
  );

  if (memo.kind === 'fund') {
    const position = lending.pools.get(memo.id);
    if (!position) {
      if (isHubRecipient && newState.profile?.isHub === true) {
        throw new Error(`LENDING_FUNDING_POSITION_MISSING: ${memo.id}`);
      }
      return;
    }
    if (position.status === 'open') return;
    if (position.status !== 'funding') {
      throw new Error(`LENDING_FUNDING_STATUS_INVALID: ${memo.id}:${position.status}`);
    }
    if (
      normalizeEntityRef(position.lenderEntityId) !== fromEntityId ||
      normalizeEntityRef(position.hubEntityId) !== toEntityId ||
      position.tokenId !== accountTx.data.tokenId ||
      position.principalAmount !== accountTx.data.amount ||
      normalizeEntityRef(counterpartyId) !== fromEntityId
    ) {
      throw new Error(`LENDING_FUNDING_PAYMENT_MISMATCH: ${memo.id}`);
    }
    position.availableAmount = position.principalAmount;
    position.borrowedAmount = 0n;
    position.status = 'open';
    position.updatedAt = now;
    return;
  }

  const loan = lending.loans.get(memo.id);
  if (!loan) {
    if (isHubRecipient && newState.profile?.isHub === true) {
      throw new Error(`LENDING_REPAY_LOAN_MISSING: ${memo.id}`);
    }
    return;
  }
  if (loan.status === 'repaid') return;
  if (loan.status !== 'repaying') {
    throw new Error(`LENDING_REPAY_STATUS_INVALID: ${memo.id}:${loan.status}`);
  }
  const remaining = loan.repaymentAmount - loan.repaidAmount;
  if (
    normalizeEntityRef(loan.borrowerEntityId) !== fromEntityId ||
    normalizeEntityRef(loan.hubEntityId) !== toEntityId ||
    loan.tokenId !== accountTx.data.tokenId ||
    accountTx.data.amount !== remaining ||
    normalizeEntityRef(counterpartyId) !== fromEntityId
  ) {
    throw new Error(`LENDING_REPAY_PAYMENT_MISMATCH: ${memo.id}`);
  }
  const pool = lending.pools.get(loan.positionId);
  if (!pool) throw new Error(`LENDING_POOL_MISSING_FOR_LOAN: ${loan.loanId}`);
  if (pool.borrowedAmount < loan.principalAmount) {
    throw new Error(`LENDING_POOL_BORROWED_UNDERFLOW: ${loan.positionId}`);
  }

  loan.repaidAmount = loan.repaymentAmount;
  loan.status = 'repaid';
  loan.updatedAt = now;
  pool.borrowedAmount -= loan.principalAmount;
  pool.availableAmount += loan.repaymentAmount;
  pool.updatedAt = now;

  const account = newState.accounts.get(loan.borrowerEntityId);
  if (account?.deltas.has(loan.tokenId)) {
    const currentLimit = getCreditGrantedByAccountOwner(account, newState.entityId, loan.tokenId);
    const nextLimit = currentLimit > loan.principalAmount ? currentLimit - loan.principalAmount : 0n;
    mempoolOps.push(setCreditLimitOp(loan.borrowerEntityId, loan.tokenId, nextLimit));
  }
}

export function applyCommittedAccountFrameFollowups(
  newState: EntityState,
  counterpartyId: string,
  committedFrame: AccountFrame,
  mempoolOps: MempoolOp[] = [],
): void {
  if (HEAVY_LOGS) {
    console.log(
      `FRAME-COMMIT-FOLLOWUPS: height=${committedFrame.height}, txs=${committedFrame.accountTxs.length}`,
    );
  }

  for (const accountTx of committedFrame.accountTxs) {
    if (HEAVY_LOGS) console.log(`FRAME-COMMIT-FOLLOWUPS: tx type=${accountTx.type}`);
    applyCommittedLendingPaymentFollowup(newState, counterpartyId, accountTx, committedFrame, mempoolOps);

    // Account frames are canonical once committed; keep entity-local indexes in
    // sync here instead of mutating them while the account proposal is still tentative.
    if (accountTx.type === 'htlc_resolve') {
      newState.lockBook.delete(accountTx.data.lockId);
      if (newState.crontabState) {
        cancelScheduledHook(newState.crontabState, `htlc-timeout:${accountTx.data.lockId}`);
      }
      if (accountTx.data.outcome === 'secret') {
        for (const [hashlock, route] of newState.htlcRoutes.entries()) {
          if (route.inboundLockId !== accountTx.data.lockId) continue;
          terminateHtlcRoute(newState, hashlock, newState.timestamp);
        }
      }
    }

    if (accountTx.type === 'j_event_claim') continue;

    if (accountTx.type === 'swap_resolve') {
      const key = swapKey(counterpartyId, accountTx.data.offerId);
      newState.pendingSwapFillRatios?.delete(key);
    }
  }
}
