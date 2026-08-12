import { safeStringify } from '../serialization';

export type FingerprintableTx = {
  type: string;
  data?: unknown;
};

export const txFingerprint = (tx: FingerprintableTx): string => {
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

  const pendingRemovals = new Map<string, number>();
  for (const tx of committedTxs) {
    const fingerprint = txFingerprint(tx);
    pendingRemovals.set(
      fingerprint,
      (pendingRemovals.get(fingerprint) ?? 0) + 1,
    );
  }

  return mempool.filter(tx => {
    const fingerprint = txFingerprint(tx);
    const remaining = pendingRemovals.get(fingerprint) ?? 0;
    if (remaining <= 0) return true;
    if (remaining === 1) pendingRemovals.delete(fingerprint);
    else pendingRemovals.set(fingerprint, remaining - 1);
    return false;
  });
};
