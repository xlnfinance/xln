import { buildDefaultEntitySwapPairs } from '../account-utils';
import type { AccountMachine, Env } from '../types';

const MARKET_MAKER_LEVEL_OFFSETS_BPS = [2, 4, 6, 8, 10, 12, 15, 20, 25, 32, 40, 50, 65, 80, 100] as const;
const MARKET_MAKER_LEVEL_BASE_SIZES = [
  120n * 10n ** 18n, 140n * 10n ** 18n, 160n * 10n ** 18n,
  180n * 10n ** 18n, 210n * 10n ** 18n, 240n * 10n ** 18n,
  270n * 10n ** 18n, 300n * 10n ** 18n, 360n * 10n ** 18n,
  420n * 10n ** 18n, 500n * 10n ** 18n, 600n * 10n ** 18n,
  720n * 10n ** 18n, 840n * 10n ** 18n, 960n * 10n ** 18n,
] as const;
const MARKET_MAKER_STABLE_LEVEL_OFFSETS_BPS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 28, 36, 48] as const;
const MARKET_MAKER_STABLE_LEVEL_BASE_SIZES = [
  120n * 10n ** 18n, 140n * 10n ** 18n, 180n * 10n ** 18n,
  210n * 10n ** 18n, 240n * 10n ** 18n, 300n * 10n ** 18n,
  360n * 10n ** 18n, 420n * 10n ** 18n, 480n * 10n ** 18n,
  560n * 10n ** 18n, 640n * 10n ** 18n, 720n * 10n ** 18n,
  800n * 10n ** 18n, 900n * 10n ** 18n, 1_000n * 10n ** 18n,
] as const;
const MARKET_MAKER_MIN_READY_OFFERS_PER_PAIR = 20;

type MarketMakerLevelProfile = {
  offsetsBps: readonly number[];
  baseSizes: readonly bigint[];
};

type MarketMakerPair = { baseTokenId: number; quoteTokenId: number; pairId: string };
export type MarketMakerServerState = {
  loopTimer: ReturnType<typeof setInterval> | null;
  entityId: string | null;
  targetHubIds: string[];
  tokenIds: number[];
};

export const createMarketMakerServerState = (): MarketMakerServerState => ({
  loopTimer: null,
  entityId: null,
  targetHubIds: [],
  tokenIds: [],
});

export const resetMarketMakerServerState = (state: MarketMakerServerState): void => {
  if (state.loopTimer) clearInterval(state.loopTimer);
  state.loopTimer = null;
  state.entityId = null;
  state.targetHubIds = [];
  state.tokenIds = [];
};

const getMarketMakerLevelProfile = (baseTokenId: number, quoteTokenId: number): MarketMakerLevelProfile => {
  if (baseTokenId === 1 && quoteTokenId === 3) {
    return {
      offsetsBps: MARKET_MAKER_STABLE_LEVEL_OFFSETS_BPS,
      baseSizes: MARKET_MAKER_STABLE_LEVEL_BASE_SIZES,
    };
  }
  return { offsetsBps: MARKET_MAKER_LEVEL_OFFSETS_BPS, baseSizes: MARKET_MAKER_LEVEL_BASE_SIZES };
};

const getExpectedMarketMakerOffersForPair = (baseTokenId: number, quoteTokenId: number): number =>
  Math.min(MARKET_MAKER_MIN_READY_OFFERS_PER_PAIR, getMarketMakerLevelProfile(baseTokenId, quoteTokenId).offsetsBps.length * 2);

const buildMarketMakerPairs = (tokenIds: number[]): MarketMakerPair[] => buildDefaultEntitySwapPairs(tokenIds);

const collectCommittedOfferIdsForAccount = (
  account: Pick<AccountMachine, 'swapOffers'> | null | undefined,
): Set<string> => {
  const ids = new Set<string>();
  if (account?.swapOffers instanceof Map) {
    for (const offerId of account.swapOffers.keys()) ids.add(String(offerId));
  }
  return ids;
};

const countMarketMakerOffersForHub = (
  account: Pick<AccountMachine, 'swapOffers' | 'mempool' | 'pendingFrame'> | null,
  hubEntityId: string,
): number => {
  const prefix = `mm-${hubEntityId.slice(-6).toLowerCase()}-`;
  let count = 0;
  for (const offerId of collectCommittedOfferIdsForAccount(account)) {
    if (offerId.startsWith(prefix)) count += 1;
  }
  return count;
};

const countMarketMakerOffersForHubPair = (
  account: Pick<AccountMachine, 'swapOffers' | 'mempool' | 'pendingFrame'> | null,
  hubEntityId: string,
  pair: Pick<MarketMakerPair, 'baseTokenId' | 'quoteTokenId'>,
): number => {
  const prefix = `mm-${hubEntityId.slice(-6).toLowerCase()}-${pair.baseTokenId}-${pair.quoteTokenId}-`;
  let count = 0;
  for (const offerId of collectCommittedOfferIdsForAccount(account)) {
    if (offerId.startsWith(prefix)) count += 1;
  }
  return count;
};

const accountReady = (
  account: Pick<AccountMachine, 'status' | 'currentHeight' | 'mempool' | 'pendingFrame'> | null | undefined,
): boolean =>
  Boolean(account) &&
  String(account?.status || 'active') === 'active' &&
  Number(account?.currentHeight ?? 0) > 0 &&
  !account?.pendingFrame &&
  Number(account?.mempool?.length || 0) === 0;

export const getMarketMakerHealth = (
  env: Env | null,
  state: MarketMakerServerState,
  getAccountMachine: (env: Env, entityId: string, counterpartyId: string) => AccountMachine | null,
): {
  enabled: boolean;
  ok: boolean;
  entityId: string | null;
  expectedOffersPerHub: number;
  expectedOffersPerPair: number;
  cross: {
    applicable: boolean;
    ok: boolean;
    expectedRoutes: number;
    expectedOffersPerRoute: number;
    expectedOffersPerPair: number;
    routes: [];
  };
  hubs: Array<{
    hubEntityId: string;
    offers: number;
    ready: boolean;
    depthReady: boolean;
    blockers?: Array<{
      reason: 'missing-account' | 'inactive-account' | 'height-zero' | 'pending-frame' | 'mempool';
      currentHeight: number | null;
      pendingFrame: boolean;
      pendingFrameHeight: number | null;
      mempoolLength: number;
      swapOffers: number;
    }>;
    pairs: Array<{ pairId: string; offers: number; ready: boolean; depthReady: boolean; expectedOffers: number }>;
  }>;
} => {
  const entityId = state.entityId;
  const hubs = [...state.targetHubIds];
  const pairs = buildMarketMakerPairs(state.tokenIds);
  const expectedOffersPerPair = Math.max(...pairs.map(pair => getExpectedMarketMakerOffersForPair(pair.baseTokenId, pair.quoteTokenId)), 0);
  const expectedOffersPerHub = pairs.reduce(
    (sum, pair) => sum + getExpectedMarketMakerOffersForPair(pair.baseTokenId, pair.quoteTokenId),
    0,
  );
  const cross = {
    applicable: false,
    ok: true,
    expectedRoutes: 0,
    expectedOffersPerRoute: 0,
    expectedOffersPerPair: 0,
    routes: [] as [],
  };

  if (!entityId || hubs.length === 0 || expectedOffersPerHub <= 0) {
    return { enabled: false, ok: false, entityId: entityId || null, expectedOffersPerHub: Math.max(0, expectedOffersPerHub), expectedOffersPerPair, cross, hubs: [] };
  }

  if (!env) {
    return {
      enabled: true,
      ok: false,
      entityId,
      expectedOffersPerHub,
      expectedOffersPerPair,
      cross,
      hubs: hubs.map(hubEntityId => ({
        hubEntityId,
        offers: 0,
        ready: false,
        depthReady: false,
        pairs: pairs.map(pair => ({
          pairId: pair.pairId,
          offers: 0,
          ready: false,
          depthReady: false,
          expectedOffers: getExpectedMarketMakerOffersForPair(pair.baseTokenId, pair.quoteTokenId),
        })),
      })),
    };
  }

  const perHub = hubs.map(hubEntityId => {
    const account = getAccountMachine(env, entityId, hubEntityId);
    const isAccountReady = accountReady(account);
    let reason: 'missing-account' | 'inactive-account' | 'height-zero' | 'pending-frame' | 'mempool' | null = null;
    if (!account) reason = 'missing-account';
    else if (String(account.status || 'active') !== 'active') reason = 'inactive-account';
    else if (Number(account.currentHeight ?? 0) <= 0) reason = 'height-zero';
    else if (account.pendingFrame) reason = 'pending-frame';
    else if (Number(account.mempool?.length || 0) > 0) reason = 'mempool';
    const offers = countMarketMakerOffersForHub(account, hubEntityId);
    const pairHealth = pairs.map(pair => {
      const pairOffers = countMarketMakerOffersForHubPair(account, hubEntityId, pair);
      const expectedPairOffers = getExpectedMarketMakerOffersForPair(pair.baseTokenId, pair.quoteTokenId);
      return {
        pairId: pair.pairId,
        offers: pairOffers,
        ready: isAccountReady && expectedPairOffers > 0 && pairOffers > 0,
        depthReady: isAccountReady && expectedPairOffers > 0 && pairOffers >= expectedPairOffers,
        expectedOffers: expectedPairOffers,
      };
    });
    return {
      hubEntityId,
      offers,
      ready: isAccountReady && expectedOffersPerHub > 0 && pairHealth.every(pair => pair.ready),
      depthReady: isAccountReady && expectedOffersPerHub > 0 && offers >= expectedOffersPerHub && pairHealth.every(pair => pair.depthReady),
      blockers: reason ? [{
        reason,
        currentHeight: account ? Number(account.currentHeight ?? 0) : null,
        pendingFrame: Boolean(account?.pendingFrame),
        pendingFrameHeight: account?.pendingFrame ? Number(account.pendingFrame.height ?? 0) : null,
        mempoolLength: Number(account?.mempool?.length || 0),
        swapOffers: Number(account?.swapOffers?.size || 0),
      }] : [],
      pairs: pairHealth,
    };
  });

  return { enabled: true, ok: perHub.length > 0 && perHub.every(entry => entry.depthReady), entityId, expectedOffersPerHub, expectedOffersPerPair, cross, hubs: perHub };
};
