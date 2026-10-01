import { expect, test } from 'bun:test';
import { assertCrossJurisdictionSwapRoute } from '../../../entity/tx-validation/cross-j-route';
import { withCanonicalCrossJurisdictionRouteHash } from '../../../extensions/cross-j';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';

// Shared literal route/hash with Rust cross_j_route_hash_parity. The user's
// authorization commits both leg jurisdictions and the independent domain;
// changing a domain while retaining that hash must fail before admission.
const route = (): CrossJurisdictionSwapRoute => ({
  orderId: 'order-1', makerEntityId: 'source-user', hubEntityId: 'source-hub',
  sourceSignerId: 'source-user-signer', sourceHubSignerId: 'source-hub-signer',
  targetHubSignerId: 'target-hub-signer', targetSignerId: 'target-user-signer',
  source: {
    jurisdiction: 'stack:1:0x1111111111111111111111111111111111111111',
    entityId: 'source-user', counterpartyEntityId: 'source-hub', tokenId: 2,
    amount: 1_000_000_000_000_000_000n,
  },
  target: {
    jurisdiction: 'stack:2:0x2222222222222222222222222222222222222222',
    entityId: 'target-hub', counterpartyEntityId: 'target-user', tokenId: 1,
    amount: 2_000_000n,
  },
  sourceDisputeConfig: { leftResponseSeconds: 3_600, rightResponseSeconds: 86_400 },
  targetDisputeConfig: { leftResponseSeconds: 3_600, rightResponseSeconds: 86_400 },
  status: 'intent', createdAt: 1_000, updatedAt: 1_000, expiresAt: 61_000,
});

const SOURCE = 'stack:999:0x9999999999999999999999999999999999999999';
const TARGET = 'stack:888:0x8888888888888888888888888888888888888888';
const HASH = '0x12695b780b36925998983227c333dd8759116e980a88ce3df85a6f598dc70d90';

test('committed cross-j routes retain exact execution amounts at the boundary', () => {
  const committed = {
    ...route(), status: 'settled' as const,
    executionSourceAmount: 999_000_000_000_000_000n, executionTargetAmount: 2_000_000n,
  };
  expect(() => assertCrossJurisdictionSwapRoute(committed, 'TEST_ROUTE')).not.toThrow();
  for (const field of ['executionSourceAmount', 'executionTargetAmount']) {
    expect(() => assertCrossJurisdictionSwapRoute({ ...committed, [field]: '2000000' }, 'TEST_ROUTE')).toThrow();
  }
  expect(() => assertCrossJurisdictionSwapRoute({ ...committed, executionUnknown: 1n }, 'TEST_ROUTE')).toThrow('extra=executionUnknown');
});

test('cross-j domain overrides preserve the TS/Rust signed route hash', () => {
  const baseline = withCanonicalCrossJurisdictionRouteHash(route());
  expect(baseline.routeHash).toBe('0xc7256dc31e315883c77c1743527b1a8b5b4966db203cecb91cfbfeab7c444f03');
  const domain = {
    protocol: 'xln-cross-j' as const, hashSchema: 'route-domain' as const,
    sourceStackId: SOURCE, targetStackId: TARGET,
    sourceAssetRef: `${baseline.source.jurisdiction}:2`,
    targetAssetRef: `${baseline.target.jurisdiction}:1`,
  };
  const supplied = { ...route(), domain, routeHash: HASH };
  assertCrossJurisdictionSwapRoute(supplied, 'TEST_ROUTE');
  const canonical = withCanonicalCrossJurisdictionRouteHash(supplied);
  expect(canonical.routeHash).toBe(HASH);
  expect(canonical.domain).toEqual(domain);
  expect(canonical.source).toEqual(baseline.source);
  expect(canonical.target).toEqual(baseline.target);
  expect(withCanonicalCrossJurisdictionRouteHash({
    ...supplied, domain: { ...domain, sourceStackId: SOURCE.toUpperCase() },
  }).routeHash).toBe(HASH);
  expect(() => withCanonicalCrossJurisdictionRouteHash({
    ...supplied, routeHash: baseline.routeHash,
  })).toThrow('CROSS_J_ROUTE_HASH_MISMATCH');
});
