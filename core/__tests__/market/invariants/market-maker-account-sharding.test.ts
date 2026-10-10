import { describe, expect, test } from 'bun:test';

import {
  MARKET_MAKER_LEVELS_PER_SIDE,
  buildMarketMakerCrossTokenPairs,
  buildMarketMakerOfferSpecs,
  mergeMarketMakerQuoteEntityInputs,
  shouldInitiateMarketMakerAccountOpen,
} from '../../../orchestrator/market-maker/node/mm-node-core';
import { planMarketMakerIdentityLabels } from '../../../orchestrator/mesh/mesh-common';
import type { MarketMakerEntityContext } from '../../../orchestrator/market-maker/node/mm-node-core';
import { getMarketMakerHealth } from '../../../orchestrator/market-maker/node/mm-node-health';
import { buildDefaultEntitySwapPairs } from '../../../account/utils';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { createEmptyEnv } from '../../../runtime';
import type { EntityReplica } from '../../../entity/types';
import type { SwapOffer } from '../../../types/account';
import { makeAccount } from '../../helpers/cross-j';

const HUB = `0x${'77'.repeat(32)}`;
const TOKENS = [1, 2, 3];
const entity = (byte: string): string => `0x${byte.repeat(32)}`;
const SIGNER = `0x${'22'.repeat(20)}`;

const context = (entityId: string, samePairIndex: number): MarketMakerEntityContext => ({
  entityId,
  signerId: SIGNER,
  jurisdictionName: 'Testnet',
  chainId: 31337,
  depositoryAddress: `0x${'33'.repeat(20)}`,
  jurisdictionRef: `stack:31337:0x${'33'.repeat(20)}`,
  roleEvidence: { entityId, isHub: false, source: 'committed-profile' },
  samePairIndex,
});

const commitShardLadders = (
  env: ReturnType<typeof createEmptyEnv>,
  hub: string,
  contexts: readonly MarketMakerEntityContext[],
  tokens: readonly number[],
): void => {
  for (const maker of contexts) {
    const offers = new Map<string, SwapOffer>(
      buildMarketMakerOfferSpecs([hub], [...tokens], maker.samePairIndex)
        .map(spec => [spec.offerId, {
          ...spec,
          makerIsLeft: true,
          giveTokenDecimals: 18,
          wantTokenDecimals: 18,
          maxFee: 0n,
          minNetReceive: 0n,
          createdHeight: 1,
          createdTimestamp: 1,
          quantizedGive: spec.giveAmount,
          quantizedWant: spec.wantAmount,
        }]),
    );
    const account = makeAccount(maker.entityId, hub);
    account.currentHeight = 1;
    // Production Account collections are Patricia-backed ReadonlyMaps, not
    // nominal `Map` instances. Health and quote dedupe must consume the
    // FinTS collection contract or a healthy persisted book appears empty.
    account.state.swapOffers = PersistentAccountStateMap.fromEntries('swapOffers', offers);
    env.state.eReplicas.set(`${maker.entityId}:${maker.signerId}`, {
      entityId: maker.entityId,
      signerId: maker.signerId,
      state: { entityId: maker.entityId, accounts: new Map([[hub, account]]) },
    } as unknown as EntityReplica);
  }
};

describe('market-maker Account sharding', () => {
  test('assigns one complete 10x2 ladder to each bilateral Account', () => {
    const pairs = buildDefaultEntitySwapPairs(TOKENS);
    const byShard = pairs.map((pair, pairIndex) => ({
      pair,
      specs: buildMarketMakerOfferSpecs([HUB], TOKENS, pairIndex),
    }));

    expect(byShard).toHaveLength(3);
    for (const { pair, specs } of byShard) {
      expect(new Set(specs.map(spec => spec.pairId))).toEqual(new Set([pair.pairId]));
      expect(specs).toHaveLength(MARKET_MAKER_LEVELS_PER_SIDE * 2);
    }
    expect(new Set(byShard.flatMap(({ specs }) => specs.map(spec => spec.offerId))).size)
      .toBe(pairs.length * MARKET_MAKER_LEVELS_PER_SIDE * 2);
  });

  test('merges all bootstrap books into one Entity input per MM Entity', () => {
    const tx = (offerId: string) => ({
      type: 'placeSwapOffer' as const,
      data: {
        counterpartyEntityId: HUB,
        offerId,
        giveTokenId: 1,
        giveTokenDecimals: 18,
        giveAmount: 1n,
        wantTokenId: 2,
        wantTokenDecimals: 18,
        wantAmount: 1n,
        maxFee: 0n,
        minNetReceive: 1n,
      },
    });
    const [merged] = mergeMarketMakerQuoteEntityInputs([
      [{ entityId: entity('11'), signerId: SIGNER, entityTxs: [tx('one')] }],
      [{ entityId: entity('11'), signerId: SIGNER, entityTxs: [tx('two')] }],
    ]);
    expect(merged?.entityTxs?.map(item => item.data.offerId)).toEqual(['one', 'two']);
  });

  test('pair shard initiates its requested Account regardless of id ordering', () => {
    expect(shouldInitiateMarketMakerAccountOpen({
      hasAccount: false,
      hasPendingConsensus: false,
      hasQueuedOpen: false,
    })).toBe(true);
    expect(shouldInitiateMarketMakerAccountOpen({
      hasAccount: false,
      hasPendingConsensus: false,
      hasQueuedOpen: true,
    })).toBe(false);
  });

  test('derives one allowlisted identity for every pair Account', () => {
    expect(planMarketMakerIdentityLabels('MM', 'Maker', TOKENS)).toEqual([
      { samePairIndex: 0, signerLabel: 'MM', profileName: 'Maker' },
      { samePairIndex: 1, signerLabel: 'MM:pair:2', profileName: 'Maker Pair 2' },
      { samePairIndex: 2, signerLabel: 'MM:pair:3', profileName: 'Maker Pair 3' },
    ]);
  });

  test('health requires and aggregates every pair Account', () => {
    const env = createEmptyEnv('mm-shards');
    const hub = entity('77');
    const contexts = [0, 1, 2].map(index => context(entity(String(index + 1)), index));
    commitShardLadders(env, hub, contexts, TOKENS);

    const health = getMarketMakerHealth(
      env,
      contexts[0]!.entityId,
      [hub],
      TOKENS,
      undefined,
      { applicable: false, ok: true, expectedRoutes: 0, expectedOffersPerRoute: 0, expectedOffersPerPair: 0, routes: [] },
      contexts,
    );
    expect(health.expectedOffersPerHub).toBe(60);
    expect(health.hubs[0]?.offers).toBe(60);
    expect(health.hubs[0]?.pairs.map(pair => pair.offers)).toEqual([20, 20, 20]);
    expect(health.hubs[0]?.depthReady).toBe(true);
  });

  test('a pair without a price policy keeps its shard but gets no ladder, same-J or cross-J', () => {
    const tokens = [1, 2, 3, 4, 5];
    const hub = entity('77');
    const pairIds = buildDefaultEntitySwapPairs(tokens).map(pair => pair.pairId);
    const unpriced = ['2/4', '2/5', '4/5'];
    // The default policy mid is 1.0000: WETH/TRX would sell WETH for one TRX.
    for (const pairId of unpriced) {
      expect(buildMarketMakerOfferSpecs([hub], tokens, pairIds.indexOf(pairId))).toEqual([]);
    }
    expect(buildMarketMakerOfferSpecs([hub], tokens).some(spec => unpriced.includes(spec.pairId))).toBe(false);
    const crossPairs = buildMarketMakerCrossTokenPairs(tokens, [1, 2, 3]);
    expect(crossPairs).not.toContainEqual({ sourceTokenId: 4, targetTokenId: 2 });
    expect(crossPairs).not.toContainEqual({ sourceTokenId: 5, targetTokenId: 2 });
    expect(crossPairs).toContainEqual({ sourceTokenId: 4, targetTokenId: 1 });
    expect(crossPairs).toContainEqual({ sourceTokenId: 2, targetTokenId: 2 });

    const env = createEmptyEnv('mm-shards-unpriced');
    const contexts = pairIds.map((_, index) => context(entity((index + 1).toString(16).padStart(2, '0')), index));
    commitShardLadders(env, hub, contexts, tokens);
    const health = getMarketMakerHealth(
      env,
      contexts[0]!.entityId,
      [hub],
      tokens,
      undefined,
      { applicable: false, ok: true, expectedRoutes: 0, expectedOffersPerRoute: 0, expectedOffersPerPair: 0, routes: [] },
      contexts,
    );
    expect(health.hubs[0]?.pairs.map(pair => pair.pairId)).toEqual(pairIds.filter(pairId => !unpriced.includes(pairId)));
    expect(health.expectedOffersPerHub).toBe(7 * MARKET_MAKER_LEVELS_PER_SIDE * 2);
    expect(health.hubs[0]?.depthReady).toBe(true);
  });
});
