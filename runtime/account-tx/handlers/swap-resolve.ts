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
 * - Left gives → offdelta decreases (negative)
 * - Right gives → offdelta increases (positive)
 */

import { AccountMachine, AccountTx } from '../../types';
import { isLeft, deriveDelta } from '../../account-utils';
import { createDefaultDelta } from '../../validation-utils';

const MAX_FILL_RATIO = 65535;

export async function handleSwapResolve(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'swap_resolve' }>,
  isOurFrame: boolean,
  currentHeight: number
): Promise<{ success: boolean; events: string[]; error?: string; swapOfferCancelled?: { offerId: string; accountId: string } }> {
  const { offerId, fillRatio, cancelRemainder } = accountTx.data;
  const events: string[] = [];

  // 1. Find offer
  if (!accountMachine.swapOffers) {
    return { success: false, error: `No swap offers exist`, events };
  }
  const offer = accountMachine.swapOffers.get(offerId);
  if (!offer) {
    return { success: false, error: `Offer ${offerId} not found`, events };
  }

  // 2. Validate caller is the counterparty (NOT the maker)
  const { fromEntity, toEntity } = accountMachine.proofHeader;
  const weAreLeft = isLeft(fromEntity, toEntity);
  const callerIsLeft = isOurFrame ? weAreLeft : !weAreLeft;

  // Caller must be opposite of maker
  if (callerIsLeft === offer.makerIsLeft) {
    return { success: false, error: `Only counterparty can resolve swap`, events };
  }

  // 3. Validate fillRatio
  if (fillRatio < 0 || fillRatio > MAX_FILL_RATIO) {
    return { success: false, error: `Invalid fillRatio: ${fillRatio}`, events };
  }
  // If filling (not just cancelling), must meet minFillRatio
  if (fillRatio > 0 && fillRatio < offer.minFillRatio) {
    return { success: false, error: `Fill ratio ${fillRatio} below minimum ${offer.minFillRatio}`, events };
  }

  // 4. Calculate fill amounts
  // filledGive anchors the fill, filledWant derived to preserve exact price ratio
  // This prevents rounding leakage where maker could lose value
  const filledGive = (offer.giveAmount * BigInt(fillRatio)) / BigInt(MAX_FILL_RATIO);
  // Derive filledWant from filledGive to strictly enforce price: want/give ratio
  const filledWant = offer.giveAmount > 0n
    ? (filledGive * offer.wantAmount) / offer.giveAmount
    : 0n;

  // 5. Get or create deltas for both tokens
  let giveDelta = accountMachine.deltas.get(offer.giveTokenId);
  if (!giveDelta) {
    giveDelta = createDefaultDelta(offer.giveTokenId);
    accountMachine.deltas.set(offer.giveTokenId, giveDelta);
  }

  let wantDelta = accountMachine.deltas.get(offer.wantTokenId);
  if (!wantDelta) {
    wantDelta = createDefaultDelta(offer.wantTokenId);
    accountMachine.deltas.set(offer.wantTokenId, wantDelta);
  }

  // Initialize all holds if needed (both HTLC and Swap)
  giveDelta.leftHtlcHold ??= 0n;
  giveDelta.rightHtlcHold ??= 0n;
  giveDelta.leftSwapHold ??= 0n;
  giveDelta.rightSwapHold ??= 0n;
  wantDelta.leftHtlcHold ??= 0n;
  wantDelta.rightHtlcHold ??= 0n;
  wantDelta.leftSwapHold ??= 0n;
  wantDelta.rightSwapHold ??= 0n;

  // 5b. AUDIT FIX: Check taker has capacity to give wantToken
  // Use deriveDelta for consistency (accounts for collateral, allowances, ondelta)
  if (filledWant > 0n) {
    const takerIsLeft = !offer.makerIsLeft;
    const takerDerived = deriveDelta(wantDelta, takerIsLeft);
    if (filledWant > takerDerived.outCapacity) {
      return { success: false, error: `Taker insufficient capacity: needs ${filledWant}, has ${takerDerived.outCapacity}`, events };
    }
  }

  // 6. Update deltas atomically if filling
  if (filledGive > 0n) {
    // Maker gives giveToken, receives wantToken
    // Taker gives wantToken, receives giveToken
    //
    // Delta semantics (canonical):
    // - Positive offdelta = Right owes Left
    // - Negative offdelta = Left owes Right
    //
    // If maker is Left: Left gives giveToken → offdelta decreases (more negative)
    //                   Left receives wantToken → offdelta increases (less negative)
    // If maker is Right: Right gives giveToken → offdelta increases (more positive)
    //                    Right receives wantToken → offdelta decreases (less positive)

    if (offer.makerIsLeft) {
      // Left (maker) gives giveToken → Right receives
      giveDelta.offdelta -= filledGive;
      // Left (maker) receives wantToken ← Right gives
      wantDelta.offdelta += filledWant;
    } else {
      // Right (maker) gives giveToken → Left receives
      giveDelta.offdelta += filledGive;
      // Right (maker) receives wantToken ← Left gives
      wantDelta.offdelta -= filledWant;
    }

    events.push(`💱 Swap filled: ${filledGive} token${offer.giveTokenId} for ${filledWant} token${offer.wantTokenId}`);
  }

  // 7. Release hold proportionally
  const holdRelease = filledGive;
  if (offer.makerIsLeft) {
    giveDelta.leftSwapHold -= holdRelease;
  } else {
    giveDelta.rightSwapHold -= holdRelease;
  }

  // 8. Handle remainder
  const accountId = `${fromEntity}:${toEntity}`;
  let swapOfferCancelled: { offerId: string; accountId: string } | undefined;

  if (cancelRemainder || fillRatio === MAX_FILL_RATIO) {
    // Cancel or fully filled - remove offer and notify orderbook
    const remainingHold = offer.giveAmount - filledGive;
    if (remainingHold > 0n) {
      // Release remaining hold
      if (offer.makerIsLeft) {
        giveDelta.leftSwapHold -= remainingHold;
      } else {
        giveDelta.rightSwapHold -= remainingHold;
      }
    }
    accountMachine.swapOffers.delete(offerId);
    swapOfferCancelled = { offerId, accountId };
    events.push(`📊 Swap offer ${offerId.slice(0,8)}... ${fillRatio === MAX_FILL_RATIO ? 'fully filled' : 'cancelled'}`);
  } else {
    // Partial fill - update remaining amounts
    offer.giveAmount -= filledGive;
    offer.wantAmount -= filledWant;
    events.push(`📊 Swap offer ${offerId.slice(0,8)}... partially filled, ${offer.giveAmount} remaining`);
  }

  return { success: true, events, swapOfferCancelled };
}
