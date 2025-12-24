/**
 * Swap Offer Handler
 * User creates limit order, locks capacity
 *
 * Flow:
 * 1. Validate offerId uniqueness
 * 2. Validate capacity (including existing holds)
 * 3. Lock capacity: leftSwapHold or rightSwapHold
 * 4. Store in swapOffers Map
 */

import { AccountMachine, AccountTx } from '../../types';

export async function handleSwapOffer(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'swap_offer' }>,
  isOurFrame: boolean,
  currentHeight: number
): Promise<{ success: boolean; events: string[]; error?: string }> {
  // TODO: Implement
  // See docs/planning/active/swap-implementation-plan.md

  return {
    success: false,
    error: 'swap_offer not yet implemented',
    events: [],
  };
}
