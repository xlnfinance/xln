/**
 * Request Rebalance Handler
 * Entity signals they want credit converted to collateral (turn debt into secured balance)
 * Reference: 2019src.txt line 2976 (they_requested_deposit)
 */

import { AccountMachine, AccountTx } from '../../types';

export function handleRequestRebalance(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'request_rebalance' }>
): { success: boolean; events: string[] } {
  const { tokenId, amount } = accountTx.data;

  accountMachine.requestedRebalance.set(tokenId, amount);

  console.log(`🔄 Rebalance requested: ${amount} token ${tokenId} (hub will coordinate)`);

  return {
    success: true,
    events: [`🔄 Requested rebalance: ${amount} token ${tokenId} (hub will convert credit→collateral)`],
  };
}
