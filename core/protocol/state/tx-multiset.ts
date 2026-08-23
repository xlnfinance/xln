import { safeStringify } from '../serialization';
import { RecencyMemo } from '../../support/recency-memo';

export type FingerprintableTx = {
  type: string;
  data?: unknown;
};

// The same mempool tx object is fingerprinted at admission, on every proposal
// window selection and again on removal. Queued tx objects are immutable,
// except settlement transitions, whose seal Hankos are attached in place by
// the Entity witness pass; those always re-render.
const fingerprintMemos = new RecencyMemo<FingerprintableTx, string>(16_384);

export const txFingerprint = (tx: FingerprintableTx): string => {
  if (tx.type === 'settle_transition') return txFingerprintUncached(tx);
  const hit = fingerprintMemos.get(tx);
  if (hit !== undefined) return hit;
  const fingerprint = txFingerprintUncached(tx);
  fingerprintMemos.set(tx, fingerprint);
  return fingerprint;
};

const txFingerprintUncached = (tx: FingerprintableTx): string => {
  if (
    tx.type !== 'consensusOutput' ||
    !tx.data ||
    typeof tx.data !== 'object' ||
    Array.isArray(tx.data)
  ) {
    return `${tx.type}:${safeStringify(tx.data)}`;
  }

  /*
   * consumptionProof is a target-proposer witness over the target pre-state.
   * It is absent from the transported mempool item and attached only to the
   * proposed frame. Including it would make a committed output impossible to
   * match and remove, causing an endless idempotent replay loop.
   */
  const {
    consumptionProof: _targetWitness,
    ...certifiedOutput
  } = tx.data as Record<string, unknown>;
  return `${tx.type}:${safeStringify(certifiedOutput)}`;
};

/**
 * Remove the exact committed transaction multiset while preserving the order
 * and multiplicity of every still-pending transaction.
 */
export const removeCommittedTxsFromMempool = <
  T extends FingerprintableTx,
>(
  mempool: T[],
  committedTxs: readonly T[],
): T[] => {
  if (committedTxs.length === 0 || mempool.length === 0) return mempool;

  // Committed txs are usually the exact mempool objects: pair by identity
  // first and fingerprint (full stringify) only what identity could not pair.
  const byIdentity = new Map<T, number>();
  for (const tx of committedTxs) byIdentity.set(tx, (byIdentity.get(tx) ?? 0) + 1);
  const remaining: T[] = [];
  for (const tx of mempool) {
    const count = byIdentity.get(tx) ?? 0;
    if (count <= 0) remaining.push(tx);
    else if (count === 1) byIdentity.delete(tx);
    else byIdentity.set(tx, count - 1);
  }
  if (byIdentity.size === 0) return remaining;

  const pendingRemovals = new Map<string, number>();
  for (const [tx, count] of byIdentity) {
    const fingerprint = txFingerprint(tx);
    pendingRemovals.set(fingerprint, (pendingRemovals.get(fingerprint) ?? 0) + count);
  }

  return remaining.filter(tx => {
    const fingerprint = txFingerprint(tx);
    const remaining = pendingRemovals.get(fingerprint) ?? 0;
    if (remaining <= 0) return true;
    if (remaining === 1) pendingRemovals.delete(fingerprint);
    else pendingRemovals.set(fingerprint, remaining - 1);
    return false;
  });
};
