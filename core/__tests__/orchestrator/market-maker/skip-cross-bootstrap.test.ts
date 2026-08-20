import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildDeferredMarketMakerCrossHealth,
  isMarketMakerDepthComplete,
  isMarketMakerSameDepthComplete,
  type MarketMakerHealth,
} from '../../../orchestrator/market-maker/node/mm-node-health';

const sameChainReady = (cross: MarketMakerHealth['cross'], ok: boolean): MarketMakerHealth => ({
  enabled: true,
  ok,
  entityId: '0xmm',
  expectedOffersPerHub: 60,
  expectedOffersPerPair: 20,
  connectivity: [],
  hubs: [{
    hubEntityId: '0xhub1',
    ready: true,
    depthReady: true,
    offers: 60,
    blockers: [],
    pairs: [],
  }],
  cross,
});

test('deferred skip-cross health is same-chain complete; pending-cross deferred is not', () => {
  const skipped = buildDeferredMarketMakerCrossHealth(false);
  expect(skipped).toEqual({
    applicable: false,
    ok: true,
    expectedRoutes: 0,
    expectedOffersPerRoute: 0,
    expectedOffersPerPair: 0,
    routeCount: 0,
    routes: [],
  });
  const skippedHealth = sameChainReady(skipped, true);
  expect(isMarketMakerSameDepthComplete(skippedHealth)).toBe(true);
  expect(isMarketMakerDepthComplete(skippedHealth)).toBe(true);

  const pending = buildDeferredMarketMakerCrossHealth(true);
  expect(pending.applicable).toBe(true);
  expect(pending.ok).toBe(false);
  const pendingHealth = sameChainReady(pending, false);
  expect(isMarketMakerSameDepthComplete(pendingHealth)).toBe(true);
  expect(isMarketMakerDepthComplete(pendingHealth)).toBe(false);
});

test('skip-cross forces deferred applicable=false in the MM health snapshot', () => {
  const mmRun = readFileSync(
    join(process.cwd(), 'core/orchestrator/market-maker/node/mm-node-run.ts'),
    'utf8',
  );
  const snapshot = mmRun.slice(
    mmRun.indexOf('const computeMarketMakerHealthSnapshot'),
    mmRun.indexOf('const summarizeRuntimeInputs'),
  );
  expect(snapshot).toContain('!MARKET_MAKER_SKIP_CROSS_BOOTSTRAP &&');
});
