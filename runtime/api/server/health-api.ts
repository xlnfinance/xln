import type { RuntimeReplica } from '../../runtime/types';
import { getHealthStatus, type HealthStatus, type HubHealth } from './health';
import type { JTokenInfo } from '../../jurisdiction/adapter/types';
import { getStorageHealthSnapshotSync } from '../../infra/storage-monitor';
import { getAllGossipProfiles, normalizeRuntimeKey, type RelayStore } from '../../network/relay/store';
import type { Profile } from '../../entity/profile';
import { publicRuntimeHealthBody } from './health-redaction';
import { buildDiskSummary } from './utils';
import { getReplicaAccountCount, getReplicaReserveSnapshot } from './entity-lookup';
import {
  HUB_MESH_CREDIT_AMOUNT,
  HUB_MESH_REQUIRED_HUBS,
  HUB_MESH_TOKEN_ID,
  HUB_REQUIRED_TOKEN_COUNT,
  getBootstrapReserveHealth,
  getHubMeshHealth,
} from './hub-health';
import type { MarketMakerServerState } from './market-maker-health';
import { getMarketMakerHealth } from './market-maker-health';
import { withRuntimeCommittedRead } from '../../runtime/frame/writer-lock';

export type RuntimeHealthCacheEntry = {
  fullBody: string;
  publicBody: string;
  expiresAt: number;
};

export type RuntimeHealthDeps = {
  env: RuntimeReplica | null;
  relayStore: RelayStore;
  healthCacheTtlMs: number;
  cachedHealthResponse: RuntimeHealthCacheEntry | null;
  setCachedHealthResponse: (entry: RuntimeHealthCacheEntry | null) => void;
  cachedHealthInFlight: Promise<{ fullBody: string; publicBody: string }> | null;
  setCachedHealthInFlight: (work: Promise<{ fullBody: string; publicBody: string }> | null) => void;
  boot: {
    phase: string;
    startedAt: number;
    completedAt: number | null;
    error: string | null;
  };
  activeHubEntityIds: string[];
  marketMakerState: MarketMakerServerState;
  getAccountReplica: Parameters<typeof getMarketMakerHealth>[2];
  ensureTokenCatalog: () => Promise<JTokenInfo[]>;
};

type HealthBodies = { fullBody: string; publicBody: string };

const healthResponse = (
  body: HealthBodies,
  includeOperatorHealth: boolean,
  headers: HeadersInit,
): Response => new Response(includeOperatorHealth ? body.fullBody : body.publicBody, {
  headers: { ...headers, 'Cache-Control': 'private, max-age=10' },
});

const collectRelayHealth = (deps: RuntimeHealthDeps) => {
  const activeClientRuntimeIds = Array.from(deps.relayStore.clients.keys());
  const clientsDetailed = Array.from(deps.relayStore.clients.entries()).map(([runtimeId, client]) => ({
    runtimeId,
    lastSeen: client.lastSeen,
    ageMs: Math.max(0, Date.now() - client.lastSeen),
    topics: Array.from(client.topics || []),
  }));
  const profiles = getAllGossipProfiles(deps.relayStore);
  const profileSummaries = profiles
    .map((profile: Profile) => ({
      entityId: profile.entityId,
      runtimeId: profile.runtimeId || null,
      name: profile.name,
      isHub: profile.metadata.isHub === true,
      lastUpdated: profile.lastUpdated,
    }))
    .sort((left, right) => right.lastUpdated - left.lastUpdated);
  return { activeClientRuntimeIds, clientsDetailed, profiles, profileSummaries };
};

const mergeHubHealth = (
  health: HealthStatus,
  env: RuntimeReplica | null,
  deps: RuntimeHealthDeps,
  activeClientRuntimeIds: string[],
  profiles: Profile[],
): HubHealth[] => {
  if (deps.activeHubEntityIds.length === 0) return [];
  const relayHubs = profiles.filter(profile => profile.metadata.isHub === true);
  const hubs = [...(health.hubs || [])];
  const known = new Set(hubs.map(hub => String(hub.entityId).toLowerCase()));
  for (const profile of relayHubs) {
    if (known.has(profile.entityId.toLowerCase())) continue;
    hubs.push({
      entityId: profile.entityId,
      name: profile.name,
      status: 'healthy',
      reserves: env ? getReplicaReserveSnapshot(env, profile.entityId) : undefined,
      accounts: env ? getReplicaAccountCount(env, profile.entityId) : undefined,
    });
    known.add(profile.entityId.toLowerCase());
  }
  const profilesByEntity = new Map(relayHubs.map(profile => [profile.entityId.toLowerCase(), profile]));
  return hubs.map(hub => {
    const entityId = String(hub.entityId || '');
    const runtimeId = profilesByEntity.get(entityId.toLowerCase())?.runtimeId;
    const normalizedRuntimeId = normalizeRuntimeKey(runtimeId);
    return {
      ...hub,
      runtimeId: normalizedRuntimeId || runtimeId,
      online: Boolean(normalizedRuntimeId && deps.relayStore.clients.has(normalizedRuntimeId)),
      selfRelayPresence: Boolean(normalizedRuntimeId && deps.relayStore.clients.has(normalizedRuntimeId)),
      activeClients: activeClientRuntimeIds.filter(id => id !== normalizedRuntimeId),
      reserves: env ? getReplicaReserveSnapshot(env, entityId) ?? hub.reserves : hub.reserves,
      accounts: env ? getReplicaAccountCount(env, entityId) ?? hub.accounts : hub.accounts,
    };
  });
};

const buildHealthBodies = async (deps: RuntimeHealthDeps): Promise<HealthBodies> => {
  const env = deps.env;
  const health = await getHealthStatus(env);
  const storage = getStorageHealthSnapshotSync();
  const relay = collectRelayHealth(deps);
  const hubs = mergeHubHealth(health, env, deps, relay.activeClientRuntimeIds, relay.profiles);
  const marketMaker = getMarketMakerHealth(env, deps.marketMakerState, deps.getAccountReplica);
  const meshApplicable = deps.activeHubEntityIds.length > 0;
  const bootstrapReserves = meshApplicable || marketMaker.applicable
    ? await getBootstrapReserveHealth(env, {
        activeHubEntityIds: deps.activeHubEntityIds,
        marketMakerEntityId: deps.marketMakerState.entityId,
        loadTokenCatalog: deps.ensureTokenCatalog,
      })
    : {
        applicable: false,
        ok: true,
        requiredTokenCount: HUB_REQUIRED_TOKEN_COUNT,
        entityCount: 0,
        entities: [],
      };
  const payload = {
    ...health,
    hubs,
    disk: buildDiskSummary(storage),
    storage,
    boot: {
      phase: deps.boot.phase,
      startedAt: deps.boot.startedAt || null,
      completedAt: deps.boot.completedAt,
      error: deps.boot.error,
    },
    hubMesh: meshApplicable
      ? getHubMeshHealth(env, deps.activeHubEntityIds)
      : {
          applicable: false,
          ok: true,
          reason: 'no-active-hub-entities',
          requiredHubCount: HUB_MESH_REQUIRED_HUBS,
          tokenId: HUB_MESH_TOKEN_ID,
          requiredCredit: HUB_MESH_CREDIT_AMOUNT.toString(),
          hubIds: [],
          pairs: [],
        },
    marketMaker,
    bootstrapReserves,
    relay: {
      activeClients: relay.activeClientRuntimeIds,
      activeClientCount: relay.activeClientRuntimeIds.length,
      clientsDetailed: relay.clientsDetailed,
      profileCount: relay.profiles.length,
      profiles: relay.profileSummaries,
    },
  };
  return { fullBody: JSON.stringify(payload), publicBody: publicRuntimeHealthBody(payload) };
};

export const handleRuntimeHealth = async (
  _req: Request,
  headers: HeadersInit,
  deps: RuntimeHealthDeps,
  includeOperatorHealth: boolean,
): Promise<Response> => {
  const now = Date.now();
  if (deps.cachedHealthResponse && deps.cachedHealthResponse.expiresAt > now) {
    return healthResponse(deps.cachedHealthResponse, includeOperatorHealth, headers);
  }
  // Capture the in-flight promise into a local so a concurrent request can't observe it being
  // cleared by another request's `.finally` between this check and the await (that race threw
  // RUNTIME_HEALTH_INFLIGHT_MISSING and 500'd /api/health under concurrent polling).
  let inFlight = deps.cachedHealthInFlight;
  if (!inFlight) {
    const build = () => buildHealthBodies(deps);
    inFlight = (deps.env
      ? withRuntimeCommittedRead(deps.env, build)
      : build())
      .then(body => {
        deps.setCachedHealthResponse({ ...body, expiresAt: Date.now() + deps.healthCacheTtlMs });
        return body;
      })
      .finally(() => deps.setCachedHealthInFlight(null));
    deps.setCachedHealthInFlight(inFlight);
  }
  return healthResponse(await inFlight, includeOperatorHealth, headers);
};
