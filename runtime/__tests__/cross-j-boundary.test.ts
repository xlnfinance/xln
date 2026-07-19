import { describe, expect, test } from 'bun:test';

import {
  entityInputHasCrossJurisdictionIntraRuntimeTx,
  isCrossJurisdictionSiblingPair,
} from '../extensions/cross-j/boundary';
import { deriveCanonicalCrossJurisdictionBookOwnerForLegs } from '../extensions/cross-j/market';
import type { CrossJurisdictionSwapRoute, EntityTx } from '../types';

const SOURCE_USER = `0x${'a1'.repeat(32)}`;
const TARGET_USER = `0x${'a2'.repeat(32)}`;
const SOURCE_HUB = `0x${'b1'.repeat(32)}`;
const TARGET_HUB = `0x${'b2'.repeat(32)}`;

const route: CrossJurisdictionSwapRoute = {
  orderId: 'cross-pull-close-boundary',
  makerEntityId: SOURCE_USER,
  hubEntityId: SOURCE_HUB,
  bookOwnerEntityId: SOURCE_HUB,
  source: {
    jurisdiction: 'source',
    entityId: SOURCE_USER,
    counterpartyEntityId: SOURCE_HUB,
    tokenId: 1,
    amount: 10n,
  },
  target: {
    jurisdiction: 'target',
    entityId: TARGET_HUB,
    counterpartyEntityId: TARGET_USER,
    tokenId: 2,
    amount: 20n,
  },
  status: 'source_claimed',
  createdAt: 1,
  updatedAt: 2,
};

const closeTx = (txRoute?: CrossJurisdictionSwapRoute): EntityTx => ({
  type: 'crossPullClose',
  data: {
    counterpartyEntityId: TARGET_HUB,
    pullId: 'target-pull',
    binary: '0x01',
    proof: {
      orderId: route.orderId,
      routeHash: `0x${'44'.repeat(32)}`,
      sourcePullId: 'source-pull',
      targetPullId: 'target-pull',
      fillRatio: 65_535,
      cumulativeSourceAmount: 10n,
      cumulativeTargetAmount: 20n,
      binaryHash: `0x${'55'.repeat(32)}`,
      closeMode: 'full',
    },
    ...(txRoute ? { route: txRoute } : {}),
  },
});

const inputWith = (tx: EntityTx) => ({ entityTxs: [tx] });

describe('cross-j runtime boundary', () => {
  test('classifies cross-j Entity inputs without pretending any remote hop is allowed', () => {
    expect(entityInputHasCrossJurisdictionIntraRuntimeTx(inputWith(closeTx(route)))).toBe(true);
    expect(entityInputHasCrossJurisdictionIntraRuntimeTx(inputWith(closeTx()))).toBe(true);
  });

  test('allows only the two sibling edges encoded by the route', () => {
    expect(isCrossJurisdictionSiblingPair(route, SOURCE_HUB, TARGET_HUB)).toBe(true);
    expect(isCrossJurisdictionSiblingPair(route, TARGET_HUB, SOURCE_HUB)).toBe(true);
    expect(isCrossJurisdictionSiblingPair(route, SOURCE_USER, TARGET_USER)).toBe(true);
    expect(isCrossJurisdictionSiblingPair(route, TARGET_USER, SOURCE_USER)).toBe(true);
  });

  test('rejects every Account edge and diagonal as a sibling message', () => {
    expect(isCrossJurisdictionSiblingPair(route, SOURCE_USER, SOURCE_HUB)).toBe(false);
    expect(isCrossJurisdictionSiblingPair(route, TARGET_HUB, TARGET_USER)).toBe(false);
    expect(isCrossJurisdictionSiblingPair(route, SOURCE_USER, TARGET_HUB)).toBe(false);
    expect(isCrossJurisdictionSiblingPair(route, SOURCE_HUB, TARGET_USER)).toBe(false);
  });

  test('chooses one book owner by numeric chain id in either trade direction', () => {
    const chain10 = `stack:10:0x${'10'.repeat(20)}`;
    const chain42161 = `stack:42161:0x${'42'.repeat(20)}`;
    expect(deriveCanonicalCrossJurisdictionBookOwnerForLegs(
      chain42161, TARGET_HUB, chain10, SOURCE_HUB,
    )).toBe(SOURCE_HUB);
    expect(deriveCanonicalCrossJurisdictionBookOwnerForLegs(
      chain10, SOURCE_HUB, chain42161, TARGET_HUB,
    )).toBe(SOURCE_HUB);
  });

  test('keeps every token market on the same stack-pair owner', () => {
    const chain10 = `stack:10:0x${'10'.repeat(20)}`;
    const chain42161 = `stack:42161:0x${'42'.repeat(20)}`;
    expect(deriveCanonicalCrossJurisdictionBookOwnerForLegs(
      chain10, SOURCE_HUB, chain42161, TARGET_HUB,
    )).toBe(SOURCE_HUB);
  });

  test('rejects a same-stack route before selecting a book owner', () => {
    const stack = `stack:10:0x${'10'.repeat(20)}`;
    expect(() => deriveCanonicalCrossJurisdictionBookOwnerForLegs(
      stack, SOURCE_HUB, stack, TARGET_HUB,
    )).toThrow('CROSS_J_REQUIRES_DISTINCT_STACKS');
  });

  test('fails closed when a book leg has no canonical chain id', () => {
    expect(() => deriveCanonicalCrossJurisdictionBookOwnerForLegs(
      'tron', SOURCE_HUB, `stack:10:0x${'10'.repeat(20)}`, TARGET_HUB,
    )).toThrow('CROSS_J_BOOK_JURISDICTION_INVALID');
  });
});
