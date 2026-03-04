/**
 * Swap Offer Handler
 * User creates limit order, locks capacity
 *
 * Flow:
 * 1. Validate offerId uniqueness
 * 2. Validate amounts > 0
 * 3. Check capacity (including existing holds)
 * 4. Lock capacity via leftHold or rightHold
 * 5. Store in swapOffers Map
 */

import type { AccountMachine, AccountTx, SwapOffer } from '../../types';
import { deriveDelta, getSwapPairPolicyByBaseQuote } from '../../account-utils';
import { createDefaultDelta } from '../../validation-utils';
import { formatEntityId } from '../../utils';
import { canonicalAccountKey } from '../../state-helpers';
import { computeSwapPriceTicks, deriveSide, ORDERBOOK_PRICE_SCALE } from '../../orderbook';
import { FINANCIAL } from '../../constants';

export async function handleSwapOffer(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'swap_offer' }>,
  byLeft: boolean,
  currentHeight: number,
  isValidation: boolean = false
): Promise<{ success: boolean; events: string[]; error?: string; swapOfferCreated?: { offerId: string; makerIsLeft: boolean; fromEntity: string; toEntity: string; giveTokenId: number; giveAmount: bigint; wantTokenId: number; wantAmount: bigint; minFillRatio: number } }> {
  const { offerId, giveTokenId, giveAmount, wantTokenId, wantAmount, priceTicks: inputPriceTicks, minFillRatio } = accountTx.data;
  const events: string[] = [];
  const LOT_SCALE = 10n ** 12n;

  // Initialize swapOffers Map if not present
  if (!accountMachine.swapOffers) {
    accountMachine.swapOffers = new Map();
  }

  // 1. Validate offerId format and uniqueness
  // offerId must not contain colons - they're used as delimiters in namespaced IDs
  if (offerId.includes(':')) {
    return { success: false, error: `Invalid offerId: colons not allowed (got ${offerId})`, events };
  }
  if (accountMachine.swapOffers.has(offerId)) {
    return { success: false, error: `Offer ${offerId} already exists`, events };
  }

  // 2. Validate amounts (network-wide bounds)
  if (giveAmount < FINANCIAL.MIN_PAYMENT_AMOUNT || giveAmount > FINANCIAL.MAX_PAYMENT_AMOUNT) {
    return {
      success: false,
      error: `Invalid giveAmount: ${giveAmount} (min ${FINANCIAL.MIN_PAYMENT_AMOUNT}, max ${FINANCIAL.MAX_PAYMENT_AMOUNT})`,
      events,
    };
  }
  if (wantAmount < FINANCIAL.MIN_PAYMENT_AMOUNT || wantAmount > FINANCIAL.MAX_PAYMENT_AMOUNT) {
    return {
      success: false,
      error: `Invalid wantAmount: ${wantAmount} (min ${FINANCIAL.MIN_PAYMENT_AMOUNT}, max ${FINANCIAL.MAX_PAYMENT_AMOUNT})`,
      events,
    };
  }
  if (giveTokenId === wantTokenId) {
    return { success: false, error: `Cannot swap same token: ${giveTokenId}`, events };
  }
  if (minFillRatio < 0 || minFillRatio > 65535) {
    return { success: false, error: `Invalid minFillRatio: ${minFillRatio}`, events };
  }

  // 3. Determine maker perspective (Channel.ts: byLeft = frame proposer = maker)
  const { leftEntity, rightEntity } = accountMachine;
  const makerIsLeft = byLeft;

  // 4. Quantize order to orderbook lot granularity at source.
  // This keeps account holds, swap state, and orderbook matching deterministic.
  const side = deriveSide(giveTokenId, wantTokenId);
  const rawBaseAmount = side === 1 ? giveAmount : wantAmount;
  const rawQuoteAmount = side === 1 ? wantAmount : giveAmount;
  const baseTokenId = side === 1 ? giveTokenId : wantTokenId;
  const quoteTokenId = side === 1 ? wantTokenId : giveTokenId;
  if (rawBaseAmount < LOT_SCALE) {
    return { success: false, error: `Order too small for lot size (${LOT_SCALE.toString()} base wei)`, events };
  }
  const pairPolicy = getSwapPairPolicyByBaseQuote(baseTokenId, quoteTokenId);
  const stepTicks = BigInt(Math.max(1, pairPolicy.priceStepTicks));
  const priceTicks = computeSwapPriceTicks(giveTokenId, wantTokenId, giveAmount, wantAmount);
  if (priceTicks <= 0n) {
    return { success: false, error: `Invalid price ratio for swap offer`, events };
  }
  if (inputPriceTicks !== undefined) {
    if (inputPriceTicks <= 0n) {
      return { success: false, error: `Invalid explicit priceTicks: ${inputPriceTicks}`, events };
    }
    // Explicit price must already be step-aligned to keep signer intent exact.
    const alignedInput = (inputPriceTicks / stepTicks) * stepTicks;
    if (alignedInput !== inputPriceTicks) {
      return {
        success: false,
        error: `Explicit priceTicks must align to step ${stepTicks.toString()} (got ${inputPriceTicks.toString()})`,
        events,
      };
    }
    if (inputPriceTicks !== priceTicks) {
      return {
        success: false,
        error: `Price mismatch after deterministic quantization: expected ${priceTicks.toString()}, got ${inputPriceTicks.toString()}`,
        events,
      };
    }
  }
  const quantizedBase = (rawBaseAmount / LOT_SCALE) * LOT_SCALE;
  if (quantizedBase <= 0n) {
    return { success: false, error: `Quantized base amount became zero`, events };
  }
  const quantizedQuote = (quantizedBase * priceTicks) / ORDERBOOK_PRICE_SCALE;
  if (quantizedQuote <= 0n) {
    return { success: false, error: `Quantized quote amount became zero`, events };
  }
  const effectiveGiveAmount = side === 1 ? quantizedBase : quantizedQuote;
  const effectiveWantAmount = side === 1 ? quantizedQuote : quantizedBase;
  if (effectiveGiveAmount < FINANCIAL.MIN_PAYMENT_AMOUNT || effectiveGiveAmount > FINANCIAL.MAX_PAYMENT_AMOUNT) {
    return {
      success: false,
      error: `Quantized giveAmount out of bounds: ${effectiveGiveAmount} (min ${FINANCIAL.MIN_PAYMENT_AMOUNT}, max ${FINANCIAL.MAX_PAYMENT_AMOUNT})`,
      events,
    };
  }
  if (effectiveWantAmount < FINANCIAL.MIN_PAYMENT_AMOUNT || effectiveWantAmount > FINANCIAL.MAX_PAYMENT_AMOUNT) {
    return {
      success: false,
      error: `Quantized wantAmount out of bounds: ${effectiveWantAmount} (min ${FINANCIAL.MIN_PAYMENT_AMOUNT}, max ${FINANCIAL.MAX_PAYMENT_AMOUNT})`,
      events,
    };
  }

  // 5. Get or create delta for giveToken (the token being locked)
  let delta = accountMachine.deltas.get(giveTokenId);
  if (!delta) {
    delta = createDefaultDelta(giveTokenId);
    accountMachine.deltas.set(giveTokenId, delta);
  }

  // Initialize holds if not present
  delta.leftHold ??= 0n;
  delta.rightHold ??= 0n;

  // 6. Check capacity (deriveDelta should account for all holds)
  const derived = deriveDelta(delta, makerIsLeft);
  if (effectiveGiveAmount > derived.outCapacity) {
    return {
      success: false,
      error: `Insufficient capacity: need ${effectiveGiveAmount}, available ${derived.outCapacity}`,
      events,
    };
  }

  // 7. Create offer (stored amounts are already quantized for deterministic matching)
  const offer: SwapOffer = {
    offerId,
    giveTokenId,
    giveAmount: effectiveGiveAmount,
    wantTokenId,
    wantAmount: effectiveWantAmount,
    minFillRatio,
    makerIsLeft,
    createdHeight: currentHeight,
    quantizedGive: effectiveGiveAmount,
    quantizedWant: effectiveWantAmount,
  };

  // 8. Lock capacity (CRITICAL PER CODEX: Apply during BOTH validation and commit!)
  // Holds ARE consensus-critical - included in fullDeltaStates hash
  // Must be in BOTH validation (for hash) and commit (for real state) to match
  if (makerIsLeft) {
    delta.leftHold += effectiveGiveAmount;
  } else {
    delta.rightHold += effectiveGiveAmount;
  }

  // 9. Store offer (proofBody includes swapOffers, so keep validation+commit aligned)
  accountMachine.swapOffers.set(offerId, offer);
  if (isValidation) {
    console.log(`📊 VALIDATION: Swap offer stored (for dispute proof)`);
  } else {
    console.log(`📊 COMMIT: Swap offer stored`);
  }

  events.push(`📊 Swap offer created: ${offerId.slice(0,8)}... give ${effectiveGiveAmount} token${giveTokenId} for ${effectiveWantAmount} token${wantTokenId}`);

  // Return event with canonical entities for deterministic attribution
  return {
    success: true,
    events,
    swapOfferCreated: {
      offerId,
      makerIsLeft,
      fromEntity: leftEntity,   // Canonical entities (same on both sides)
      toEntity: rightEntity,
      giveTokenId,
      giveAmount: effectiveGiveAmount,
      wantTokenId,
      wantAmount: effectiveWantAmount,
      minFillRatio,
    },
  };
}
