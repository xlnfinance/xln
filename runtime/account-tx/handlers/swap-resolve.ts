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
 *
 * TODO(liquidation): Add solvency check after delta updates
 * If abs(offdelta) > collateral for either party, trigger forced liquidation:
 * - Clear all open orders for insolvent party
 * - Seize collateral proportionally
 * - Emit LIQUIDATION event for on-chain settlement
 *
 * TODO(fees): Add fee collection on matched trades
 * - Hub takes spread (e.g., 0.1% of filledWant)
 * - Fee accrues to hub's delta, incentivizes market making
 */

import { AccountMachine, AccountTx } from '../../types';
import { isLeft, deriveDelta } from '../../account-utils';
import { createDefaultDelta } from '../../validation-utils';
import { FINANCIAL } from '../../constants';

const MAX_FILL_RATIO = 65535;

export async function handleSwapResolve(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'swap_resolve' }>,
  isOurFrame: boolean,
  currentHeight: number,
  isValidation: boolean = false
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
  // Use quantized amounts if available (set by orderbook) for exact lot-to-wei consistency
  // This ensures fill ratios computed from lots match settlement amounts exactly
  const effectiveGive = offer.quantizedGive ?? offer.giveAmount;
  const effectiveWant = offer.quantizedWant ?? offer.wantAmount;

  // filledGive anchors the fill, filledWant derived using ceil() to protect maker
  // Maker must receive AT LEAST their limit price - taker pays any dust
  const filledGive = (effectiveGive * BigInt(fillRatio)) / BigInt(MAX_FILL_RATIO);
  // Ceiling division: (a * b + c - 1) / c ensures maker gets >= limit price
  const filledWant = effectiveGive > 0n
    ? (filledGive * effectiveWant + effectiveGive - 1n) / effectiveGive
    : 0n;

  if (fillRatio > 0) {
    if (filledGive < FINANCIAL.MIN_PAYMENT_AMOUNT || filledGive > FINANCIAL.MAX_PAYMENT_AMOUNT) {
      return {
        success: false,
        error: `Filled give amount out of bounds: ${filledGive} (min ${FINANCIAL.MIN_PAYMENT_AMOUNT}, max ${FINANCIAL.MAX_PAYMENT_AMOUNT})`,
        events,
      };
    }
    if (filledWant < FINANCIAL.MIN_PAYMENT_AMOUNT || filledWant > FINANCIAL.MAX_PAYMENT_AMOUNT) {
      return {
        success: false,
        error: `Filled want amount out of bounds: ${filledWant} (min ${FINANCIAL.MIN_PAYMENT_AMOUNT}, max ${FINANCIAL.MAX_PAYMENT_AMOUNT})`,
        events,
      };
    }
  }

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
    // Taker (counterparty) gives wantToken, receives giveToken
    //
    // CANONICAL Delta semantics (from direct-payment.ts):
    // - Positive offdelta = Right owes Left
    // - Negative offdelta = Left owes Right
    // - Left pays → offdelta DECREASES
    // - Right pays → offdelta INCREASES

    if (offer.makerIsLeft) {
      // Maker (Left) gives giveToken → Left pays → offdelta decreases
      // Maker (Left) receives wantToken → Right pays → offdelta increases
      giveDelta.offdelta -= filledGive;
      wantDelta.offdelta += filledWant;
    } else {
      // Maker (Right) gives giveToken → Right pays → offdelta INCREASES
      // Maker (Right) receives wantToken → Left pays → offdelta DECREASES
      giveDelta.offdelta += filledGive;
      wantDelta.offdelta -= filledWant;
    }

    events.push(`💱 Swap filled: ${filledGive} token${offer.giveTokenId} for ${filledWant} token${offer.wantTokenId}`);
  }

  // 7. Release hold proportionally (with underflow guard)
  const holdRelease = filledGive;
  if (offer.makerIsLeft) {
    const currentHold = giveDelta.leftSwapHold || 0n;
    if (currentHold < holdRelease) {
      console.error(`⚠️ Swap resolve hold underflow! leftSwapHold=${currentHold} < holdRelease=${holdRelease}`);
      giveDelta.leftSwapHold = 0n;
    } else {
      giveDelta.leftSwapHold = currentHold - holdRelease;
    }
  } else {
    const currentHold = giveDelta.rightSwapHold || 0n;
    if (currentHold < holdRelease) {
      console.error(`⚠️ Swap resolve hold underflow! rightSwapHold=${currentHold} < holdRelease=${holdRelease}`);
      giveDelta.rightSwapHold = 0n;
    } else {
      giveDelta.rightSwapHold = currentHold - holdRelease;
    }
  }

  // 8. Handle remainder
  // AUDIT FIX (CRITICAL-3): Use counterparty ID format, not canonical pair format
  // This ensures orderbook cancellation finds the correct entry
  // The maker is who created this offer (makerIsLeft determines left vs right)
  const makerId = offer.makerIsLeft ? accountMachine.leftEntity : accountMachine.rightEntity;
  let swapOfferCancelled: { offerId: string; accountId: string } | undefined;

  if (cancelRemainder || fillRatio === MAX_FILL_RATIO) {
    // Cancel or fully filled - remove offer and notify orderbook
    const remainingHold = effectiveGive - filledGive;
    if (remainingHold > 0n) {
      // Release remaining hold (with underflow guard)
      if (offer.makerIsLeft) {
        const currentHold = giveDelta.leftSwapHold || 0n;
        if (currentHold < remainingHold) {
          console.error(`⚠️ Swap remainder hold underflow! leftSwapHold=${currentHold} < remainingHold=${remainingHold}`);
          giveDelta.leftSwapHold = 0n;
        } else {
          giveDelta.leftSwapHold = currentHold - remainingHold;
        }
      } else {
        const currentHold = giveDelta.rightSwapHold || 0n;
        if (currentHold < remainingHold) {
          console.error(`⚠️ Swap remainder hold underflow! rightSwapHold=${currentHold} < remainingHold=${remainingHold}`);
          giveDelta.rightSwapHold = 0n;
        } else {
          giveDelta.rightSwapHold = currentHold - remainingHold;
        }
      }
    }
    accountMachine.swapOffers.delete(offerId);
    swapOfferCancelled = { offerId, accountId: makerId };
    events.push(`📊 Swap offer ${offerId.slice(0,8)}... ${fillRatio === MAX_FILL_RATIO ? 'fully filled' : 'cancelled'}`);
  } else {
    // Partial fill - update remaining amounts (use quantized values for consistency)
    offer.giveAmount = effectiveGive - filledGive;
    offer.wantAmount = effectiveWant - filledWant;
    // Update quantized amounts too
    if (offer.quantizedGive !== undefined) {
      offer.quantizedGive = offer.giveAmount;
      offer.quantizedWant = offer.wantAmount;
    }
    events.push(`📊 Swap offer ${offerId.slice(0,8)}... partially filled, ${offer.giveAmount} remaining`);
  }

  return { success: true, events, swapOfferCancelled };
}
