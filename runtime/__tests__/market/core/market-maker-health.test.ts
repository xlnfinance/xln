import { expect, test } from 'bun:test';

import {
  createMarketMakerServerState,
  getMarketMakerHealth as getServerMarketMakerHealth,
} from '../../../api/server/health/market-maker';
import { buildDefaultEntitySwapPairs, getTokenInfo } from '../../../account/utils';
import { deriveSwapNetAuthorization } from '../../../account/swap/swap-net-authorization';
import { handleSwapOffer } from '../../../account/tx/handlers/swap/offer/index';
import { deriveSameOrderbookMaterialization } from '../../../entity/tx/handlers/account/orderbook/helpers';
import { buildMarketSnapshotForReplica } from '../../../network/relay/market/snapshot';
import { applyCommand, createBook } from '../../../orderbook';
import { markWorkingOrderbookOffer } from '../../../orderbook/swap-execution';
import {
  buildMarketMakerOfferSpecs,
  buildMarketMakerBootstrapFingerprint,
  buildMarketMakerCrossHealth,
  buildMarketMakerCrossOfferSpecs,
  deriveMarketMakerCrossExpiryAt,
  getMarketMakerHealth as getRuntimeMarketMakerHealth,
  hasFinalizedMarketMakerCrossOffer,
  readVisibleHubProfiles,
  type HubProfile,
  type MarketMakerEntityContext,
  type MarketMakerHealth,
  type MarketMakerTokenIdsByContext,
} from '../../../orchestrator/mm-node';
import { getBootstrapCreditAmount, HUB_DEFAULT_MIN_TRADE_SIZE } from '../../../orchestrator/mesh/mesh-common';
import { createEmptyEnv } from '../../../runtime';
import type { AccountReplica, SwapOffer } from '../../../types/account';
import type { EntityReplica } from '../../../entity/types';
import type { RuntimeReplica } from '../../../runtime/types';
import { createDefaultDelta } from '../../../account/state/delta';
import { LIMITS } from '../../../config/constants';
import { encodeBuffer } from '../../../storage/codec/codec';
import { makeAccount as makeCanonicalAccount } from '../../helpers/cross-j';

const entity = (byte: string): string => `0x${byte.repeat(32)}`;
const addr = (byte: string): string => `0x${byte.repeat(20)}`;
const stackRef = (chainId: number, byte: string): string => `stack:${chainId}:${addr(byte)}`;

test('default market maker depth fits every quote leg and aggregate hold inside bootstrap credit', () => {
  const specs = buildMarketMakerOfferSpecs(
    ['0x0000000000000000000000000000000000abcdef'],
    [1, 2, 3],
  );
  const aggregateGiveByToken = new Map<number, bigint>();

  expect(specs).toHaveLength(60);
  const offersByPairSide = new Map<string, number>();
  for (const spec of specs) {
    const side = spec.giveTokenId < spec.wantTokenId ? 'ask' : 'bid';
    const key = `${spec.pairId}:${side}`;
    offersByPairSide.set(key, (offersByPairSide.get(key) ?? 0) + 1);
  }
  expect(Array.from(offersByPairSide.values())).toEqual([10, 10, 10, 10, 10, 10]);
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

  const health = getServerMarketMakerHealth({} as RuntimeReplica, state, () => null);

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
    state: { swapOffers: new Map([
      ['mm-abcdef-2-1-ask-1', {}],
      ['mm-abcdef-1-3-ask-1', {}],
      ['mm-abcdef-2-3-ask-1', {}],
    ]) },
    currentHeight: 1,
    mempool: [],
    pendingFrame: null,
  };
  const health = getServerMarketMakerHealth({} as RuntimeReplica, state, () => account as any);

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
  const health = getServerMarketMakerHealth({} as RuntimeReplica, state, () => ({
    state: { swapOffers: offers },
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

  const health = getServerMarketMakerHealth({} as RuntimeReplica, state, () => ({
    state: { swapOffers: new Map() },
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
      config: { jurisdiction: { chainId: 31337, depositoryAddress: addr('aa') } },
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
  swapOffers: Map<string, SwapOffer> = new Map(),
): AccountReplica => {
  const account = makeCanonicalAccount(ownerEntityId, counterpartyEntityId);
  account.currentHeight = 1;
  account.state.swapOffers = swapOffers;
  return account;
};

test('five-token market maker depth remains canonical through Account and hub admission', async () => {
  const mmEntityId = entity('a');
  const hubEntityId = entity('b');
  const account = makeAccount(mmEntityId, hubEntityId);
  for (const tokenId of [1, 2, 3, 4, 5]) {
    const delta = createDefaultDelta(tokenId);
    delta.leftCreditLimit = getBootstrapCreditAmount(tokenId);
    delta.rightCreditLimit = getBootstrapCreditAmount(tokenId);
    account.state.deltas.set(tokenId, delta);
  }

  const specs = buildMarketMakerOfferSpecs([hubEntityId], [1, 2, 3, 4, 5]);
  expect(specs).toHaveLength(200);
  const rejected: string[] = [];

  for (const spec of specs) {
    const netAuthorization = deriveSwapNetAuthorization(spec.wantAmount, 1);
    const result = await handleSwapOffer(account, {
      type: 'swap_offer',
      data: {
        offerId: spec.offerId,
        giveTokenId: spec.giveTokenId,
        giveTokenDecimals: getTokenInfo(spec.giveTokenId).decimals,
        giveAmount: spec.giveAmount,
        wantTokenId: spec.wantTokenId,
        wantTokenDecimals: getTokenInfo(spec.wantTokenId).decimals,
        wantAmount: spec.wantAmount,
        ...netAuthorization,
        priceTicks: spec.priceTicks,
      },
    }, true, 1);
    expect(result.ok ? undefined : result.rejection.message).toBeUndefined();
    expect(result.ok).toBe(true);

    const offer = account.state.swapOffers.get(spec.offerId)!;
    expect(offer.priceTicks).toBe(spec.priceTicks);
    const working = markWorkingOrderbookOffer({
      offerId: offer.offerId,
      accountId: hubEntityId,
      makerIsLeft: offer.makerIsLeft,
      fromEntity: account.state.leftEntity,
      toEntity: account.state.rightEntity,
      createdHeight: offer.createdHeight,
      giveTokenId: offer.giveTokenId,
      giveTokenDecimals: offer.giveTokenDecimals,
      giveAmount: offer.giveAmount,
      wantTokenId: offer.wantTokenId,
      wantTokenDecimals: offer.wantTokenDecimals,
      wantAmount: offer.wantAmount,
      quantizedGive: offer.quantizedGive,
      quantizedWant: offer.quantizedWant,
      priceTicks: offer.priceTicks,
      timeInForce: offer.timeInForce ?? 0,
    });
    if (working.orderbookKind !== 'same-jurisdiction') {
      throw new Error(`MARKET_MAKER_SAME_CHAIN_SPEC_BECAME_CROSS_J:${spec.offerId}`);
    }
    const materialized = deriveSameOrderbookMaterialization(working, HUB_DEFAULT_MIN_TRADE_SIZE);
    if (materialized.kind === 'reject') rejected.push(`${spec.offerId}:${materialized.reason}`);
  }

  expect(account.state.swapOffers.size).toBe(200);
  expect(encodeBuffer(account.state.swapOffers).byteLength).toBeGreaterThan(LIMITS.MAX_STORAGE_VALUE_BYTES);
  expect(rejected).toEqual([]);
});

const addReplica = (
  env: RuntimeReplica,
  entityId: string,
  signerId: string,
  accounts: Map<string, AccountReplica> = new Map(),
): void => {
  env.state.eReplicas.set(`${entityId}:${signerId}`, {
    entityId,
    signerId,
    entityEncPubKey: '',
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

const committedSameChainOffers = (hubEntityId: string, tokenIds: number[]): Map<string, SwapOffer> => {
  return new Map(buildMarketMakerOfferSpecs([hubEntityId], tokenIds).map(spec => [spec.offerId, {
    offerId: spec.offerId,
    makerIsLeft: true,
    fromEntity: 'market-maker',
    toEntity: hubEntityId,
    accountId: hubEntityId,
    createdHeight: 1,
    giveTokenId: spec.giveTokenId,
    giveAmount: spec.giveAmount,
    wantTokenId: spec.wantTokenId,
    wantAmount: spec.wantAmount,
    priceTicks: spec.priceTicks,
    timeInForce: 0,
  }]));
};

const buildBootstrapTopology = (): {
  env: RuntimeReplica;
  contexts: MarketMakerEntityContext[];
  visibleHubs: HubProfile[];
  tokenIdsByContext: MarketMakerTokenIdsByContext;
} => {
  const env = createEmptyEnv('market-maker-bootstrap-health');
  env.state.timestamp = 1_000;
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
      roleEvidence: { entityId: entity('10'), isHub: false, source: 'committed-profile' },
    },
    {
      entityId: entity('20'),
      signerId: addr('20'),
      jurisdictionName: 'Tron',
      chainId: 31338,
      depositoryAddress: addr('22'),
      jurisdictionRef: stackRef(31338, '22'),
      roleEvidence: { entityId: entity('20'), isHub: false, source: 'committed-profile' },
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
      roleEvidence: { entityId: entity('30'), isHub: true, source: 'verified-gossip-profile' },
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
      roleEvidence: { entityId: entity('40'), isHub: true, source: 'verified-gossip-profile' },
    },
  ];
  env.infrastructure.verifiedProfileRoutes = new Map([
    ...contexts.map(context => [context.entityId.toLowerCase(), {
      runtimeId: env.runtimeId,
      runtimeSignerId: context.signerId,
      runtimeEncPubKey: '',
      lastUpdated: env.state.timestamp,
    }] as const),
    ...visibleHubs.map(hub => [hub.entityId.toLowerCase(), {
      runtimeId: hubRuntimeId,
      runtimeSignerId: hub.signerId,
      runtimeEncPubKey: '',
      lastUpdated: env.state.timestamp,
    }] as const),
  ]);
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
  } as RuntimeReplica['gossip'];
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
  const sameJurisdictionSpecs = buildMarketMakerOfferSpecs([sourceHub.entityId], sourceTokenIds);
  const specs = [...sameJurisdictionSpecs, ...crossSpecs];
  const aggregateGiveByToken = new Map<number, bigint>();

  // One Account carries pulls from both directed jurisdiction routes. Each
  // direction gets half of the 32-slot Account budget so reciprocal MM depth
  // remains symmetric and atomically dispute-enforceable.
  expect(crossSpecs).toHaveLength(LIMITS.MAX_ACCOUNT_CROSS_J_SWAP_OFFERS / 2);
  expect(specs).toHaveLength(
    sameJurisdictionSpecs.length + LIMITS.MAX_ACCOUNT_CROSS_J_SWAP_OFFERS / 2,
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
  env.state.timestamp = 0;

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

test('cross stablecoin depth fully covers a 300 USDC wallet order', () => {
  const { env, contexts, visibleHubs } = buildBootstrapTopology();
  addReplica(env, contexts[0]!.entityId, contexts[0]!.signerId);
  addReplica(env, contexts[1]!.entityId, contexts[1]!.signerId);
  const specs = buildMarketMakerCrossOfferSpecs(
    env,
    contexts[0]!,
    contexts[1]!,
    [visibleHubs[0]!],
    [visibleHubs[1]!],
    [1],
    [1],
  );
  const sourceDepth = specs.reduce((sum, spec) => sum + spec.giveAmount, 0n);

  expect(specs).toHaveLength(10);
  expect(sourceDepth).toBeGreaterThanOrEqual(300n * 10n ** 6n);
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
        crossJurisdiction: pendingSpec.crossJurisdiction!,
      },
    }],
  } as AccountState['pendingFrame'];

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
  } as RuntimeReplica['gossip'];

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
  const commitOneOfferPerPair = (account: AccountReplica, specs: ReturnType<typeof buildMarketMakerCrossOfferSpecs>): number => {
    const coveredPairs = new Set<string>();
    const pairBudget = Math.max(1, new Set(specs.map(spec => spec.pairId)).size - 1);
    for (const spec of specs) {
      if (coveredPairs.has(spec.pairId)) continue;
      account.state.swapOffers.set(spec.offerId, {
        offerId: spec.offerId,
        makerIsLeft: true,
        fromEntity: account.state.leftEntity,
        toEntity: account.state.rightEntity,
        accountId: account.proofHeader.toEntity,
        createdHeight: 1,
        giveTokenId: spec.giveTokenId,
        giveAmount: spec.giveAmount,
        wantTokenId: spec.wantTokenId,
        wantAmount: spec.wantAmount,
        priceTicks: spec.priceTicks,
        timeInForce: 0,
        crossJurisdiction: spec.crossJurisdiction,
      });
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
  expect(health.cross.routes.flatMap(route => route.pairs).every(pair =>
    pair.expectedBidOffers + pair.expectedAskOffers === pair.expectedOffers
  )).toBe(true);
  expect(health.cross.routes.flatMap(route => route.pairs).every(pair =>
    pair.expectedBidOffers === 0 || pair.expectedAskOffers === 0
  )).toBe(true);
});

test('market maker cross order identity is stable within one expiry generation', () => {
  const { env, contexts, visibleHubs } = buildBootstrapTopology();
  const sourceContext = contexts[0]!;
  const targetContext = contexts[1]!;
  const sourceHub = visibleHubs[0]!;
  const targetHub = visibleHubs[1]!;
  addReplica(env, sourceContext.entityId, sourceContext.signerId);
  addReplica(env, targetContext.entityId, targetContext.signerId);
  env.state.timestamp = 10_000;
  const build = () => buildMarketMakerCrossOfferSpecs(
    env,
    sourceContext,
    targetContext,
    [sourceHub],
    [targetHub],
    [1, 2, 3],
    [1, 2, 3],
  );
  const first = build();
  const firstExpiry = deriveMarketMakerCrossExpiryAt(env.state.timestamp);
  env.state.timestamp += 1;
  const retry = build();
  expect(retry.map(spec => spec.crossJurisdiction))
    .toEqual(first.map(spec => spec.crossJurisdiction));
  expect(retry.map(spec => [spec.offerId, spec.crossJurisdiction?.routeHash]))
    .toEqual(first.map(spec => [spec.offerId, spec.crossJurisdiction?.routeHash]));
  expect(first.every(spec => spec.crossJurisdiction?.expiresAt === firstExpiry)).toBe(true);
  expect(first.every(spec => /^mmx-[0-9a-f]{6}-[0-9a-f]{6}-\d+-\d+-[0-9a-f]{64}-sell-\d+$/.test(spec.offerId)))
    .toBe(true);

  env.state.timestamp = firstExpiry;
  const nextGeneration = build();
  expect(nextGeneration.map(spec => spec.offerId)).not.toEqual(first.map(spec => spec.offerId));
  expect(nextGeneration.map(spec => spec.crossJurisdiction?.routeHash))
    .not.toEqual(first.map(spec => spec.crossJurisdiction?.routeHash));
  const hashesById = new Map<string, Set<string>>();
  for (const spec of [...first, ...retry, ...nextGeneration]) {
    const hashes = hashesById.get(spec.offerId) ?? new Set<string>();
    hashes.add(String(spec.crossJurisdiction?.routeHash || ''));
    hashesById.set(spec.offerId, hashes);
  }
  expect([...hashesById.values()].every(hashes => hashes.size === 1)).toBe(true);

  const revisedSignerId = addr('12');
  env.infrastructure!.verifiedProfileRoutes!.set(sourceContext.entityId.toLowerCase(), {
    runtimeId: env.runtimeId,
    runtimeSignerId: revisedSignerId,
    runtimeEncPubKey: '',
    lastUpdated: env.state.timestamp,
  });
  const revisedTerms = buildMarketMakerCrossOfferSpecs(
    env,
    { ...sourceContext, signerId: revisedSignerId },
    targetContext,
    [sourceHub],
    [targetHub],
    [1, 2, 3],
    [1, 2, 3],
  );
  expect(revisedTerms).toHaveLength(nextGeneration.length);
  expect(revisedTerms.map(spec => spec.offerId)).not.toEqual(nextGeneration.map(spec => spec.offerId));
  expect(revisedTerms.map(spec => spec.crossJurisdiction?.routeHash))
    .not.toEqual(nextGeneration.map(spec => spec.crossJurisdiction?.routeHash));
});

test('market maker advances only the cross quote slot that committed a close', () => {
  const { env, contexts, visibleHubs } = buildBootstrapTopology();
  const sourceContext = contexts[0]!;
  const targetContext = contexts[1]!;
  const sourceHub = visibleHubs[0]!;
  const targetHub = visibleHubs[1]!;
  const sourceAccount = makeAccount(sourceContext.entityId, sourceHub.entityId);
  addReplica(env, sourceContext.entityId, sourceContext.signerId, new Map([[sourceHub.entityId, sourceAccount]]));
  addReplica(env, targetContext.entityId, targetContext.signerId);
  const build = () => buildMarketMakerCrossOfferSpecs(
    env,
    sourceContext,
    targetContext,
    [sourceHub],
    [targetHub],
    [1],
    [1],
  );
  const initial = build();
  const closed = initial[0]!;
  sourceAccount.swapClosedOrders.set(closed.offerId, {
    offerId: closed.offerId,
    giveTokenId: closed.giveTokenId,
    giveTokenDecimals: getTokenInfo(closed.giveTokenId).decimals,
    giveAmount: closed.giveAmount,
    wantTokenId: closed.wantTokenId,
    wantTokenDecimals: getTokenInfo(closed.wantTokenId).decimals,
    wantAmount: closed.wantAmount,
    priceTicks: closed.priceTicks,
    createdHeight: 6,
    crossJurisdiction: closed.crossJurisdiction,
    cancelRequested: false,
    lastUpdatedHeight: 7,
    resolves: [],
  });

  const replenished = build();
  expect(replenished).toHaveLength(initial.length);
  expect(replenished[0]!.offerId).not.toBe(closed.offerId);
  expect(replenished[0]!.crossJurisdiction?.routeHash)
    .not.toBe(closed.crossJurisdiction?.routeHash);
  expect(replenished.slice(1).map(spec => spec.offerId))
    .toEqual(initial.slice(1).map(spec => spec.offerId));
  expect(build().map(spec => [spec.offerId, spec.crossJurisdiction?.routeHash]))
    .toEqual(replenished.map(spec => [spec.offerId, spec.crossJurisdiction?.routeHash]));
});

test('market maker does not reuse a terminal cross route after bounded close history prunes it', () => {
  const { env, contexts, visibleHubs } = buildBootstrapTopology();
  const sourceContext = contexts[0]!;
  const targetContext = contexts[1]!;
  const sourceHub = visibleHubs[0]!;
  const targetHub = visibleHubs[1]!;
  const sourceAccount = makeAccount(sourceContext.entityId, sourceHub.entityId);
  addReplica(env, sourceContext.entityId, sourceContext.signerId, new Map([[sourceHub.entityId, sourceAccount]]));
  addReplica(env, targetContext.entityId, targetContext.signerId);
  const build = () => buildMarketMakerCrossOfferSpecs(
    env,
    sourceContext,
    targetContext,
    [sourceHub],
    [targetHub],
    [1],
    [1],
  );
  const terminal = build()[0]!;
  const sourceReplica = env.state.eReplicas.get(`${sourceContext.entityId}:${sourceContext.signerId}`)!;
  sourceReplica.state.crossJurisdictionSwaps = new Map([[terminal.offerId, {
    ...terminal.crossJurisdiction!,
    status: 'settled',
    updatedAt: env.state.timestamp + 7,
    settledAt: env.state.timestamp + 7,
  }]]);
  sourceAccount.swapClosedOrders.clear();

  const replenished = build();
  expect(replenished[0]!.offerId).not.toBe(terminal.offerId);
  expect(build().map(spec => spec.offerId)).toEqual(replenished.map(spec => spec.offerId));
});

test('market maker finalized cross matching requires the exact immutable route hash', () => {
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
  account.state.swapOffers.set(spec.offerId, {
    offerId: spec.offerId,
    giveTokenId: spec.giveTokenId,
    giveTokenDecimals: getTokenInfo(spec.giveTokenId).decimals,
    giveAmount: spec.giveAmount,
    wantTokenId: spec.wantTokenId,
    wantTokenDecimals: getTokenInfo(spec.wantTokenId).decimals,
    wantAmount: spec.wantAmount,
    maxFee: 0n,
    minNetReceive: 0n,
    priceTicks: route.priceTicks,
    makerIsLeft: true,
    createdHeight: 1,
    quantizedGive: spec.giveAmount,
    quantizedWant: spec.wantAmount,
    crossJurisdiction: route,
  } satisfies SwapOffer);

  expect(hasFinalizedMarketMakerCrossOffer(env, spec)).toBe(true);
  const fingerprintHealth: MarketMakerHealth = {
    enabled: true,
    ok: false,
    entityId: sourceContext.entityId,
    expectedOffersPerHub: 0,
    expectedOffersPerPair: 0,
    hubs: [],
    cross: buildMarketMakerCrossHealth(env, contexts, visibleHubs, new Map(
      contexts.map(context => [context.entityId, [1, 2, 3]]),
    )),
  };
  const fingerprint = buildMarketMakerBootstrapFingerprint(
    env,
    contexts,
    visibleHubs,
    new Map(contexts.map(context => [context.entityId, [1, 2, 3]])),
    fingerprintHealth,
  );
  const committed = (fingerprint.payload['cross'] as {
    offersCommitted: Array<Record<string, unknown>>;
  }).offersCommitted;
  expect(committed).toHaveLength(1);
  expect(committed[0]).toMatchObject({
    giveTokenDecimals: getTokenInfo(spec.giveTokenId).decimals,
    wantTokenDecimals: getTokenInfo(spec.wantTokenId).decimals,
    routeStatus: route.status,
  });
  account.state.swapOffers.set(spec.offerId, {
    ...account.state.swapOffers.get(spec.offerId),
    crossJurisdiction: {
      ...route,
      routeHash: `0x${'ab'.repeat(32)}`,
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
