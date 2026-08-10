import type { AccountReplica } from '../../types/account';
import type { EntityState } from '../types';
import { getSignedSettlementWorkspaceTxError } from '../../account/tx/handlers/settle-transition';
import { accountTxAwaitsPostCommitHanko } from './hanko-witness';

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
  return account.mempool.some((tx) => getSignedSettlementWorkspaceTxError(account, tx) === undefined);
};
