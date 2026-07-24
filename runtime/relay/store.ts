/**
 * Relay Store — transport-agnostic state container for the WS relay.
 *
 * Holds clients, gossip profiles, encryption keys, pending messages,
 * and debug events. No WebSocket API, no crypto, no Env.
 */

import { isRuntimeId, normalizeRuntimeId } from '../networking/runtime-id';
import { canonicalizeProfile, type Profile } from '../networking/gossip';
import { safeStringify } from '../protocol/serialization';
import {
  normalizeRuntimeFailureCode,
  type RuntimeFailureCategory,
} from '../protocol/failure-taxonomy';
import {
  deliveryAccepted,
  deliveryDeferred,
  deliveryFailure,
  type DeliveryOutcome,
  type DeliveryResult,
} from '../protocol/payments/delivery-result';
import {
  DEFAULT_GOSSIP_BATCH_LIMIT,
  selectProfileBatch,
  type GossipProfileBatchRequest,
} from './profile-batch';
import { redactTelemetryValue } from '../infra/telemetry-redaction';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RelayClient = {
  ws: RelaySocketLike;
  runtimeId: string;
  lastSeen: number;
  topics: Set<string>;
};

export type RelaySocketLike = {
  send(data: string | Uint8Array): boolean | number | void;
  close?(code?: number, reason?: string): unknown;
  terminate?(): unknown;
  readyState?: unknown;
};

export type RelaySendResult = boolean | number | void;

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
  delivery?: RelayDeliveryResult | undefined;
  details?: unknown;
};

export type RelayDebugIncidentState = 'unread' | 'acknowledged' | 'resolved';

export type RelayDebugIncident = {
  fingerprint: string;
  state: RelayDebugIncidentState;
  source: string;
  code: string;
  message: string;
  runtimeId?: string | undefined;
  firstSeen: number;
  lastSeen: number;
  count: number;
  firstEventId: number;
  lastEventId: number;
  sample: RelayDebugEvent;
};

export type RelayDeliveryOutcome = DeliveryOutcome;

export type RelayDeliveryResult = DeliveryResult;

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
  debugIncidents: Map<string, RelayDebugIncident>;
  debugId: number;
  wsCounter: number;
  activeHubEntityIds: string[];
};

const MAX_DEBUG_EVENTS = 5000;
const MAX_DEBUG_INCIDENTS = 1000;
const MAX_PENDING_PER_CLIENT = 200;
const MAX_PENDING_TARGETS = 10_000;
const MAX_PENDING_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_PENDING_MESSAGE_AGE_MS = 5 * 60 * 1000;
const MAX_GOSSIP_PROFILES = 50_000;
export const DEFAULT_GOSSIP_SYNC_LIMIT = DEFAULT_GOSSIP_BATCH_LIMIT;

const DELIVERY_ACCEPTED_STATUSES = new Set([
  'delivered',
  'delivered-local-queued',
  'delivered-direct-local',
]);

const DELIVERY_DEFERRED_STATUSES = new Set([
  'queued',
  'direct-miss-fallback',
  'stale-target',
]);

const DELIVERY_TRANSIENT_REASONS = new Set([
  'ENTITY_INPUT_TARGET_NOT_CONNECTED',
  'ENTITY_INPUT_RECEIPT_TARGET_NOT_CONNECTED',
  'RECOVERY_TARGET_NOT_CONNECTED',
  'TARGET_SOCKET_NOT_OPEN',
]);

const DELIVERY_FATAL_REASON_PARTS = [
  'ENTITY_INPUT_MUST_BE_ENCRYPTED',
  'NO_LOCAL_REPLICA',
  'P2P_DECRYPT_ERROR',
  'invalid tag',
];

type RelayPendingLimits = {
  maxPerTarget: number;
  maxTargets: number;
  maxTotalBytes: number;
  maxAgeMs: number;
};

type PendingRelayMessage = {
  msg: unknown;
  bytes: number;
  enqueuedAt: number;
};

type RelayStoreOptions = {
  pendingLimits?: Partial<RelayPendingLimits>;
  maxGossipProfiles?: number;
};

export type RelayPendingDeliveryResult = {
  delivered: number;
  expired: number;
  retained: number;
  failure?: {
    reason: string;
  };
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
    maxAgeMs: options.pendingLimits?.maxAgeMs ?? MAX_PENDING_MESSAGE_AGE_MS,
  },
  maxGossipProfiles: Math.max(1, Math.floor(Number(options.maxGossipProfiles ?? MAX_GOSSIP_PROFILES))),
  gossipProfiles: new Map(),
  runtimeEncryptionKeys: new Map(),
  debugEvents: [],
  debugIncidents: new Map(),
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

export const isRelaySendResultFailure = (result: RelaySendResult): boolean =>
  result === false || (typeof result === 'number' && result < 0);

const deliveryCodeFor = (status: string, reason: string): string => {
  if (reason) return normalizeRuntimeFailureCode(reason);
  if (status === 'queued') return 'DELIVERY_QUEUED';
  if (status === 'direct-miss-fallback') return 'DELIVERY_DIRECT_MISS_FALLBACK';
  if (status === 'stale-target') return 'DELIVERY_STALE_TARGET';
  if (DELIVERY_ACCEPTED_STATUSES.has(status)) return 'DELIVERY_ACCEPTED';
  return `DELIVERY_${normalizeRuntimeFailureCode(status)}`;
};

const deliveryFailureCategory = (
  status: string,
  code: string,
  reason: string,
): RuntimeFailureCategory => {
  if (status === 'send-failed') return 'TransientRace';
  if (status === 'local-delivery-failed') {
    return DELIVERY_FATAL_REASON_PARTS.some((part) => reason.includes(part)) ? 'Contradiction' : 'TransientRace';
  }
  if (DELIVERY_TRANSIENT_REASONS.has(code)) return 'TransientRace';
  if (code === 'DIRECT_MISS_FALLBACK' || code === 'DELIVERY_DIRECT_MISS_FALLBACK') return 'TransientRace';
  if (code === 'DELIVERY_STALE_TARGET') return 'TransientRace';
  return 'Contradiction';
};

export const classifyRelayDeliveryEvent = (event: {
  status?: unknown;
  reason?: unknown;
}): RelayDeliveryResult | null => {
  const status = String(event.status || '').trim();
  if (!status) return null;
  const reason = String(event.reason || '').trim();
  const code = deliveryCodeFor(status, reason);

  if (DELIVERY_ACCEPTED_STATUSES.has(status)) {
    return deliveryAccepted(code);
  }
  if (DELIVERY_DEFERRED_STATUSES.has(status)) {
    return deliveryDeferred({
      outcome: status === 'queued' ? 'queued' : 'deferred',
      code,
    });
  }

  return deliveryFailure({
    category: deliveryFailureCategory(status, code, reason),
    code,
    message: reason || status,
  });
};

// ---------------------------------------------------------------------------
// Debug events
// ---------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const boundedText = (value: unknown, maxLength = 1000): string =>
  typeof value === 'string' ? value.trim().slice(0, maxLength) : '';

const incidentHash = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const classifyIncident = (
  event: RelayDebugEvent,
): Pick<RelayDebugIncident, 'fingerprint' | 'source' | 'code' | 'message' | 'runtimeId'> | null => {
  const details = asRecord(event.details);
  const payload = asRecord(details?.['payload']);
  const payloadData = asRecord(payload?.['data']);
  const severity = boundedText(
    details?.['severity'] ?? details?.['level'] ?? payload?.['level'],
    20,
  ).toLowerCase();
  const isError =
    event.event === 'error' ||
    event.event === 'browser_error' ||
    severity === 'error' ||
    severity === 'fatal' ||
    event.status === 'error' ||
    event.status === 'fatal' ||
    (event.status === 'failed' && event.delivery?.fatal !== false) ||
    event.delivery?.fatal === true;
  if (!isError) return null;

  const rawCode =
    boundedText(payloadData?.['message'], 200) ||
    boundedText(payload?.['message'], 200) ||
    boundedText(details?.['code'], 200) ||
    boundedText(event.reason, 200) ||
    boundedText(details?.['message'], 200) ||
    event.event;
  const code = normalizeRuntimeFailureCode(rawCode);
  const message =
    boundedText(payloadData?.['message'], 2000) ||
    boundedText(details?.['message'], 2000) ||
    boundedText(event.reason, 2000) ||
    boundedText(payload?.['message'], 2000) ||
    code;
  const source =
    boundedText(details?.['source'], 80) ||
    boundedText(payload?.['category'], 80) ||
    (event.event === 'browser_error' ? 'browser' : event.event);
  const runtimeId =
    boundedText(event.runtimeId, 200) ||
    boundedText(payload?.['runtimeId'], 200) ||
    boundedText(event.from, 200) ||
    undefined;
  const stackHead =
    boundedText(details?.['stack'], 4000).split('\n').slice(0, 2).join('\n') ||
    boundedText(payloadData?.['stack'], 4000).split('\n').slice(0, 2).join('\n');
  const genericCode = code === 'ERROR' || code === 'BROWSER_ERROR' || code.endsWith('_ERROR');
  const basis = [code, runtimeId ?? '', genericCode ? message : '', stackHead].join('|');
  return {
    fingerprint: `${code.toLowerCase()}-${incidentHash(basis)}`,
    source,
    code,
    message,
    runtimeId,
  };
};

const trimDebugIncidents = (store: RelayStore): void => {
  if (store.debugIncidents.size <= MAX_DEBUG_INCIDENTS) return;
  const candidates = Array.from(store.debugIncidents.values()).sort((left, right) => {
    const leftResolved = left.state === 'resolved' ? 0 : 1;
    const rightResolved = right.state === 'resolved' ? 0 : 1;
    return leftResolved - rightResolved || left.lastSeen - right.lastSeen;
  });
  for (const incident of candidates.slice(0, store.debugIncidents.size - MAX_DEBUG_INCIDENTS)) {
    store.debugIncidents.delete(incident.fingerprint);
  }
};

const updateDebugIncident = (store: RelayStore, event: RelayDebugEvent): void => {
  const classified = classifyIncident(event);
  if (!classified) return;
  const existing = store.debugIncidents.get(classified.fingerprint);
  store.debugIncidents.set(classified.fingerprint, existing
    ? {
        ...existing,
        state: 'unread',
        message: classified.message,
        runtimeId: classified.runtimeId,
        lastSeen: event.ts,
        count: existing.count + 1,
        lastEventId: event.id,
        sample: event,
      }
    : {
        ...classified,
        state: 'unread',
        firstSeen: event.ts,
        lastSeen: event.ts,
        count: 1,
        firstEventId: event.id,
        lastEventId: event.id,
        sample: event,
      });
  trimDebugIncidents(store);
};

export const pushDebugEvent = (store: RelayStore, event: Omit<RelayDebugEvent, 'id' | 'ts'>): void => {
  store.debugId += 1;
  const redactedEvent = redactTelemetryValue(event) as Omit<RelayDebugEvent, 'id' | 'ts'>;
  const delivery = redactedEvent.delivery ??
    (redactedEvent.event === 'delivery' ? classifyRelayDeliveryEvent(redactedEvent) ?? undefined : undefined);
  const storedEvent: RelayDebugEvent = {
    id: store.debugId,
    ts: Date.now(),
    ...redactedEvent,
    ...(delivery ? { delivery } : {}),
  };
  store.debugEvents.push(storedEvent);
  updateDebugIncident(store, storedEvent);
  if (store.debugEvents.length > MAX_DEBUG_EVENTS) {
    store.debugEvents.shift();
  }
};

export const setDebugIncidentState = (
  store: RelayStore,
  fingerprint: string,
  state: RelayDebugIncidentState,
): RelayDebugIncident => {
  const incident = store.debugIncidents.get(fingerprint);
  if (!incident) throw new Error(`DEBUG_INCIDENT_NOT_FOUND:${fingerprint}`);
  const updated = { ...incident, state };
  store.debugIncidents.set(fingerprint, updated);
  return updated;
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

export const registerClient = (store: RelayStore, runtimeId: string, ws: RelaySocketLike): boolean => {
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

export const removeClient = (store: RelayStore, ws: RelaySocketLike): string | null => {
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
  // Queue limits are a security boundary. Falling back to String(msg) would
  // measure a circular object as the tiny string "[object Object]" and permit
  // it to bypass maxTotalBytes. Canonical serialization must succeed before a
  // message can consume durable queue capacity.
  return Buffer.byteLength(safeStringify(msg));
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
  queue.push({ msg, bytes, enqueuedAt: Date.now() });
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
  const now = Date.now();
  const deliverable: unknown[] = [];
  for (const item of pending) {
    store.pendingMessageBytes = Math.max(0, store.pendingMessageBytes - item.bytes);
    // Account frames reject timestamps outside the same five-minute window.
    // Delivering older pending entity_input after a deterministic runtime reset
    // can replay an old, validly signed frame into a fresh local account. Drop it
    // at the relay boundary instead of letting stale consensus traffic poison
    // the next live run.
    if (now - item.enqueuedAt > store.pendingLimits.maxAgeMs) {
      pushDebugEvent(store, {
        event: 'pending_drop',
        to: toKey,
        status: 'dropped',
        reason: 'PENDING_MESSAGE_EXPIRED',
        size: item.bytes,
      });
      continue;
    }
    deliverable.push(item.msg);
  }
  return deliverable;
};

export const deliverPendingMessages = (
  store: RelayStore,
  toKey: string,
  deliver: (msg: unknown) => RelaySendResult,
): RelayPendingDeliveryResult => {
  const pending = store.pendingMessages.get(toKey) || [];
  if (pending.length === 0) {
    return { delivered: 0, expired: 0, retained: 0 };
  }
  const now = Date.now();
  const retained: PendingRelayMessage[] = [];
  let delivered = 0;
  let expired = 0;
  let failure: RelayPendingDeliveryResult['failure'];

  for (const item of pending) {
    if (failure) {
      retained.push(item);
      continue;
    }
    if (now - item.enqueuedAt > store.pendingLimits.maxAgeMs) {
      expired++;
      store.pendingMessageBytes = Math.max(0, store.pendingMessageBytes - item.bytes);
      pushDebugEvent(store, {
        event: 'pending_drop',
        to: toKey,
        status: 'dropped',
        reason: 'PENDING_MESSAGE_EXPIRED',
        size: item.bytes,
      });
      continue;
    }
    try {
      const sendResult = deliver(item.msg);
      if (isRelaySendResultFailure(sendResult)) {
        failure = { reason: 'RELAY_PENDING_SEND_FAILED' };
        retained.push(item);
        continue;
      }
      delivered++;
      store.pendingMessageBytes = Math.max(0, store.pendingMessageBytes - item.bytes);
    } catch (error) {
      failure = { reason: error instanceof Error ? error.message : String(error) };
      retained.push(item);
    }
  }

  if (retained.length > 0) {
    store.pendingMessages.set(toKey, retained);
  } else {
    store.pendingMessages.delete(toKey);
  }
  return {
    delivered,
    expired,
    retained: retained.length,
    ...(failure ? { failure } : {}),
  };
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
  store.debugIncidents.clear();
  store.debugId = 0;
  clearPendingMessages(store);
  store.runtimeEncryptionKeys.clear();
};
