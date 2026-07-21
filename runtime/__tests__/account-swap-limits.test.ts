import { describe, expect, test } from 'bun:test';

import { LIMITS } from '../constants';
import {
  accountSwapMarketKey,
  getAccountSwapMarketLimitError,
  getAccountSwapMarketOfferCount,
} from '../account/swap-limits';
import type { SwapOffer } from '../types';
import { handleSwapOffer } from '../account/tx/handlers/swap-offer';

const offer = (
  offerId: string,
  makerIsLeft: boolean,
  giveTokenId = 1,
  wantTokenId = 2,
): SwapOffer => ({
  offerId,
  giveTokenId,
  giveAmount: 1n,
  wantTokenId,
  wantAmount: 1n,
  minFillRatio: 0,
  makerIsLeft,
  createdHeight: 1,
});

describe('account economic swap limits', () => {
  test('counts one directed market independently for each bilateral side', () => {
    const limit = LIMITS.MAX_ACCOUNT_SWAP_OFFERS_PER_SIDE_PER_MARKET;
    const offers = [
      ...Array.from({ length: limit }, (_, index) => offer(`left-${index}`, true)),
      ...Array.from({ length: limit }, (_, index) => offer(`right-${index}`, false)),
      ...Array.from({ length: limit }, (_, index) => offer(`reverse-${index}`, true, 2, 1)),
    ];

    expect(getAccountSwapMarketOfferCount(offers, offer('candidate', true))).toBe(limit);
    expect(getAccountSwapMarketLimitError(offers, offer('candidate', true))).toContain(`max ${limit}`);
    expect(getAccountSwapMarketLimitError(offers, offer('other-market', true, 1, 3))).toBeUndefined();
  });

  test('uses stable directed same-j market keys', () => {
    expect(accountSwapMarketKey(offer('ask', true, 1, 2))).toBe('same:1>2');
    expect(accountSwapMarketKey(offer('bid', true, 2, 1))).toBe('same:2>1');
  });

  test('rejects the eleventh live offer before mutating Account state', async () => {
    const limit = LIMITS.MAX_ACCOUNT_SWAP_OFFERS_PER_SIDE_PER_MARKET;
    const swapOffers = new Map(
      Array.from({ length: limit }, (_, index) => {
        const current = offer(`left-${index}`, true);
        return [current.offerId, current] as const;
      }),
    );
    const account = {
      leftEntity: 'left',
      rightEntity: 'right',
      deltas: new Map(),
      swapOffers,
    };

    const result = await handleSwapOffer(account as Parameters<typeof handleSwapOffer>[0], {
      type: 'swap_offer',
      data: {
        offerId: 'eleventh',
        giveTokenId: 1,
        giveAmount: 1n,
        wantTokenId: 2,
        wantAmount: 1n,
        minFillRatio: 0,
      },
    }, true, 2);

    expect(result.success).toBe(false);
    expect(result.error).toContain(`max ${limit}`);
    expect(swapOffers.has('eleventh')).toBe(false);
    expect(swapOffers.size).toBe(limit);
  });
});
