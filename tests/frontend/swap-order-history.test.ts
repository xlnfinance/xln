import { describe, expect, test } from 'bun:test';

import {
  buildClosedOrderViews,
  collectOfferLifecyclesFrom,
} from '../../frontend/src/lib/components/Entity/swap-order-history';

const WETH = 2;
const USDC = 1;
const WEI = 10n ** 18n;
const USDC_UNIT = 10n ** 6n;

const historyDeps = {
  resolvePairOrientation: () => ({ baseTokenId: WETH, quoteTokenId: USDC }),
  getTokenDecimals: (tokenId: number) => (tokenId === USDC ? 6 : 18),
  quoteFromBase: (baseAmount: bigint) => (baseAmount * 2_500n * USDC_UNIT) / WEI,
  tokenSymbol: (tokenId: number) => (tokenId === WETH ? 'WETH' : 'USDC'),
  filledDisplayPpmThreshold: 999_950n,
};

describe('swap order history', () => {
  test('closed partial cancel computes fill percent from original order amounts', () => {
    const lifecycles = collectOfferLifecyclesFrom([
      {
        accountId: 'maker:hub',
        account: {
          swapClosedOrders: new Map([[
            'partial-cancel',
            {
              offerId: 'partial-cancel',
              giveTokenId: WETH,
              giveAmount: 2n * WEI / 100n,
              originalGiveAmount: 4n * WEI / 100n,
              wantTokenId: USDC,
              wantAmount: 50n * USDC_UNIT,
              originalWantAmount: 100n * USDC_UNIT,
              priceTicks: 25_000_000_000n,
              createdHeight: 1,
              cancelRequested: true,
              lastUpdatedHeight: 3,
              resolves: [
                {
                  fillRatio: 32768,
                  fillNumerator: 1n,
                  fillDenominator: 2n,
                  cancelRemainder: false,
                  height: 2,
                  executionGiveAmount: 2n * WEI / 100n,
                  executionWantAmount: 50n * USDC_UNIT,
                },
                {
                  fillRatio: 0,
                  cancelRemainder: true,
                  height: 3,
                  comment: 'cancel_request',
                },
              ],
            },
          ]]),
        } as never,
      },
    ], (account) => account.swapClosedOrders, () => 25_000_000_000n);

    const views = buildClosedOrderViews(lifecycles, historyDeps);
    expect(views).toHaveLength(1);
    expect(views[0]?.status).toBe('partial');
    expect(views[0]?.filledPercent).toBe(50);
    expect(views[0]?.targetBaseAmount).toBe(4n * WEI / 100n);
    expect(views[0]?.filledBaseAmount).toBe(2n * WEI / 100n);
  });
});
