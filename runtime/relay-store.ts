/**
 * Relay Store — transport-agnostic state container for the WS relay.
 *
 * Holds clients, gossip profiles, encryption keys, pending messages,
 * and debug events. No WebSocket API, no crypto, no Env.
 */

import { isRuntimeId, normalizeRuntimeId } from './networking/runtime-id';
import type { Profile } from './networking/gossip';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RelayClient = {
  ws: any;          // Bun ServerWebSocket — stored opaquely, never called here
  runtimeId: string;
  lastSeen: number;
  topics: Set<string>;
};

export type RelayDebugEvent = {
  id: number;
  ts: number;
  event: string;
  runtimeId?: string;
  from?: string;
  to?: string;
  msgType?: string;
  status?: string;
  reason?: string;
  encrypted?: boolean;
  size?: number;
  queueSize?: number;
  details?: unknown;
};

export type RelayStore = {
  serverId: string;
  clients: Map<string, RelayClient>;
  pendingMessages: Map<string, any[]>;
  gossipProfiles: Map<string, { profile: Profile; timestamp: number }>;
  runtimeEncryptionKeys: Map<string, string>;
  debugEvents: RelayDebugEvent[];
  debugId: number;
  wsCounter: number;
  activeHubEntityIds: string[];
};

const MAX_DEBUG_EVENTS = 5000;
const MAX_PENDING_PER_CLIENT = 200;
export const DEFAULT_GOSSIP_SYNC_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createRelayStore = (serverId: string): RelayStore => ({
  serverId,
  clients: new Map(),
  pendingMessages: new Map(),
  gossipProfiles: new Map(),
  runtimeEncryptionKeys: new Map(),
  debugEvents: [],
  debugId: 0,
  wsCounter: 0,
  activeHubEntityIds: [],
});

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export const isCanonicalRuntimeId = isRuntimeId;

export const normalizeRuntimeKey = (runtimeId: unknown): string => normalizeRuntimeId(runtimeId);

export const nextWsTimestamp = (store: RelayStore): number => ++store.wsCounter;

// ---------------------------------------------------------------------------
// Debug events
// ---------------------------------------------------------------------------

export const pushDebugEvent = (store: RelayStore, event: Omit<RelayDebugEvent, 'id' | 'ts'>): void => {
  store.debugId += 1;
  store.debugEvents.push({
    id: store.debugId,
    ts: Date.now(),
    ...event,
  });
  if (store.debugEvents.length > MAX_DEBUG_EVENTS) {
    store.debugEvents.shift();
  }
};

// ---------------------------------------------------------------------------
// Gossip profiles
// ---------------------------------------------------------------------------

const isHubProfile = (profile: Profile): boolean =>
  profile.metadata?.isHub === true ||
  profile.capabilities.includes('hub') ||
  profile.capabilities.includes('routing');

const sortProfilesForDefaultSync = (left: Profile, right: Profile): number => {
  const leftHub = isHubProfile(left);
  const rightHub = isHubProfile(right);
  if (leftHub !== rightHub) return leftHub ? -1 : 1;
  const leftTs = Number(left.metadata?.lastUpdated || 0);
  const rightTs = Number(right.metadata?.lastUpdated || 0);
  if (leftTs !== rightTs) return rightTs - leftTs;
  return String(left.entityId).localeCompare(String(right.entityId));
};

export const storeGossipProfile = (store: RelayStore, profile: Profile): boolean => {
  const entityId = profile.entityId;
  if (!entityId) return false;
  const newTs = profile?.metadata?.lastUpdated || 0;
  const existing = store.gossipProfiles.get(entityId);
  if (existing && existing.timestamp >= newTs) return false;
  store.gossipProfiles.set(entityId, { profile, timestamp: newTs });
  return true;
};

export const getAllGossipProfiles = (store: RelayStore): Profile[] =>
  Array.from(store.gossipProfiles.values()).map(v => v.profile);

export const getDefaultGossipProfiles = (
  store: RelayStore,
  limit: number = DEFAULT_GOSSIP_SYNC_LIMIT,
): Profile[] => {
  const boundedLimit = Math.max(1, Math.min(DEFAULT_GOSSIP_SYNC_LIMIT, Math.floor(Number(limit) || DEFAULT_GOSSIP_SYNC_LIMIT)));
  return getAllGossipProfiles(store)
    .sort(sortProfilesForDefaultSync)
    .slice(0, boundedLimit);
};

export const getGossipProfileBundle = (store: RelayStore, entityIds: string[]): Profile[] => {
  const requestedIds = Array.from(
    new Set(
      entityIds
        .map(entityId => String(entityId || '').toLowerCase())
        .filter(entityId => entityId.length > 0),
    ),
  );
  const results = new Map<string, Profile>();
  for (const entityId of requestedIds) {
    const rootProfile = store.gossipProfiles.get(entityId)?.profile;
    if (!rootProfile) continue;
    results.set(entityId, rootProfile);
    const peerIds = rootProfile.publicAccounts || rootProfile.hubs || [];
    for (const peerId of peerIds) {
      const normalizedPeerId = String(peerId || '').toLowerCase();
      const peerProfile = store.gossipProfiles.get(normalizedPeerId)?.profile;
      if (peerProfile) {
        results.set(normalizedPeerId, peerProfile);
      }
    }
  }
  return Array.from(results.values()).sort(sortProfilesForDefaultSync);
};

// ---------------------------------------------------------------------------
// Client registry
// ---------------------------------------------------------------------------

export const registerClient = (store: RelayStore, runtimeId: string, ws: any): void => {
  const key = normalizeRuntimeKey(runtimeId);
  if (!key) return;
  const existing = store.clients.get(key);
  if (existing && existing.ws !== ws) {
    pushDebugEvent(store, {
      event: 'ws_duplicate_runtime_replace',
      runtimeId: key,
      from: key,
      status: 'warning',
      reason: 'DUPLICATE_RUNTIME_CONNECTION',
      details: {
        runtimeId: key,
      },
    });
    try { existing.ws.close(4009, 'duplicate-runtime'); } catch {
      try { existing.ws.close(); } catch { /* best effort */ }
    }
  }
  store.clients.set(key, { ws, runtimeId: key, lastSeen: nextWsTimestamp(store), topics: new Set() });
};

export const removeClient = (store: RelayStore, ws: any): string | null => {
  for (const [id, client] of store.clients) {
    if (client.ws === ws) {
      store.clients.delete(id);
      store.runtimeEncryptionKeys.delete(id.toLowerCase());
      return id;
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Encryption key cache
// ---------------------------------------------------------------------------

export const cacheEncryptionKey = (store: RelayStore, runtimeId: string, pubKeyHex: string): void => {
  const normalized = normalizeRuntimeKey(runtimeId);
  if (!normalized) return;
  const normalizedKey = pubKeyHex.startsWith('0x')
    ? pubKeyHex.toLowerCase()
    : `0x${pubKeyHex.toLowerCase()}`;
  if (/^0x[0-9a-f]{64}$/.test(normalizedKey)) {
    store.runtimeEncryptionKeys.set(normalized, normalizedKey);
  }
};

export const resolveEncryptionPublicKeyHex = (store: RelayStore, targetRuntimeId: string): string | null => {
  const normalizedTarget = normalizeRuntimeKey(targetRuntimeId);
  if (!normalizedTarget) return null;

  const directKey = store.runtimeEncryptionKeys.get(normalizedTarget);
  if (typeof directKey === 'string' && directKey.length > 0) return directKey;

  for (const { profile } of store.gossipProfiles.values()) {
    if (!profile || typeof profile !== 'object') continue;
    const profileRuntimeId = normalizeRuntimeKey(profile.runtimeId || profile.metadata?.runtimeId || '');
    if (!profileRuntimeId || profileRuntimeId !== normalizedTarget) continue;
    const candidateKeys = [
      profile.metadata?.encryptionPublicKey,
      profile.metadata?.cryptoPublicKey,
    ];
    for (const key of candidateKeys) {
      if (typeof key !== 'string' || key.length === 0) continue;
      return key.startsWith('0x') ? key : `0x${key}`;
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Pending message queue
// ---------------------------------------------------------------------------

export const enqueueMessage = (store: RelayStore, toKey: string, msg: any): number => {
  const queue = store.pendingMessages.get(toKey) || [];
  queue.push(msg);
  if (queue.length > MAX_PENDING_PER_CLIENT) queue.shift();
  store.pendingMessages.set(toKey, queue);
  return queue.length;
};

export const flushPendingMessages = (store: RelayStore, toKey: string): any[] => {
  const pending = store.pendingMessages.get(toKey) || [];
  store.pendingMessages.delete(toKey);
  return pending;
};

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

export const resetStore = (store: RelayStore): void => {
  store.debugEvents.length = 0;
  store.debugId = 0;
  store.pendingMessages.clear();
  store.runtimeEncryptionKeys.clear();
};
