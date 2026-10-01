import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  buildClosedOrderViews,
  observeSwapCompletion,
  hasCompleteSwapCompletion,
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
        fillNumerator: 1n,
        fillDenominator: 2n,
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
        fillNumerator: 0n,
        fillDenominator: 1n,
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


test('live completion preserves exact execution and ignores duplicate committed frames', () => {
  const [history] = historyPageToOfferLifecycles(decodeSwapHistoryPage(pageWire()));
  if (!history) throw new Error('Expected fixture lifecycle');
  const pending = { ...history, closed: false, resolves: [], observedHeight: 1, complete: true, seenOpen: true };
  const frame = {
    height: 2, timestamp: 1000, jHeight: 1,
    prevFrameHash: '', accountStateRoot: '', stateHash: '',
    accountTxs: [{ type: 'swap_resolve' as const, data: {
      offerId: pending.offerId, fillRatio: 32768, cancelRemainder: false,
      fillNumerator: 1n, fillDenominator: 2n,
      executionGiveAmount: 2n * WEI / 100n, executionWantAmount: 50n * USDC_UNIT,
      feeTokenId: USDC, feeAmount: 10_000n,
    } }],
  };
  const partial = observeSwapCompletion(pending, frame, false);
  expect(partial.closed).toBe(false);
  expect(partial.complete).toBe(true);
  expect(observeSwapCompletion(partial, frame, false)).toBe(partial);
  const closed = observeSwapCompletion(partial, {
    ...frame, height: 3, timestamp: 2000,
    accountTxs: [{ type: 'swap_resolve', data: {
      offerId: pending.offerId, fillRatio: 0, cancelRemainder: true,
    } }],
  }, true);
  expect(closed.complete).toBe(true);
  const [view] = buildClosedOrderViews([closed], historyDeps);
  expect(view?.status).toBe('partial');
  expect(view?.filledGiveAmount).toBe(2n * WEI / 100n);
  expect(view?.filledWantAmount).toBe(50n * USDC_UNIT);
  expect(view?.feeAmount).toBe(10_000n);
});


test('live completion marks a skipped first fill and capped frame as incomplete', () => {
  const [history] = historyPageToOfferLifecycles(decodeSwapHistoryPage(pageWire()));
  if (!history) throw new Error('Expected fixture lifecycle');
  const pending = { ...history, closed: false, resolves: [], observedHeight: 1, complete: true, seenOpen: true };
  const frame = {
    height: 3, timestamp: 1000, jHeight: 1,
    prevFrameHash: '', accountStateRoot: '', stateHash: '',
    accountTxs: [{ type: 'swap_resolve' as const, data: {
      offerId: pending.offerId, fillRatio: 65535, cancelRemainder: false,
      executionGiveAmount: 2n * WEI / 100n, executionWantAmount: 50n * USDC_UNIT,
      feeTokenId: USDC, feeAmount: 10_000n,
    } }],
  };
  const skipped = observeSwapCompletion(pending, frame, true);
  expect(skipped.closed).toBe(true);
  expect(skipped.complete).toBe(false);
  expect(hasCompleteSwapCompletion(skipped)).toBe(false);
  expect(skipped.resolves).toHaveLength(1);
  const capped = observeSwapCompletion(pending, {
    ...frame, height: 2,
    accountTxs: Array.from({ length: 20 }, (_, index) => ({
      ...frame.accountTxs[0]!, data: { ...frame.accountTxs[0]!.data, offerId: index === 19 ? pending.offerId : `other-${index}` },
    })),
  }, true);
  expect(capped.closed).toBe(true);
  expect(capped.complete).toBe(false);
  expect(hasCompleteSwapCompletion(capped)).toBe(false);
  expect(capped.resolves).toHaveLength(1);
  expect(observeSwapCompletion(capped, { ...frame, height: 3 }, true).complete).toBe(false);
});


test('continuous single fill remains eligible for the exact Filled modal', () => {
  const [history] = historyPageToOfferLifecycles(decodeSwapHistoryPage(pageWire()));
  if (!history) throw new Error('Expected fixture lifecycle');
  const pending = { ...history, closed: false, resolves: [], observedHeight: 1, complete: true, seenOpen: false };
  const completed = observeSwapCompletion(pending, {
    height: 2, timestamp: 1000, jHeight: 1,
    prevFrameHash: '', accountStateRoot: '', stateHash: '',
    accountTxs: [{ type: 'swap_resolve', data: {
      offerId: pending.offerId, fillRatio: 65535, cancelRemainder: false,
      executionGiveAmount: pending.giveAmount, executionWantAmount: pending.wantAmount,
      feeTokenId: USDC, feeAmount: 10_000n,
    } }],
  }, true);
  expect(completed.complete).toBe(true);
  expect(completed.closed).toBe(true);
  const [view] = buildClosedOrderViews([completed], historyDeps);
  expect(view?.status).toBe('filled');
  expect(view?.filledGiveAmount).toBe(pending.giveAmount);
  expect(view?.filledWantAmount).toBe(pending.wantAmount);
  expect(view?.feeAmount).toBe(10_000n);
});


test('coalesced full fill proves exact give exhaustion without confusing partial cancellation', () => {
  const [history] = historyPageToOfferLifecycles(decodeSwapHistoryPage(pageWire()));
  if (!history) throw new Error('Expected fixture lifecycle');
  const pending = { ...history, closed: false, resolves: [], observedHeight: 1, complete: true, seenOpen: false };
  const completed = observeSwapCompletion(pending, {
    height: 4, timestamp: 1000, jHeight: 1,
    prevFrameHash: '', accountStateRoot: '', stateHash: '',
    accountTxs: [{ type: 'swap_resolve', data: {
      offerId: pending.offerId, fillRatio: 65535, cancelRemainder: true,
      executionGiveAmount: pending.giveAmount, executionWantAmount: pending.wantAmount,
      feeTokenId: USDC, feeAmount: 10_000n,
    } }],
  }, true);
  expect(completed.complete).toBe(false);
  expect(hasCompleteSwapCompletion(completed)).toBe(true);
  const [full] = completed.resolves;
  if (!full) throw new Error('Expected committed fill');
  const partialCancel = { ...completed, resolves: [{ ...full,
    executionGiveAmount: pending.giveAmount / 2n,
    // A better ask price can deliver the original quote amount with only half the base sold.
    executionWantAmount: pending.wantAmount,
  }] };
  expect(hasCompleteSwapCompletion(partialCancel)).toBe(false);
});
