import type { AccountState } from '../../../../../types/account';
import type { AccountDraftState } from '../../../../state/account-state-draft';
import { deriveDelta } from '../../../../utils';
import { createDefaultDelta } from '../../../../state/delta';
import { deriveSwapOffdeltaChanges } from '../../../../../swapbook/swap-execution';
import { getHold, releaseHold } from '../../../hold-utils';
import { createDeltaDraft, getOffdeltaRepresentationError } from '../../../delta-utils';
import { deriveTransferOffdeltaChange } from '../../../../../protocol/transform/delta-movement';
import { accountTxValidationRejected } from '../../../apply-result';
import type { AppliedSwapResolve, SwapResolveFailure, ValidatedSwapResolve } from './types';

const failure = (events: string[], error: string): SwapResolveFailure => accountTxValidationRejected(error, events);

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
        `Counterparty insufficient capacity on token ${tokenId}: ` + `needs ${resolve.filledWant}, has ${capacity}`,
      )
    : null;
};

export const applySwapResolveFinancials = (
  account: AccountDraftState,
  resolve: ValidatedSwapResolve,
  events: string[],
): AppliedSwapResolve | SwapResolveFailure => {
  const giveDelta = createDeltaDraft(account, resolve.offer.giveTokenId);
  const wantDelta = createDeltaDraft(account, resolve.offer.wantTokenId);
  const capacityFailure = validateCounterpartyCapacity(account, resolve, events);
  if (capacityFailure) return capacityFailure;

  const makerHoldSide = resolve.offer.makerIsLeft ? 'left' : 'right';
  const currentMakerHold = getHold(giveDelta, makerHoldSide);
  if (currentMakerHold < resolve.canonicalQuantizedGive) {
    return failure(
      events,
      `Hold underflow: current=${currentMakerHold} ` + `< required=${resolve.canonicalQuantizedGive}`,
    );
  }
  if (resolve.filledGive > 0n) {
    const change = deriveSwapOffdeltaChanges(resolve.offer.makerIsLeft, resolve.filledGive, resolve.filledWant);
    giveDelta.offdelta += change.give;
    wantDelta.offdelta += change.want;
  }
  if (resolve.feeAmount > 0n) {
    wantDelta.offdelta += deriveTransferOffdeltaChange(resolve.offer.makerIsLeft, resolve.feeAmount);
  }
  const representationError =
    getOffdeltaRepresentationError(account, giveDelta) ?? getOffdeltaRepresentationError(account, wantDelta);
  if (representationError) return failure(events, representationError);
  const releaseError = releaseHold(
    giveDelta,
    makerHoldSide,
    resolve.filledGive,
    (currentHold, releaseAmount) => `Hold underflow: current=${currentHold} < required=${releaseAmount}`,
  );
  if (releaseError) return failure(events, releaseError);
  if (resolve.filledGive > 0n)
    events.push(
      `💱 Swap filled: ${resolve.filledGive} token${resolve.offer.giveTokenId} ` +
        `for ${resolve.filledWant} token${resolve.offer.wantTokenId}`,
    );
  if (resolve.feeAmount > 0n)
    events.push(`💸 Swap taker fee: ${resolve.feeAmount} token${resolve.effectiveFeeTokenId}`);
  return { ...resolve, giveDelta, wantDelta, makerHoldSide };
};
