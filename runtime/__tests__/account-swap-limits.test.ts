import { describe, expect, test } from 'bun:test';

import { LIMITS } from '../config/constants';
import {
  accountSwapMarketKey,
  getAccountSwapMarketLimitError,
  getAccountSwapMarketOfferCount,
} from '../account/swap/swap-limits';
import type { SwapOffer } from '../types/account';
import { handleSwapOffer } from '../account/tx/handlers/swap/offer/index';
import { validateSwapOfferAdmission } from '../account/tx/handlers/swap/offer/admission';
import { makeAccount } from './helpers/cross-j';

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
  maxFee: 0n,
  minNetReceive: 1n,
  makerIsLeft,
  createdHeight: 1,
});

describe('account economic swap limits', () => {
  test('rejects fee-bearing cross-j authorization at Account admission', () => {
    const account = makeAccount('left', 'right');
    const result = validateSwapOfferAdmission(account.state, {
      type: 'swap_offer',
      data: {
        offerId: 'malformed-cross-j-auth',
        giveTokenId: 1,
        giveAmount: 1n,
        wantTokenId: 2,
        wantAmount: 2n,
        maxFee: 1n,
        minNetReceive: 1n,
        crossJurisdiction: { status: 'resting' },
      },
    } as Parameters<typeof validateSwapOfferAdmission>[1], true);

    expect(result).toEqual({ error: 'CROSS_J_SWAP_NET_AUTH_INVALID' });
    expect(account.state.swapOffers.size).toBe(0);
  });

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

  test('rejects the twenty-first live offer before mutating Account state', async () => {
    const limit = LIMITS.MAX_ACCOUNT_SWAP_OFFERS_PER_SIDE_PER_MARKET;
    const swapOffers = new Map(
      Array.from({ length: limit }, (_, index) => {
        const current = offer(`left-${index}`, true);
        return [current.offerId, current] as const;
      }),
    );
    const account = makeAccount('left', 'right');
    account.state.swapOffers = swapOffers;

    const result = await handleSwapOffer(account as Parameters<typeof handleSwapOffer>[0], {
      type: 'swap_offer',
      data: {
        offerId: 'twenty-first',
        giveTokenId: 1,
        giveAmount: 1n,
        wantTokenId: 2,
        wantAmount: 1n,
        maxFee: 0n,
        minNetReceive: 1n,
      },
    }, true, 2);

    expect(result.success).toBe(false);
    expect(result.error).toContain(`max ${limit}`);
    expect(swapOffers.has('twenty-first')).toBe(false);
    expect(swapOffers.size).toBe(limit);
  });

  test('bounds cross-j live offers independently of paged physical storage', async () => {
    const limit = LIMITS.MAX_ACCOUNT_CROSS_J_SWAP_OFFERS;
    const swapOffers = new Map(
      Array.from({ length: limit }, (_, index) => {
        const current = {
          ...offer(`cross-${index}`, true, index + 1, index + 2),
          crossJurisdiction: { status: 'resting' },
        } as SwapOffer;
        return [current.offerId, current] as const;
      }),
    );
    const account = makeAccount('left', 'right');
    account.state.swapOffers = swapOffers;
    const result = await handleSwapOffer(account as Parameters<typeof handleSwapOffer>[0], {
      type: 'swap_offer',
      data: {
        offerId: 'cross-overflow',
        giveTokenId: 100,
        giveAmount: 1n,
        wantTokenId: 101,
        wantAmount: 1n,
        maxFee: 0n,
        minNetReceive: 1n,
        crossJurisdiction: { status: 'resting' },
      },
    } as Parameters<typeof handleSwapOffer>[1], true, 2);

    expect(result.success).toBe(false);
    expect(result.error).toContain(`max ${limit}`);
    expect(swapOffers.has('cross-overflow')).toBe(false);
  });
});
