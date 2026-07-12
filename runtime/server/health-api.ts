import type { Env } from '../types';
import { getHealthStatus, type HubHealth } from './health';
import type { JTokenInfo } from '../jadapter/types';
import { getStorageHealthSnapshotSync } from '../orchestrator/storage-monitor';
import { getAllGossipProfiles, normalizeRuntimeKey, type RelayStore } from '../relay/store';
import type { Profile } from '../networking/gossip';
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

export type RuntimeHealthCacheEntry = {
  fullBody: string;
  publicBody: string;
  expiresAt: number;
};

export type RuntimeHealthDeps = {
  env: Env | null;
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
  getAccountMachine: Parameters<typeof getMarketMakerHealth>[2];
  ensureTokenCatalog: () => Promise<JTokenInfo[]>;
};

export const handleRuntimeHealth = async (
  _req: Request,
  headers: HeadersInit,
  deps: RuntimeHealthDeps,
  includeOperatorHealth: boolean,
): Promise<Response> => {
  const now = Date.now();
  if (deps.cachedHealthResponse && deps.cachedHealthResponse.expiresAt > now) {
    return new Response(
      includeOperatorHealth ? deps.cachedHealthResponse.fullBody : deps.cachedHealthResponse.publicBody,
      {
        headers: {
          ...headers,
          'Cache-Control': 'private, max-age=10',
        },
      },
    );
  }

  // Capture the in-flight promise into a local so a concurrent request can't observe it being
  // cleared by another request's `.finally` between this check and the await (that race threw
  // RUNTIME_HEALTH_INFLIGHT_MISSING and 500'd /api/health under concurrent polling).
  let inFlight = deps.cachedHealthInFlight;
  if (!inFlight) {
    inFlight = (async () => {
      const env = deps.env;
      const hubMeshApplicable = deps.activeHubEntityIds.length > 0;
      const health = await getHealthStatus(env);
      const storage = getStorageHealthSnapshotSync();
      const activeClientRuntimeIds = Array.from(deps.relayStore.clients.keys());
      const activeClientsDetailed = Array.from(deps.relayStore.clients.entries()).map(([runtimeId, client]) => ({
        runtimeId,
        lastSeen: client.lastSeen,
        ageMs: Math.max(0, Date.now() - client.lastSeen),
        topics: Array.from(client.topics || []),
      }));
      const relayHubProfiles = hubMeshApplicable
        ? getAllGossipProfiles(deps.relayStore).filter((profile: Profile) => profile.metadata.isHub === true)
        : [];
      if (!hubMeshApplicable) {
        health.hubs = [];
      }
      const existing = new Set((health.hubs || []).map((hub) => String(hub.entityId).toLowerCase()));
      for (const profile of relayHubProfiles) {
        const entityId = profile.entityId;
        if (existing.has(entityId.toLowerCase())) continue;
        health.hubs.push({
          entityId,
          name: profile.name,
          status: 'healthy',
          reserves: env ? getReplicaReserveSnapshot(env, entityId) : undefined,
          accounts: env ? getReplicaAccountCount(env, entityId) : undefined,
        });
        existing.add(entityId.toLowerCase());
      }

      const relayHubsByEntity = new Map<string, Profile>();
      for (const profile of relayHubProfiles) {
        relayHubsByEntity.set(profile.entityId.toLowerCase(), profile);
      }
      const relayProfiles = getAllGossipProfiles(deps.relayStore);
      const relayProfileSummaries = relayProfiles
        .map((profile: Profile) => ({
          entityId: profile.entityId,
          runtimeId: profile.runtimeId || null,
          name: profile.name,
          isHub: profile.metadata.isHub === true,
          lastUpdated: profile.lastUpdated,
        }))
        .sort((left, right) => right.lastUpdated - left.lastUpdated);
      health.hubs = (health.hubs || []).map((hub: HubHealth) => {
        const entityId = String(hub.entityId || '');
        const profile = relayHubsByEntity.get(entityId.toLowerCase());
        const runtimeId = profile?.runtimeId;
        const normalizedRuntimeId = normalizeRuntimeKey(runtimeId);
        const selfRelayPresence = Boolean(normalizedRuntimeId && deps.relayStore.clients.has(normalizedRuntimeId));
        const activeClients = activeClientRuntimeIds.filter((clientRuntimeId) => clientRuntimeId !== normalizedRuntimeId);
        return {
          ...hub,
          runtimeId: normalizedRuntimeId || runtimeId,
          online: selfRelayPresence,
          selfRelayPresence,
          activeClients,
          reserves: env ? getReplicaReserveSnapshot(env, entityId) ?? hub.reserves : hub.reserves,
          accounts: env ? getReplicaAccountCount(env, entityId) ?? hub.accounts : hub.accounts,
        };
      });
      const marketMaker = getMarketMakerHealth(env, deps.marketMakerState, deps.getAccountMachine);
      const bootstrapReserves =
        hubMeshApplicable || marketMaker.applicable
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
        disk: buildDiskSummary(storage),
        storage,
        boot: {
          phase: deps.boot.phase,
          startedAt: deps.boot.startedAt || null,
          completedAt: deps.boot.completedAt,
          error: deps.boot.error,
        },
        hubMesh: hubMeshApplicable
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
          activeClients: activeClientRuntimeIds,
          activeClientCount: activeClientRuntimeIds.length,
          clientsDetailed: activeClientsDetailed,
          profileCount: relayProfiles.length,
          profiles: relayProfileSummaries,
        },
      };
      const fullBody = JSON.stringify(payload);
      const publicBody = publicRuntimeHealthBody(payload);
      deps.setCachedHealthResponse({
        fullBody,
        publicBody,
        expiresAt: Date.now() + deps.healthCacheTtlMs,
      });
      return { fullBody, publicBody };
    })().finally(() => {
      deps.setCachedHealthInFlight(null);
    });
    deps.setCachedHealthInFlight(inFlight);
  }

  const body = await inFlight;
  return new Response(includeOperatorHealth ? body.fullBody : body.publicBody, {
    headers: {
      ...headers,
      'Cache-Control': 'private, max-age=10',
    },
  });
};
