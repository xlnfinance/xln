import type { EntityState, EntityTx, AccountTx } from '../../types';

export function handleRequestWithdrawal(
  state: EntityState,
  entityTx: Extract<EntityTx, { type: 'requestWithdrawal' }>
): EntityState {
  const { counterpartyEntityId, tokenId, amount } = entityTx.data;

  // Find or create account
  let accountMachine = state.accounts.get(counterpartyEntityId);
  if (!accountMachine) {
    throw new Error(`No account exists with ${counterpartyEntityId.slice(-8)}`);
  }

  // Generate unique request ID (simple hash for demo - use deterministic RNG in production)
  const requestId = `${state.entityId.slice(0,4)}${counterpartyEntityId.slice(0,4)}${tokenId}${Date.now()}`.slice(0, 16);

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
