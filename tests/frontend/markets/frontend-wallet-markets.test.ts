import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { formatTokenAmount, parseTokenAmount } from '../../../core/account/financial-utils';
import { deriveDelta, getTokenInfo, isLeftEntity } from '../../../core/account/utils';
import { deriveSwapNetAuthorization } from '../../../core/account/swap/swap-net-authorization';
import { buildDeterministicSwapOfferId } from '../../../core/account/swap/swap-command-route';
import { applyCommand, createBook } from '../../../core/orderbook/core';
import { projectBookPricePageTree } from '../../../core/orderbook/pages/page';
import {
  canonicalPair,
  getStaticSwapTokenDimensions,
  prepareSwapOrderForDimensions,
} from '../../../core/orderbook/types';
import { buildWalletMarketCancelInput, buildWalletMarketOrderInput } from '../../../frontend/apps/wallet/src/wallet-market-command';
import { decodeWalletMarketProjection } from '../../../frontend/apps/wallet/src/wallet-market-model';
import type { WalletPaymentMath } from '../../../frontend/apps/wallet/src/wallet-payment-model';
import type { WalletMarketMath } from '../../../frontend/apps/wallet/src/wallet-runtime-read-boundary';

const alice = `0x${'11'.repeat(32)}`;
const hub = `0x${'22'.repeat(32)}`;
const maker = `0x${'33'.repeat(32)}`;
const signer = `0x${'aa'.repeat(20)}`;

const paymentMath: WalletPaymentMath = {
  deriveDelta,
  formatTokenAmount,
  getTokenInfo,
  isLeftEntity,
  parseTokenAmount,
};

const marketMath: WalletMarketMath = {
  canonicalPair,
  getStaticSwapTokenDimensions,
  prepareSwapOrderForDimensions,
  deriveSwapNetAuthorization,
  buildDeterministicSwapOfferId,
};

const delta = (tokenId: number, spendCapacity: bigint) => ({
  tokenId,
  collateral: 0n,
  ondelta: 0n,
  offdelta: 0n,
  leftCreditLimit: spendCapacity,
  rightCreditLimit: 0n,
  leftAllowance: 0n,
  rightAllowance: 0n,
  leftHold: 0n,
  rightHold: 0n,
});

const account = () => ({
  status: 'active',
  state: {
    leftEntity: alice,
    rightEntity: hub,
    deltas: new Map([
      [1, delta(1, 500_000_000n)],
      [2, delta(2, 2_000_000_000_000_000_000n)],
    ]),
    swapOffers: new Map([['alice-open', {
      offerId: 'alice-open',
      giveTokenId: 1,
      giveTokenDecimals: 6,
      giveAmount: 25_000_000n,
      wantTokenId: 2,
      wantTokenDecimals: 18,
      wantAmount: 10_000_000_000_000_000n,
      maxFee: 25_000_000_000_000n,
      minNetReceive: 9_975_000_000_000_000n,
      priceTicks: 2_500_000n,
      timeInForce: 0,
      makerIsLeft: true,
      createdHeight: 18,
      quantizedGive: 25_000_000n,
      quantizedWant: 10_000_000_000_000_000n,
    }]]),
  },
});

const activeFrame = () => ({
  height: 22,
  entities: [
    { entityId: alice, label: 'Alice', height: 22 },
    { entityId: hub, label: 'North Hub', height: 22, isHub: true },
  ],
  activeEntityId: alice,
  activeEntity: {
    core: {
      entityId: alice,
      signerId: signer,
      timestamp: 1_780_000_000_000,
      reserves: new Map([[1, 50_000_000n]]),
      crossJurisdictionSwaps: new Map([['cross-1', {
        orderId: 'cross-1',
        status: 'resting',
        source: { tokenId: 1, amount: 10_000_000n },
        target: { tokenId: 2, amount: 4_000_000_000_000_000n },
        updatedAt: 1_780_000_000_000,
        expiresAt: 1_780_086_400_000,
      }]]),
    },
    accounts: { items: [account()], pageIndex: 0, pageCount: 1, totalItems: 1 },
  },
});

const hubFrame = () => {
  let book = createBook({ bucketWidthTicks: 1n, maxOrders: 100, stpPolicy: 0 });
  book = applyCommand(book, {
    kind: 0, ownerId: maker, orderId: 'maker-bid', side: 0, tif: 0,
    postOnly: false, priceTicks: 2_400_000n, qtyLots: 20n,
  }).state;
  book = applyCommand(book, {
    kind: 0, ownerId: maker, orderId: 'maker-ask', side: 1, tif: 0,
    postOnly: false, priceTicks: 2_600_000n, qtyLots: 18n,
  }).state;
  return {
    height: 22,
    entities: [{ entityId: hub, label: 'North Hub', height: 22, isHub: true }],
    activeEntityId: hub,
    activeEntity: {
      core: {
        entityId: hub,
        profile: { isHub: true },
        hubRebalanceConfig: { swapTakerFeeBps: 25 },
      },
      accounts: { items: [] },
      books: { items: [{
        pairId: canonicalPair(1, 2).pairId,
        book: {
          ...book,
          bidPages: projectBookPricePageTree(book.bidPages),
          askPages: projectBookPricePageTree(book.askPages),
        },
      }] },
    },
  };
};

const activity = () => ({
  ok: true,
  events: [{
    id: 'activity-1',
    height: 22,
    timestamp: 1_780_000_000_000,
    kind: 'offchain',
    type: 'swap',
    source: 'runtime_input',
    direction: 'out',
    title: 'Swap Offer',
    subtitle: 'Placed with North Hub',
    status: 'submitted',
    counterpartyId: hub,
    tokenId: 1,
    amount: '25000000',
    orderId: 'alice-open',
    rawType: 'placeSwapOffer',
  }],
  nextBeforeHeight: 21,
});

const projection = () => decodeWalletMarketProjection({
  activeFrame: activeFrame(),
  hubFrame: hubFrame(),
  activity: activity(),
  selectedHubId: hub,
  selectedPairId: canonicalPair(1, 2).pairId,
  activityKind: 'all',
  activityPage: 0,
}, paymentMath);

describe('React wallet markets', () => {
  test('projects Runtime book depth, own offers, cross-j lifecycle, and activity', () => {
    const result = projection();
    expect(result).toMatchObject({
      height: 22,
      activeEntityId: alice,
      selectedHubId: hub,
      selectedPairId: canonicalPair(1, 2).pairId,
      activityNextBeforeHeight: 21,
    });
    expect(result.hubs[0]).toMatchObject({ label: 'North Hub', feeBps: 25 });
    expect(result.pairs[0]?.bids[0]).toMatchObject({ priceTicks: 2_400_000n, quantityLots: 20n });
    expect(result.pairs[0]?.asks[0]).toMatchObject({ priceTicks: 2_600_000n, quantityLots: 18n });
    expect(result.openOrders).toHaveLength(1);
    expect(result.crossRoutes[0]).toMatchObject({ orderId: 'cross-1', status: 'resting' });
    expect(result.activity[0]).toMatchObject({ title: 'Swap Offer', amountLabel: '25.0 USDC' });
  });

  test('builds a quantized, fee-authorized deterministic same-j order', () => {
    const result = projection();
    const input = buildWalletMarketOrderInput({
      hubEntityId: hub,
      giveTokenId: 1,
      wantTokenId: 2,
      giveAmount: '25',
      wantAmount: '0.01',
      timeInForce: 1,
    }, result, paymentMath, marketMath);
    const tx = input.entityInputs[0]?.entityTxs[0];
    expect(tx?.type).toBe('placeSwapOffer');
    if (tx?.type !== 'placeSwapOffer') throw new Error('TEST_MARKET_ORDER_TYPE_INVALID');
    expect(tx.data).toMatchObject({
      counterpartyEntityId: hub,
      giveTokenId: 1,
      wantTokenId: 2,
      timeInForce: 1,
      maxFee: 25_000_000_000_000n,
      minNetReceive: 9_975_000_000_000_000n,
    });
    expect(tx.data.offerId).toMatch(/^swap-/);
    expect(tx.data.priceTicks).toBeGreaterThan(0n);
  });

  test('rejects unsupported pairs and hub-account overspend before submission', () => {
    const result = projection();
    expect(() => buildWalletMarketOrderInput({
      hubEntityId: hub, giveTokenId: 1, wantTokenId: 3,
      giveAmount: '1', wantAmount: '1', timeInForce: 0,
    }, result, paymentMath, marketMath)).toThrow('WALLET_MARKET_PAIR_UNSUPPORTED');
    expect(() => buildWalletMarketOrderInput({
      hubEntityId: hub, giveTokenId: 1, wantTokenId: 2,
      giveAmount: '501', wantAmount: '0.2', timeInForce: 0,
    }, result, paymentMath, marketMath)).toThrow('WALLET_MARKET_CAPACITY_EXCEEDED');
  });

  test('cancels only a maker-owned open offer through the hub Account', () => {
    expect(buildWalletMarketCancelInput(projection(), 'alice-open').entityInputs[0]?.entityTxs[0]).toEqual({
      type: 'proposeCancelSwap',
      data: { counterpartyEntityId: hub, offerId: 'alice-open' },
    });
    expect(() => buildWalletMarketCancelInput(projection(), 'unknown')).toThrow('WALLET_MARKET_OPEN_ORDER_UNKNOWN');
  });

  test('keeps Runtime reads, idempotent command identity, cleanup, and React subscriptions explicit', () => {
    const source = readFileSync('frontend/apps/wallet/src/wallet-market-source.ts', 'utf8');
    const view = readFileSync('frontend/apps/wallet/src/wallet-markets.tsx', 'utf8');
    expect(source).toContain('client.readViewFrame');
    expect(source).toContain('client.readActivity');
    expect(source).toContain('prepareWalletPaymentCommand');
    expect(source).toContain('executeWalletPaymentCommand');
    expect(source).toContain('this.adapter?.disconnect()');
    expect(source).toContain('Do not submit a second command');
    expect(source).toContain("this.requireNoPendingCommand('WALLET_MARKET_PAIR_CHANGE_PENDING_COMMAND')");
    expect(view).toContain('useSyncExternalStore');
    expect(source).not.toContain('setInterval');
    expect(source).not.toContain('Math.random');
    expect(source).not.toContain('.catch(() => undefined)');
  });
});
