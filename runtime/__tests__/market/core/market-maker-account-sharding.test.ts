import { describe, expect, test } from 'bun:test';

import {
  MARKET_MAKER_BOOTSTRAP_OFFERS_PER_ACCOUNT_PER_TICK,
  MARKET_MAKER_LEVELS_PER_SIDE,
  buildMarketMakerOfferSpecs,
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

  test('admits at most five quote transactions per Account frame', () => {
    expect(MARKET_MAKER_BOOTSTRAP_OFFERS_PER_ACCOUNT_PER_TICK).toBe(5);
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
    for (const maker of contexts) {
      const offers = new Map<string, SwapOffer>(
        buildMarketMakerOfferSpecs([hub], TOKENS, maker.samePairIndex)
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
});
