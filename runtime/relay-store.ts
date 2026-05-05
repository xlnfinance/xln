/**
 * Relay Store — transport-agnostic state container for the WS relay.
 *
 * Holds clients, gossip profiles, encryption keys, pending messages,
 * and debug events. No WebSocket API, no crypto, no Env.
 */

import { isRuntimeId, normalizeRuntimeId } from './networking/runtime-id';
import { canonicalizeProfile, type Profile } from './networking/gossip';
import { safeStringify } from './serialization-utils';
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
  pendingMessages: Map<string, PendingRelayMessage[]>;
  pendingMessageBytes: number;
  pendingLimits: RelayPendingLimits;
  maxGossipProfiles: number;
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
const MAX_PENDING_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_GOSSIP_PROFILES = 50_000;
export const DEFAULT_GOSSIP_SYNC_LIMIT = DEFAULT_GOSSIP_BATCH_LIMIT;

type RelayPendingLimits = {
  maxPerTarget: number;
  maxTargets: number;
  maxTotalBytes: number;
};

type PendingRelayMessage = {
  msg: any;
  bytes: number;
};

type RelayStoreOptions = {
  pendingLimits?: Partial<RelayPendingLimits>;
  maxGossipProfiles?: number;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createRelayStore = (serverId: string, options: RelayStoreOptions = {}): RelayStore => ({
  serverId,
  clients: new Map(),
  pendingMessages: new Map(),
  pendingMessageBytes: 0,
  pendingLimits: {
    maxPerTarget: options.pendingLimits?.maxPerTarget ?? MAX_PENDING_PER_CLIENT,
    maxTargets: options.pendingLimits?.maxTargets ?? MAX_PENDING_TARGETS,
    maxTotalBytes: options.pendingLimits?.maxTotalBytes ?? MAX_PENDING_TOTAL_BYTES,
  },
  maxGossipProfiles: Math.max(1, Math.floor(Number(options.maxGossipProfiles ?? MAX_GOSSIP_PROFILES))),
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

export const isRelaySocketOpen = (ws: unknown): boolean => {
  if (!ws || (typeof ws !== 'object' && typeof ws !== 'function')) return false;
  const readyState = Number((ws as { readyState?: unknown }).readyState);
  return !Number.isFinite(readyState) || readyState === 1;
};

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

export const storeVerifiedGossipProfile = (store: RelayStore, profile: Profile): boolean => {
  const canonicalProfile = canonicalizeProfile(profile);
  const entityId = canonicalProfile.entityId;
  if (!entityId) return false;
  const newTs = canonicalProfile.lastUpdated;
  const existing = store.gossipProfiles.get(entityId);
  if (existing && existing.timestamp >= newTs) return false;
  if (!existing && store.gossipProfiles.size >= store.maxGossipProfiles) {
    pushDebugEvent(store, {
      event: 'gossip_drop',
      status: 'dropped',
      reason: 'GOSSIP_PROFILE_CAP_EXCEEDED',
      details: { entityId, maxGossipProfiles: store.maxGossipProfiles },
    });
    return false;
  }
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
    if (!isRelaySocketOpen(existing.ws)) {
      store.clients.delete(key);
    } else {
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

  const directKey = store.runtimeEncryptionKeys.get(normalizedTarget);
  if (typeof directKey === 'string' && directKey.length > 0) return directKey;

  for (const { profile } of store.gossipProfiles.values()) {
    const profileRuntimeId = normalizeRuntimeKey(profile.runtimeId || '');
    if (!profileRuntimeId || profileRuntimeId !== normalizedTarget) continue;
    const key = profile.runtimeEncPubKey;
    if (typeof key === 'string' && key.length > 0) {
      return key.startsWith('0x') ? key : `0x${key}`;
    }
  }

  return null;
};

// ---------------------------------------------------------------------------
// Pending message queue
// ---------------------------------------------------------------------------

const estimatePendingMessageBytes = (msg: unknown): number => {
  try {
    return Buffer.byteLength(safeStringify(msg));
  } catch {
    return Buffer.byteLength(String(msg));
  }
};

export const enqueueMessage = (store: RelayStore, toKey: string, msg: unknown): number => {
  if (!store.pendingMessages.has(toKey) && store.pendingMessages.size >= store.pendingLimits.maxTargets) {
    pushDebugEvent(store, {
      event: 'pending_drop',
      to: toKey,
      status: 'dropped',
      reason: 'PENDING_TARGET_CAP_EXCEEDED',
      queueSize: store.pendingMessages.size,
      size: store.pendingMessageBytes,
    });
    return 0;
  }
  const bytes = estimatePendingMessageBytes(msg);
  if (bytes > store.pendingLimits.maxTotalBytes || store.pendingMessageBytes + bytes > store.pendingLimits.maxTotalBytes) {
    pushDebugEvent(store, {
      event: 'pending_drop',
      to: toKey,
      status: 'dropped',
      reason: bytes > store.pendingLimits.maxTotalBytes ? 'PENDING_MESSAGE_TOO_LARGE' : 'PENDING_TOTAL_BYTES_EXCEEDED',
      size: bytes,
    });
    return store.pendingMessages.get(toKey)?.length ?? 0;
  }
  const queue = store.pendingMessages.get(toKey) || [];
  queue.push({ msg, bytes });
  store.pendingMessageBytes += bytes;
  while (queue.length > store.pendingLimits.maxPerTarget) {
    const dropped = queue.shift();
    if (dropped) {
      store.pendingMessageBytes = Math.max(0, store.pendingMessageBytes - dropped.bytes);
    }
  }
  store.pendingMessages.set(toKey, queue);
  return queue.length;
};

export const flushPendingMessages = (store: RelayStore, toKey: string): unknown[] => {
  const pending = store.pendingMessages.get(toKey) || [];
  store.pendingMessages.delete(toKey);
  for (const item of pending) {
    store.pendingMessageBytes = Math.max(0, store.pendingMessageBytes - item.bytes);
  }
  return pending.map(item => item.msg);
};

export const clearPendingMessages = (store: RelayStore): void => {
  store.pendingMessages.clear();
  store.pendingMessageBytes = 0;
};

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

export const resetStore = (store: RelayStore): void => {
  store.debugEvents.length = 0;
  store.debugId = 0;
  clearPendingMessages(store);
  store.runtimeEncryptionKeys.clear();
};
