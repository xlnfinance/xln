import type { AccountMachine, AccountTx } from '../../types';
import { prependUniqueMempoolTxs } from './helpers';
import { createStructuredLogger } from '../../infra/logger';

const disputePolicyLog = createStructuredLogger('account.dispute-policy');

/**
 * Account dispute freeze policy.
 *
 * The prepare-dispute phase is a local-only quarantine before any on-chain
 * dispute hash is committed. Account consensus is already frozen: optional
 * evidence remains in the Account mempool and never creates another Account
 * frame on top of the last mutually signed ProofBody.
 *
 * Once disputeStart is queued or observed on-chain, calldata hashes are already
 * committed. From that point even evidence updates must stop changing account
 * state; only jurisdiction-event bookkeeping and explicit reopen are allowed.
 */

export const isAccountControlTx = (txType: string): boolean =>
  txType === 'j_event_claim' || txType === 'reopen_disputed';

const isEvidenceBearingAccountTx = (tx: AccountTx): boolean => {
  if (tx.type === 'pull_resolve') return typeof tx.data.binary === 'string';
  if (tx.type === 'cross_pull_close') return typeof tx.data.binary === 'string' && Boolean(tx.data.proof);
  return false;
};

export const isDisputeEvidenceAccountTx = (txOrType: AccountTx | string): boolean => {
  if (typeof txOrType === 'string') {
    return txOrType === 'pull_resolve' || txOrType === 'cross_pull_close' || txOrType === 'swap_resolve';
  }
  return txOrType.type === 'swap_resolve' || isEvidenceBearingAccountTx(txOrType);
};

export const isAccountBusinessTx = (txType: string): boolean =>
  !isAccountControlTx(txType);

export const isArgumentChangingAccountTx = (txType: string): boolean =>
  isAccountBusinessTx(txType);

export const freezeAccountForDispute = (
  account: AccountMachine,
  retainOptionalEvidence: boolean,
): void => {
  const pendingEvidence = retainOptionalEvidence
    ? (account.pendingFrame?.accountTxs ?? []).filter(isDisputeEvidenceAccountTx)
    : [];
  account.mempool = (account.mempool || []).filter((tx) => (
    isAccountControlTx(tx.type) || (retainOptionalEvidence && isDisputeEvidenceAccountTx(tx))
  ));
  // A locally proposed frame is not mutually signed state, but a unilateral
  // resolve inside it is still valid transformer evidence. Move that evidence
  // back before deleting the candidate; later resolves are already behind it
  // in mempool and remain available while the peer is offline.
  prependUniqueMempoolTxs(account, pendingEvidence);
  disputePolicyLog.info('freeze', {
    leftEntity: account.leftEntity,
    rightEntity: account.rightEntity,
    status: account.status,
    retainOptionalEvidence,
    restoredPendingEvidence: pendingEvidence.map(tx => tx.type),
    retainedMempool: account.mempool.map(tx => tx.type),
  });
  // The candidate is not mutually committed state. Dispute always starts from
  // the last signed ProofBody; late proposal/ACK traffic is rejected at ingress.
  delete account.pendingFrame;
  delete account.pendingAccountInput;
  delete account.pendingAccountInputSignerId;
  delete account.clonedForValidation;
  account.rollbackCount = 0;
  delete account.lastRollbackFrameHash;
};

export const isDisputeStartedByLeft = (
  starterEntityId: string,
  leftEntityId: string,
  rightEntityId: string,
): boolean => {
  const starter = String(starterEntityId || '').toLowerCase();
  const left = String(leftEntityId || '').toLowerCase();
  const right = String(rightEntityId || '').toLowerCase();
  if (!starter || !left || !right) return false;
  if (starter === left) return true;
  if (starter === right) return false;
  return starter < right;
};

export const canProcessAccountTxForDisputeStatus = (
  status: string | undefined,
  txType: string,
): boolean => {
  const normalized = status ?? 'active';
  if (normalized === 'active') return true;
  return isAccountControlTx(txType);
};
