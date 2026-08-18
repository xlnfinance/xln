import type { AccountReplica } from '../../../types/account';
import type { EntityState } from '../../types';
import { getSignedSettlementWorkspaceTxError } from '../../../account/tx/handlers/settlement/transition';
import { accountTxAwaitsPostCommitHanko } from '../input/hanko-witness';
import { LIMITS } from '../../../config/constants';

/**
 * A durable Account mempool is not automatically runnable work. A signed
 * settlement intentionally freezes ordinary mutations until its J result is
 * observed, while post-commit Hanko drafts must preserve exact queue order.
 * Keeping those transactions is required for retry safety; repeatedly waking
 * the Entity for them would only manufacture empty Entity heights.
 */
export const accountHasProposableMempool = (
  account: AccountReplica,
  state: EntityState,
): boolean => {
  if (account.pendingFrame || account.mempool.length === 0) return false;
  // During dispute preparation/finalization, unilateral resolve txs are
  // durable transformer evidence, not candidates for another bilateral frame.
  // No Account transaction can wake a non-active Account: preparation and
  // finalized disputes both close the peer ACK lane.
  if ((account.status ?? 'active') !== 'active') return false;
  if (account.mempool.some((tx) => accountTxAwaitsPostCommitHanko(tx, account, state))) return false;
  // Locks past MAX_ACCOUNT_HTLC_LOCKS wait for a resolve to commit; waking the
  // Entity for them only produces idle Account proposals (100 users x every
  // Runtime input hit the cross-J cascade guard).
  const locksFull = (account.state.locks?.size ?? 0) >= LIMITS.MAX_ACCOUNT_HTLC_LOCKS;
  return account.mempool.some((tx) =>
    !(locksFull && tx.type === 'htlc_lock') &&
    getSignedSettlementWorkspaceTxError(account, tx) === undefined);
};
