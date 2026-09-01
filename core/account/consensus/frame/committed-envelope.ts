import { cloneIsolatedAccountFrame } from '../../../protocol/state/account-input-clone';
import type { AccountFrame, AccountReplica } from '../../../types/account';

/**
 * Install one already-verified Account frame as the committed head.
 *
 * A committed resolve makes every queued retry of the corresponding lock
 * permanently stale. Pruning belongs to this Account commit boundary: doing
 * it later from Entity consensus bypasses resident Account workers and forks
 * their envelope from the inline transition.
 */
export const installCommittedAccountFrameHead = (
  account: AccountReplica,
  frame: AccountFrame,
): void => {
  account.currentFrame = cloneIsolatedAccountFrame(frame);
  account.currentHeight = frame.height;

  const resolvedLockIds = new Set(frame.accountTxs.flatMap((tx) =>
    tx.type === 'htlc_resolve' ? [tx.data.lockId] : []));
  if (resolvedLockIds.size === 0) return;
  account.mempool = account.mempool.filter((tx) =>
    tx.type !== 'htlc_lock' || !resolvedLockIds.has(tx.data.lockId));
};
