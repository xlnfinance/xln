import type { AccountState } from '../../../types';
import { deriveDelta } from '../../utils';
import { createDefaultDelta } from '../../delta';
import { deriveSwapOffdeltaChanges } from '../../../orderbook/swap-execution';
import { getHold, releaseHold } from '../hold-utils';
import { ensureDelta } from '../delta-utils';
import { deriveTransferOffdeltaChange } from '../../../protocol/delta-movement';
import type {
  AppliedSwapResolve,
  SwapResolveFailure,
  ValidatedSwapResolve,
} from './swap-resolve-types';

const failure = (events: string[], error: string): SwapResolveFailure => ({
  success: false,
  error,
  events,
});

const validateCounterpartyCapacity = (
  account: AccountState,
  resolve: ValidatedSwapResolve,
  events: string[],
): SwapResolveFailure | null => {
  if (resolve.filledWant <= 0n) return null;
  const tokenId = resolve.offer.wantTokenId;
  const delta = account.deltas.get(tokenId) ?? createDefaultDelta(tokenId);
  const capacity = deriveDelta(delta, !resolve.offer.makerIsLeft).outCapacity;
  return resolve.filledWant > capacity
    ? failure(
        events,
        `Counterparty insufficient capacity on token ${tokenId}: ` +
        `needs ${resolve.filledWant}, has ${capacity}`,
      )
    : null;
};

export const applySwapResolveFinancials = (
  account: AccountState,
  resolve: ValidatedSwapResolve,
  events: string[],
): AppliedSwapResolve | SwapResolveFailure => {
  const giveDelta = ensureDelta(account, resolve.offer.giveTokenId);
  const wantDelta = ensureDelta(account, resolve.offer.wantTokenId);
  const capacityFailure = validateCounterpartyCapacity(account, resolve, events);
  if (capacityFailure) return capacityFailure;

  const makerHoldSide = resolve.offer.makerIsLeft ? 'left' : 'right';
  const currentMakerHold = getHold(giveDelta, makerHoldSide);
  if (currentMakerHold < resolve.canonicalQuantizedGive) {
    return failure(
      events,
      `Hold underflow: current=${currentMakerHold} ` +
      `< required=${resolve.canonicalQuantizedGive}`,
    );
  }
  if (resolve.filledGive > 0n) {
    const change = deriveSwapOffdeltaChanges(
      resolve.offer.makerIsLeft,
      resolve.filledGive,
      resolve.filledWant,
    );
    giveDelta.offdelta += change.give;
    wantDelta.offdelta += change.want;
    events.push(
      `💱 Swap filled: ${resolve.filledGive} token${resolve.offer.giveTokenId} ` +
      `for ${resolve.filledWant} token${resolve.offer.wantTokenId}`,
    );
  }
  if (resolve.feeAmount > 0n) {
    wantDelta.offdelta += deriveTransferOffdeltaChange(
      resolve.offer.makerIsLeft,
      resolve.feeAmount,
    );
    events.push(`💸 Swap taker fee: ${resolve.feeAmount} token${resolve.effectiveFeeTokenId}`);
  }
  const releaseError = releaseHold(
    giveDelta,
    makerHoldSide,
    resolve.filledGive,
    (currentHold, releaseAmount) =>
      `Hold underflow: current=${currentHold} < required=${releaseAmount}`,
  );
  if (releaseError) return failure(events, releaseError);
  return { ...resolve, giveDelta, wantDelta, makerHoldSide };
};
