import { normalizeRuntimeKey, type RelayStore } from '../relay-store';
import { compareStableText } from '../serialization-utils';
import type { HubChild } from './orchestrator-types';

export type PublicHubJurisdiction = {
  name: string;
  chainId?: number;
  depositoryAddress?: string;
  entityProviderAddress?: string;
};

export type PublicHubDiscoveryHub = {
  entityId: string;
  runtimeId: string | null;
  name: string;
  bio: null;
  website: null;
  wsUrl: string | null;
  publicAccounts: [];
  metadata: {
    isHub: true;
    jurisdiction?: PublicHubJurisdiction;
  };
  lastUpdated: number;
  online: boolean;
};

type RawHubJurisdiction = {
  name?: string | undefined;
  chainId?: number | undefined;
  depositoryAddress?: string | undefined;
  entityProviderAddress?: string | undefined;
};

const buildJurisdictionMetadata = (jurisdiction: RawHubJurisdiction | undefined): { jurisdiction?: PublicHubJurisdiction } => {
  const name = String(jurisdiction?.name || '').trim();
  if (!name) return {};
  return {
    jurisdiction: {
      name,
      ...(jurisdiction?.chainId !== undefined ? { chainId: jurisdiction.chainId } : {}),
      ...(jurisdiction?.depositoryAddress ? { depositoryAddress: jurisdiction.depositoryAddress } : {}),
      ...(jurisdiction?.entityProviderAddress ? { entityProviderAddress: jurisdiction.entityProviderAddress } : {}),
    },
  };
};

export const buildPublicHubDiscoveryPayload = (input: {
  hubChildren: HubChild[];
  relayStore: RelayStore;
  primaryJurisdictionFallback: PublicHubJurisdiction | null;
  serverTime?: number;
}): {
  ok: true;
  count: number;
  serverTime: number;
  hubs: PublicHubDiscoveryHub[];
} => {
  const { hubChildren, relayStore, primaryJurisdictionFallback } = input;
  const serverTime = input.serverTime ?? Date.now();
  const hubsByEntityId = new Map<string, PublicHubDiscoveryHub>();
  const addHub = (hub: PublicHubDiscoveryHub): void => {
    const key = String(hub.entityId || '').trim().toLowerCase();
    if (!key || !hub.online) return;
    const existing = hubsByEntityId.get(key);
    if (!existing || (hub.metadata.jurisdiction && !existing.metadata.jurisdiction)) {
      hubsByEntityId.set(key, hub);
    }
  };

  hubChildren
    .flatMap((child) => {
      const entityId = String(child.lastInfo?.entityId || child.lastHealth?.entityId || '').trim();
      const runtimeId = String(child.lastInfo?.runtimeId || child.lastHealth?.runtimeId || '').trim();
      const normalizedRuntimeId = normalizeRuntimeKey(runtimeId);
      const directWsUrl = String(child.lastHealth?.directWsUrl || '').trim();
      const apiReachable = Boolean(child.lastInfo || child.lastHealth);
      const online =
        child.proc?.exitCode === null
        && apiReachable
        && Boolean(normalizedRuntimeId)
        && (relayStore.clients.has(normalizedRuntimeId) || Boolean(directWsUrl));
      const hubEntities = child.lastInfo?.hubEntities?.length
        ? child.lastInfo.hubEntities
        : [{
          entityId,
          name: child.name,
          jurisdictionName: primaryJurisdictionFallback?.name || '',
          ...(primaryJurisdictionFallback?.chainId !== undefined ? { chainId: primaryJurisdictionFallback.chainId } : {}),
          ...(primaryJurisdictionFallback?.depositoryAddress ? { depositoryAddress: primaryJurisdictionFallback.depositoryAddress } : {}),
          ...(primaryJurisdictionFallback?.entityProviderAddress ? { entityProviderAddress: primaryJurisdictionFallback.entityProviderAddress } : {}),
        }];
      return hubEntities
        .map((entry) => {
          const entryEntityId = String(entry?.entityId || '').trim();
          if (!entryEntityId) return null;
          return {
            entityId: entryEntityId,
            runtimeId: runtimeId || null,
            name: String(entry?.name || child.name || entryEntityId).trim(),
            bio: null,
            website: null,
            wsUrl: directWsUrl || null,
            publicAccounts: [] as [],
            metadata: {
              isHub: true as const,
              ...buildJurisdictionMetadata({
                name: entry?.jurisdictionName,
                chainId: entry.chainId,
                depositoryAddress: entry.depositoryAddress,
                entityProviderAddress: entry.entityProviderAddress,
              }),
            },
            lastUpdated: serverTime,
            online,
          };
        })
        .filter((hub): hub is NonNullable<typeof hub> => Boolean(hub));
    })
    .forEach(addHub);

  for (const entry of relayStore.gossipProfiles.values()) {
    const profile = entry.profile;
    if (profile?.metadata?.isHub !== true) continue;
    const runtimeId = normalizeRuntimeKey(profile.runtimeId);
    const online = Boolean(runtimeId && relayStore.clients.has(runtimeId));
    const jurisdiction = profile.metadata?.jurisdiction as RawHubJurisdiction | undefined;
    addHub({
      entityId: profile.entityId,
      runtimeId: runtimeId || profile.runtimeId || null,
      name: String(profile.name || profile.entityId).trim(),
      bio: null,
      website: null,
      wsUrl: String(profile.wsUrl || '').trim() || null,
      publicAccounts: [],
      metadata: {
        isHub: true,
        ...buildJurisdictionMetadata(jurisdiction),
      },
      lastUpdated: Number(profile.lastUpdated || entry.timestamp || serverTime),
      online,
    });
  }

  const hubs = Array.from(hubsByEntityId.values())
    .sort((left, right) =>
      compareStableText(String(left.metadata.jurisdiction?.name || ''), String(right.metadata.jurisdiction?.name || '')) ||
      compareStableText(left.name, right.name)
    );

  return {
    ok: true,
    count: hubs.length,
    serverTime,
    hubs,
  };
};

export type DebugEntityEntry = {
  entityId: string;
  runtimeId?: string | undefined;
  name: string;
  isHub: boolean;
  online: boolean;
  lastUpdated: number;
  accounts: unknown[];
  publicAccounts: unknown[];
  metadata: Record<string, unknown>;
};

export const getDebugEntityEntries = (input: {
  requestUrl: URL;
  relayStore: RelayStore;
  hubChildren: HubChild[];
  serverTime?: number;
}): DebugEntityEntry[] => {
  const { requestUrl, relayStore, hubChildren } = input;
  const serverTime = input.serverTime ?? Date.now();
  const q = (requestUrl.searchParams.get('q') || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(5000, Number(requestUrl.searchParams.get('limit') || '1000')));
  const onlineOnly = requestUrl.searchParams.get('online') === 'true';

  const entities = new Map<string, DebugEntityEntry>();

  for (const [entityId, entry] of relayStore.gossipProfiles.entries()) {
    const profile = entry.profile || {};
    const runtimeId = typeof profile.runtimeId === 'string' ? profile.runtimeId : undefined;
    const normalizedRuntimeId = normalizeRuntimeKey(runtimeId);
    const metadata =
      profile?.metadata && typeof profile.metadata === 'object'
        ? profile.metadata as Record<string, unknown>
        : {};
    const isHub = profile?.metadata?.isHub === true;
    const name =
      typeof profile?.name === 'string' && profile.name.trim().length > 0
        ? profile.name.trim()
        : entityId;
    const online = normalizedRuntimeId ? relayStore.clients.has(normalizedRuntimeId) : false;
    entities.set(entityId.toLowerCase(), {
      entityId,
      runtimeId: normalizedRuntimeId || runtimeId,
      name,
      isHub,
      online,
      lastUpdated: Number(profile?.lastUpdated || entry.timestamp || 0),
      accounts: Array.isArray(profile?.accounts) ? profile.accounts : [],
      publicAccounts: Array.isArray(profile?.publicAccounts) ? profile.publicAccounts : [],
      metadata,
    });
  }

  for (const child of hubChildren) {
    const entityId = String(child.lastInfo?.entityId || child.lastHealth?.entityId || '');
    if (!entityId) continue;
    const key = entityId.toLowerCase();
    const runtimeId = String(child.lastInfo?.runtimeId || child.lastHealth?.runtimeId || '') || undefined;
    const normalizedRuntimeId = normalizeRuntimeKey(runtimeId);
    const existing = entities.get(key);
    const online = child.proc?.exitCode === null && Boolean(child.lastHealth);
    entities.set(key, {
      entityId,
      runtimeId: normalizedRuntimeId || runtimeId || existing?.runtimeId,
      name: existing?.name || child.name,
      isHub: true,
      online: existing?.online === true || online,
      lastUpdated: Math.max(existing?.lastUpdated || 0, serverTime),
      accounts: existing?.accounts || [],
      publicAccounts: existing?.publicAccounts || [],
      metadata: {
        ...(existing?.metadata || {}),
        isHub: true,
      },
    });
  }

  return Array.from(entities.values())
    .filter((entity) => {
      if (onlineOnly && !entity.online) return false;
      if (!q) return true;
      const blob = `${entity.entityId} ${entity.runtimeId || ''} ${entity.name}`.toLowerCase();
      return blob.includes(q);
    })
    .sort((left, right) => (right.lastUpdated || 0) - (left.lastUpdated || 0))
    .slice(0, limit);
};
