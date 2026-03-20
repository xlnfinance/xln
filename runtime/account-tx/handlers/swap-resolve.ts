/**
 * Swap Resolve Handler
 * Hub (counterparty) fills and/or cancels user's offer
 *
 * Settlement: ALWAYS at offer's limit price (maker's terms).
 * Price improvement delivered as rebate: hub matched at better prices,
 * returns the spread to maker (taker in exchange terms) minus hub's cut.
 *
 * Flow:
 * 1. Find offer by offerId
 * 2. Validate caller is NOT the maker (is the counterparty/hub)
 * 3. Validate fillRatio >= offer.minFillRatio (unless cancelling all)
 * 4. Calculate fill amounts at LIMIT PRICE (offer ratio)
 * 5. Update deltas atomically (both tokens)
 * 6. Apply rebate if present (price improvement refund to maker)
 * 7. Release proportional hold
 * 8. If cancelRemainder: remove offer; else: update remaining amount
 *
 * Delta rules (same as HTLC):
 * - Left gives → offdelta decreases (negative)
 * - Right gives → offdelta increases (positive)
 */

import type { AccountMachine, AccountTx } from '../../types';
import { deriveDelta } from '../../account-utils';
import { createDefaultDelta } from '../../validation-utils';
import { FINANCIAL } from '../../constants';
import { computeSwapPriceTicks, requantizeRemainingSwapAtPrice, SWAP_LOT_SCALE } from '../../orderbook/types';

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
    rebateAmount,
    rebateTokenId,
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

  // 4. Calculate fill amounts at LIMIT PRICE (offer ratio)
  const effectiveGive = offer.quantizedGive ?? offer.giveAmount;
  const effectiveWant = offer.quantizedWant ?? offer.wantAmount;

  // filledGive anchors the fill, filledWant derived using ceil() to protect maker.
  // Maker must receive at least their limit price; taker pays any dust.
  const filledGive = (effectiveGive * BigInt(fillRatio)) / BigInt(MAX_FILL_RATIO);
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

  // Validate rebate
  const hasRebate = rebateAmount !== undefined && rebateAmount > 0n && rebateTokenId !== undefined;
  if (hasRebate) {
    if (rebateTokenId !== offer.giveTokenId && rebateTokenId !== offer.wantTokenId) {
      return { success: false, error: `Rebate token ${rebateTokenId} not in swap pair`, events };
    }
    if (rebateAmount > FINANCIAL.MAX_PAYMENT_AMOUNT) {
      return { success: false, error: `Rebate amount out of bounds: ${rebateAmount}`, events };
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
  if (filledWant > 0n) {
    const takerIsLeft = !offer.makerIsLeft;
    const takerDerived = deriveDelta(wantDelta, takerIsLeft);
    if (filledWant > takerDerived.outCapacity) {
      return { success: false, error: `Taker insufficient capacity: needs ${filledWant}, has ${takerDerived.outCapacity}`, events };
    }
  }

  // 6. Update deltas atomically if filling (at LIMIT PRICE)
  if (filledGive > 0n) {
    // CANONICAL Delta semantics:
    // - Left pays → offdelta DECREASES
    // - Right pays → offdelta INCREASES

    if (offer.makerIsLeft) {
      giveDelta.offdelta -= filledGive;
      wantDelta.offdelta += filledWant;
    } else {
      giveDelta.offdelta += filledGive;
      wantDelta.offdelta -= filledWant;
    }

    events.push(`💱 Swap filled: ${filledGive} token${offer.giveTokenId} for ${filledWant} token${offer.wantTokenId}`);
  }

  // 6b. Apply rebate (price improvement refund to maker/offer-creator)
  // Hub matched at better prices, returns portion of spread to maker
  if (hasRebate) {
    let rebateDelta = accountMachine.deltas.get(rebateTokenId!);
    if (!rebateDelta) {
      rebateDelta = createDefaultDelta(rebateTokenId!);
      accountMachine.deltas.set(rebateTokenId!, rebateDelta);
    }
    rebateDelta.leftHold ??= 0n;
    rebateDelta.rightHold ??= 0n;

    // Rebate = hub pays maker. Hub is counterparty (opposite of makerIsLeft).
    if (offer.makerIsLeft) {
      // Hub (right) pays maker (left) → offdelta INCREASES
      rebateDelta.offdelta += rebateAmount!;
    } else {
      // Hub (left) pays maker (right) → offdelta DECREASES
      rebateDelta.offdelta -= rebateAmount!;
    }

    // Track cumulative rebates
    if (!accountMachine.totalRebates) {
      accountMachine.totalRebates = new Map();
    }
    const prevRebate = accountMachine.totalRebates.get(rebateTokenId!) ?? 0n;
    accountMachine.totalRebates.set(rebateTokenId!, prevRebate + rebateAmount!);

    events.push(`💰 Rebate: ${rebateAmount} token${rebateTokenId} (price improvement)`);
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
  const makerId = offer.makerIsLeft ? accountMachine.leftEntity : accountMachine.rightEntity;
  let swapOfferCancelled: { offerId: string; accountId: string } | undefined;

  if (cancelRemainder || fillRatio === MAX_FILL_RATIO) {
    // Cancel or fully filled - remove offer and notify orderbook
    const remainingHold = effectiveGive - filledGive;
    if (remainingHold > 0n) {
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
