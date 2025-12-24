/**
 * Swap Cancel Handler
 * User requests cancellation of their offer
 *
 * Note: This is a REQUEST - the counterparty (hub) must agree via swap_resolve.
 * In dispute, user can prove they requested cancellation.
 *
 * Flow:
 * 1. Find offer by offerId
 * 2. Validate caller is the maker
 * 3. Mark as cancel-requested (or immediately cancel if hub agrees)
 */

import { AccountMachine, AccountTx } from '../../types';

export async function handleSwapCancel(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'swap_cancel' }>,
  isOurFrame: boolean,
  currentHeight: number
): Promise<{ success: boolean; events: string[]; error?: string }> {
  // TODO: Implement
  // See docs/planning/active/swap-implementation-plan.md

  return {
    success: false,
    error: 'swap_cancel not yet implemented',
    events: [],
  };
}
