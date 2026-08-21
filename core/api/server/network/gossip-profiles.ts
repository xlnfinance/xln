import type { RuntimeReplica } from '../../../runtime/types';
import type { Profile } from '../../../entity/profile';
import { normalizeRuntimeKey, type RelayStore } from '../../../network/relay/store';
import { safeStringify } from '../../../protocol/serialization';

const normalizeEntityId = (value: unknown): string => String(value || '').trim().toLowerCase();

const buildKnownProfileBundle = (
  input: {
    env: RuntimeReplica | null;
    relayStore: RelayStore | null;
    entityId: string;
  },
): { profile: Profile | null; peers: Profile[] } => {
  const target = normalizeEntityId(input.entityId);
  if (!target) return { profile: null, peers: [] };

  // Lookup by id, then resolve only the target's peers: rebuilding a merged
  // map of every stored profile per request was 18% of a 100-user daemon's
  // CPU under the load driver's route polling.
  const localProfiles = input.env?.gossip?.getProfiles?.() || [];
  const lookup = (wanted: string): Profile | null => {
    let found: Profile | null = input.relayStore === null
      ? null
      : input.relayStore.gossipProfiles.get(wanted)?.profile ?? null;
    // Local Runtime profiles override relay copies (same precedence as before).
    for (const profile of localProfiles) {
      if (normalizeEntityId(profile?.entityId) === wanted) found = profile;
    }
    return found;
  };
  const merged = { get: lookup };

  const profile = lookup(target);
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

export const gossipProfileEntityId = (request: Request): string => {
  const entityId = normalizeEntityId(new URL(request.url).searchParams.get('entityId'));
  return /^0x[0-9a-f]{64}$/.test(entityId) ? entityId : '';
};

/** One profile inspection contract for API, Hub, and multiplexed Runtime. */
export const handleKnownProfileRequest = (input: {
  request: Request;
  env: RuntimeReplica | null;
  relayStore: RelayStore | null;
  headers: HeadersInit;
}): Response => {
  const entityId = gossipProfileEntityId(input.request);
  if (!entityId) {
    return new Response(safeStringify({ ok: false, error: 'entityId is required' }), {
      status: 400,
      headers: input.headers,
    });
  }
  const bundle = buildKnownProfileBundle({
    env: input.env,
    relayStore: input.relayStore,
    entityId,
  });
  return new Response(safeStringify({
    ok: true,
    entityId,
    found: bundle.profile !== null,
    profile: bundle.profile,
    peers: bundle.peers,
  }), { headers: input.headers });
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
