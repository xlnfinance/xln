import { expect, test } from 'bun:test';

import {
  createMarketMakerServerState,
  getMarketMakerHealth as getServerMarketMakerHealth,
} from '../server/market-maker-health';
import { buildDefaultEntitySwapPairs } from '../account-utils';
import { buildMarketSnapshotForReplica } from '../market-snapshot';
import { applyCommand, createBook } from '../orderbook';
import {
  buildMarketMakerBootstrapFingerprint,
  buildMarketMakerCrossHealth,
  buildMarketMakerCrossOfferSpecs,
  getMarketMakerHealth as getRuntimeMarketMakerHealth,
  hasFinalizedMarketMakerCrossOffer,
  type HubProfile,
  type MarketMakerEntityContext,
  type MarketMakerHealth,
  type MarketMakerTokenIdsByContext,
} from '../orchestrator/mm-node';
import { createEmptyEnv } from '../runtime';
import type { AccountMachine, EntityReplica, Env } from '../types';

const entity = (byte: string): string => `0x${byte.repeat(32)}`;
const addr = (byte: string): string => `0x${byte.repeat(20)}`;
const stackRef = (chainId: number, byte: string): string => `stack:${chainId}:${addr(byte)}`;

test('market maker server health treats absent cross topology as neutral', () => {
  const state = createMarketMakerServerState();
  state.entityId = 'mm';
  state.targetHubIds = ['hub'];
  state.tokenIds = [1, 2, 3];

  const health = getServerMarketMakerHealth({} as Env, state, () => null);

  expect(health.cross.applicable).toBe(false);
  expect(health.cross.ok).toBe(true);
  expect(health.cross.expectedRoutes).toBe(0);
  expect(health.cross.routes).toEqual([]);
});

test('market maker server health requires full quote depth', () => {
  const state = createMarketMakerServerState();
  state.entityId = 'mm';
  state.targetHubIds = ['0x0000000000000000000000000000000000abcdef'];
  state.tokenIds = [1, 2, 3];

  const account = {
    swapOffers: new Map([
      ['mm-abcdef-2-1-ask-1', {}],
      ['mm-abcdef-1-3-ask-1', {}],
      ['mm-abcdef-2-3-ask-1', {}],
    ]),
    currentHeight: 1,
    mempool: [],
    pendingFrame: null,
  };
  const health = getServerMarketMakerHealth({} as Env, state, () => account as any);

  expect(health.ok).toBe(false);
  expect(health.hubs[0]?.ready).toBe(true);
  expect(health.hubs[0]?.depthReady).toBe(false);
  expect(health.hubs[0]?.pairs.map(pair => ({
    pairId: pair.pairId,
    offers: pair.offers,
    ready: pair.ready,
    depthReady: pair.depthReady,
  }))).toEqual([
    { pairId: '1/2', offers: 1, ready: true, depthReady: false },
    { pairId: '1/3', offers: 1, ready: true, depthReady: false },
    { pairId: '2/3', offers: 1, ready: true, depthReady: false },
  ]);
});

test('market maker server health is green only at full configured depth', () => {
  const state = createMarketMakerServerState();
  state.entityId = 'mm';
  state.targetHubIds = ['0x0000000000000000000000000000000000abcdef'];
  state.tokenIds = [1, 2, 3];

  const offers = new Map<string, unknown>();
  for (const pair of buildDefaultEntitySwapPairs(state.tokenIds)) {
    const pairKey = `${pair.baseTokenId}-${pair.quoteTokenId}`;
    for (const side of ['ask', 'bid']) {
      for (let level = 1; level <= 10; level += 1) {
        offers.set(`mm-abcdef-${pairKey}-${side}-${level}`, {});
      }
    }
  }
  const health = getServerMarketMakerHealth({} as Env, state, () => ({
    swapOffers: offers,
    currentHeight: 1,
    mempool: [],
    pendingFrame: null,
  } as any));

  expect(health.ok).toBe(true);
  expect(health.expectedOffersPerPair).toBe(20);
  expect(health.expectedOffersPerHub).toBe(60);
  expect(health.hubs[0]?.depthReady).toBe(true);
});

test('market maker server health does not count pending offers as bootstrap-ready', () => {
  const state = createMarketMakerServerState();
  state.entityId = 'mm';
  state.targetHubIds = ['0x0000000000000000000000000000000000abcdef'];
  state.tokenIds = [1, 2, 3];

  const pendingOffers = [];
  for (const pair of buildDefaultEntitySwapPairs(state.tokenIds)) {
    const pairKey = `${pair.baseTokenId}-${pair.quoteTokenId}`;
    for (const side of ['ask', 'bid']) {
      for (let level = 1; level <= 10; level += 1) {
        pendingOffers.push({
          type: 'swap_offer',
          data: { offerId: `mm-abcdef-${pairKey}-${side}-${level}` },
        });
      }
    }
  }

  const health = getServerMarketMakerHealth({} as Env, state, () => ({
    swapOffers: new Map(),
    currentHeight: 1,
    mempool: [],
    pendingFrame: {
      height: 2,
      accountTxs: pendingOffers,
    },
  } as any));

  expect(health.ok).toBe(false);
  expect(health.hubs[0]?.offers).toBe(0);
  expect(health.hubs[0]?.depthReady).toBe(false);
  expect(health.hubs[0]?.blockers?.[0]?.reason).toBe('pending-frame');
});

test('market snapshots expose order counts for aggregated price levels', () => {
  const book = createBook({ bucketWidthTicks: 1n, maxOrders: 10, stpPolicy: 0 });
  applyCommand(book, {
    kind: 0,
    ownerId: 'maker-a',
    orderId: 'ask-a',
    side: 1,
    tif: 0,
    postOnly: true,
    priceTicks: 4n,
    qtyLots: 10n,
  });
  applyCommand(book, {
    kind: 0,
    ownerId: 'maker-b',
    orderId: 'ask-b',
    side: 1,
    tif: 0,
    postOnly: true,
    priceTicks: 4n,
    qtyLots: 15n,
  });

  const snapshot = buildMarketSnapshotForReplica({
    state: {
      orderbookExt: { books: new Map([['cross:a/b', book]]) },
      height: 3,
      timestamp: 100,
    },
  } as any, `0x${'a'.repeat(64)}`, 'cross:a/b', 20);

  expect(snapshot.asks).toHaveLength(1);
  expect(snapshot.asks[0]).toMatchObject({ price: '4', size: '25', total: '25', orderCount: 2 });
});

const makeAccount = (
  ownerEntityId: string,
  counterpartyEntityId: string,
  swapOffers: Map<string, unknown> = new Map(),
): AccountMachine => ({
  leftEntity: ownerEntityId,
  rightEntity: counterpartyEntityId,
  status: 'active',
  currentHeight: 1,
  mempool: [],
  pendingFrame: null,
  swapOffers,
  deltas: new Map(),
} as unknown as AccountMachine);

const addReplica = (
  env: Env,
  entityId: string,
  signerId: string,
  accounts: Map<string, AccountMachine> = new Map(),
): void => {
  env.eReplicas.set(`${entityId}:${signerId}`, {
    entityId,
    signerId,
    mempool: [],
    isProposer: true,
    state: {
      entityId,
      accounts,
      config: {
        mode: 'proposer-based',
        threshold: 1n,
        validators: [signerId],
        shares: { [signerId]: 1n },
      },
    },
  } as unknown as EntityReplica);
};

const committedSameChainOffers = (hubEntityId: string, tokenIds: number[]): Map<string, unknown> => {
  const offers = new Map<string, unknown>();
  for (const pair of buildDefaultEntitySwapPairs(tokenIds)) {
    const pairKey = `${pair.baseTokenId}-${pair.quoteTokenId}`;
    for (const side of ['ask', 'bid']) {
      for (let level = 1; level <= 10; level += 1) {
        offers.set(`mm-${hubEntityId.slice(-6).toLowerCase()}-${pairKey}-${side}-${level}`, {});
      }
    }
  }
  return offers;
};

const buildBootstrapTopology = (): {
  env: Env;
  contexts: MarketMakerEntityContext[];
  visibleHubs: HubProfile[];
  tokenIdsByContext: MarketMakerTokenIdsByContext;
} => {
  const env = createEmptyEnv('market-maker-bootstrap-health');
  env.timestamp = 1_000;
  env.runtimeId = addr('90');
  env.quietRuntimeLogs = true;
  const hubRuntimeId = addr('91');
  const contexts: MarketMakerEntityContext[] = [
    {
      entityId: entity('10'),
      signerId: addr('10'),
      jurisdictionName: 'Arrakis',
      chainId: 31337,
      depositoryAddress: addr('11'),
      jurisdictionRef: stackRef(31337, '11'),
    },
    {
      entityId: entity('20'),
      signerId: addr('20'),
      jurisdictionName: 'Tron',
      chainId: 31338,
      depositoryAddress: addr('22'),
      jurisdictionRef: stackRef(31338, '22'),
    },
  ];
  const visibleHubs: HubProfile[] = [
    {
      name: 'H1 Arrakis',
      entityId: entity('30'),
      signerId: addr('30'),
      runtimeId: hubRuntimeId,
      jurisdictionName: 'Arrakis',
      chainId: 31337,
      depositoryAddress: addr('11'),
      jurisdictionRef: stackRef(31337, '11'),
    },
    {
      name: 'H1 Tron',
      entityId: entity('40'),
      signerId: addr('40'),
      runtimeId: hubRuntimeId,
      jurisdictionName: 'Tron',
      chainId: 31338,
      depositoryAddress: addr('22'),
      jurisdictionRef: stackRef(31338, '22'),
    },
  ];
  env.gossip = {
    getProfiles: () => visibleHubs.map((hub) => ({
      name: hub.name,
      entityId: hub.entityId,
      runtimeId: hub.runtimeId,
      metadata: {
        isHub: true,
        jurisdiction: {
          name: hub.jurisdictionName,
          chainId: hub.chainId,
          depositoryAddress: hub.depositoryAddress,
        },
        board: { validators: [{ signerId: hub.signerId }] },
      },
    })),
  } as Env['gossip'];
  const tokenIdsByContext = new Map(contexts.map(context => [context.entityId, [1, 2, 3]]));
  return { env, contexts, visibleHubs, tokenIdsByContext };
};

test('runtime market maker health stays red when same-chain offers are committed but cross source offer is pending', () => {
  const { env, contexts, visibleHubs, tokenIdsByContext } = buildBootstrapTopology();
  const sourceContext = contexts[0]!;
  const targetContext = contexts[1]!;
  const sourceHub = visibleHubs[0]!;
  const targetHub = visibleHubs[1]!;
  const sameChainAccount = makeAccount(
    sourceContext.entityId,
    sourceHub.entityId,
    committedSameChainOffers(sourceHub.entityId, [1, 2, 3]),
  );
  const targetAccount = makeAccount(targetContext.entityId, targetHub.entityId);
  addReplica(env, sourceContext.entityId, sourceContext.signerId, new Map([[sourceHub.entityId, sameChainAccount]]));
  addReplica(env, targetContext.entityId, targetContext.signerId, new Map([[targetHub.entityId, targetAccount]]));

  const specs = buildMarketMakerCrossOfferSpecs(
    env,
    sourceContext,
    targetContext,
    [sourceHub],
    [targetHub],
    [1, 2, 3],
    [1, 2, 3],
  );
  expect(specs.length).toBeGreaterThan(0);
  const pendingSpec = specs[0]!;
  sameChainAccount.pendingFrame = {
    height: 2,
    accountTxs: [{
      type: 'swap_offer',
      data: {
        offerId: pendingSpec.offerId,
        giveTokenId: pendingSpec.giveTokenId,
        giveAmount: pendingSpec.giveAmount,
        wantTokenId: pendingSpec.wantTokenId,
        wantAmount: pendingSpec.wantAmount,
        minFillRatio: pendingSpec.minFillRatio,
        crossJurisdiction: pendingSpec.crossJurisdiction!,
      },
    }],
  } as AccountMachine['pendingFrame'];

  expect(hasFinalizedMarketMakerCrossOffer(env, pendingSpec)).toBe(false);
  const health = getRuntimeMarketMakerHealth(
    env,
    sourceContext.entityId,
    [sourceHub.entityId],
    [1, 2, 3],
    { contexts, visibleHubs, tokenIdsByContext },
  );
  const pendingRoute = health.cross.routes.find(route =>
    route.sourceMmEntityId === sourceContext.entityId &&
    route.targetMmEntityId === targetContext.entityId &&
    route.sourceHubEntityId === sourceHub.entityId &&
    route.targetHubEntityId === targetHub.entityId,
  );

  expect(health.ok).toBe(false);
  expect(health.hubs[0]?.offers).toBe(health.expectedOffersPerHub);
  expect(health.hubs[0]?.blockers[0]?.reason).toBe('pending-frame');
  expect(pendingRoute?.offers).toBe(0);
  expect(pendingRoute?.depthReady).toBe(false);
});

test('market maker finalized cross matching tolerates rolling route hash but rejects changed economics', () => {
  const { env, contexts, visibleHubs } = buildBootstrapTopology();
  const sourceContext = contexts[0]!;
  const targetContext = contexts[1]!;
  const sourceHub = visibleHubs[0]!;
  const targetHub = visibleHubs[1]!;
  const account = makeAccount(sourceContext.entityId, sourceHub.entityId);
  addReplica(env, sourceContext.entityId, sourceContext.signerId, new Map([[sourceHub.entityId, account]]));
  addReplica(env, targetContext.entityId, targetContext.signerId);
  const spec = buildMarketMakerCrossOfferSpecs(
    env,
    sourceContext,
    targetContext,
    [sourceHub],
    [targetHub],
    [1, 2, 3],
    [1, 2, 3],
  )[0]!;
  const route = spec.crossJurisdiction!;
  account.swapOffers.set(spec.offerId, {
    offerId: spec.offerId,
    giveTokenId: spec.giveTokenId,
    giveAmount: spec.giveAmount,
    wantTokenId: spec.wantTokenId,
    wantAmount: spec.wantAmount,
    priceTicks: route.priceTicks,
    minFillRatio: 0,
    makerIsLeft: true,
    createdHeight: 1,
    crossJurisdiction: {
      ...route,
      routeHash: `0x${'ab'.repeat(32)}`,
      expiresAt: Number(route.expiresAt || 0) + 60_000,
    },
  } as any);

  expect(hasFinalizedMarketMakerCrossOffer(env, spec)).toBe(true);
  account.swapOffers.set(spec.offerId, {
    ...account.swapOffers.get(spec.offerId),
    crossJurisdiction: {
      ...route,
      target: {
        ...route.target,
        amount: BigInt(route.target.amount) + 1n,
      },
    },
  } as any);
  expect(hasFinalizedMarketMakerCrossOffer(env, spec)).toBe(false);
});

test('market maker bootstrap fingerprint is stable across repeated and shuffled inputs', () => {
  const { env, contexts, visibleHubs, tokenIdsByContext } = buildBootstrapTopology();
  addReplica(env, contexts[0]!.entityId, contexts[0]!.signerId);
  addReplica(env, contexts[1]!.entityId, contexts[1]!.signerId);
  const health: MarketMakerHealth = {
    enabled: true,
    ok: true,
    entityId: contexts[0]!.entityId,
    expectedOffersPerHub: 60,
    expectedOffersPerPair: 20,
    hubs: visibleHubs.map(hub => ({
      hubEntityId: hub.entityId,
      offers: 60,
      ready: true,
      depthReady: true,
      blockers: [],
      pairs: buildDefaultEntitySwapPairs([1, 2, 3]).map(pair => ({
        pairId: pair.pairId,
        offers: 20,
        ready: true,
        depthReady: true,
        expectedOffers: 20,
      })),
    })),
    cross: buildMarketMakerCrossHealth(env, contexts, visibleHubs, tokenIdsByContext),
  };
  const first = buildMarketMakerBootstrapFingerprint(env, contexts, visibleHubs, tokenIdsByContext, health);
  const second = buildMarketMakerBootstrapFingerprint(env, contexts, visibleHubs, tokenIdsByContext, health);
  const shuffledContexts = [...contexts].reverse();
  const shuffledHubs = [...visibleHubs].reverse();
  const shuffledTokenIdsByContext = new Map(Array.from(tokenIdsByContext.entries()).reverse());
  const shuffledHealth: MarketMakerHealth = {
    ...health,
    hubs: [...health.hubs].reverse(),
    cross: {
      ...health.cross,
      routes: [...health.cross.routes].reverse(),
    },
  };
  const shuffled = buildMarketMakerBootstrapFingerprint(
    env,
    shuffledContexts,
    shuffledHubs,
    shuffledTokenIdsByContext,
    shuffledHealth,
  );

  expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(second.hash).toBe(first.hash);
  expect(shuffled.hash).toBe(first.hash);
});
