import type { EntityState, EntityTx, AccountTx, MempoolOp } from '../../types';
import { cloneEntityState } from '../../state-helpers';

export function handleRequestWithdrawal(
  state: EntityState,
  entityTx: Extract<EntityTx, { type: 'requestWithdrawal' }>
): { newState: EntityState; mempoolOps: MempoolOp[] } {
  const { counterpartyEntityId, tokenId, amount } = entityTx.data;

  const newState = cloneEntityState(state);
  const accountMachine = newState.accounts.get(counterpartyEntityId);
  if (!accountMachine) {
    throw new Error(`No account exists with ${counterpartyEntityId.slice(-8)}`);
  }

  // DETERMINISTIC: Use entity height + account height for withdrawal ID (not Date.now())
  const requestId = `w-${state.entityId.slice(-4)}-${state.height}-${accountMachine.currentHeight}`;

  const accountTx: AccountTx = {
    type: 'request_withdrawal',
    data: {
      tokenId,
      amount,
      requestId
    }
  };

  // Route through mempoolOps so entity-consensus marks the counterparty account
  // as proposable in the same tick. Directly mutating account.mempool here can
  // leave request_withdrawal stranded until some unrelated future entity input.
  const mempoolOps: MempoolOp[] = [{ accountId: counterpartyEntityId, tx: accountTx }];

  console.log(`💸 Queued withdrawal request: ${amount} (token ${tokenId}) from ${counterpartyEntityId.slice(-8)}`);
  console.log(`   Request ID: ${requestId}`);
  console.log(`   Scheduled via mempoolOps for ${counterpartyEntityId.slice(-8)}`);

  return { newState, mempoolOps };
}
