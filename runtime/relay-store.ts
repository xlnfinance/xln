/**
 * Relay Store — transport-agnostic state container for the WS relay.
 *
 * Holds clients, gossip profiles, encryption keys, pending messages,
 * and debug events. No WebSocket API, no crypto, no Env.
 */

import { isRuntimeId, normalizeRuntimeId } from './networking/runtime-id';
import { canonicalizeProfile, type Profile } from './networking/gossip';
import {
  DEFAULT_GOSSIP_BATCH_LIMIT,
  selectProfileBatch,
  type GossipProfileBatchRequest,
} from './relay/profile-batch';

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
  runtimeId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  msgType?: string | undefined;
  status?: string | undefined;
  reason?: string | undefined;
  encrypted?: boolean | undefined;
  size?: number | undefined;
  queueSize?: number | undefined;
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
const MAX_PENDING_TARGETS = 10_000;
export const DEFAULT_GOSSIP_SYNC_LIMIT = DEFAULT_GOSSIP_BATCH_LIMIT;

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

export const storeGossipProfile = (store: RelayStore, profile: Profile): boolean => {
  const canonicalProfile = canonicalizeProfile(profile);
  const entityId = canonicalProfile.entityId;
  if (!entityId) return false;
  const newTs = canonicalProfile.lastUpdated;
  const existing = store.gossipProfiles.get(entityId);
  if (existing && existing.timestamp >= newTs) return false;
  store.gossipProfiles.set(entityId, { profile: canonicalProfile, timestamp: newTs });
  return true;
};

export const getAllGossipProfiles = (store: RelayStore): Profile[] =>
  Array.from(store.gossipProfiles.values()).map(v => v.profile);

export const getDefaultGossipProfiles = (
  store: RelayStore,
  limit: number = DEFAULT_GOSSIP_SYNC_LIMIT,
): Profile[] => {
  return selectProfileBatch(
    getAllGossipProfiles(store),
    { set: 'default', limit: Math.min(DEFAULT_GOSSIP_SYNC_LIMIT, Math.floor(Number(limit) || DEFAULT_GOSSIP_SYNC_LIMIT)) },
    DEFAULT_GOSSIP_SYNC_LIMIT,
  );
};

export const getHubGossipProfiles = (store: RelayStore, limit?: number): Profile[] => {
  return selectProfileBatch(
    getAllGossipProfiles(store),
    { set: 'hubs', ...(limit !== undefined ? { limit } : {}) },
    DEFAULT_GOSSIP_SYNC_LIMIT,
  );
};

export const getProfileBatch = (
  store: RelayStore,
  request: GossipProfileBatchRequest = {},
): Profile[] => {
  return selectProfileBatch(getAllGossipProfiles(store), request, DEFAULT_GOSSIP_SYNC_LIMIT);
};

// ---------------------------------------------------------------------------
// Client registry
// ---------------------------------------------------------------------------

export const registerClient = (store: RelayStore, runtimeId: string, ws: any): boolean => {
  const key = normalizeRuntimeKey(runtimeId);
  if (!key) return false;
  const existing = store.clients.get(key);
  if (existing && existing.ws !== ws) {
    pushDebugEvent(store, {
      event: 'ws_duplicate_runtime_rejected',
      runtimeId: key,
      from: key,
      status: 'rejected',
      reason: 'DUPLICATE_RUNTIME_CONNECTION',
      details: {
        runtimeId: key,
      },
    });
    return false;
  }
  store.clients.set(key, { ws, runtimeId: key, lastSeen: nextWsTimestamp(store), topics: new Set() });
  return true;
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

  for (const { profile } of store.gossipProfiles.values()) {
    const profileRuntimeId = normalizeRuntimeKey(profile.runtimeId || '');
    if (!profileRuntimeId || profileRuntimeId !== normalizedTarget) continue;
    const key = profile.runtimeEncPubKey;
    if (typeof key === 'string' && key.length > 0) {
      return key.startsWith('0x') ? key : `0x${key}`;
    }
  }

  const directKey = store.runtimeEncryptionKeys.get(normalizedTarget);
  if (typeof directKey === 'string' && directKey.length > 0) return directKey;
  return null;
};

// ---------------------------------------------------------------------------
// Pending message queue
// ---------------------------------------------------------------------------

export const enqueueMessage = (store: RelayStore, toKey: string, msg: any): number => {
  if (!store.pendingMessages.has(toKey) && store.pendingMessages.size >= MAX_PENDING_TARGETS) {
    const oldestKey = store.pendingMessages.keys().next().value as string | undefined;
    if (oldestKey) store.pendingMessages.delete(oldestKey);
  }
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
