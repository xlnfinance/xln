/**
 * Swap Resolve Handler
 * Hub (counterparty) fills and/or cancels user's offer
 *
 * Settlement:
 * - non-zero fills MUST carry exact execution amounts from matcher/manual caller
 * - better prices are represented directly in those execution amounts
 * - cancel-only path is still fillRatio=0 with no execution amounts
 *
 * Flow:
 * 1. Find offer by offerId
 * 2. Validate caller is NOT the maker (is the counterparty/hub)
 * 3. Validate fillRatio >= offer.minFillRatio (unless cancelling all)
 * 4. Validate exact execution amounts for fills
 * 5. Update deltas atomically (both tokens)
 * 6. Release proportional hold
 * 7. If cancelRemainder: remove offer; else: update remaining amount
 *
 * Delta rules (same as HTLC):
 * - Left gives -> offdelta decreases (negative)
 * - Right gives -> offdelta increases (positive)
 */

import type { AccountMachine, AccountTx } from '../../types';
import { deriveDelta } from '../../account-utils';
import { createDefaultDelta } from '../../validation-utils';
import { FINANCIAL } from '../../constants';
import { deriveCanonicalSwapFillRatio, MAX_SWAP_FILL_RATIO } from '../../swap-execution';
import {
  requantizeRemainingSwapAtPrice,
  SWAP_LOT_SCALE,
} from '../../orderbook/types';

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
    executionGiveAmount,
    executionWantAmount,
    restingPriceTicks,
    restingGiveAmount,
    restingWantAmount,
    restingQuantizedGive,
    restingQuantizedWant,
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

  const canonicalGiveAmount = restingGiveAmount ?? offer.giveAmount;
  const canonicalWantAmount = restingWantAmount ?? offer.wantAmount;
  const canonicalQuantizedGive = restingQuantizedGive ?? offer.quantizedGive ?? canonicalGiveAmount;
  const canonicalQuantizedWant = restingQuantizedWant ?? offer.quantizedWant ?? canonicalWantAmount;
  const canonicalPriceTicks = restingPriceTicks ?? offer.priceTicks;

  if (canonicalGiveAmount <= 0n || canonicalWantAmount <= 0n) {
    return { success: false, error: `Canonical resting offer amounts must be positive`, events };
  }
  if (canonicalQuantizedGive <= 0n || canonicalQuantizedWant <= 0n) {
    return { success: false, error: `Canonical resting quantized amounts must be positive`, events };
  }
  if (canonicalQuantizedGive > canonicalGiveAmount || canonicalQuantizedWant > canonicalWantAmount) {
    return { success: false, error: `Canonical resting quantized amounts exceed offer amounts`, events };
  }

  // 2. Validate caller is the counterparty (Channel.ts: byLeft = frame proposer = caller)
  const callerIsLeft = byLeft;

  // Caller must be opposite of maker
  if (callerIsLeft === offer.makerIsLeft) {
    return { success: false, error: `Only counterparty can resolve swap`, events };
  }

  // 3. Validate fillRatio
  if (fillRatio < 0 || fillRatio > MAX_SWAP_FILL_RATIO) {
    return { success: false, error: `Invalid fillRatio: ${fillRatio}`, events };
  }

  // 4. Calculate fill amounts
  const effectiveGive = canonicalQuantizedGive;
  const effectiveWant = canonicalQuantizedWant;
  const executionProvided = executionGiveAmount !== undefined || executionWantAmount !== undefined;
  if (executionProvided && (executionGiveAmount === undefined || executionWantAmount === undefined)) {
    return {
      success: false,
      error: `executionGiveAmount and executionWantAmount must both be provided`,
      events,
    };
  }
  if (fillRatio > 0 && !executionProvided) {
    return {
      success: false,
      error: `executionGiveAmount and executionWantAmount required for non-zero fills`,
      events,
    };
  }

  const limitFilledGive = (effectiveGive * BigInt(fillRatio)) / BigInt(MAX_SWAP_FILL_RATIO);
  const limitFilledWant = effectiveGive > 0n
    ? (limitFilledGive * effectiveWant + effectiveGive - 1n) / effectiveGive
    : 0n;

  const filledGive = executionProvided ? executionGiveAmount! : limitFilledGive;
  const filledWant = executionProvided ? executionWantAmount! : limitFilledWant;
  const canonicalFillRatio = executionProvided
    ? deriveCanonicalSwapFillRatio(effectiveGive, filledGive)
    : fillRatio;

  if (executionProvided) {
    const hasExecutionFill = filledGive > 0n || filledWant > 0n;
    if (hasExecutionFill && (filledGive <= 0n || filledWant <= 0n)) {
      return {
        success: false,
        error: `Execution amounts must both be positive for a fill`,
        events,
      };
    }
    if (fillRatio !== canonicalFillRatio) {
      return {
        success: false,
        error: `fillRatio ${fillRatio} does not match canonical execution ratio ${canonicalFillRatio}`,
        events,
      };
    }
  }

  // For explicit execution amounts, ensure they match the offer's absolute limits.
  if (executionProvided && (filledGive > 0n || filledWant > 0n)) {
    if (filledGive > effectiveGive) {
      return {
        success: false,
        error: `Execution give amount ${filledGive} exceeds offer limit ${effectiveGive}`,
        events,
      };
    }
    if (filledWant * effectiveGive < filledGive * effectiveWant) {
      const limitLhs = filledWant * effectiveGive;
      const limitRhs = filledGive * effectiveWant;
      console.error('❌ SWAP-RESOLVE MAKER LIMIT VIOLATION', {
        offerId,
        byLeft,
        makerIsLeft: offer.makerIsLeft,
        giveTokenId: offer.giveTokenId,
        wantTokenId: offer.wantTokenId,
        effectiveGive: effectiveGive.toString(),
        effectiveWant: effectiveWant.toString(),
        filledGive: filledGive.toString(),
        filledWant: filledWant.toString(),
        fillRatio,
        canonicalFillRatio,
        limitLhs: limitLhs.toString(),
        limitRhs: limitRhs.toString(),
      });
      return {
        success: false,
        error:
          `Execution violates maker limit price: ` +
          `offer=${offerId} makerIsLeft=${offer.makerIsLeft} ` +
          `effectiveGive=${effectiveGive} effectiveWant=${effectiveWant} ` +
          `filledGive=${filledGive} filledWant=${filledWant} ` +
          `lhs=${limitLhs} rhs=${limitRhs}`,
        events,
      };
    }
  }

  if (canonicalFillRatio > 0 && canonicalFillRatio < offer.minFillRatio) {
    return {
      success: false,
      error: `Fill ratio ${canonicalFillRatio} below minimum ${offer.minFillRatio}`,
      events,
    };
  }

  if (canonicalFillRatio > 0) {
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

  // 5b. Check counterparty capacity for the full outgoing bundle.
  // swap_resolve is proposed by the counterparty/hub, so they must be able to fund:
  // - the canonical fill on offer.wantTokenId
  const counterpartyIsLeft = !offer.makerIsLeft;
  const counterpartyOutgoing = new Map<number, bigint>();
  if (filledWant > 0n) {
    counterpartyOutgoing.set(offer.wantTokenId, filledWant);
  }
  for (const [tokenId, requiredAmount] of counterpartyOutgoing) {
    if (requiredAmount <= 0n) continue;
    const deltaForCapacity =
      tokenId === offer.wantTokenId
        ? wantDelta
        : tokenId === offer.giveTokenId
          ? giveDelta
          : createDefaultDelta(tokenId);
    const counterpartyDerived = deriveDelta(deltaForCapacity, counterpartyIsLeft);
    if (requiredAmount > counterpartyDerived.outCapacity) {
      return {
        success: false,
        error: `Counterparty insufficient capacity on token ${tokenId}: needs ${requiredAmount}, has ${counterpartyDerived.outCapacity}`,
        events,
      };
    }
  }

  const currentMakerHold = offer.makerIsLeft
    ? (giveDelta.leftHold || 0n)
    : (giveDelta.rightHold || 0n);
  if (currentMakerHold < effectiveGive) {
    return {
      success: false,
      error: `Hold underflow: current=${currentMakerHold} < required=${effectiveGive}`,
      events,
    };
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

  // 6. Release hold proportionally
  const holdRelease = filledGive;
  if (offer.makerIsLeft) {
    const currentHold = giveDelta.leftHold || 0n;
    giveDelta.leftHold = currentHold - holdRelease;
  } else {
    const currentHold = giveDelta.rightHold || 0n;
    giveDelta.rightHold = currentHold - holdRelease;
  }

  // 7. Handle remainder
  const makerId = offer.makerIsLeft ? accountMachine.leftEntity : accountMachine.rightEntity;
  let swapOfferCancelled: { offerId: string; accountId: string } | undefined;

  if (cancelRemainder || canonicalFillRatio === MAX_SWAP_FILL_RATIO) {
    // Cancel or fully filled - remove offer and notify orderbook
    const remainingHold = effectiveGive - filledGive;
    if (remainingHold > 0n) {
      if (offer.makerIsLeft) {
        const currentHold = giveDelta.leftHold || 0n;
        giveDelta.leftHold = currentHold - remainingHold;
      } else {
        const currentHold = giveDelta.rightHold || 0n;
        giveDelta.rightHold = currentHold - remainingHold;
      }
    }
    accountMachine.swapOffers.delete(offerId);
    swapOfferCancelled = { offerId, accountId: makerId };
    events.push(`📊 Swap offer ${offerId.slice(0,8)}... ${canonicalFillRatio === MAX_SWAP_FILL_RATIO ? 'fully filled' : 'cancelled'}`);
  } else {
    // Partial fill - requantize remainder so subsequent fills stay lot-aligned.
    const remainingGiveRaw = effectiveGive - filledGive;
    const offerPriceTicks = canonicalPriceTicks ?? computeSwapPriceTicks(
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
          giveDelta.leftHold = currentHold - remainingGiveRaw;
        } else {
          const currentHold = giveDelta.rightHold || 0n;
          giveDelta.rightHold = currentHold - remainingGiveRaw;
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
          giveDelta.leftHold = currentHold - releasedGiveDust;
        } else {
          const currentHold = giveDelta.rightHold || 0n;
          giveDelta.rightHold = currentHold - releasedGiveDust;
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
