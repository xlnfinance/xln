/**
 * Swap Offer Handler
 * User creates limit order, locks capacity
 *
 * Flow:
 * 1. Validate offerId uniqueness
 * 2. Validate amounts > 0
 * 3. Check capacity (including existing holds)
 * 4. Lock capacity via leftSwapHold or rightSwapHold
 * 5. Store in swapOffers Map
 */

import { AccountMachine, AccountTx, SwapOffer } from '../../types';
import { deriveDelta, isLeft } from '../../account-utils';
import { createDefaultDelta } from '../../validation-utils';
import { formatEntityId } from '../../utils';
import { canonicalAccountKey } from '../../state-helpers';
import { deriveSide } from '../../orderbook';
import { FINANCIAL } from '../../constants';

export async function handleSwapOffer(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'swap_offer' }>,
  isOurFrame: boolean,
  currentHeight: number,
  isValidation: boolean = false
): Promise<{ success: boolean; events: string[]; error?: string }> {
  const { offerId, giveTokenId, giveAmount, wantTokenId, wantAmount, minFillRatio } = accountTx.data;
  const events: string[] = [];

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

  // 3. Determine maker perspective using CANONICAL entities
  // CRITICAL: Use leftEntity/rightEntity (canonical, same on both sides)
  // NOT fromEntity/toEntity (perspective-dependent, can flip!)
  const { leftEntity, rightEntity } = accountMachine;
  const weAreLeft = accountMachine.proofHeader.fromEntity === leftEntity;

  // Maker is whoever created this frame (isOurFrame means WE created it)
  // If isOurFrame=true: we are the maker
  // If isOurFrame=false: counterparty is the maker
  const makerIsLeft = isOurFrame ? weAreLeft : !weAreLeft;

  // 4. Get or create delta for giveToken (the token being locked)
  let delta = accountMachine.deltas.get(giveTokenId);
  if (!delta) {
    delta = createDefaultDelta(giveTokenId);
    accountMachine.deltas.set(giveTokenId, delta);
  }

  // Initialize swap holds if not present
  delta.leftSwapHold ??= 0n;
  delta.rightSwapHold ??= 0n;

  // 5. Check capacity (deriveDelta should account for all holds)
  const derived = deriveDelta(delta, makerIsLeft);
  if (giveAmount > derived.outCapacity) {
    return {
      success: false,
      error: `Insufficient capacity: need ${giveAmount}, available ${derived.outCapacity}`,
      events,
    };
  }

  // 6. Create offer (also compute quantized amounts for orderbook determinism)
  const LOT_SCALE = 10n ** 12n;
  let quantizedGive: bigint | undefined;
  let quantizedWant: bigint | undefined;
  const side = deriveSide(giveTokenId, wantTokenId);
  if (side === 1) {
    if (giveAmount % LOT_SCALE === 0n) {
      const priceTicks = (wantAmount * 100n) / giveAmount;
      if (priceTicks > 0n) {
        quantizedGive = giveAmount;
        quantizedWant = (quantizedGive * priceTicks) / 100n;
      }
    }
  } else {
    if (wantAmount % LOT_SCALE === 0n) {
      const priceTicks = (giveAmount * 100n) / wantAmount;
      if (priceTicks > 0n) {
        quantizedWant = wantAmount;
        quantizedGive = (quantizedWant * priceTicks) / 100n;
      }
    }
  }

  const offer: SwapOffer = {
    offerId,
    giveTokenId,
    giveAmount,
    wantTokenId,
    wantAmount,
    minFillRatio,
    makerIsLeft,
    createdHeight: currentHeight,
    ...(quantizedGive !== undefined ? { quantizedGive } : {}),
    ...(quantizedWant !== undefined ? { quantizedWant } : {}),
  };

  // 7. Lock capacity (CRITICAL PER CODEX: Apply during BOTH validation and commit!)
  // Holds ARE consensus-critical - included in fullDeltaStates hash
  // Must be in BOTH validation (for hash) and commit (for real state) to match
  if (makerIsLeft) {
    delta.leftSwapHold += giveAmount;
  } else {
    delta.rightSwapHold += giveAmount;
  }

  // 8. Store offer (proofBody includes swapOffers, so keep validation+commit aligned)
  accountMachine.swapOffers.set(offerId, offer);
  if (isValidation) {
    console.log(`📊 VALIDATION: Swap offer stored (for dispute proof)`);
  } else {
    console.log(`📊 COMMIT: Swap offer stored`);
  }

  events.push(`📊 Swap offer created: ${offerId.slice(0,8)}... give ${giveAmount} token${giveTokenId} for ${wantAmount} token${wantTokenId}`);

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
      giveAmount,
      wantTokenId,
      wantAmount,
      minFillRatio,
    },
  };
}
