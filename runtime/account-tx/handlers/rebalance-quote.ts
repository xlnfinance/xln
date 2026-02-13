/**
 * Rebalance Quote Handler
 * Hub offers a price for rebalancing. quoteId = env.timestamp (deterministic).
 * Auto-accepts if fee <= user's maxAcceptableFee.
 * See docs/rebalance.md for full spec
 */

import type { AccountMachine, AccountTx, RebalanceQuote } from '../../types';
import { QUOTE_EXPIRY_MS } from '../../types';

export function handleRebalanceQuote(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'rebalance_quote' }>,
  currentTimestamp: number
): { success: boolean; events: string[]; error?: string } {
  const { tokenId, amount, feeTokenId, feeAmount } = accountTx.data;

  if (amount <= 0n) {
    return { success: false, events: [], error: 'amount must be > 0' };
  }
  if (feeAmount < 0n) {
    return { success: false, events: [], error: 'feeAmount must be >= 0' };
  }

  // quoteId = timestamp (both sides compute identically)
  const quoteId = currentTimestamp;

  // Auto-accept check: fee <= user's maxAcceptableFee
  const policy = accountMachine.rebalancePolicy.get(tokenId);
  const accepted = !!(policy && feeAmount <= policy.maxAcceptableFee);

  const quote: RebalanceQuote = {
    quoteId,
    tokenId,
    amount,
    feeTokenId,
    feeAmount,
    accepted,
  };

  // Replace any existing quote (one at a time)
  accountMachine.activeRebalanceQuote = quote;

  // Clear pending request (this quote IS the response)
  accountMachine.pendingRebalanceRequest = undefined;

  const status = accepted ? 'auto-accepted' : 'pending user approval';
  return {
    success: true,
    events: [`💰 Rebalance quote: ${amount} token ${tokenId}, fee ${feeAmount} (${status}, quoteId=${quoteId})`],
  };
}
