/**
 * Swap Resolve Handler
 * Hub (counterparty) fills and/or cancels user's offer
 *
 * The hub owns the "option" on the swap:
 * - Can fill 0% to 100% (via fillRatio: 0-65535)
 * - Can keep remainder open or cancel it
 *
 * Flow:
 * 1. Find offer by offerId
 * 2. Validate caller is NOT the maker (is the counterparty/hub)
 * 3. Validate fillRatio >= offer.minFillRatio (unless cancelling all)
 * 4. Calculate fill amounts using uint16 ratio
 * 5. Update deltas atomically (both tokens)
 * 6. Release proportional hold
 * 7. If cancelRemainder: remove offer; else: update remaining amount
 *
 * Delta rules (same as HTLC):
 * - Left gives → delta decreases (negative)
 * - Right gives → delta increases (positive)
 */

import { AccountMachine, AccountTx } from '../../types';

// uint16 max for fill ratio
const MAX_FILL_RATIO = 65535;

export async function handleSwapResolve(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'swap_resolve' }>,
  isOurFrame: boolean,
  currentHeight: number
): Promise<{ success: boolean; events: string[]; error?: string }> {
  // TODO: Implement
  // See docs/planning/active/swap-implementation-plan.md
  //
  // Key formula for fill amount:
  // filledAmount = (offer.giveAmount * BigInt(fillRatio)) / BigInt(MAX_FILL_RATIO)

  return {
    success: false,
    error: 'swap_resolve not yet implemented',
    events: [],
  };
}
