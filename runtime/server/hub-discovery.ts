import type { Env } from '../types';
import type { Profile } from '../networking/gossip';
import { getAllGossipProfiles } from '../relay-store';
import { normalizeRuntimeKey, type RelayStore } from '../relay-store';
import { compareStableText } from '../serialization-utils';

export const buildHubDiscoveryPayload = (input: {
  env: Env | null;
  relayStore: RelayStore;
  serverTime?: number;
}): {
  ok: true;
  count: number;
  serverTime: number;
  hubs: Array<{
    entityId: string;
    runtimeId: string | null;
    name: string | undefined;
    bio: string | null;
    website: string | null;
    wsUrl: string | null;
    publicAccounts: unknown[];
    metadata: Profile['metadata'];
    lastUpdated: number;
    online: boolean;
  }>;
} => {
  const { env, relayStore } = input;
  const relayHubProfiles = getAllGossipProfiles(relayStore).filter((profile: Profile) =>
    profile.metadata.isHub === true,
  );
  const mergedHubProfiles = new Map<string, Profile>();
  for (const profile of relayHubProfiles) {
    mergedHubProfiles.set(String(profile.entityId || '').toLowerCase(), profile);
  }
  for (const profile of env?.gossip?.getHubs?.() || []) {
    const entityId = String(profile.entityId || '').toLowerCase();
    if (!entityId || mergedHubProfiles.has(entityId)) continue;
    mergedHubProfiles.set(entityId, profile);
  }

  const hubs = Array.from(mergedHubProfiles.values())
    .map((profile: Profile) => {
      const runtimeId = normalizeRuntimeKey(profile.runtimeId);
      return {
        entityId: profile.entityId,
        runtimeId: runtimeId || profile.runtimeId || null,
        name: profile.name,
        bio: profile.bio || null,
        website: profile.website || null,
        wsUrl: profile.wsUrl || null,
        publicAccounts: profile.publicAccounts || [],
        metadata: profile.metadata,
        lastUpdated: profile.lastUpdated,
        online: runtimeId ? relayStore.clients.has(runtimeId) : false,
      };
    })
    .sort((left, right) => {
      const leftName = String(left.name || '');
      const rightName = String(right.name || '');
      if (leftName && rightName && leftName !== rightName) {
        return compareStableText(leftName, rightName);
      }
      return Number(right.lastUpdated || 0) - Number(left.lastUpdated || 0);
    });

  return {
    ok: true,
    count: hubs.length,
    serverTime: input.serverTime ?? Date.now(),
    hubs,
  };
};
