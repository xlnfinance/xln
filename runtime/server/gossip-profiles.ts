import type { Env } from '../types';
import type { Profile } from '../networking/gossip';
import { getAllGossipProfiles, normalizeRuntimeKey, type RelayStore } from '../relay-store';

const normalizeEntityId = (value: unknown): string => String(value || '').trim().toLowerCase();

export const buildKnownProfileBundle = (
  input: {
    env: Env | null;
    relayStore: RelayStore;
    entityId: string;
  },
): { profile: Profile | null; peers: Profile[] } => {
  const target = normalizeEntityId(input.entityId);
  if (!target) return { profile: null, peers: [] };

  const merged = new Map<string, Profile>();
  for (const profile of getAllGossipProfiles(input.relayStore)) {
    const entityId = normalizeEntityId(profile?.entityId);
    if (entityId) merged.set(entityId, profile);
  }
  for (const profile of input.env?.gossip?.getProfiles?.() || []) {
    const entityId = normalizeEntityId(profile?.entityId);
    if (entityId) merged.set(entityId, profile);
  }

  const profile = merged.get(target) || null;
  if (!profile) return { profile: null, peers: [] };

  const peerIds = new Set<string>();
  for (const peerId of Array.isArray(profile.publicAccounts) ? profile.publicAccounts : []) {
    const normalized = normalizeEntityId(peerId);
    if (normalized) peerIds.add(normalized);
  }
  for (const account of Array.isArray(profile.accounts) ? profile.accounts : []) {
    const normalized = normalizeEntityId(account?.counterpartyId);
    if (normalized) peerIds.add(normalized);
  }

  const peers: Profile[] = [];
  for (const peerId of peerIds) {
    const peer = merged.get(peerId);
    if (peer) peers.push(peer);
  }
  return { profile, peers };
};

export const buildDebugEntitiesPayload = (input: {
  relayStore: RelayStore;
  query?: string;
  limit?: number;
  onlineOnly?: boolean;
  serverTime?: number;
}): {
  ok: true;
  totalRegistered: number;
  returned: number;
  serverTime: number;
  entities: Array<{
    entityId: string;
    runtimeId: string | undefined;
    name: string;
    isHub: boolean;
    online: boolean;
    lastUpdated: number;
    accounts: Profile['accounts'];
    publicAccounts: Profile['publicAccounts'];
    metadata: Profile['metadata'];
  }>;
} => {
  const q = normalizeEntityId(input.query);
  const limit = Math.max(1, Math.min(5000, Number(input.limit || 1000)));
  const onlineOnly = input.onlineOnly === true;
  const entities = Array.from(input.relayStore.gossipProfiles.entries())
    .map(([entityId, entry]) => {
      const profile = entry.profile || {};
      const runtimeId = typeof profile.runtimeId === 'string' ? profile.runtimeId : undefined;
      const normalizedRuntimeId = normalizeRuntimeKey(runtimeId);
      const name =
        typeof profile.name === 'string' && profile.name.trim().length > 0
          ? profile.name.trim()
          : entityId;
      const isHub = profile.metadata.isHub === true;
      const online = normalizedRuntimeId ? input.relayStore.clients.has(normalizedRuntimeId) : false;
      return {
        entityId,
        runtimeId: normalizedRuntimeId || runtimeId,
        name,
        isHub,
        online,
        lastUpdated: Number(profile.lastUpdated || entry.timestamp || 0),
        accounts: profile.accounts,
        publicAccounts: profile.publicAccounts,
        metadata: profile.metadata,
      };
    })
    .filter(entity => {
      if (onlineOnly && !entity.online) return false;
      if (!q) return true;
      const blob = `${entity.entityId} ${entity.runtimeId || ''} ${entity.name}`.toLowerCase();
      return blob.includes(q);
    })
    .sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0))
    .slice(0, limit);

  return {
    ok: true,
    totalRegistered: input.relayStore.gossipProfiles.size,
    returned: entities.length,
    serverTime: input.serverTime ?? Date.now(),
    entities,
  };
};
