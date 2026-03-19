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

import type { AccountMachine, AccountTx } from '../../types';
import { deriveDelta } from '../../account-utils';
import { createDefaultDelta } from '../../validation-utils';
import { FINANCIAL } from '../../constants';
import { canonicalPair, computeSwapPriceTicks, requantizeRemainingSwapAtPrice, SWAP_LOT_SCALE } from '../../orderbook/types';

const MAX_FILL_RATIO = 65535;

export async function handleSwapResolve(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'swap_resolve' }>,
  byLeft: boolean,
  currentHeight: number,
  isValidation: boolean = false
): Promise<{ success: boolean; events: string[]; error?: string; swapOfferCancelled?: { offerId: string; accountId: string } }> {
  const {
    offerId,
    fillRatio,
    cancelRemainder,
    executionBaseAmount,
    executionQuoteAmount,
  } = accountTx.data;
  const events: string[] = [];

  // 1. Find offer
  if (!accountMachine.swapOffers) {
    return { success: false, error: `No swap offers exist`, events };
  }
  const offer = accountMachine.swapOffers.get(offerId);
  if (!offer) {
    return { success: false, error: `Offer ${offerId} not found`, events };
  }

  // 2. Validate caller is the counterparty (Channel.ts: byLeft = frame proposer = caller)
  const callerIsLeft = byLeft;

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
  const hasExecutionBaseAmount = executionBaseAmount !== undefined;
  const hasExecutionQuoteAmount = executionQuoteAmount !== undefined;
  if (hasExecutionBaseAmount !== hasExecutionQuoteAmount) {
    return { success: false, error: 'Exact execution amounts must be provided together', events };
  }

  let filledGive: bigint;
  let filledWant: bigint;
  if (hasExecutionBaseAmount && hasExecutionQuoteAmount) {
    const exactBaseAmount = executionBaseAmount;
    const exactQuoteAmount = executionQuoteAmount;
    if (fillRatio === 0 && (exactBaseAmount !== 0n || exactQuoteAmount !== 0n)) {
      return { success: false, error: 'Exact execution amounts must be zero for zero fill', events };
    }
    if (fillRatio > 0 && (exactBaseAmount <= 0n || exactQuoteAmount <= 0n)) {
      return { success: false, error: 'Exact execution amounts must be positive when fillRatio > 0', events };
    }
    if (exactBaseAmount % SWAP_LOT_SCALE !== 0n) {
      return { success: false, error: 'Exact base execution amount must be lot-aligned', events };
    }

    const { base: baseTokenId } = canonicalPair(offer.giveTokenId, offer.wantTokenId);
    const makerSellsBase = offer.giveTokenId === baseTokenId;
    const expectedBaseAmount = makerSellsBase
      ? (effectiveGive * BigInt(fillRatio)) / BigInt(MAX_FILL_RATIO)
      : (effectiveWant * BigInt(fillRatio)) / BigInt(MAX_FILL_RATIO);
    if (exactBaseAmount !== expectedBaseAmount) {
      return {
        success: false,
        error: `Exact base amount ${exactBaseAmount} does not match fillRatio-derived amount ${expectedBaseAmount}`,
        events,
      };
    }

    if (makerSellsBase) {
      filledGive = exactBaseAmount;
      filledWant = exactQuoteAmount;
    } else {
      const maximumQuoteAmount = (effectiveGive * BigInt(fillRatio)) / BigInt(MAX_FILL_RATIO);
      if (exactQuoteAmount > maximumQuoteAmount) {
        return {
          success: false,
          error: `Exact quote amount ${exactQuoteAmount} exceeds maker max spend ${maximumQuoteAmount}`,
          events,
        };
      }
      filledGive = exactQuoteAmount;
      filledWant = exactBaseAmount;
    }
  } else {
    // filledGive anchors the fill, filledWant derived using ceil() to protect maker.
    // Maker must receive at least their limit price; taker pays any dust.
    filledGive = (effectiveGive * BigInt(fillRatio)) / BigInt(MAX_FILL_RATIO);
    filledWant = effectiveGive > 0n
      ? (filledGive * effectiveWant + effectiveGive - 1n) / effectiveGive
      : 0n;
  }

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

  // Initialize holds if needed.
  giveDelta.leftHold ??= 0n;
  giveDelta.rightHold ??= 0n;
  wantDelta.leftHold ??= 0n;
  wantDelta.rightHold ??= 0n;

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
    const currentHold = giveDelta.leftHold || 0n;
    if (currentHold < holdRelease) {
      console.error(`⚠️ Swap resolve hold underflow! leftHold=${currentHold} < holdRelease=${holdRelease}`);
      giveDelta.leftHold = 0n;
    } else {
      giveDelta.leftHold = currentHold - holdRelease;
    }
  } else {
    const currentHold = giveDelta.rightHold || 0n;
    if (currentHold < holdRelease) {
      console.error(`⚠️ Swap resolve hold underflow! rightHold=${currentHold} < holdRelease=${holdRelease}`);
      giveDelta.rightHold = 0n;
    } else {
      giveDelta.rightHold = currentHold - holdRelease;
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
        const currentHold = giveDelta.leftHold || 0n;
        if (currentHold < remainingHold) {
          console.error(`⚠️ Swap remainder hold underflow! leftHold=${currentHold} < remainingHold=${remainingHold}`);
          giveDelta.leftHold = 0n;
        } else {
          giveDelta.leftHold = currentHold - remainingHold;
        }
      } else {
        const currentHold = giveDelta.rightHold || 0n;
        if (currentHold < remainingHold) {
          console.error(`⚠️ Swap remainder hold underflow! rightHold=${currentHold} < remainingHold=${remainingHold}`);
          giveDelta.rightHold = 0n;
        } else {
          giveDelta.rightHold = currentHold - remainingHold;
        }
      }
    }
    accountMachine.swapOffers.delete(offerId);
    swapOfferCancelled = { offerId, accountId: makerId };
    events.push(`📊 Swap offer ${offerId.slice(0,8)}... ${fillRatio === MAX_FILL_RATIO ? 'fully filled' : 'cancelled'}`);
  } else {
    // Partial fill - requantize remainder so subsequent fills stay lot-aligned.
    const remainingGiveRaw = effectiveGive - filledGive;
    const remainingWantRaw = effectiveWant - filledWant;
    const offerPriceTicks = offer.priceTicks ?? computeSwapPriceTicks(
      offer.giveTokenId,
      offer.wantTokenId,
      effectiveGive,
      effectiveWant,
    );
    const requantized = requantizeRemainingSwapAtPrice(
      offer.giveTokenId,
      offer.wantTokenId,
      remainingGiveRaw,
      offerPriceTicks,
    );

    if (!requantized) {
      if (remainingGiveRaw > 0n) {
        if (offer.makerIsLeft) {
          const currentHold = giveDelta.leftHold || 0n;
          giveDelta.leftHold = currentHold > remainingGiveRaw ? currentHold - remainingGiveRaw : 0n;
        } else {
          const currentHold = giveDelta.rightHold || 0n;
          giveDelta.rightHold = currentHold > remainingGiveRaw ? currentHold - remainingGiveRaw : 0n;
        }
      }
      accountMachine.swapOffers.delete(offerId);
      swapOfferCancelled = { offerId, accountId: makerId };
      events.push(`📊 Swap offer ${offerId.slice(0,8)}... filled remainder dropped below lot size`);
    } else {
      const releasedGiveDust = requantized.releasedGiveDust;
      if (releasedGiveDust > 0n) {
        if (offer.makerIsLeft) {
          const currentHold = giveDelta.leftHold || 0n;
          giveDelta.leftHold = currentHold > releasedGiveDust ? currentHold - releasedGiveDust : 0n;
        } else {
          const currentHold = giveDelta.rightHold || 0n;
          giveDelta.rightHold = currentHold > releasedGiveDust ? currentHold - releasedGiveDust : 0n;
        }
      }

      offer.giveAmount = requantized.effectiveGive;
      offer.wantAmount = requantized.effectiveWant;
      offer.priceTicks = offerPriceTicks;
      offer.quantizedGive = requantized.effectiveGive;
      offer.quantizedWant = requantized.effectiveWant;
      events.push(`📊 Swap offer ${offerId.slice(0,8)}... partially filled, ${offer.giveAmount} remaining`);
    }
  }

  return { success: true, events, ...(swapOfferCancelled !== undefined && { swapOfferCancelled }) };
}
