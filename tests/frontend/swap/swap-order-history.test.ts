import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  buildClosedOrderViews,
  decodeSwapHistoryPage,
  historyPageToOfferLifecycles,
} from '../../../frontend/src/lib/components/Entity/swap/swap-order-history';

const WETH = 2;
const USDC = 1;
const WEI = 10n ** 18n;
const USDC_UNIT = 10n ** 6n;
const ENTITY = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HUB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const historyDeps = {
  resolvePairOrientation: () => ({ baseTokenId: WETH, quoteTokenId: USDC }),
  getTokenDecimals: (tokenId: number) => (tokenId === USDC ? 6 : 18),
  quoteFromBase: (baseAmount: bigint) => (baseAmount * 2_500n * USDC_UNIT) / WEI,
  tokenSymbol: (tokenId: number) => (tokenId === WETH ? 'WETH' : 'USDC'),
  filledDisplayPpmThreshold: 999_950n,
};

const pageWire = () => ({
  entityId: ENTITY,
  accountId: HUB,
  latestHeight: 3,
  nextCursor: null,
  items: [{
    offerId: 'partial-cancel',
    giveTokenId: WETH,
    originalGiveAmount: 4n * WEI / 100n,
    wantTokenId: USDC,
    originalWantAmount: 100n * USDC_UNIT,
    liveGiveAmount: null,
    liveWantAmount: null,
    priceTicks: 25_000_000_000n,
    createdHeight: 1,
    lastUpdatedHeight: 3,
    cancelRequested: true,
    closed: true,
    resolves: [
      {
        fillRatio: 32768,
        cancelRemainder: false,
        height: 2,
        executionGiveAmount: 2n * WEI / 100n,
        executionWantAmount: 50n * USDC_UNIT,
        feeTokenId: null,
        feeAmount: null,
        comment: '',
      },
      {
        fillRatio: 0,
        cancelRemainder: true,
        height: 3,
        executionGiveAmount: null,
        executionWantAmount: null,
        feeTokenId: null,
        feeAmount: null,
        comment: 'cancel_request',
      },
    ],
  }],
});

describe('swap order history', () => {
  test('SwapPanel reads history only through the paged Runtime adapter', () => {
    const source = readFileSync('frontend/src/lib/components/Entity/swap/SwapPanel.svelte', 'utf8');
    expect(source).toContain('readRuntimeSwapHistory');
    expect(source).toContain('decodeSwapHistoryPage');
    expect(source).not.toContain('swapOrderHistory');
    expect(source).not.toContain('swapClosedOrders');
  });

  test('uses one certified page to compute a closed partial cancel', () => {
    const lifecycles = historyPageToOfferLifecycles(decodeSwapHistoryPage(pageWire()));
    const views = buildClosedOrderViews(lifecycles, historyDeps);
    expect(views).toHaveLength(1);
    expect(views[0]?.status).toBe('partial');
    expect(views[0]?.filledPercent).toBe(50);
    expect(views[0]?.targetBaseAmount).toBe(4n * WEI / 100n);
    expect(views[0]?.filledBaseAmount).toBe(2n * WEI / 100n);
  });

  test('rejects unknown fields and noncanonical history amounts at the UI boundary', () => {
    expect(() => decodeSwapHistoryPage({ ...pageWire(), extra: true })).toThrow('SWAP_HISTORY_PAGE_FIELDS_INVALID');
    const malformed = pageWire();
    malformed.items[0]!.originalGiveAmount = '40000000000000000' as never;
    expect(() => decodeSwapHistoryPage(malformed)).toThrow('SWAP_HISTORY_ORIGINAL_GIVE_INVALID:0');
    expect(() => decodeSwapHistoryPage({ ...pageWire(), nextCursor: 'not-a-cursor' })).toThrow('SWAP_HISTORY_PAGE_CURSOR_INVALID');
    expect(() => decodeSwapHistoryPage({ ...pageWire(), nextCursor: encodeURIComponent(JSON.stringify([0, 'offer'])) })).toThrow('SWAP_HISTORY_PAGE_CURSOR_INVALID');
  });
});
