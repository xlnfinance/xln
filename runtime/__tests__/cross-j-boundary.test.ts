import { describe, expect, test } from 'bun:test';

import { isCrossJurisdictionEntityInputRemoteHopAllowed } from '../extensions/cross-j/boundary';
import type { CrossJurisdictionSwapRoute, EntityTx } from '../types';

const USER_RUNTIME = `0x${'11'.repeat(20)}`;
const HUB_RUNTIME = `0x${'22'.repeat(20)}`;
const THIRD_RUNTIME = `0x${'33'.repeat(20)}`;

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

const twoRuntimeResolver = (entityId: string): string | null => {
  if (entityId === SOURCE_USER || entityId === TARGET_USER) return USER_RUNTIME;
  if (entityId === SOURCE_HUB || entityId === TARGET_HUB) return HUB_RUNTIME;
  return null;
};

describe('cross-j remote boundary', () => {
  test('allows route-bound crossPullClose across the admitted two-runtime topology', () => {
    expect(isCrossJurisdictionEntityInputRemoteHopAllowed(
      inputWith(closeTx(route)),
      HUB_RUNTIME,
      USER_RUNTIME,
      twoRuntimeResolver,
    )).toBe(true);
  });

  test('rejects route-less crossPullClose across runtimes', () => {
    expect(isCrossJurisdictionEntityInputRemoteHopAllowed(
      inputWith(closeTx()),
      HUB_RUNTIME,
      USER_RUNTIME,
      twoRuntimeResolver,
    )).toBe(false);
  });

  test('rejects crossPullClose when the route introduces a third runtime', () => {
    const threeRuntimeResolver = (entityId: string): string | null =>
      entityId === TARGET_USER ? THIRD_RUNTIME : twoRuntimeResolver(entityId);

    expect(isCrossJurisdictionEntityInputRemoteHopAllowed(
      inputWith(closeTx(route)),
      HUB_RUNTIME,
      USER_RUNTIME,
      threeRuntimeResolver,
    )).toBe(false);
  });
});
