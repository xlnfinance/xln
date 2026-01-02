/**
 * Swap Cancel Handler
 * User requests cancellation of their offer
 *
 * Note: This is a REQUEST to cancel. The counterparty (hub) can either:
 * - Accept the cancellation (do nothing, let the offer be removed)
 * - Or use swap_resolve with fillRatio=0, cancelRemainder=true
 *
 * In practice, for same-J swaps within trusted hub relationship,
 * the hub typically honors cancellation requests immediately.
 *
 * Flow:
 * 1. Find offer by offerId
 * 2. Validate caller IS the maker
 * 3. Release hold
 * 4. Remove offer
 */

import { AccountMachine, AccountTx } from '../../types';
import { isLeft } from '../../account-utils';

export async function handleSwapCancel(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'swap_cancel' }>,
  isOurFrame: boolean,
  currentHeight: number,
  isValidation: boolean = false
): Promise<{ success: boolean; events: string[]; error?: string; swapOfferCancelled?: { offerId: string; accountId: string; makerId: string } }> {
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

  // 2. Validate caller IS the maker (only maker can cancel)
  const { fromEntity, toEntity } = accountMachine.proofHeader;
  const weAreLeft = isLeft(fromEntity, toEntity);
  const callerIsLeft = isOurFrame ? weAreLeft : !weAreLeft;

  if (callerIsLeft !== offer.makerIsLeft) {
    return { success: false, error: `Only maker can cancel swap offer`, events };
  }

  // 3. Release hold (always - affects delta validation)
  const giveDelta = accountMachine.deltas.get(offer.giveTokenId);
  if (giveDelta) {
    if (giveDelta.leftSwapHold === undefined) giveDelta.leftSwapHold = 0n;
    if (giveDelta.rightSwapHold === undefined) giveDelta.rightSwapHold = 0n;

    if (offer.makerIsLeft) {
      giveDelta.leftSwapHold -= offer.giveAmount;
    } else {
      giveDelta.rightSwapHold -= offer.giveAmount;
    }
  }

  // 4. Remove offer (only during commit, not validation)
  if (!isValidation) {
    accountMachine.swapOffers.delete(offerId);
    console.log(`📊 COMMIT: Swap offer removed, offerId=${offerId.slice(0,8)}`);
  } else {
    console.log(`⏭️ VALIDATION: Skipping swapOffers removal (will commit later)`);
  }

  const accountId = `${fromEntity}:${toEntity}`;
  const makerId = offer.makerIsLeft ? fromEntity : toEntity;

  events.push(`📊 Swap offer cancelled: ${offerId.slice(0,8)}... (released ${offer.giveAmount} token${offer.giveTokenId})`);

  return { success: true, events, swapOfferCancelled: { offerId, accountId, makerId } };
}
