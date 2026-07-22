import { appendAccountMempoolTx } from '../../account/mempool';
import { txFingerprint } from '../../state-helpers';
import type { AccountMachine, AccountTx } from '../../types';

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
