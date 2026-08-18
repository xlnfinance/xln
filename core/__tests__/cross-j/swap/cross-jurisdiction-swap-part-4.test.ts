import { describe, expect, test } from 'bun:test';

import {
  buildPreparedCrossJurisdictionRoute as buildPreparedCrossJurisdictionRouteCanonical,
} from '../../../extensions/cross-j';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import {
  buildCrossJurisdictionMarketOffer,
} from '../../../extensions/cross-j/orderbook';
import {
  deriveCanonicalCrossJurisdictionBookOwnerForLegs,
  deriveCanonicalCrossJurisdictionMarketForLegs,
} from '../../../extensions/cross-j/market';
import {
  getSwapPairOrientation,
  getSwapPairPolicyByBaseQuote,
  getTokenIdsForJurisdiction,
} from '../../../account/utils';
import { normalizeEntitySwapTradingPairs } from '../../../runtime/swap-cmd/swap-pairs';
import {
  addr,
  entity,
  makeJurisdiction,
  makeState,
} from '../../helpers/cross-j';

const TEST_DISPUTE_CONFIG = { leftResponseSeconds: 10, rightResponseSeconds: 10 } as const;
type TestRouteInput = Omit<CrossJurisdictionSwapRoute, 'sourceDisputeConfig' | 'targetDisputeConfig'>;
const buildPreparedCrossJurisdictionRoute = (
  route: TestRouteInput,
  options: { runtimeSeed?: string; now: number },
): CrossJurisdictionSwapRoute => buildPreparedCrossJurisdictionRouteCanonical({
  ...route,
  sourceDisputeConfig: TEST_DISPUTE_CONFIG,
  targetDisputeConfig: TEST_DISPUTE_CONFIG,
} as CrossJurisdictionSwapRoute, options);

describe('cross-jurisdiction canonical market surface', () => {
  test('production API exposes only the hashledger orderbook flow', async () => {
    const runtime = await import('../../../runtime');
    expect(typeof runtime.submitCrossJurisdictionSwap).toBe('function');
    expect('submitCrossJurisdictionSourceLock' in runtime).toBe(false);
    expect('submitCrossJurisdictionTargetLock' in runtime).toBe(false);
    expect('submitCrossJurisdictionSwapClaims' in runtime).toBe(false);
  });

  test('same-token market price uses jurisdiction asset orientation', () => {
    const sourceRef = `stack:2:0x${'22'.repeat(20)}`;
    const targetRef = `stack:1:0x${'11'.repeat(20)}`;
    const route = {
      ...buildPreparedCrossJurisdictionRoute({
        orderId: 'cross-same-token-market',
        makerEntityId: entity('c1'),
        hubEntityId: entity('c2'),
        bookOwnerEntityId: entity('c3'),
        source: {
          jurisdiction: sourceRef,
          entityId: entity('c1'),
          counterpartyEntityId: entity('c2'),
          tokenId: 1,
          amount: 2_000_000_000_000n,
        },
        target: {
          jurisdiction: targetRef,
          entityId: entity('c3'),
          counterpartyEntityId: entity('c4'),
          tokenId: 1,
          amount: 1_000_000_000_000n,
        },
        status: 'resting',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 61_000,
        priceTicks: 1n,
      }, { runtimeSeed: 'cross-same-token-market', now: 1_000 }),
      status: 'resting' as const,
    };
    const market = buildCrossJurisdictionMarketOffer({
      offerId: route.orderId,
      accountId: route.source.entityId,
      makerIsLeft: true,
      fromEntity: route.source.entityId,
      toEntity: route.source.counterpartyEntityId,
      giveTokenId: 1,
      giveAmount: route.source.amount,
      wantTokenId: 1,
      wantAmount: route.target.amount,
      priceTicks: 1n,
      timeInForce: 0,
      createdHeight: 1,
      crossJurisdiction: route,
    }, route.bookOwnerEntityId || '');

    expect(market?.pairId).toBe(`cross:${targetRef}:1/${sourceRef}:1`);
    expect(market?.side).toBe(0);
    expect(market?.baseAmount).toBe(1_000_000_000_000n);
    expect(market?.quoteAmount).toBe(2_000_000_000_000n);
    expect(market?.priceTicks).toBe(20_000n);
  });

  test('USD stables remain quote assets independently from book ownership', () => {
    const sourceHub = entity('stable-source-hub');
    const targetHub = entity('stable-target-hub');
    const tronRef = `stack:728126428:0x${'31'.repeat(20)}`;
    const testnetRef = `stack:11155111:0x${'21'.repeat(20)}`;

    const stableToEth = deriveCanonicalCrossJurisdictionMarketForLegs(tronRef, 3, testnetRef, 2);
    expect(stableToEth).toMatchObject({
      sourceIsBase: false,
      baseKey: `${testnetRef}:2`,
      quoteKey: `${tronRef}:3`,
      venueId: `cross:${testnetRef}:2/${tronRef}:3`,
    });
    expect(deriveCanonicalCrossJurisdictionBookOwnerForLegs(tronRef, sourceHub, testnetRef, targetHub)).toBe(targetHub);

    const ethToStable = deriveCanonicalCrossJurisdictionMarketForLegs(testnetRef, 2, tronRef, 3);
    expect(ethToStable).toMatchObject({
      sourceIsBase: true,
      baseKey: `${testnetRef}:2`,
      quoteKey: `${tronRef}:3`,
      venueId: `cross:${testnetRef}:2/${tronRef}:3`,
    });
    expect(deriveCanonicalCrossJurisdictionBookOwnerForLegs(testnetRef, targetHub, tronRef, sourceHub)).toBe(targetHub);

    const tronEthToStable = deriveCanonicalCrossJurisdictionMarketForLegs(tronRef, 2, testnetRef, 3);
    expect(tronEthToStable).toMatchObject({
      sourceIsBase: true,
      baseKey: `${tronRef}:2`,
      quoteKey: `${testnetRef}:3`,
      venueId: `cross:${tronRef}:2/${testnetRef}:3`,
    });
    expect(deriveCanonicalCrossJurisdictionBookOwnerForLegs(tronRef, sourceHub, testnetRef, targetHub)).toBe(targetHub);
  });

  test.each([
    {
      name: 'WETH to stable',
      sourceTokenId: 2,
      targetTokenId: 3,
      sourceAmount: 1_000_000_000_000_000_000n,
      targetAmount: 2_500n * 10n ** 6n,
      expectedSide: 1,
    },
    {
      name: 'stable to WETH',
      sourceTokenId: 3,
      targetTokenId: 2,
      sourceAmount: 2_500n * 10n ** 6n,
      targetAmount: 1_000_000_000_000_000_000n,
      expectedSide: 0,
    },
  ])('$name market offer keeps stable quote units', ({
    sourceTokenId,
    targetTokenId,
    sourceAmount,
    targetAmount,
    expectedSide,
  }) => {
    const sourceHub = entity(`stable-source-${sourceTokenId}`);
    const targetHub = entity(`stable-target-${targetTokenId}`);
    const sourceRef = `stack:728126428:0x${'31'.repeat(20)}`;
    const targetRef = `stack:11155111:0x${'21'.repeat(20)}`;
    const canonicalMarket = deriveCanonicalCrossJurisdictionMarketForLegs(
      sourceRef,
      sourceTokenId,
      targetRef,
      targetTokenId,
    );
    const route = {
      ...buildPreparedCrossJurisdictionRoute({
        orderId: `cross-stable-quote-${sourceTokenId}-${targetTokenId}`,
        makerEntityId: entity(`stable-maker-${sourceTokenId}`),
        hubEntityId: sourceHub,
        bookOwnerEntityId: targetHub,
        source: {
          jurisdiction: sourceRef,
          entityId: entity(`stable-maker-${sourceTokenId}`),
          counterpartyEntityId: sourceHub,
          tokenId: sourceTokenId,
          amount: sourceAmount,
        },
        target: {
          jurisdiction: targetRef,
          entityId: targetHub,
          counterpartyEntityId: entity(`stable-taker-${targetTokenId}`),
          tokenId: targetTokenId,
          amount: targetAmount,
        },
        status: 'resting',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 61_000,
        priceTicks: 25_000_000n,
      }, { runtimeSeed: `stable-quote-${sourceTokenId}-${targetTokenId}`, now: 1_000 }),
      status: 'resting' as const,
    };
    const market = buildCrossJurisdictionMarketOffer({
      offerId: route.orderId,
      accountId: route.source.entityId,
      makerIsLeft: true,
      fromEntity: route.source.entityId,
      toEntity: route.source.counterpartyEntityId,
      giveTokenId: sourceTokenId,
      giveAmount: sourceAmount,
      wantTokenId: targetTokenId,
      wantAmount: targetAmount,
      priceTicks: 25_000_000n,
      timeInForce: 0,
      createdHeight: 1,
      crossJurisdiction: route,
    }, targetHub);

    expect(market?.pairId).toBe(canonicalMarket.venueId);
    expect(market?.side).toBe(expectedSide);
    expect(market?.baseAmount).toBe(expectedSide === 1 ? sourceAmount : targetAmount);
    expect(market?.quoteAmount).toBe(expectedSide === 1 ? targetAmount : sourceAmount);
    expect(market?.priceTicks).toBe(25_000_000n);
  });

  test('jurisdiction token catalog and pair policy are canonical', () => {
    expect(getTokenIdsForJurisdiction('Testnet')).toEqual([1, 2, 3]);
    expect(getTokenIdsForJurisdiction({ name: 'Testnet', chainId: 31338 })).toEqual([1, 2, 3]);
    expect(getTokenIdsForJurisdiction({ name: '', chainId: 31338 })).toEqual([1, 2, 3, 4, 5]);
    expect(getTokenIdsForJurisdiction({ name: 'Tron', chainId: 31338 })).toEqual([1, 2, 3, 4, 5]);
    expect(getSwapPairOrientation(4, 1)).toEqual({ baseTokenId: 4, quoteTokenId: 1, pairId: '1/4' });
    expect(getSwapPairPolicyByBaseQuote(4, 1).mmMidPriceTicks).toBe(1_200n);
    expect(getSwapPairOrientation(5, 3)).toEqual({ baseTokenId: 5, quoteTokenId: 3, pairId: '3/5' });
    expect(getSwapPairPolicyByBaseQuote(5, 3).mmMidPriceTicks).toBe(200n);
  });

  test('trading pairs follow the entity jurisdiction token catalog', () => {
    const testnetState = makeState(
      entity('same-token-catalog-testnet'),
      addr('12'),
      makeJurisdiction('Testnet', 31337, '11', '12'),
    );
    normalizeEntitySwapTradingPairs(testnetState);
    expect(testnetState.swapTradingPairs?.map(pair => `${pair.baseTokenId}/${pair.quoteTokenId}`)).toEqual([
      '2/1',
      '1/3',
      '2/3',
    ]);

    const tronState = makeState(
      entity('same-token-catalog-tron'),
      addr('13'),
      makeJurisdiction('Tron', 31338, '13', '14'),
    );
    normalizeEntitySwapTradingPairs(tronState);
    const tronPairs = tronState.swapTradingPairs?.map(pair => `${pair.baseTokenId}/${pair.quoteTokenId}`) ?? [];
    expect(tronPairs).toEqual(expect.arrayContaining(['4/1', '4/3', '5/1', '5/3']));
  });

  test('same-jurisdiction same-token route is rejected before orderbook admission', () => {
    const jurisdictionRef = `stack:31337:0x${'11'.repeat(20)}`;
    expect(() => buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-same-chain-same-token-invalid',
      makerEntityId: entity('d1'),
      hubEntityId: entity('d2'),
      source: {
        jurisdiction: jurisdictionRef,
        entityId: entity('d1'),
        counterpartyEntityId: entity('d2'),
        tokenId: 1,
        amount: 1_000n,
      },
      target: {
        jurisdiction: jurisdictionRef,
        entityId: entity('d3'),
        counterpartyEntityId: entity('d4'),
        tokenId: 1,
        amount: 1_000n,
      },
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    }, {
      runtimeSeed: 'cross-same-chain-same-token-invalid',
      now: 1_000,
    })).toThrow(/CROSS_J_REQUIRES_DISTINCT_STACKS/);
  });
});
