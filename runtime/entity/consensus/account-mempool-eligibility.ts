import type { AccountMachine, EntityState } from '../../types';
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
  account: AccountMachine,
  state: EntityState,
): boolean => {
  if (account.pendingFrame || account.mempool.length === 0) return false;
  if (account.mempool.some((tx) => accountTxAwaitsPostCommitHanko(tx, account, state))) return false;
  return account.mempool.some((tx) => getSignedSettlementWorkspaceTxError(account, tx) === undefined);
};
