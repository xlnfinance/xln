import type { EntityState, EntityTx, AccountTx } from '../../types';
import { canonicalAccountKey } from '../../state-helpers';

export function handleRequestWithdrawal(
  state: EntityState,
  entityTx: Extract<EntityTx, { type: 'requestWithdrawal' }>
): EntityState {
  const { counterpartyEntityId, tokenId, amount } = entityTx.data;

  // Find or create account (use canonical key)
  // Account keyed by counterparty ID
  let accountMachine = state.accounts.get(counterpartyEntityId);
  if (!accountMachine) {
    throw new Error(`No account exists with ${counterpartyEntityId.slice(-8)}`);
  }

  // DETERMINISTIC: Use height + counter for withdrawal ID (not Date.now())
  const withdrawalCounter = accountMachine?.sendCounter || 0;
  const requestId = `w-${state.entityId.slice(-4)}-${state.height}-${withdrawalCounter}`;

  // Create request_withdrawal AccountTx
  const accountTx: AccountTx = {
    type: 'request_withdrawal',
    data: {
      tokenId,
      amount,
      requestId
    }
  };

  // Add to account mempool (will be picked up by AUTO-PROPOSE)
  accountMachine.mempool.push(accountTx);

  console.log(`💸 Queued withdrawal request: ${amount} (token ${tokenId}) from ${counterpartyEntityId.slice(-8)}`);
  console.log(`   Request ID: ${requestId}`);
  console.log(`   Account mempool now has ${accountMachine.mempool.length} pending transactions`);

  return state;
}
