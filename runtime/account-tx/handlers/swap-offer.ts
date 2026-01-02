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

  // 3. Determine maker perspective
  const { fromEntity, toEntity } = accountMachine.proofHeader;
  const weAreLeft = isLeft(fromEntity, toEntity);

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

  // CRITICAL: Only update swapOffers during COMMIT, not VALIDATION
  // During validation (on clonedMachine), skip offer storage to avoid data loss
  // Validation clone is discarded - offers must only be created during commit on real accountMachine
  if (!isValidation) {
    accountMachine.swapOffers.set(offerId, offer);
    console.log(`📊 COMMIT: Swap offer created, offerId=${offerId.slice(0,8)}`);

    // 7. Lock capacity
    if (makerIsLeft) {
      delta.leftSwapHold += giveAmount;
    } else {
      delta.rightSwapHold += giveAmount;
    }
  } else {
    console.log(`⏭️ VALIDATION: Skipping swapOffers update (will commit later)`);
  }

  const makerId = makerIsLeft ? fromEntity : toEntity;

  // CRITICAL: For Hub's orderbook, accountId = counterparty ID (the key Hub uses)
  // Since this runs on BOTH entities' accounts, we need generic logic:
  // accountId should always be the maker's entity ID (the one creating the offer)
  // Hub will use this to look up accounts.get(makerId)
  const accountId = makerId;

  events.push(`📊 Swap offer created: ${offerId.slice(0,8)}... give ${giveAmount} token${giveTokenId} for ${wantAmount} token${wantTokenId}`);
  console.log(`📊 SWAP-OFFER: from=${formatEntityId(fromEntity)}, to=${formatEntityId(toEntity)}, makerIsLeft=${makerIsLeft}, maker=${formatEntityId(makerId)}`);
  console.log(`📊 SWAP-OFFER: Computed accountId=${accountId.slice(-8)} (Hub's Map key for this account)`);

  // Return swap offer event for orderbook integration (hub processes these)
  return {
    success: true,
    events,
    swapOfferCreated: {
      offerId,
      makerId,
      accountId, // Hub's Map key = non-Hub entity's ID
      giveTokenId,
      giveAmount,
      wantTokenId,
      wantAmount,
      minFillRatio,
    },
  };
}
