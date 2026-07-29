/**
 * Account Transaction Applicator
 * Routes AccountTx to the handler that mutates one bilateral account clone/state.
 */

import type { AccountState, AccountTx, EntityCandidateEffect, RuntimeState } from '../../types';
import type { AccountJClaimSession } from '../j-claim-session';
import { invalidateAccountMapCommitment, type AccountCommittedMap } from '../map-commitment';
import type { ApplyAccountTxResult } from './apply-types';
import { applyAccountTxMutation } from './mutation';

const missingCommitmentInvalidation = (_tx: never): never => {
  throw new Error('ACCOUNT_TX_COMMITMENT_INVALIDATION_MISSING');
};

const swapDeltaKeys = (account: AccountState, tx: AccountTx): number[] => {
  if (tx.type === 'swap_offer') return [tx.data.giveTokenId, tx.data.wantTokenId];
  if (tx.type === 'swap_resolve') {
    const offer = account.swapOffers.get(tx.data.offerId);
    const keys = [
      offer?.giveTokenId ?? tx.data.restingGiveTokenId,
      offer?.wantTokenId ?? tx.data.restingWantTokenId,
      tx.data.feeTokenId,
    ];
    return [...new Set(keys.filter((value): value is number => Number.isSafeInteger(value)))];
  }
  return [];
};

const invalidateCommittedMapsForTx = (
  account: AccountState,
  tx: AccountTx,
  deltaKeysBeforeMutation: readonly number[],
): void => {
  const invalidate = (namespace: AccountCommittedMap, key?: unknown): void =>
    invalidateAccountMapCommitment(account, namespace, key);
  switch (tx.type) {
    case 'add_delta':
    case 'set_credit_limit':
    case 'direct_payment':
    case 'reserve_to_collateral':
    case 'request_collateral':
    case 'rebalance_refund':
    case 'j_event_claim':
    case 'settle_transition':
      invalidate('deltas');
      return;
    case 'lending_fund':
    case 'lending_borrow_request':
    case 'lending_repay':
    case 'lending_credit':
    case 'lending_close_request':
    case 'lending_close_payout':
      invalidate('deltas');
      invalidate('lendingIntents');
      return;
    case 'htlc_lock':
    case 'htlc_resolve':
      invalidate('deltas');
      invalidate('locks', tx.data.lockId);
      return;
    case 'pull_lock':
    case 'pull_resolve':
    case 'pull_cancel':
    case 'cross_pull_close':
      invalidate('deltas');
      invalidate('pulls', tx.data.pullId);
      return;
    case 'swap_offer':
      for (const tokenId of deltaKeysBeforeMutation) invalidate('deltas', tokenId);
      invalidate('swapOffers', tx.data.offerId);
      return;
    case 'swap_resolve':
      for (const tokenId of deltaKeysBeforeMutation) invalidate('deltas', tokenId);
      invalidate('swapOffers', tx.data.offerId);
      return;
    case 'cross_swap_fill_ack':
      invalidate('deltas');
      invalidate('pulls');
      invalidate('swapOffers', tx.data.offerId);
      return;
    case 'swap_cancel_request':
      // The request emits parent orchestration output and updates only
      // non-committed lifecycle history; the bilateral committed maps stay
      // byte-identical until a later swap_resolve applies the cancellation.
      return;
    case 'rebalance_policy':
    case 'reopen_disputed':
    case 'account_frame':
    case 'account_settle':
      return;
    default:
      // This is a financial cache-safety boundary, not merely a TypeScript
      // nicety. Every new AccountTx must explicitly declare which committed
      // maps it can mutate. Otherwise the incremental root can stay stale
      // until the expensive cold-root oracle catches it at commit time.
      return missingCommitmentInvalidation(tx);
  }
};

export async function applyAccountTx(
  account: AccountState,
  accountTx: AccountTx,
  byLeft: boolean,
  currentTimestamp: number = 0,
  currentHeight: number = 0,
  isValidation: boolean = false,
  env?: RuntimeState,
  jClaimSession?: AccountJClaimSession,
  counterpartyCertifiedBoardHash?: string,
): Promise<ApplyAccountTxResult> {
  const deltaKeysBeforeMutation = swapDeltaKeys(account, accountTx);
  const candidateEffects: EntityCandidateEffect[] = [];
  const result = await applyAccountTxMutation(
    account,
    accountTx,
    byLeft,
    currentTimestamp,
    currentHeight,
    isValidation,
    env,
    jClaimSession,
    counterpartyCertifiedBoardHash,
    candidateEffects,
  );
  if (result.success) {
    invalidateCommittedMapsForTx(account, accountTx, deltaKeysBeforeMutation);
  }
  return candidateEffects.length > 0 ? { ...result, candidateEffects } : result;
}
