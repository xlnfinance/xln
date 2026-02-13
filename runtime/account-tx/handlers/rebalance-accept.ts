/**
 * Rebalance Accept Handler
 * User manually approves a quote that wasn't auto-accepted (fee > maxAcceptableFee).
 * See docs/rebalance.md for full spec
 */

import type { AccountMachine, AccountTx } from '../../types';
import { QUOTE_EXPIRY_MS } from '../../types';

export function handleRebalanceAccept(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'rebalance_accept' }>,
  currentTimestamp: number
): { success: boolean; events: string[]; error?: string } {
  const { quoteId } = accountTx.data;
  const quote = accountMachine.activeRebalanceQuote;

  if (!quote) {
    return { success: false, events: [], error: 'No active quote' };
  }

  if (quote.quoteId !== quoteId) {
    return { success: false, events: [], error: `Quote ID mismatch: expected ${quote.quoteId}, got ${quoteId}` };
  }

  if (currentTimestamp > quote.quoteId + QUOTE_EXPIRY_MS) {
    accountMachine.activeRebalanceQuote = undefined;
    return { success: false, events: [], error: `Quote expired (age: ${currentTimestamp - quote.quoteId}ms, max: ${QUOTE_EXPIRY_MS}ms)` };
  }

  if (quote.accepted) {
    return { success: true, events: ['Quote already accepted'] };
  }

  quote.accepted = true;

  return {
    success: true,
    events: [`✅ Rebalance quote ${quoteId} accepted: ${quote.amount} token ${quote.tokenId}, fee ${quote.feeAmount}`],
  };
}
