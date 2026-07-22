import { appendAccountMempoolTx } from '../../account/mempool';
import { txFingerprint } from '../../state-helpers';
import { MAX_SWAP_FILL_RATIO, swapKey } from '../../orderbook/swap-execution';
import type { AccountMachine, AccountTx, EntityState } from '../../types';

type AccountMempoolQueue = Pick<AccountMachine, 'mempool' | 'pendingFrame'>;

/**
 * Queue an Account transaction while preserving the transaction's intended
 * multiplicity.
 *
 * Two separately authorized payments may deliberately have identical
 * token/amount/route bytes. Their Entity-command nonces distinguish the user
 * intents before this projection, so semantic deduplication here would destroy
 * money movement whenever the first payment is still in a pending frame.
 * Protocol lifecycle transactions remain idempotent by exact payload.
 */
export const queueAccountMempoolTx = (
  account: AccountMempoolQueue,
  tx: AccountTx,
): boolean => {
  if (tx.type === 'direct_payment') {
    appendAccountMempoolTx(account, tx, 'entityConsensus:queuePayment');
    return true;
  }

  const fingerprint = txFingerprint(tx);
  for (const existing of account.mempool) {
    if (txFingerprint(existing) === fingerprint) return false;
  }
  for (const pendingTx of account.pendingFrame?.accountTxs ?? []) {
    if (txFingerprint(pendingTx) === fingerprint) return false;
  }
  appendAccountMempoolTx(account, tx, 'entityConsensus:queueLifecycle');
  return true;
};

/** Persist unilateral swap evidence outside the optimistic Account candidate. */
export const recordPendingSwapFillRatio = (
  state: EntityState,
  accountId: string,
  tx: AccountTx,
): void => {
  if (tx.type !== 'swap_resolve') return;
  const ratio = tx.data.fillRatio;
  if (!Number.isSafeInteger(ratio) || ratio < 0 || ratio > MAX_SWAP_FILL_RATIO) {
    throw new Error(`SWAP_DISPUTE_FILL_RATIO_INVALID:${accountId}:${tx.data.offerId}:${ratio}`);
  }
  state.pendingSwapFillRatios ??= new Map();
  const key = swapKey(accountId, tx.data.offerId);
  const existing = state.pendingSwapFillRatios.get(key);
  if (existing !== undefined && existing !== ratio) {
    throw new Error(
      `SWAP_DISPUTE_FILL_RATIO_CONFLICT:${accountId}:${tx.data.offerId}:${existing}:${ratio}`,
    );
  }
  state.pendingSwapFillRatios.set(key, ratio);
};

/**
 * Keep unilateral fill evidence bound to an actual queued or in-flight tx.
 * Recording at enqueue time is required so a peer cannot block dispute evidence
 * by withholding the ACK. But retaining a locally rejected fill would poison a
 * later valid retry with a false ratio conflict, so proposal validation is the
 * exact lifecycle boundary for removing evidence that never became a candidate.
 */
export const reconcilePendingSwapFillRatios = (
  state: EntityState,
  accountId: string,
  account: AccountMempoolQueue,
): void => {
  const active = new Set<string>();
  for (const tx of [...account.mempool, ...(account.pendingFrame?.accountTxs ?? [])]) {
    if (tx.type === 'swap_resolve') active.add(swapKey(accountId, tx.data.offerId));
  }
  const prefix = `${accountId}:`;
  const evidence = state.pendingSwapFillRatios;
  if (!evidence) return;
  for (const key of evidence.keys()) {
    if (key.startsWith(prefix) && !active.has(key)) evidence.delete(key);
  }
};
