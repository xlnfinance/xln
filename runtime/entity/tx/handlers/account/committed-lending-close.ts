import type { AccountTx } from '../../../../types';
import { getAccountOutCapacity } from '../../../../extensions/lending';
import type { LendingFollowupContext } from './committed-lending-followup';

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
  const payoutCapacity = getAccountOutCapacity(account, hubEntityId, pool.tokenId);
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
