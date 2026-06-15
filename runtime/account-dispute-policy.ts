import type { AccountTx } from './types';

/**
 * Account dispute freeze policy.
 *
 * The prepare-dispute phase is a local-only quarantine before any on-chain
 * dispute hash is committed. During that phase the account may still consume
 * evidence-only updates that make transformer calldata more complete
 * (HTLC/pull secrets, swap fill ratios), but normal business must stop.
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
  if (normalized === 'dispute_preparing') {
    return isAccountControlTx(txType) || isDisputeEvidenceAccountTx(txType);
  }
  return isAccountControlTx(txType);
};
