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

  // 2. Validate amounts
  if (giveAmount <= 0n) {
    return { success: false, error: `Invalid giveAmount: ${giveAmount}`, events };
  }
  if (wantAmount <= 0n) {
    return { success: false, error: `Invalid wantAmount: ${wantAmount}`, events };
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

  // 6. Create offer
  const offer: SwapOffer = {
    offerId,
    giveTokenId,
    giveAmount,
    wantTokenId,
    wantAmount,
    minFillRatio,
    makerIsLeft,
    createdHeight: currentHeight,
  };

  // 7. Lock capacity (CRITICAL PER CODEX: Apply during BOTH validation and commit!)
  // Holds ARE consensus-critical - included in fullDeltaStates hash
  // Must be in BOTH validation (for hash) and commit (for real state) to match
  if (makerIsLeft) {
    delta.leftSwapHold += giveAmount;
  } else {
    delta.rightSwapHold += giveAmount;
  }

  // 8. Store offer (only during commit - metadata, not in state hash)
  if (!isValidation) {
    accountMachine.swapOffers.set(offerId, offer);
    console.log(`📊 COMMIT: Swap offer stored (holds already applied in validation)`);
  } else {
    console.log(`⏭️ VALIDATION: Holds applied, swapOffers storage deferred`);
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
