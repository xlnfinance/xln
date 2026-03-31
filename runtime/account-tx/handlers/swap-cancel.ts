/**
 * Swap Cancel Request Handler
 * Maker can only REQUEST cancellation. Counterparty/hub decides final cancel via swap_resolve.
 *
 * Flow:
 * 1. Find offer by offerId
 * 2. Validate caller IS the maker
 * 3. Emit cancel-request event for orderbook/counterparty orchestration
 *
 * IMPORTANT: No hold release and no swapOffers mutation here.
 * Final state transition happens only in swap_resolve (counterparty side).
 */

import type { AccountMachine, AccountTx } from '../../types';
import { recordSwapCancelRequested } from './swap-history';

export async function handleSwapCancelRequest(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'swap_cancel_request' }> | Extract<AccountTx, { type: 'swap_cancel' }>,
  byLeft: boolean,
  _currentHeight: number,
  isValidation: boolean = false
): Promise<{ success: boolean; events: string[]; error?: string; swapOfferCancelRequested?: { offerId: string } }> {
  const { offerId } = accountTx.data;
  const events: string[] = [];

  // 1. Find offer
  if (!accountMachine.swapOffers) {
    return { success: false, error: `No swap offers exist`, events };
  }
  const offer = accountMachine.swapOffers.get(offerId);
  if (!offer) {
    return { success: false, error: `Offer ${offerId} not found`, events };
  }

  // 2. Validate caller IS the maker (Channel.ts: byLeft = frame proposer = caller)
  const callerIsLeft = byLeft;

  if (callerIsLeft !== offer.makerIsLeft) {
    return { success: false, error: `Only maker can cancel swap offer`, events };
  }

  // 3. Emit request event (used by hub orderbook cancel flow)
  events.push(`📨 Swap cancel requested: ${offerId.slice(0, 8)}...`);
  if (isValidation) {
    console.log(`📊 VALIDATION: swap_cancel_request accepted, offerId=${offerId.slice(0, 8)}`);
  } else {
    console.log(`📊 COMMIT: swap_cancel_request accepted, offerId=${offerId.slice(0, 8)}`);
  }
  recordSwapCancelRequested(accountMachine, offerId, _currentHeight);
  return { success: true, events, swapOfferCancelRequested: { offerId } };
}

// Legacy export for older imports.
export const handleSwapCancel = handleSwapCancelRequest;
