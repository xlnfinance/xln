import type { AccountState } from '../types';
import { freezeAccountForDispute } from './consensus/dispute-policy';
import { invalidateAccountMapCommitment } from './map-commitment';
import { clearFinalizedSettlementWorkspace } from './tx/handlers/settle-transition';

export type AccountDisputeFinalityResult = {
  hadActiveDispute: boolean;
  hadSettlementWorkspace: boolean;
  removedSettlementTxs: number;
};

const clearFinalizedDeltas = (
  account: AccountState,
  finalizedTokenIds: readonly number[],
): void => {
  for (const tokenId of finalizedTokenIds) {
    const delta = account.deltas.get(tokenId);
    if (!delta) continue;
    const changed =
      delta.collateral !== 0n ||
      delta.ondelta !== 0n ||
      delta.offdelta !== 0n ||
      delta.leftHold !== 0n ||
      delta.rightHold !== 0n ||
      delta.leftAllowance !== 0n ||
      delta.rightAllowance !== 0n;
    delta.collateral = 0n;
    delta.ondelta = 0n;
    delta.offdelta = 0n;
    delta.leftHold = 0n;
    delta.rightHold = 0n;
    delta.leftAllowance = 0n;
    delta.rightAllowance = 0n;
    if (changed) invalidateAccountMapCommitment(account, 'deltas', tokenId);
  }
};

const clearFinalizedCollections = (account: AccountState): void => {
  if (account.swapOffers.size > 0) {
    account.swapOffers.clear();
    invalidateAccountMapCommitment(account, 'swapOffers');
  }
  if (account.locks.size > 0) {
    account.locks.clear();
    invalidateAccountMapCommitment(account, 'locks');
  }
  delete account.disputeProofBodiesByHash;
  delete account.disputeProofNoncesByHash;
  delete account.disputeArgumentSnapshotsByHash;
};

/**
 * Apply the Account-owned state transition authorized by a finalized
 * Depository dispute event.
 *
 * This is deliberately not an Account proposal or bilateral acknowledgement.
 * Depository finality is unilateral external consensus: both replicas consume
 * the same certified J event and deterministically converge. Requiring the
 * counterparty to acknowledge the already-final result could let that party
 * veto or indefinitely delay on-chain settlement.
 */
export const applyAccountDisputeFinality = (
  account: AccountState,
  finalizedJNonce: number,
  finalizedTokenIds: readonly number[],
): AccountDisputeFinalityResult => {
  const hadActiveDispute = Boolean(account.activeDispute);
  const hadSettlementWorkspace = Boolean(account.settlementWorkspace);
  if (hadSettlementWorkspace) clearFinalizedSettlementWorkspace(account);
  const beforeMempool = account.mempool.length;
  account.mempool = account.mempool.filter(tx => tx.type !== 'settle_transition');

  account.jNonce = finalizedJNonce;
  delete account.activeDispute;
  if (account.proofHeader.nextProofNonce <= finalizedJNonce) {
    account.proofHeader.nextProofNonce = finalizedJNonce + 1;
  }
  account.status = 'disputed';
  freezeAccountForDispute(account, false);
  delete account.counterpartyDisputeProofHanko;
  delete account.counterpartyDisputeProofNonce;
  delete account.counterpartyDisputeProofBodyHash;
  clearFinalizedDeltas(account, finalizedTokenIds);
  clearFinalizedCollections(account);

  return {
    hadActiveDispute,
    hadSettlementWorkspace,
    removedSettlementTxs: beforeMempool - account.mempool.length,
  };
};
