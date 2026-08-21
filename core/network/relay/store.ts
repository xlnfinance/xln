/**
 * Relay Store — transport-agnostic state container for the WS relay.
 *
 * Holds clients, gossip profiles, encryption keys, pending messages,
 * and debug events. No WebSocket API, no crypto, no RuntimeReplica.
 */

import { isRuntimeId, normalizeRuntimeId } from '../p2p/auth/runtime-id';
import { canonicalizeProfile, type Profile } from '../../entity/profile';
import { safeStringify } from '../../protocol/serialization';
import {
  normalizeRuntimeFailureCode,
  type RuntimeFailureCategory,
} from '../../protocol/errors/failure-taxonomy';
import {
  deliveryAccepted,
  deliveryDeferred,
  deliveryFailure,
  isDeliveryDelivered,
  type DeliveryResult,
} from '../../protocol/payments/delivery-result';
import {
  DEFAULT_GOSSIP_BATCH_LIMIT,
  selectProfileBatch,
  createRouteGraphCache,
  type RouteGraphCache,
  type GossipProfileBatchRequest,
} from '../p2p/gossip/profile-batch';
import { redactTelemetryValue } from '../../support/telemetry-redaction';
import type { WebSocketSendResult } from '../websocket-send-result';
import type { EntityMarketCapEntry } from './market/cap/market-cap';
import {
  computeJurisdictionGossipHash,
  decodeJurisdictionGossipAnnouncement,
  jurisdictionGossipScopeIsFull,
  type JurisdictionGossipAnnouncement,
} from '../../jurisdiction/gossip/announcement';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RelayClient = {
  ws: RelaySocketLike;
  runtimeId: string;
  lastSeen: number;
  topics: Set<string>;
  /** Consecutive forwardToRemoteRuntime sends that landed in Bun's backpressure
   *  queue (send() returned -1) while this socket still reported open. A
   *  queued send is not a delivery failure — retrying the same envelope risks
   *  double-sending a financial payload — but a socket that stays queued for
   *  several sends *and* several seconds is stuck, not just slow; see
   *  noteSendOutcome in core/network/p2p/direct-runtime-bun.ts. */
  consecutiveBackpressuredSends: number;
  /** Timestamp of the first -1 in the current streak; 0 when none. */
  backpressureStartedAt: number;
};

export type RelaySocketLike = {
  send(data: string | Uint8Array): WebSocketSendResult;
  close?(code?: number, reason?: string): unknown;
  terminate?(): unknown;
  readyState?: unknown;
};

export type RelaySendResult = WebSocketSendResult;

export type RelayDebugEvent = {
  id: number;
  ts: number;
  event: string;
  rootFingerprint?: string | undefined;
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

export type RelayDeliveryResult = DeliveryResult;

export type RelayStore = {
  serverId: string;
  clients: Map<string, RelayClient>;
  maxGossipProfiles: number;
  gossipProfiles: Map<string, { profile: Profile; timestamp: number; seq: number }>;
  /** Monotonic receipt sequence; every stored profile update takes the next value. */
  gossipSeq: number;
  /** Snapshot of gossipProfiles reused across gossip requests until the map changes. */
  gossipProfilesSnapshot?: { size: number; last?: { profile: Profile; timestamp: number } | undefined; profiles: Profile[] } | undefined;
  routeGraphCache: RouteGraphCache;
  marketCapEntries: Map<string, EntityMarketCapEntry>;
  marketCapUpdatedAt: number;
  gossipJurisdictions: Map<string, JurisdictionGossipAnnouncement>;
  officialFoundationSignerId?: string | undefined;
  runtimeEncryptionKeys: Map<string, string>;
  applicationBudgets: Map<string, { windowStartedAt: number; messageCount: number; bytes: number }>;
  debugEvents: RelayDebugEvent[];
  debugEventByteLengths: number[];
  debugEventBytes: number;
  debugIncidents: Map<string, RelayDebugIncident>;
  debugId: number;
  debugIdAllocator?: (() => number) | undefined;
  incidentSink?: ((incident: RelayDebugIncident) => void) | undefined;
  wsCounter: number;
  activeHubEntityIds: string[];
};

const MAX_DEBUG_EVENTS = 5000;
export const MAX_DEBUG_EVENT_BYTES = 64 * 1024;
export const MAX_DEBUG_TIMELINE_BYTES = 8 * 1024 * 1024;
const MAX_DEBUG_INCIDENTS = 1000;
const MAX_GOSSIP_PROFILES = 50_000;
export const DEFAULT_GOSSIP_SYNC_LIMIT = DEFAULT_GOSSIP_BATCH_LIMIT;

const DELIVERY_ACCEPTED_STATUSES = new Set([
  'delivered',
  'delivered-local-queued',
  'delivered-direct-local',
]);

const DELIVERY_DEFERRED_STATUSES = new Set([
  'queued',
  'direct-miss-failover',
  'stale-target',
]);

const DELIVERY_TRANSIENT_REASONS = new Set([
  'ENTITY_INPUT_TARGET_NOT_CONNECTED',
  'RECOVERY_TARGET_NOT_CONNECTED',
  'TARGET_SOCKET_NOT_OPEN',
  'ENTITY_INPUT_RATE_LIMITED',
]);

const DELIVERY_FATAL_REASON_PARTS = [
  'ENTITY_INPUT_MUST_BE_ENCRYPTED',
  'NO_LOCAL_REPLICA',
  'P2P_DECRYPT_ERROR',
  'invalid tag',
];

export type RelayStoreOptions = {
  maxGossipProfiles?: number;
  initialDebugId?: number;
  initialIncidents?: Iterable<RelayDebugIncident>;
  debugIdAllocator?: () => number;
  incidentSink?: (incident: RelayDebugIncident) => void;
  officialFoundationSignerId?: string;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createRelayStore = (serverId: string, options: RelayStoreOptions = {}): RelayStore => {
  const initialIncidents = Array.from(options.initialIncidents ?? []);
  const debugIncidents = new Map(initialIncidents.map(incident => [incident.fingerprint, incident]));
  const debugId = Math.max(
    Math.max(0, Math.floor(Number(options.initialDebugId ?? 0))),
    ...initialIncidents.map(incident => incident.lastEventId),
  );
  return {
    serverId,
    clients: new Map(),
    maxGossipProfiles: Math.max(1, Math.floor(Number(options.maxGossipProfiles ?? MAX_GOSSIP_PROFILES))),
    gossipProfiles: new Map(),
    gossipSeq: 0,
    routeGraphCache: createRouteGraphCache(),
    marketCapEntries: new Map(),
    marketCapUpdatedAt: 0,
    gossipJurisdictions: new Map(),
    ...(options.officialFoundationSignerId
      ? { officialFoundationSignerId: options.officialFoundationSignerId }
      : {}),
    runtimeEncryptionKeys: new Map(),
    applicationBudgets: new Map(),
    debugEvents: [],
    debugEventByteLengths: [],
    debugEventBytes: 0,
    debugIncidents,
    debugId,
    ...(options.debugIdAllocator ? { debugIdAllocator: options.debugIdAllocator } : {}),
    ...(options.incidentSink ? { incidentSink: options.incidentSink } : {}),
    wsCounter: 0,
    activeHubEntityIds: [],
  };
};

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

const deliveryCodeFor = (status: string, reason: string): string => {
  if (reason) return normalizeRuntimeFailureCode(reason);
  if (status === 'queued') return 'DELIVERY_QUEUED';
  if (status === 'direct-miss-failover') return 'DELIVERY_DIRECT_MISS_FAILOVER';
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
  if (code === 'DIRECT_MISS_FAILOVER' || code === 'DELIVERY_DIRECT_MISS_FAILOVER') return 'TransientRace';
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

const normalizeRootFingerprint = (value: unknown): string =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{7,199}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : '';

const classifyDebugIncident = (
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
    fingerprint: normalizeRootFingerprint(event.rootFingerprint) || `${code.toLowerCase()}-${incidentHash(basis)}`,
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

const updateDebugIncident = (store: RelayStore, event: RelayDebugEvent): RelayDebugIncident | null => {
  const classified = classifyDebugIncident(event);
  if (!classified) return null;
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
  const persisted = store.debugIncidents.get(classified.fingerprint);
  if (persisted) store.incidentSink?.(persisted);
  return persisted ?? null;
};

const relayDeliveryWarnAt = new Map<string, number>();

export const pushDebugEvent = (
  store: RelayStore,
  event: Omit<RelayDebugEvent, 'id' | 'ts'>,
): RelayDebugIncident | null => {
  const nextDebugId = store.debugIdAllocator?.() ?? store.debugId + 1;
  if (!Number.isSafeInteger(nextDebugId) || nextDebugId <= store.debugId) {
    throw new Error(`DEBUG_EVENT_ID_INVALID:current=${store.debugId}:next=${String(nextDebugId)}`);
  }
  const redactedEvent = redactTelemetryValue(event) as Omit<RelayDebugEvent, 'id' | 'ts'>;
  const delivery = redactedEvent.delivery ??
    (redactedEvent.event === 'delivery' ? classifyRelayDeliveryEvent(redactedEvent) ?? undefined : undefined);
  const storedEvent: RelayDebugEvent = {
    id: nextDebugId,
    ts: Date.now(),
    ...redactedEvent,
    ...(delivery ? { delivery } : {}),
  };
  const eventBytes = new TextEncoder().encode(safeStringify(storedEvent)).byteLength;
  if (eventBytes > MAX_DEBUG_EVENT_BYTES) {
    throw new Error(`DEBUG_EVENT_TOO_LARGE:bytes=${eventBytes}:max=${MAX_DEBUG_EVENT_BYTES}`);
  }
  store.debugId = nextDebugId;
  // Drain investigations live on these events: a stuck bilateral ACK leaves
  // no other trace. Surface non-delivered outcomes at warn (rate-limited per
  // reason) so one HLT run's log answers "where did the ACK die".
  if (storedEvent.event === 'delivery' && delivery && !isDeliveryDelivered(delivery)) {
    const reason = String((storedEvent as { reason?: unknown }).reason ?? 'unknown');
    const now = Date.now();
    const lastAt = relayDeliveryWarnAt.get(reason) ?? 0;
    if (now - lastAt >= 10_000) {
      relayDeliveryWarnAt.set(reason, now);
      console.warn(
        `[RELAY-DELIVERY] non-delivered reason=${reason} from=${String(storedEvent.from ?? '').slice(-8)} to=${String(storedEvent.to ?? '').slice(-8)} msgType=${String((storedEvent as { msgType?: unknown }).msgType ?? '')}`,
      );
    }
  }
  store.debugEvents.push(storedEvent);
  store.debugEventByteLengths.push(eventBytes);
  store.debugEventBytes += eventBytes;
  const incident = updateDebugIncident(store, storedEvent);
  while (
    store.debugEvents.length > MAX_DEBUG_EVENTS ||
    store.debugEventBytes > MAX_DEBUG_TIMELINE_BYTES
  ) {
    const removedEvent = store.debugEvents.shift();
    const removedBytes = store.debugEventByteLengths.shift();
    if (!removedEvent || removedBytes === undefined) {
      throw new Error('DEBUG_EVENT_TIMELINE_ACCOUNTING_DIVERGED');
    }
    store.debugEventBytes -= removedBytes;
  }
  if (
    store.debugEvents.length !== store.debugEventByteLengths.length ||
    store.debugEventBytes < 0
  ) {
    throw new Error('DEBUG_EVENT_TIMELINE_ACCOUNTING_INVALID');
  }
  return incident;
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
  store.incidentSink?.(updated);
  return updated;
};

/**
 * Clear the high-volume event timeline while retaining grouped incidents.
 *
 * Event ids are cursors, so they must remain monotonic for the lifetime of the
 * incident registry. Resetting debugId while incidents survive makes afterId
 * queries skip new events until the counter catches up to its old value.
 */
export const clearDebugTimeline = (store: RelayStore): void => {
  store.debugEvents.length = 0;
  store.debugEventByteLengths.length = 0;
  store.debugEventBytes = 0;
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
  store.gossipSeq += 1;
  store.gossipProfiles.set(entityId, { profile: canonicalProfile, timestamp: newTs, seq: store.gossipSeq });
  store.gossipProfilesSnapshot = undefined;
  return true;
};

// Identity-stable while the map is unchanged so the route graph memo holds;
// storeVerifiedGossipProfile drops the snapshot on every write, size/last catch
// clears and external mutation.
export const getAllGossipProfiles = (store: RelayStore): Profile[] => {
  let last: { profile: Profile; timestamp: number } | undefined;
  for (const entry of store.gossipProfiles.values()) last = entry;
  const snapshot = store.gossipProfilesSnapshot;
  if (snapshot && snapshot.size === store.gossipProfiles.size && snapshot.last === last) {
    return snapshot.profiles;
  }
  const profiles = Array.from(store.gossipProfiles.values()).map(v => v.profile);
  store.gossipProfilesSnapshot = { size: store.gossipProfiles.size, last, profiles };
  return profiles;
};

export const storeVerifiedJurisdictionAnnouncement = (
  store: RelayStore,
  value: unknown,
): JurisdictionGossipAnnouncement | null => {
  const announcement = decodeJurisdictionGossipAnnouncement(value, store.officialFoundationSignerId);
  const id = computeJurisdictionGossipHash(announcement);
  if (store.gossipJurisdictions.has(id)) return null;
  if (jurisdictionGossipScopeIsFull(store.gossipJurisdictions.values(), announcement.scope)) {
    throw new Error('RELAY_JURISDICTION_GOSSIP_CAP_EXCEEDED');
  }
  store.gossipJurisdictions.set(id, announcement);
  return announcement;
};

export const getAllGossipJurisdictions = (
  store: RelayStore,
): JurisdictionGossipAnnouncement[] => Array.from(store.gossipJurisdictions.values());

export type GossipProfileBatchPage = Readonly<{
  profiles: Profile[];
  cursor?: number;
  hasMore?: boolean;
}>;

/**
 * Default/hub directory sync is an exact relay-sequence page. Explicit
 * ids/route/prefix lookups never move that cursor: otherwise one targeted
 * lookup could skip unrelated profiles that the Runtime has not received.
 */
export const getProfileBatchPage = (
  store: RelayStore,
  request: GossipProfileBatchRequest = {},
): GossipProfileBatchPage => {
  const explicitLookup = request.ids !== undefined || request.routeTo !== undefined || request.prefix !== undefined;
  if (explicitLookup) {
    return {
      profiles: selectProfileBatch(
        getAllGossipProfiles(store),
        request,
        DEFAULT_GOSSIP_SYNC_LIMIT,
        store.routeGraphCache,
      ),
    };
  }

  const sinceSeq = Math.min(request.sinceSeq ?? 0, store.gossipSeq);
  const limit = Math.min(
    DEFAULT_GOSSIP_SYNC_LIMIT,
    Math.max(1, Math.floor(request.limit ?? DEFAULT_GOSSIP_SYNC_LIMIT)),
  );
  const hubsOnly = request.set === 'hubs';
  const profiles: Profile[] = [];
  let cursor = sinceSeq;
  const entries = Array.from(store.gossipProfiles.values())
    .filter(entry => entry.seq > sinceSeq)
    .sort((left, right) => left.seq - right.seq);
  for (const entry of entries) {
    cursor = entry.seq;
    if (!hubsOnly || entry.profile.metadata.isHub === true) profiles.push(entry.profile);
    if (profiles.length >= limit) break;
  }
  if (cursor < store.gossipSeq && profiles.length < limit) cursor = store.gossipSeq;
  return { profiles, cursor, hasMore: cursor < store.gossipSeq };
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
  store.clients.set(key, {
    ws,
    runtimeId: key,
    lastSeen: nextWsTimestamp(store),
    topics: new Set(),
    consecutiveBackpressuredSends: 0,
    backpressureStartedAt: 0,
  });
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
  return null;
};
