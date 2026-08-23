import { describe, expect, test } from 'bun:test';

import { createDefaultDelta } from '../../../account/state/delta';
import { applyAccountTxToMutableReplica } from '../../../account/tx/apply';
import {
  exactFillRatioToUint16,
} from '../../../orderbook/swap-execution';
import {
  getStaticSwapTokenDimensions,
  SWAP_LOT_SCALE,
} from '../../../orderbook/types';
import type { AccountOutput, AccountReplica, AccountSwapOfferSnapshot } from '../../../types/account';
import { makeAccount } from '../../helpers/cross-j';

type SameJurisdictionSwapOutput = Extract<
  AccountOutput,
  { kind: 'swapOfferUpsert' | 'swapOfferRemove' | 'swapCancelRequest' }
>;

const sameJurisdictionSwapOutputs = (
  outputs: readonly AccountOutput[] | undefined,
): SameJurisdictionSwapOutput[] =>
  (outputs ?? []).filter((output): output is SameJurisdictionSwapOutput =>
    output.kind === 'swapOfferUpsert' ||
    output.kind === 'swapOfferRemove' ||
    output.kind === 'swapCancelRequest');

const expectedSnapshot = (
  account: AccountReplica,
  offerId: string,
): AccountSwapOfferSnapshot => {
  const offer = account.state.swapOffers.get(offerId);
  if (!offer) throw new Error(`TEST_SWAP_OFFER_MISSING:${offerId}`);
  return {
    offerId: offer.offerId,
    leftEntity: account.state.leftEntity,
    rightEntity: account.state.rightEntity,
    giveTokenId: offer.giveTokenId,
    giveTokenDecimals: offer.giveTokenDecimals,
    giveAmount: offer.giveAmount,
    wantTokenId: offer.wantTokenId,
    wantTokenDecimals: offer.wantTokenDecimals,
    wantAmount: offer.wantAmount,
    maxFee: offer.maxFee,
    minNetReceive: offer.minNetReceive,
    priceTicks: offer.priceTicks,
    ...(offer.timeInForce !== undefined ? { timeInForce: offer.timeInForce } : {}),
    makerIsLeft: offer.makerIsLeft,
    createdHeight: offer.createdHeight,
    quantizedGive: offer.quantizedGive,
    quantizedWant: offer.quantizedWant,
  };
};

describe('same-j Account outputs', () => {
  test('emits ordered committed snapshots for upsert, cancel request, remainder, and removal', async () => {
    const account = makeAccount('alice', 'hub');
    const wantDelta = createDefaultDelta(2);
    wantDelta.leftCreditLimit = wantDelta.rightCreditLimit = 10n ** 30n;
    account.state.deltas = account.state.deltas.updated(2, wantDelta);
    const offerId = 'same-j-output-order';
    const amount = 2n * SWAP_LOT_SCALE;
    const outputs: SameJurisdictionSwapOutput[] = [];

    const created = await applyAccountTxToMutableReplica(account, {
      type: 'swap_offer',
      data: {
        offerId,
        giveTokenId: 1,
        ...getStaticSwapTokenDimensions(1, 2),
        giveAmount: amount,
        wantTokenId: 2,
        wantAmount: amount,
        maxFee: 200n,
        minNetReceive: amount - 200n,
        timeInForce: 0,
      },
    }, true, 1_000, 7);
    expect(created.ok).toBe(true);
    outputs.push(...sameJurisdictionSwapOutputs(created.candidateEffects));
    expect(outputs[0]).toEqual({
      kind: 'swapOfferUpsert',
      offer: expectedSnapshot(account, offerId),
    });
    const originalSnapshot = outputs[0]?.kind === 'swapOfferUpsert'
      ? outputs[0].offer
      : undefined;

    const cancelRequested = await applyAccountTxToMutableReplica(account, {
      type: 'swap_cancel_request',
      data: { offerId },
    }, true, 2_000, 8);
    expect(cancelRequested.ok).toBe(true);
    outputs.push(...sameJurisdictionSwapOutputs(cancelRequested.candidateEffects));

    const half = SWAP_LOT_SCALE;
    const partiallyResolved = await applyAccountTxToMutableReplica(account, {
      type: 'swap_resolve',
      data: {
        offerId,
        fillRatio: exactFillRatioToUint16({ numerator: 1n, denominator: 2n }),
        fillNumerator: 1n,
        fillDenominator: 2n,
        cancelRemainder: false,
        executionGiveAmount: half,
        executionWantAmount: half,
        feeTokenId: 2,
        feeAmount: 100n,
      },
    }, false, 3_000, 9);
    expect(partiallyResolved.ok).toBe(true);
    outputs.push(...sameJurisdictionSwapOutputs(partiallyResolved.candidateEffects));
    expect(outputs[2]).toEqual({
      kind: 'swapOfferUpsert',
      offer: expectedSnapshot(account, offerId),
    });
    expect(originalSnapshot?.giveAmount).toBe(amount);
    expect(account.state.swapOffers.get(offerId)?.giveAmount).toBe(half);

    const removed = await applyAccountTxToMutableReplica(account, {
      type: 'swap_resolve',
      data: { offerId, fillRatio: 0, cancelRemainder: true },
    }, false, 4_000, 10);
    expect(removed.ok).toBe(true);
    outputs.push(...sameJurisdictionSwapOutputs(removed.candidateEffects));

    expect(outputs.map(output => output.kind)).toEqual([
      'swapOfferUpsert',
      'swapCancelRequest',
      'swapOfferUpsert',
      'swapOfferRemove',
    ]);
    expect(outputs[1]).toEqual({ kind: 'swapCancelRequest', offerId });
    expect(outputs[3]).toEqual({ kind: 'swapOfferRemove', offerId });
    expect(account.state.swapOffers.has(offerId)).toBe(false);
  });
});
