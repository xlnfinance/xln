import { expect, test } from 'bun:test';

import {
  createMarketMakerServerState,
  getMarketMakerHealth as getServerMarketMakerHealth,
} from '../server/market-maker-health';
import { buildDefaultEntitySwapPairs } from '../account/utils';
import { handleSwapOffer } from '../account/tx/handlers/swap-offer';
import { deriveSameOrderbookMaterialization } from '../entity/tx/handlers/account/orderbook-matching-helpers';
import { buildMarketSnapshotForReplica } from '../relay/market-snapshot';
import { applyCommand, createBook } from '../orderbook';
import { markWorkingOrderbookOffer } from '../orderbook/swap-execution';
import {
  buildMarketMakerOfferSpecs,
  buildMarketMakerBootstrapFingerprint,
  buildMarketMakerCrossHealth,
  buildMarketMakerCrossOfferSpecs,
  getMarketMakerHealth as getRuntimeMarketMakerHealth,
  hasFinalizedMarketMakerCrossOffer,
  readVisibleHubProfiles,
  type HubProfile,
  type MarketMakerEntityContext,
  type MarketMakerHealth,
  type MarketMakerTokenIdsByContext,
} from '../orchestrator/mm-node';
import { getBootstrapCreditAmount, HUB_DEFAULT_MIN_TRADE_SIZE } from '../orchestrator/mesh-common';
import { createEmptyEnv } from '../runtime';
import type { AccountMachine, EntityReplica, Env } from '../types';
import { createDefaultDelta } from '../validation-utils';
import { LIMITS } from '../constants';
import { encodeBuffer } from '../storage/codec';

const entity = (byte: string): string => `0x${byte.repeat(32)}`;
const addr = (byte: string): string => `0x${byte.repeat(20)}`;
const stackRef = (chainId: number, byte: string): string => `stack:${chainId}:${addr(byte)}`;

test('default market maker depth fits every quote leg and aggregate hold inside bootstrap credit', () => {
  const specs = buildMarketMakerOfferSpecs(
    ['0x0000000000000000000000000000000000abcdef'],
    [1, 2, 3],
  );
  const aggregateGiveByToken = new Map<number, bigint>();

  expect(specs).toHaveLength(18);
  expect(specs.length).toBeLessThanOrEqual(LIMITS.MAX_ACCOUNT_SAME_J_SWAP_OFFERS);
  for (const spec of specs) {
    expect(spec.giveAmount).toBeLessThanOrEqual(getBootstrapCreditAmount(spec.giveTokenId));
    expect(spec.wantAmount).toBeLessThanOrEqual(getBootstrapCreditAmount(spec.wantTokenId));
    aggregateGiveByToken.set(
      spec.giveTokenId,
      (aggregateGiveByToken.get(spec.giveTokenId) ?? 0n) + spec.giveAmount,
    );
  }
  for (const [tokenId, aggregateGive] of aggregateGiveByToken) {
    expect(aggregateGive).toBeLessThanOrEqual(getBootstrapCreditAmount(tokenId));
  }
});

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

test('market maker server health is ready with one committed offer per pair before full depth', () => {
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

  expect(health.ok).toBe(true);
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

test('market maker server health reports depthReady at full configured depth', () => {
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
  expect(health.hubs[0]?.blockers).toEqual([]);
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
  currentFrame: {},
  mempool: [],
  pendingFrame: null,
  swapOffers,
  deltas: new Map(),
} as unknown as AccountMachine);

test('five-token market maker depth remains canonical through Account and hub admission', async () => {
  const mmEntityId = entity('a');
  const hubEntityId = entity('b');
  const account = makeAccount(mmEntityId, hubEntityId);
  for (const tokenId of [1, 2, 3, 4, 5]) {
    const delta = createDefaultDelta(tokenId);
    delta.leftCreditLimit = getBootstrapCreditAmount(tokenId);
    delta.rightCreditLimit = getBootstrapCreditAmount(tokenId);
    account.deltas.set(tokenId, delta);
  }

  const specs = buildMarketMakerOfferSpecs([hubEntityId], [1, 2, 3, 4, 5]);
  expect(specs).toHaveLength(LIMITS.MAX_ACCOUNT_SAME_J_SWAP_OFFERS);
  const rejected: string[] = [];

  for (const spec of specs) {
    const result = await handleSwapOffer(account, {
      type: 'swap_offer',
      data: {
        offerId: spec.offerId,
        giveTokenId: spec.giveTokenId,
        giveAmount: spec.giveAmount,
        wantTokenId: spec.wantTokenId,
        wantAmount: spec.wantAmount,
        priceTicks: spec.priceTicks,
        minFillRatio: spec.minFillRatio,
      },
    }, true, 1);
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);

    const offer = account.swapOffers.get(spec.offerId)!;
    expect(offer.priceTicks).toBe(spec.priceTicks);
    const working = markWorkingOrderbookOffer({
      offerId: offer.offerId,
      accountId: hubEntityId,
      makerIsLeft: offer.makerIsLeft,
      fromEntity: account.leftEntity,
      toEntity: account.rightEntity,
      createdHeight: offer.createdHeight,
      giveTokenId: offer.giveTokenId,
      giveAmount: offer.giveAmount,
      wantTokenId: offer.wantTokenId,
      wantAmount: offer.wantAmount,
      quantizedGive: offer.quantizedGive,
      quantizedWant: offer.quantizedWant,
      priceTicks: offer.priceTicks,
      timeInForce: offer.timeInForce ?? 0,
      minFillRatio: offer.minFillRatio,
    });
    if (working.orderbookKind !== 'same-jurisdiction') {
      throw new Error(`MARKET_MAKER_SAME_CHAIN_SPEC_BECAME_CROSS_J:${spec.offerId}`);
    }
    const materialized = deriveSameOrderbookMaterialization(working, HUB_DEFAULT_MIN_TRADE_SIZE);
    if (materialized.kind === 'reject') rejected.push(`${spec.offerId}:${materialized.reason}`);
  }

  expect(account.swapOffers.size).toBe(LIMITS.MAX_ACCOUNT_SAME_J_SWAP_OFFERS);
  expect(encodeBuffer(account.swapOffers).byteLength).toBeLessThan(LIMITS.MAX_STORAGE_VALUE_BYTES);
  expect(rejected).toEqual([]);
});

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
  return new Map(buildMarketMakerOfferSpecs([hubEntityId], tokenIds).map(spec => [spec.offerId, {}]));
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

test('five-token jurisdiction keeps same-chain and cross depth inside one account credit', () => {
  const { env, contexts, visibleHubs } = buildBootstrapTopology();
  const sourceContext = contexts[1]!;
  const targetContext = contexts[0]!;
  const sourceHub = visibleHubs[1]!;
  const targetHub = visibleHubs[0]!;
  const sourceTokenIds = [1, 2, 3, 4, 5];
  const targetTokenIds = [1, 2, 3];
  addReplica(env, sourceContext.entityId, sourceContext.signerId);
  addReplica(env, targetContext.entityId, targetContext.signerId);
  const crossSpecs = buildMarketMakerCrossOfferSpecs(
    env,
    sourceContext,
    targetContext,
    [sourceHub],
    [targetHub],
    sourceTokenIds,
    targetTokenIds,
  );
  const reverseCrossSpecs = buildMarketMakerCrossOfferSpecs(
    env,
    targetContext,
    sourceContext,
    [targetHub],
    [sourceHub],
    targetTokenIds,
    sourceTokenIds,
  );
  const specs = [...buildMarketMakerOfferSpecs([sourceHub.entityId], sourceTokenIds), ...crossSpecs];
  const aggregateGiveByToken = new Map<number, bigint>();

  expect(specs).toHaveLength(
    LIMITS.MAX_ACCOUNT_SAME_J_SWAP_OFFERS + LIMITS.MAX_ACCOUNT_CROSS_J_SWAP_OFFERS,
  );
  expect(crossSpecs.some(spec => (spec.crossJurisdiction?.source.tokenId ?? 0) >= 4)).toBeTrue();
  expect(reverseCrossSpecs.some(spec => (spec.crossJurisdiction?.target.tokenId ?? 0) >= 4)).toBeTrue();
  for (const spec of specs) {
    aggregateGiveByToken.set(
      spec.giveTokenId,
      (aggregateGiveByToken.get(spec.giveTokenId) ?? 0n) + spec.giveAmount,
    );
  }
  for (const [tokenId, aggregateGive] of aggregateGiveByToken) {
    expect(aggregateGive).toBeLessThanOrEqual(getBootstrapCreditAmount(tokenId));
  }
});

test('cross offer construction requires the deterministic Runtime-frame timestamp', () => {
  const { env, contexts, visibleHubs } = buildBootstrapTopology();
  env.timestamp = 0;

  expect(() => buildMarketMakerCrossOfferSpecs(
    env,
    contexts[0]!,
    contexts[1]!,
    [visibleHubs[0]!],
    [visibleHubs[1]!],
    [1],
    [1],
  )).toThrow('MARKET_MAKER_CROSS_TIMESTAMP_INVALID:0');
});

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
  expect(health.hubs[0]?.blockers).toEqual([]);
  expect(pendingRoute?.offers).toBe(0);
  expect(pendingRoute?.depthReady).toBe(false);
});

test('market maker hub discovery uses stable hubName instead of mutable display name', () => {
  const env = createEmptyEnv('market-maker-stable-hub-name');
  env.gossip = {
    getProfiles: () => [
      {
        name: 'Name Only Hub',
        entityId: entity('91'),
        runtimeId: '0xnameonly',
        metadata: {
          isHub: true,
          hubName: 'H1',
          jurisdiction: { name: 'Arrakis' },
          board: { validators: [{ signerId: addr('91') }] },
        },
      },
      {
        name: 'Desk Renamed By Admin',
        entityId: entity('90'),
        runtimeId: '0xruntime',
        metadata: {
          isHub: true,
          hubName: 'H1',
          jurisdiction: {
            name: 'Arrakis',
            chainId: 31337,
            depositoryAddress: addr('11'),
          },
          board: { validators: [{ signerId: addr('90') }] },
        },
      },
    ],
  } as Env['gossip'];

  const visibleHubs = readVisibleHubProfiles(env);
  expect(visibleHubs.map(hub => hub.entityId)).toEqual([entity('90')]);
  expect(visibleHubs[0]?.name).toBe('Desk Renamed By Admin');
  expect(visibleHubs[0]?.hubName).toBe('h1');
});

test('runtime market maker health stays red until every byte-budgeted cross market is covered', () => {
  const { env, contexts, visibleHubs, tokenIdsByContext } = buildBootstrapTopology();
  const sourceContext = contexts[0]!;
  const targetContext = contexts[1]!;
  const sourceHub = visibleHubs[0]!;
  const targetHub = visibleHubs[1]!;
  const sourceAccount = makeAccount(
    sourceContext.entityId,
    sourceHub.entityId,
    committedSameChainOffers(sourceHub.entityId, [1, 2, 3]),
  );
  const targetAccount = makeAccount(
    targetContext.entityId,
    targetHub.entityId,
    committedSameChainOffers(targetHub.entityId, [1, 2, 3]),
  );
  addReplica(env, sourceContext.entityId, sourceContext.signerId, new Map([[sourceHub.entityId, sourceAccount]]));
  addReplica(env, targetContext.entityId, targetContext.signerId, new Map([[targetHub.entityId, targetAccount]]));

  const sourceToTargetSpecs = buildMarketMakerCrossOfferSpecs(
    env,
    sourceContext,
    targetContext,
    [sourceHub],
    [targetHub],
    [1, 2, 3],
    [1, 2, 3],
  );
  const targetToSourceSpecs = buildMarketMakerCrossOfferSpecs(
    env,
    targetContext,
    sourceContext,
    [targetHub],
    [sourceHub],
    [1, 2, 3],
    [1, 2, 3],
  );
  const commitOneOfferPerPair = (account: AccountMachine, specs: ReturnType<typeof buildMarketMakerCrossOfferSpecs>): number => {
    const coveredPairs = new Set<string>();
    const pairBudget = Math.max(1, new Set(specs.map(spec => spec.pairId)).size - 1);
    for (const spec of specs) {
      if (coveredPairs.has(spec.pairId)) continue;
      account.swapOffers?.set(spec.offerId, { crossJurisdiction: spec.crossJurisdiction });
      coveredPairs.add(spec.pairId);
      if (coveredPairs.size >= pairBudget) break;
    }
    return coveredPairs.size;
  };
  const sourcePairCoverage = commitOneOfferPerPair(sourceAccount, sourceToTargetSpecs);
  const targetPairCoverage = commitOneOfferPerPair(targetAccount, targetToSourceSpecs);

  const health = getRuntimeMarketMakerHealth(
    env,
    sourceContext.entityId,
    [sourceHub.entityId],
    [1, 2, 3],
    { contexts, visibleHubs, tokenIdsByContext },
  );

  expect(health.ok).toBe(false);
  expect(health.cross.ok).toBe(false);
  expect(health.cross.expectedRoutes).toBe(2);
  expect(health.cross.routes.map(route => route.offers)).toEqual([sourcePairCoverage, targetPairCoverage]);
  expect(health.cross.routes.some(route => !route.ready)).toBe(true);
  expect(health.cross.routes.some(route => !route.depthReady)).toBe(true);
  expect(health.cross.routes.flatMap(route => route.pairs).some(pair => !pair.ready)).toBe(true);
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
  const renamedContexts = contexts.map((context) => ({
    ...context,
    jurisdictionName: `${context.jurisdictionName} renamed`,
  }));
  const renamedHubs = visibleHubs.map((hub) => ({
    ...hub,
    jurisdictionName: `${hub.jurisdictionName} renamed`,
  }));
  const renamed = buildMarketMakerBootstrapFingerprint(
    env,
    renamedContexts,
    renamedHubs,
    tokenIdsByContext,
    health,
  );

  expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(second.hash).toBe(first.hash);
  expect(shuffled.hash).toBe(first.hash);
  expect(renamed.hash).toBe(first.hash);
});
