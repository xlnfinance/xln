import type { Profile } from '../../../../entity/profile';
import { getJurisdictionStackId } from '../../../../jurisdiction/machine/jurisdiction-stack';
import { toUnixMs } from '../../../../protocol/units';
import type { RelayStore } from '../../store';
import { aggregateMarketSnapshots, type RelayTradeObservationStore } from '../aggregate';
import {
  buildEntityMarketCapEntries,
  buildShareMarketPairs,
  ENTITY_DIVIDEND_CLASS_BIT,
  type MarketCapCatalog,
  type MarketCapToken,
} from './market-cap';
import {
  buildMarketCapFacets,
  buildMarketCapJurisdictionLeaders,
  decodeMarketCapQuery,
  selectMarketCapEntries,
  type MarketCapPublicResponse,
} from './market-cap-wire';
import type { MarketPairCatalogPayload, MarketSnapshotPayload } from '../snapshot';

const MARKET_CAP_REFRESH_MS = 1_000;
const MARKET_CAP_FETCH_BATCH = 40;

type MarketCapControllerOptions = Readonly<{
  relayStore: RelayStore;
  getConnectedHubEntityIds(): string[];
  fetchPairCatalog(hubEntityId: string): Promise<MarketPairCatalogPayload>;
  fetchTokenCatalog(hubEntityId: string): Promise<MarketCapToken[]>;
  fetchSnapshots(hubEntityId: string, pairIds: string[], depth: number): Promise<MarketSnapshotPayload[]>;
}>;

export type MarketCapController = Readonly<{
  handle(url: URL): Promise<MarketCapPublicResponse>;
  clear(): void;
}>;

const profileJurisdiction = (profile: Profile): Readonly<{
  jurisdictionRef: string;
  entityProviderAddress: string;
}> | null => {
  const jurisdiction = profile.metadata.jurisdiction;
  if (
    !jurisdiction
    || !Number.isSafeInteger(jurisdiction.chainId)
    || !jurisdiction.depositoryAddress
    || !jurisdiction.entityProviderAddress
  ) return null;
  return {
    jurisdictionRef: getJurisdictionStackId({
      chainId: jurisdiction.chainId,
      depositoryAddress: jurisdiction.depositoryAddress,
    }),
    entityProviderAddress: jurisdiction.entityProviderAddress.toLowerCase(),
  };
};

const numberedProfileIds = (profiles: readonly Profile[]): bigint[] => profiles.flatMap(profile => {
  try {
    const value = BigInt(profile.entityId);
    return value > 0n && value < ENTITY_DIVIDEND_CLASS_BIT ? [value] : [];
  } catch {
    return [];
  }
});

const fetchActiveSnapshots = async (
  hubEntityId: string,
  activePairIds: readonly string[],
  fetchSnapshots: MarketCapControllerOptions['fetchSnapshots'],
): Promise<MarketSnapshotPayload[]> => {
  const batches: string[][] = [];
  for (let offset = 0; offset < activePairIds.length; offset += MARKET_CAP_FETCH_BATCH) {
    batches.push(activePairIds.slice(offset, offset + MARKET_CAP_FETCH_BATCH));
  }
  const results = await Promise.all(batches.map(batch => fetchSnapshots(hubEntityId, batch, 1)));
  return results.flat();
};

export const createMarketCapController = (options: MarketCapControllerOptions): MarketCapController => {
  const observations: RelayTradeObservationStore = new Map();
  let refreshPromise: Promise<void> | null = null;

  const refresh = async (): Promise<void> => {
    const now = Date.now();
    if (options.relayStore.marketCapUpdatedAt > 0 && now - options.relayStore.marketCapUpdatedAt < MARKET_CAP_REFRESH_MS) {
      return;
    }
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const hubEntityIds = Array.from(new Set(options.getConnectedHubEntityIds())).sort();
      const profiles = Array.from(options.relayStore.gossipProfiles.values()).map(entry => entry.profile);
      const profileById = new Map(profiles.map(profile => [profile.entityId.toLowerCase(), profile]));
      const entityNumbers = numberedProfileIds(profiles);
      const hubData = await Promise.all(hubEntityIds.map(async hubEntityId => {
        const profile = profileById.get(hubEntityId);
        const jurisdiction = profile ? profileJurisdiction(profile) : null;
        if (!jurisdiction) throw new Error(`MARKET_CAP_HUB_PROFILE_MISSING:${hubEntityId}`);
        const [pairCatalog, tokens] = await Promise.all([
          options.fetchPairCatalog(hubEntityId),
          options.fetchTokenCatalog(hubEntityId),
        ]);
        if (pairCatalog.hubEntityId !== hubEntityId) throw new Error(`MARKET_CAP_CATALOG_HUB_MISMATCH:${hubEntityId}`);
        if (pairCatalog.jurisdictionRef !== jurisdiction.jurisdictionRef) {
          throw new Error(`MARKET_CAP_CATALOG_JURISDICTION_MISMATCH:${hubEntityId}`);
        }
        const catalog: MarketCapCatalog = {
          jurisdictionRef: jurisdiction.jurisdictionRef,
          entityProviderAddress: jurisdiction.entityProviderAddress,
          tokens,
        };
        const activeBooks = new Set(pairCatalog.pairIds);
        const activePairIds = Array.from(buildShareMarketPairs(catalog, entityNumbers).values())
          .flatMap(pair => [pair.controlPairId, pair.dividendPairId])
          .filter((pair): pair is string => pair !== null && activeBooks.has(pair));
        const snapshots = await fetchActiveSnapshots(
          hubEntityId,
          Array.from(new Set(activePairIds)).sort(),
          options.fetchSnapshots,
        );
        return { catalog, snapshots };
      }));
      const snapshotsByMarket = new Map<string, MarketSnapshotPayload[]>();
      for (const snapshot of hubData.flatMap(entry => entry.snapshots)) {
        const key = `${snapshot.jurisdictionRef}:${snapshot.pairId}`;
        const values = snapshotsByMarket.get(key) ?? [];
        values.push(snapshot);
        snapshotsByMarket.set(key, values);
      }
      const observedAt = Date.now();
      const markets = Array.from(snapshotsByMarket.values()).map(snapshots =>
        aggregateMarketSnapshots(snapshots, 1, observedAt, observations)
      );
      const entries = buildEntityMarketCapEntries({
        profiles,
        onlineRuntimeIds: new Set(options.relayStore.clients.keys()),
        catalogs: hubData.map(entry => entry.catalog),
        markets,
        now: toUnixMs(observedAt),
      });
      options.relayStore.marketCapEntries = new Map(entries.map(entry => [entry.entityId, entry]));
      options.relayStore.marketCapUpdatedAt = observedAt;
    })().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  };

  return {
    handle: async url => {
      await refresh();
      const query = decodeMarketCapQuery(url.searchParams);
      const entries = Array.from(options.relayStore.marketCapEntries.values());
      const selected = selectMarketCapEntries(entries, query);
      return {
        format: 'entity-market-cap',
        generatedAt: options.relayStore.marketCapUpdatedAt,
        staleAfterMs: 5 * 60 * 1_000,
        connectedHubCount: new Set(options.getConnectedHubEntityIds()).size,
        numberedEntityCount: entries.length,
        freshCount: entries.filter(entry => entry.status === 'fresh').length,
        staleCount: entries.filter(entry => entry.status === 'stale').length,
        noPriceCount: entries.filter(entry => entry.status === 'no-price').length,
        facets: buildMarketCapFacets(entries),
        jurisdictionLeaders: buildMarketCapJurisdictionLeaders(entries),
        returned: selected.length,
        entries: selected,
      };
    },
    clear: () => {
      observations.clear();
      options.relayStore.marketCapEntries.clear();
      options.relayStore.marketCapUpdatedAt = 0;
    },
  };
};
