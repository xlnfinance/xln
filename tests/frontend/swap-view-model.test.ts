import { expect, test } from 'bun:test';

import type { StorageAccountDoc } from '../../runtime/storage/types';
import {
  projectWalletSwapQuote,
} from '../../frontend/apps/wallet/src/features/swap/swap-view-model';
import { buildWalletSwapRouteOptions } from '../../frontend/apps/wallet/src/features/swap/swap-route-options';
import { projectWalletSwapOrders } from '../../frontend/apps/wallet/src/features/swap/swap-order-view-model';

test('route projection exposes one same-j and multiple cross-j candidates from canonical identities', () => {
  const routes = buildWalletSwapRouteOptions({
    sourceEntityId: 'alice',
    sourceRuntimeId: 'runtime-1',
    sourceJurisdictionRef: 'stack:1:0xj1',
    sourceAccountIds: ['hub-1'],
    directory: [
      { entityId: 'hub-1', runtimeId: 'remote', signerId: 'signer-h1', label: 'H1', isHub: true, jurisdictionRef: 'stack:1:0xj1' },
      { entityId: 'bob', runtimeId: 'runtime-1', signerId: 'signer-bob', label: 'Bob', isHub: false, jurisdictionRef: 'stack:2:0xj2' },
      { entityId: 'hub-2', runtimeId: 'remote', signerId: 'signer-h2', label: 'H2', isHub: true, jurisdictionRef: 'stack:2:0xj2' },
      { entityId: 'hub-3', runtimeId: 'remote', signerId: 'signer-h3', label: 'H3', isHub: true, jurisdictionRef: 'stack:2:0xj2' },
    ],
  });
  expect(routes.map(route => route.mode)).toEqual(['same', 'cross', 'cross']);
  expect(routes[0]?.label).toBe('Same jurisdiction · H1');
  expect(routes.every(route => route.enabled)).toBe(true);
  expect(routes.map(route => route.value)).toContain('cross:alice:hub-1:bob:hub-3');
});

test('route projection returns no invented route when no source hub account exists', () => {
  expect(buildWalletSwapRouteOptions({
    sourceEntityId: 'alice', sourceRuntimeId: 'runtime-1', sourceJurisdictionRef: 'stack:1:0xj1',
    sourceAccountIds: ['peer'], directory: [],
  })).toEqual([]);
});

test('route projection exposes one deterministic same-jurisdiction lane across multiple hub accounts', () => {
  const routes = buildWalletSwapRouteOptions({
    sourceEntityId: 'alice',
    sourceRuntimeId: 'runtime-1',
    sourceJurisdictionRef: 'stack:1:0xj1',
    sourceAccountIds: ['hub-3', 'hub-1', 'hub-2'],
    directory: [
      { entityId: 'hub-3', runtimeId: 'remote', signerId: 'signer-h3', label: 'H3', isHub: true, jurisdictionRef: 'stack:1:0xj1' },
      { entityId: 'hub-1', runtimeId: 'remote', signerId: 'signer-h1', label: 'H1', isHub: true, jurisdictionRef: 'stack:1:0xj1' },
      { entityId: 'hub-2', runtimeId: 'remote', signerId: 'signer-h2', label: 'H2', isHub: true, jurisdictionRef: 'stack:1:0xj1' },
    ],
  });

  expect(routes).toHaveLength(1);
  expect(routes[0]).toMatchObject({
    value: 'same:alice:hub-1',
    label: 'Same jurisdiction · H1',
    enabled: true,
  });
});

test('quote projection preserves canonical planner amounts without a UI formula', () => {
  const quote = projectWalletSwapQuote({
    requestIdentity: 'request-1',
    giveTokenId: 1,
    wantTokenId: 2,
    routeLabel: 'same jurisdiction via H1',
    plan: {
      mode: 'same',
      offerId: 'offer-7',
      preparedOrder: {
        priceTicks: 25n,
        effectiveGive: 99n,
        effectiveWant: 2475n,
        unspentGiveAmount: 1n,
      },
      sourceOutCapacity: 500n,
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
      targetSetupInput: null,
      crossJurisdictionIntent: null,
    },
  });
  expect(quote).toMatchObject({
    offerId: 'offer-7',
    giveAmountRaw: '99',
    wantAmountRaw: '2475',
    priceTicks: '25',
    unspentGiveRaw: '1',
    sourceOutCapacityRaw: '500',
    feeEvidence: 'execution-bound',
  });
});

const accountFixture = (): StorageAccountDoc => ({
  state: {
    leftEntity: 'alice',
    rightEntity: 'hub',
    domain: { chainId: 1, depositoryAddress: '0x0000000000000000000000000000000000000001' },
    watchSeed: 'seed',
    deltas: new Map(),
    locks: new Map(),
    swapOffers: new Map([['open-1', {
      offerId: 'open-1', giveTokenId: 1, giveAmount: 80n, wantTokenId: 2, wantAmount: 160n,
      priceTicks: 2n, makerIsLeft: true, createdHeight: 8,
    }]]),
    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
    leftPendingJClaims: { nextNonce: 0, pending: new Map() },
    rightPendingJClaims: { nextNonce: 0, pending: new Map() },
    lastFinalizedJHeight: 0,
    disputeConfig: { leftDisputeDelay: 0, rightDisputeDelay: 0 },
    jNonce: 0,
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
  },
  status: 'active',
  mempool: [],
  currentFrame: {} as StorageAccountDoc['currentFrame'],
  swapOrderHistory: new Map(),
  swapClosedOrders: new Map([['closed-1', {
    offerId: 'closed-1', giveTokenId: 1, giveAmount: 100n, originalGiveAmount: 100n,
    wantTokenId: 2, wantAmount: 200n, originalWantAmount: 200n, priceTicks: 2n,
    createdHeight: 4, cancelRequested: true, lastUpdatedHeight: 9,
    resolves: [{
      fillRatio: 32_768, cancelRemainder: true, height: 9,
      executionGiveAmount: 50n, executionWantAmount: 105n, feeTokenId: 2, feeAmount: 1n,
      comment: 'remainder canceled',
    }],
  }]]),
  currentHeight: 9,
  pendingSignatures: [],
  rollbackCount: 0,
  proofHeader: { fromEntity: 'alice', toEntity: 'hub', nextProofNonce: 0 },
  proofBody: { tokenIds: [], deltas: [] },
  requestedRebalanceBatch: undefined,
} as unknown as StorageAccountDoc);

test('order lifecycle projection has deterministic ordering and exact execution evidence', () => {
  const orders = projectWalletSwapOrders(accountFixture(), 'hub', {
    computeSwapPriceTicks: () => { throw new Error('unexpected fallback'); },
  });
  expect(orders.map(order => order.offerId)).toEqual(['closed-1', 'open-1']);
  expect(orders[0]).toMatchObject({
    status: 'partial',
    executionGiveRaw: '50',
    executionWantRaw: '105',
    feeRaw: '1',
    feeTokenId: 2,
    closeComment: 'remainder canceled',
  });
  expect(orders[1]).toMatchObject({ status: 'open', giveAmountRaw: '80', wantAmountRaw: '160' });
});

test('malformed persisted order evidence fails loudly instead of becoming zero or pending', () => {
  const fixture = accountFixture();
  fixture.swapClosedOrders!.get('closed-1')!.resolves[0]!.fillRatio = Number.NaN;
  expect(() => projectWalletSwapOrders(fixture, 'hub', { computeSwapPriceTicks: () => 1n })).toThrow(
    'WALLET_SWAP_RESOLVE_RATIO_INVALID',
  );
});
