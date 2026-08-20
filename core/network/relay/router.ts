/**
 * Relay Router — pure message routing. No RuntimeReplica, no decryption.
 *
 * Receives parsed relay messages, looks up targets in the store,
 * and delegates to callbacks for local delivery and sending.
 */

import { asFailFastPayload, failfastAssert } from '../p2p/failfast';
import { HEAVY_LOGS } from '../../support/debug-flags';
import { serializeWsMessage, type RuntimeWsMessage } from '../p2p/ws-protocol';
import {
  type RelaySocketLike,
  type RelaySendResult,
  type RelayStore,
  isCanonicalRuntimeId,
  normalizeRuntimeKey,
  nextWsTimestamp,
  pushDebugEvent,
  storeVerifiedGossipProfile,
  getProfileBatch,
  getAllGossipJurisdictions,
  storeVerifiedJurisdictionAnnouncement,
  DEFAULT_GOSSIP_SYNC_LIMIT,
  registerClient,
  removeClient,
  cacheEncryptionKey,
  isRelaySocketOpen,
  classifyRelayDeliveryEvent,
} from './store';
import { classifyWebSocketSendResult } from '../websocket-send-result';
import { parseProfile, type Profile } from '../../entity/profile';
import { verifyProfileSignature, type ProfileVerifyResult } from '../../entity/profile/profile-signing';
import { verifyHelloAuth, verifyRuntimeWsFrameAuth } from '../p2p/auth/hello-auth';
import type { HelloChallengeBinding } from '../p2p/auth/hello-challenge';
import { isDeliveryDelivered, type DeliveryResult } from '../../protocol/payments/delivery-result';
import { createStructuredLogger } from '../../support/logger';
import { safeStringify } from '../../protocol/serialization';
import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../protocol/boundary-validation';
import {
  MAX_JURISDICTION_GOSSIP_BATCH_RECORDS,
  type JurisdictionGossipAnnouncement,
} from '../../jurisdiction/gossip/announcement';
import { decodeGossipProfileBatchRequest } from '../p2p/gossip/profile-batch';

const SOCKET_RUNTIME_ID = Symbol.for('xln.relay.socketRuntimeId');
const SOCKET_DUPLICATE_CLOSING = Symbol.for('xln.relay.duplicateClosing');
const SOCKET_AUTH_BINDING = Symbol.for('xln.relay.socketAuthBinding');
const SOCKET_GOSSIP_BUDGET = Symbol.for('xln.relay.socketGossipBudget');
type RememberedRelaySocket = object & { [SOCKET_RUNTIME_ID]?: string };
type DuplicateClosingRelaySocket = object & { [SOCKET_DUPLICATE_CLOSING]?: boolean };
type AuthenticatedRelaySocket = object & {
  [SOCKET_AUTH_BINDING]?: HelloChallengeBinding & { encryptionPubKey: string; lastAuthTimestamp: number };
};
type GossipBudgetRelaySocket = object & {
  [SOCKET_GOSSIP_BUDGET]?: { windowStartedAt: number; profileCount: number };
};
const GOSSIP_BUDGET_WINDOW_MS = 60_000;
const GOSSIP_PROFILES_PER_WINDOW = 10_000;
const NON_RECOVERABLE_LOCAL_DELIVERY_ERRORS = [
  'invalid tag',
  'P2P_DECRYPT_ERROR',
  'NO_LOCAL_REPLICA',
];
const LIVE_RECOVERY_MESSAGE_TYPES = new Set([
  'recovery_bundle_request',
  'recovery_bundle_response',
]);
const relayRouterLog = createStructuredLogger('relay.router');
const relayLog = process.env['RELAY_VERBOSE_LOGS'] === '1'
  ? (message: string): void => relayRouterLog.debug('verbose', { line: message })
  : (_message: string): void => {};

const rememberSocketRuntimeId = (ws: unknown, runtimeId: string): void => {
  if (!ws || (typeof ws !== 'object' && typeof ws !== 'function')) return;
  const normalized = normalizeRuntimeKey(runtimeId);
  if (!normalized) return;
  Object.defineProperty(ws as RememberedRelaySocket, SOCKET_RUNTIME_ID, {
    value: normalized,
    enumerable: false,
    configurable: true,
    writable: true,
  });
};

const getRememberedSocketRuntimeId = (ws: unknown): string => {
  if (!ws || (typeof ws !== 'object' && typeof ws !== 'function')) return '';
  return normalizeRuntimeKey((ws as RememberedRelaySocket)[SOCKET_RUNTIME_ID] || '');
};

const rememberSocketAuthBinding = (
  ws: unknown,
  binding: HelloChallengeBinding & { encryptionPubKey: string; lastAuthTimestamp: number },
): void => {
  if (!ws || (typeof ws !== 'object' && typeof ws !== 'function')) return;
  Object.defineProperty(ws as AuthenticatedRelaySocket, SOCKET_AUTH_BINDING, {
    value: binding,
    enumerable: false,
    configurable: true,
  });
};

const getSocketAuthBinding = (ws: unknown): AuthenticatedRelaySocket[typeof SOCKET_AUTH_BINDING] =>
  ws && (typeof ws === 'object' || typeof ws === 'function')
    ? (ws as AuthenticatedRelaySocket)[SOCKET_AUTH_BINDING]
    : undefined;

export const forgetRelaySocketRuntimeId = (ws: unknown): void => {
  if (!ws || (typeof ws !== 'object' && typeof ws !== 'function')) return;
  delete (ws as RememberedRelaySocket)[SOCKET_RUNTIME_ID];
  delete (ws as AuthenticatedRelaySocket)[SOCKET_AUTH_BINDING];
  delete (ws as GossipBudgetRelaySocket)[SOCKET_GOSSIP_BUDGET];
};

const markDuplicateClosingSocket = (ws: unknown): void => {
  if (!ws || (typeof ws !== 'object' && typeof ws !== 'function')) return;
  Object.defineProperty(ws as DuplicateClosingRelaySocket, SOCKET_DUPLICATE_CLOSING, {
    value: true,
    enumerable: false,
    configurable: true,
    writable: true,
  });
};

const isDuplicateClosingSocket = (ws: unknown): boolean =>
  !!ws && (typeof ws === 'object' || typeof ws === 'function') &&
  (ws as DuplicateClosingRelaySocket)[SOCKET_DUPLICATE_CLOSING] === true;

const closeDuplicateRuntimeSocket = (ws: RelaySocketLike): void => {
  markDuplicateClosingSocket(ws);
  try {
    ws.close?.(4009, 'duplicate-runtime');
  } catch (error) {
    relayRouterLog.warn('duplicate_socket.close_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const closeSupersededRuntimeSocket = (ws: RelaySocketLike): void => {
  markDuplicateClosingSocket(ws);
  try {
    ws.close?.(4009, 'superseded-runtime');
  } catch (error) {
    // The newly authenticated session is already authoritative. Keep it live,
    // but preserve a loud transport diagnostic for the stale socket.
    relayRouterLog.warn('superseded_socket.close_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const closeInvalidRelaySession = (
  store: RelayStore,
  ws: RelaySocketLike,
  reason = 'relay-session-auth-invalid',
): void => {
  removeClient(store, ws);
  forgetRelaySocketRuntimeId(ws);
  try {
    ws.close?.(4003, reason);
  } catch (error) {
    relayRouterLog.warn('invalid_session_socket.close_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const consumeGossipBudget = (ws: RelaySocketLike, profileCount: number, now = Date.now()): boolean => {
  const socket = ws as GossipBudgetRelaySocket;
  const previous = socket[SOCKET_GOSSIP_BUDGET];
  const budget = !previous || now - previous.windowStartedAt >= GOSSIP_BUDGET_WINDOW_MS
    ? { windowStartedAt: now, profileCount: 0 }
    : previous;
  if (budget.profileCount + profileCount > GOSSIP_PROFILES_PER_WINDOW) return false;
  budget.profileCount += profileCount;
  socket[SOCKET_GOSSIP_BUDGET] = budget;
  return true;
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type RelayRouterConfig = {
  store: RelayStore;
  localRuntimeId: string;
  /** Called when an entity_inputs envelope targets this runtime. */
  localDeliver: (from: string | undefined, msg: RuntimeWsMessage) => Promise<void>;
  /** Thin wrapper over the binary production WebSocket codec. */
  send: (ws: RelaySocketLike, data: Uint8Array) => RelaySendResult;
  /** Hook to mirror gossip into env. */
  onGossipStore?: (profile: Profile) => void;
  helloSkewMs?: number;
  consumeHelloChallenge?: (ws: object, claim: unknown) => HelloChallengeBinding | null;
  verifyProfile?: (profile: Profile) => Promise<ProfileVerifyResult> | ProfileVerifyResult;
  applicationBudget?: Partial<{
    windowMs: number;
    maxMessages: number;
    maxBytes: number;
  }>;
};

const DEFAULT_HELLO_SKEW_MS = 5 * 60 * 1000;

const relayDeliveryMetadata = (status: string, reason?: string) =>
  classifyRelayDeliveryEvent({ status, ...(reason ? { reason } : {}) }) ?? undefined;

const requireRelayDeliveryMetadata = (status: string, reason?: string): DeliveryResult => {
  const delivery = relayDeliveryMetadata(status, reason);
  if (!delivery) throw new Error(`RELAY_DELIVERY_CLASSIFICATION_MISSING: status=${status}`);
  return delivery;
};

type RelayDeliveryAttempt = {
  delivery: DeliveryResult;
  /** True when Bun's send() returned -1 (queued into the backpressure buffer,
   *  not confirmed written). Kept separate from `delivery` so callers don't
   *  start failover-retrying a queued financial envelope — see the
   *  consecutiveBackpressuredSends doc on RelayClient for why a socket stuck
   *  in this state needs a force-close watchdog instead. */
  backpressured: boolean;
};

const sendRelayDelivery = (
  config: RelayRouterConfig,
  ws: RelaySocketLike,
  msg: unknown,
  wireBytes?: Uint8Array,
): RelayDeliveryAttempt => {
  if (!isRelaySocketOpen(ws)) {
    return { delivery: requireRelayDeliveryMetadata('stale-target', 'TARGET_SOCKET_NOT_OPEN'), backpressured: false };
  }
  let result: RelaySendResult;
  try {
    result = config.send(ws, wireBytes ?? serializeWsMessage(msg as RuntimeWsMessage));
  } catch (error) {
    return {
      delivery: requireRelayDeliveryMetadata('send-failed', error instanceof Error ? error.message : String(error)),
      backpressured: false,
    };
  }
  const disposition = classifyWebSocketSendResult(result);
  if (disposition === 'dropped') {
    return { delivery: requireRelayDeliveryMetadata('send-failed', 'RELAY_SEND_DROPPED'), backpressured: false };
  }
  return { delivery: requireRelayDeliveryMetadata('delivered'), backpressured: disposition === 'backpressured' };
};

const createRelayRouteContext = (
  config: RelayRouterConfig,
  ws: RelaySocketLike,
  msg: RuntimeWsMessage,
  rawBytes?: Uint8Array,
) => {
  const type = String(msg.type);
  const fromKey = normalizeRuntimeKey(msg.from);
  const toKey = normalizeRuntimeKey(msg.to);
  return {
    config,
    ws,
    msg,
    rawBytes,
    encodedBytes: undefined as Uint8Array | undefined,
    type,
    to: msg.to,
    from: msg.from,
    payload: msg.payload,
    id: msg.id,
    fromKey,
    toKey,
    traceId: typeof msg.id === 'string' && msg.id.length > 0
      ? msg.id
      : `relay-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    rememberedRuntimeId: getRememberedSocketRuntimeId(ws),
    fromEncryptionPubKey: typeof msg.fromEncryptionPubKey === 'string'
      ? msg.fromEncryptionPubKey
      : null,
    deliveryEntityId: typeof msg.entityId === 'string' && msg.entityId.length > 0
      ? msg.entityId
      : undefined,
    deliveryTxCount: typeof msg.txs === 'number' && Number.isFinite(msg.txs)
      ? msg.txs
      : undefined,
  };
};

type RelayRouteContext = ReturnType<typeof createRelayRouteContext>;

const resolveRelayWireBytes = (context: RelayRouteContext): Uint8Array => {
  if (context.rawBytes) return context.rawBytes;
  return context.encodedBytes ??= serializeWsMessage(context.msg);
};

const relayMessageByteLength = (context: RelayRouteContext): number => {
  if (context.rawBytes) return context.rawBytes.byteLength;
  try {
    return resolveRelayWireBytes(context).byteLength;
  } catch {
    return 1;
  }
};

const DEFAULT_APPLICATION_BUDGET = {
  windowMs: 60_000,
  maxMessages: 10_000,
  maxBytes: 512 * 1024 * 1024,
} as const;

const consumeApplicationBudget = (
  context: RelayRouteContext,
  bytes: number,
  now = Date.now(),
): boolean => {
  const { config, fromKey } = context;
  if (!fromKey) return false;
  const limits = { ...DEFAULT_APPLICATION_BUDGET, ...config.applicationBudget };
  let budget = config.store.applicationBudgets.get(fromKey);
  if (!budget || now - budget.windowStartedAt >= limits.windowMs) {
    for (const [runtimeId, candidate] of config.store.applicationBudgets) {
      if (now - candidate.windowStartedAt >= limits.windowMs) {
        config.store.applicationBudgets.delete(runtimeId);
      }
    }
    budget = { windowStartedAt: now, messageCount: 0, bytes: 0 };
  }
  if (budget.messageCount + 1 > limits.maxMessages || budget.bytes + bytes > limits.maxBytes) {
    return false;
  }
  budget.messageCount += 1;
  budget.bytes += bytes;
  config.store.applicationBudgets.set(fromKey, budget);
  return true;
};

const handleHello = (context: RelayRouteContext): boolean => {
  const { config, ws, type, from, fromKey, traceId, fromEncryptionPubKey } = context;
  const { store, send } = config;
  if (type !== 'hello' || !from) return false;
  if (!isCanonicalRuntimeId(from)) {
    pushDebugEvent(store, {
      event: 'error',
      from,
      msgType: type,
      status: 'rejected',
      reason: 'Invalid runtimeId in hello',
      details: { traceId },
    });
    send(ws, serializeWsMessage({ type: 'error', error: 'Invalid runtimeId in hello' }));
    return true;
  }
  const binding = config.consumeHelloChallenge?.(
    ws as object,
    { challenge: context.msg.auth?.nonce, audience: context.msg.audience },
  ) ?? null;
  const authError = binding
    ? verifyHelloAuth(
        fromKey,
        fromEncryptionPubKey!,
        context.msg.auth,
        config.helloSkewMs ?? DEFAULT_HELLO_SKEW_MS,
        binding.audience,
        typeof context.msg.sessionPubKey === 'string' ? context.msg.sessionPubKey : undefined,
      )
    : 'Hello challenge missing, expired, or already consumed';
  if (authError) {
    pushDebugEvent(store, {
      event: 'hello', runtimeId: from, from, msgType: type, status: 'rejected',
      reason: 'HELLO_AUTH_INVALID', details: { traceId, authError },
    });
    send(ws, serializeWsMessage({ type: 'error', error: authError }));
    return true;
  }
  rememberSocketAuthBinding(ws, {
    ...binding!,
    encryptionPubKey: fromEncryptionPubKey!,
    lastAuthTimestamp: 0,
  });
  const existingClient = store.clients.get(fromKey);
  if (existingClient && existingClient.ws !== ws) {
    // A fresh challenge signed by the same runtime key proves reconnect
    // authority. Install the new socket before closing the stale one so its
    // close callback cannot remove the replacement.
    removeClient(store, existingClient.ws);
    closeSupersededRuntimeSocket(existingClient.ws);
    pushDebugEvent(store, {
      event: 'ws_runtime_replaced',
      runtimeId: fromKey,
      from: fromKey,
      msgType: type,
      status: 'reconnected',
      details: { traceId },
    });
  }
  if (!registerClient(store, from, ws)) {
    pushDebugEvent(store, {
      event: 'hello',
      runtimeId: from,
      from,
      msgType: type,
      status: 'rejected',
      reason: 'DUPLICATE_RUNTIME_CONNECTION',
      details: { traceId },
    });
    closeDuplicateRuntimeSocket(ws);
    return true;
  }
  rememberSocketRuntimeId(ws, fromKey);
  if (fromEncryptionPubKey) cacheEncryptionKey(store, fromKey, fromEncryptionPubKey);
  pushDebugEvent(store, {
    event: 'hello',
    runtimeId: from,
    from,
    msgType: type,
    status: 'connected',
    details: { traceId },
  });
  send(ws, serializeWsMessage({ type: 'hello_ack', to: fromKey }));
  return true;
};

type StoredGossipProfiles = {
  received: number;
  stored: number;
  droppedMalformed: number;
  droppedInvalidSignature: number;
  profiles: Profile[];
};

const storeAnnouncedProfiles = async (
  context: RelayRouteContext,
  profiles: unknown[],
): Promise<StoredGossipProfiles> => {
  const { config, from, fromKey, type, traceId } = context;
  const result: StoredGossipProfiles = {
    received: profiles.length,
    stored: 0,
    droppedMalformed: 0,
    droppedInvalidSignature: 0,
    profiles: [],
  };
  const verifyProfile = config.verifyProfile ?? verifyProfileSignature;
  for (const value of profiles) {
    try {
      const profile = parseProfile(value);
      const normalized: Profile = { ...profile, runtimeId: profile.runtimeId || fromKey };
      const verified = await verifyProfile(normalized);
      if (!verified.valid) {
        result.droppedInvalidSignature += 1;
        pushDebugEvent(config.store, {
          event: 'error',
          from,
          msgType: type,
          status: 'rejected',
          reason: 'GOSSIP_PROFILE_SIGNATURE_INVALID',
          details: {
            entityId: typeof normalized.entityId === 'string' ? normalized.entityId : null,
            verifyReason: verified.reason || 'invalid',
            traceId,
          },
        });
        continue;
      }
      if (storeVerifiedGossipProfile(config.store, normalized)) {
        result.stored += 1;
        result.profiles.push(normalized);
      }
      config.onGossipStore?.(normalized);
    } catch (error) {
      result.droppedMalformed += 1;
      pushDebugEvent(config.store, {
        event: 'error',
        from,
        msgType: type,
        status: 'rejected',
        reason: 'GOSSIP_PROFILE_DROPPED_MALFORMED',
        details: {
          entityId: value && typeof value === 'object' && 'entityId' in value
            ? String((value as { entityId?: unknown }).entityId ?? '')
            : null,
          message: error instanceof Error ? error.message : String(error),
          traceId,
        },
      });
    }
  }
  return result;
};

// Profiles are pull-only: the relay stores what hubs and users announce and
// answers gossip_request (set/ids/routeTo) — it never fans profiles out. Only
// fresh jurisdiction discovery (rare, tiny, cluster-wide) is still pushed.
const broadcastGossipJurisdictions = (
  context: RelayRouteContext,
  storedJurisdictions: JurisdictionGossipAnnouncement[] = [],
): number => {
  if (storedJurisdictions.length === 0) return 0;
  const { config, fromKey, id } = context;
  let targets = 0;
  for (const [runtimeId, client] of config.store.clients.entries()) {
    if (!client?.ws || (fromKey && runtimeId === fromKey)) continue;
    config.send(client.ws, serializeWsMessage({
      type: 'gossip_update',
      id: `gossip_update_${Date.now()}`,
      from: config.store.serverId,
      to: runtimeId,
      timestamp: Date.now(),
      payload: { profiles: [], jurisdictions: storedJurisdictions },
      ...(id ? { inReplyTo: id } : {}),
    }));
    targets += 1;
  }
  return targets;
};

const handleGossipAnnounce = async (context: RelayRouteContext): Promise<boolean> => {
  const { config, ws, payload, type, from, fromKey, rememberedRuntimeId, traceId } = context;
  if (type !== 'gossip_announce') return false;
  if (!fromKey || rememberedRuntimeId !== fromKey) {
    pushDebugEvent(config.store, {
      event: 'error',
      from,
      msgType: type,
      status: 'rejected',
      reason: 'GOSSIP_ANNOUNCE_UNREGISTERED_RUNTIME',
      details: { traceId },
    });
    config.send(ws, serializeWsMessage({
      type: 'error',
      error: 'Gossip announce requires registered relay hello',
    }));
    return true;
  }
  const value = requireBoundaryRecord(payload, 'RELAY_GOSSIP_ANNOUNCE_INVALID');
  requireExactBoundaryKeys(value, ['profiles', 'jurisdictions'], [], 'RELAY_GOSSIP_ANNOUNCE_FIELDS_INVALID');
  if (!Array.isArray(value['profiles']) || !Array.isArray(value['jurisdictions'])) {
    throw new Error('RELAY_GOSSIP_ANNOUNCE_ARRAYS_INVALID');
  }
  const announced = value['profiles'];
  const jurisdictionValues = value['jurisdictions'];
  if (
    announced.length > DEFAULT_GOSSIP_SYNC_LIMIT ||
    jurisdictionValues.length > MAX_JURISDICTION_GOSSIP_BATCH_RECORDS ||
    !consumeGossipBudget(ws, announced.length + jurisdictionValues.length)
  ) {
    pushDebugEvent(config.store, {
      event: 'error', from, msgType: type, status: 'rejected',
      reason: 'GOSSIP_ANNOUNCE_RATE_LIMITED',
      details: {
        announced: announced.length,
        jurisdictions: jurisdictionValues.length,
        maxBatch: DEFAULT_GOSSIP_SYNC_LIMIT,
        traceId,
      },
    });
    config.send(ws, serializeWsMessage({ type: 'error', error: 'GOSSIP_ANNOUNCE_RATE_LIMITED' }));
    closeInvalidRelaySession(config.store, ws, 'relay-gossip-rate-limited');
    return true;
  }
  const stored = await storeAnnouncedProfiles(context, announced);
  const storedJurisdictions: JurisdictionGossipAnnouncement[] = [];
  for (const jurisdiction of jurisdictionValues) {
    try {
      const accepted = storeVerifiedJurisdictionAnnouncement(config.store, jurisdiction);
      if (accepted) storedJurisdictions.push(accepted);
    } catch (error) {
      pushDebugEvent(config.store, {
        event: 'error',
        from,
        msgType: type,
        status: 'rejected',
        reason: 'GOSSIP_JURISDICTION_DROPPED_INVALID',
        details: { message: error instanceof Error ? error.message : String(error), traceId },
      });
    }
  }
  const broadcastTargets = broadcastGossipJurisdictions(context, storedJurisdictions);
  pushDebugEvent(config.store, {
    event: 'gossip_store',
    from,
    msgType: type,
    status: 'stored',
    details: {
      received: stored.received,
      stored: stored.stored,
      droppedMalformed: stored.droppedMalformed,
      droppedInvalidSignature: stored.droppedInvalidSignature,
      jurisdictionsStored: storedJurisdictions.length,
      broadcastTargets,
      traceId,
    },
  });
  return true;
};

const handleSimpleRelayMessage = (context: RelayRouteContext): boolean => {
  const { config, ws, payload, type, from, to, id, traceId } = context;
  if (type === 'gossip_request') {
    const request = decodeGossipProfileBatchRequest(payload);
    const requestCost = request.routeTo
      ? 200
      : Math.max(1, request.ids?.length ?? 1);
    if (!consumeGossipBudget(ws, requestCost)) {
      pushDebugEvent(config.store, {
        event: 'error',
        from,
        msgType: type,
        status: 'rejected',
        reason: 'GOSSIP_REQUEST_RATE_LIMITED',
        details: { requestCost, traceId },
      });
      config.send(ws, serializeWsMessage({
        type: 'error',
        error: 'GOSSIP_REQUEST_RATE_LIMITED',
        ...(id ? { inReplyTo: id } : {}),
      }));
      return true;
    }
    const profiles = getProfileBatch(config.store, request);
    const jurisdictions = request.includeJurisdictions === true
      ? getAllGossipJurisdictions(config.store)
      : [];
    pushDebugEvent(config.store, {
      event: 'gossip_request',
      from,
      to,
      msgType: type,
      details: {
        returnedProfiles: profiles.length,
        returnedJurisdictions: jurisdictions.length,
        idCount: Array.isArray(request.ids) ? request.ids.length : 0,
        set: request.set ?? (request.routeTo || (request.ids?.length ?? 0) > 0 ? null : 'default'),
        routeTo: request.routeTo ? { source: request.routeTo.source, target: request.routeTo.target } : null,
        updatedSince: request.updatedSince ?? null,
        limit: request.limit ?? DEFAULT_GOSSIP_SYNC_LIMIT,
        traceId,
      },
    });
    config.send(ws, serializeWsMessage({
      type: 'gossip_response',
      id: `gossip_${Date.now()}`,
      from: config.store.serverId,
      ...(from ? { to: from } : {}),
      timestamp: Date.now(),
      payload: { profiles, jurisdictions, cursor: config.store.gossipSeq },
      ...(id ? { inReplyTo: id } : {}),
    }));
    return true;
  }
  if (type === 'debug_event') {
    pushDebugEvent(config.store, {
      event: 'debug_event',
      from,
      to,
      msgType: type,
      details: {
        traceId,
        payloadBytes: new TextEncoder().encode(safeStringify(payload)).byteLength,
      },
    });
    return true;
  }
  if (type === 'ping') {
    config.send(ws, serializeWsMessage({ type: 'pong', ...(id ? { inReplyTo: id } : {}) }));
    return true;
  }
  return false;
};

const isRoutableRelayType = (type: string): boolean =>
  type === 'entity_inputs' ||
  type === 'gossip_response' ||
  LIVE_RECOVERY_MESSAGE_TYPES.has(type);

/**
 * Recipient-key encryption proves confidentiality, not sender identity. If a
 * socket could route before signed hello, it could claim a victim runtime in
 * both `from` and the encrypted envelope; Runtime admission intentionally
 * forwards opaque ciphertext; Runtime verifies the signed plaintext envelope.
 */
const rejectUnauthenticatedRoutableMessage = (context: RelayRouteContext): boolean => {
  const { config, ws, type, from, to, id, fromKey, rememberedRuntimeId, traceId } = context;
  if (fromKey && rememberedRuntimeId === fromKey) return false;
  pushDebugEvent(config.store, {
    event: 'error',
    from,
    to,
    msgType: type,
    status: 'rejected',
    reason: 'ROUTABLE_MESSAGE_UNREGISTERED_RUNTIME',
    details: { traceId, rememberedRuntimeId },
  });
  config.send(ws, serializeWsMessage({
    type: 'error',
    error: 'Routable message requires registered relay hello',
    ...(id ? { inReplyTo: id } : {}),
    ...(to ? { to } : {}),
  }));
  return true;
};

const routeDeliveryDetails = (context: RelayRouteContext): Record<string, unknown> => ({
  traceId: context.traceId,
  ...(context.deliveryEntityId ? { entityId: context.deliveryEntityId } : {}),
  ...(context.deliveryTxCount !== undefined ? { txs: context.deliveryTxCount } : {}),
});

/** A socket that keeps queuing sends into backpressure without draining is
 *  stuck, not just slow — matches STUCK_SEND_THRESHOLD in
 *  core/network/p2p/direct-runtime-bun.ts's noteSendOutcome. Count alone is
 *  wrong at 1000-user mixed load: four 10 MB Hub frames in one burst are
 *  queued, not wedged; closing the Hub socket drops in-flight Account ACKs. */
export const RELAY_STUCK_BACKPRESSURE_THRESHOLD = 4;
export const RELAY_STUCK_BACKPRESSURE_MS = 10_000;

const forwardToRemoteRuntime = (
  context: RelayRouteContext,
  isLocalTarget: boolean,
): boolean => {
  const { config, msg, type, from, to, toKey } = context;
  const target = config.store.clients.get(toKey);
  if (!target || isLocalTarget) return false;
  const attempt = sendRelayDelivery(config, target.ws, msg, resolveRelayWireBytes(context));
  const delivery = attempt.delivery;
  if (type === 'entity_inputs' && HEAVY_LOGS) {
    console.debug(
      `[RELAY-REMOTE] entity_inputs from=${String(from || '').slice(-8)} to=${String(to || '').slice(-8)} outcome=${delivery.outcome}:${delivery.code}`,
    );
  }
  if (isDeliveryDelivered(delivery)) {
    if (attempt.backpressured) {
      const now = Date.now();
      target.consecutiveBackpressuredSends += 1;
      if (target.backpressureStartedAt === 0) target.backpressureStartedAt = now;
      if (
        target.consecutiveBackpressuredSends >= RELAY_STUCK_BACKPRESSURE_THRESHOLD &&
        now - target.backpressureStartedAt >= RELAY_STUCK_BACKPRESSURE_MS
      ) {
        target.consecutiveBackpressuredSends = 0;
        target.backpressureStartedAt = 0;
        pushDebugEvent(config.store, {
          event: 'ws_stuck_backpressure_closed',
          runtimeId: toKey,
          from,
          to,
          status: 'send-failed',
          reason: 'RELAY_STUCK_BACKPRESSURE',
          details: routeDeliveryDetails(context),
        });
        target.ws.close?.(4010, 'stuck-backpressure');
        removeClient(config.store, target.ws);
      }
    } else {
      target.consecutiveBackpressuredSends = 0;
      target.backpressureStartedAt = 0;
    }
    relayLog('[RELAY] → forwarding to WS client');
    pushDebugEvent(config.store, {
      event: 'delivery',
      from,
      to,
      msgType: type,
      encrypted: msg.encrypted === true,
      status: 'delivered',
      delivery,
      details: routeDeliveryDetails(context),
    });
    return true;
  }
  removeClient(config.store, target.ws);
  const sendFailure = delivery.code !== 'TARGET_SOCKET_NOT_OPEN' && delivery.code !== 'DELIVERY_STALE_TARGET';
  pushDebugEvent(config.store, {
    event: 'delivery',
    from,
    to,
    msgType: type,
    encrypted: msg.encrypted === true,
    status: sendFailure ? 'send-failed' : 'stale-target',
    reason: delivery.failure?.message ?? delivery.code,
    delivery,
    details: routeDeliveryDetails(context),
  });
  return false;
};

type LocalDeliveryDisposition = 'delivered' | 'rejected' | 'unavailable';

const deliverToLocalRuntime = async (
  context: RelayRouteContext,
  isLocalTarget: boolean,
): Promise<LocalDeliveryDisposition> => {
  const { config, ws, msg, type, from, to, payload, traceId } = context;
  const isApplicationMessage = type === 'entity_inputs';
  if (!isApplicationMessage || !payload || !isLocalTarget) return 'unavailable';
  try {
    await config.localDeliver(from, msg);
    if (HEAVY_LOGS) {
      console.debug(`[RELAY-FORWARD] entity_inputs from=${String(from || '').slice(-8)} to=${String(to || '').slice(-8)}`);
    }
    return 'delivered';
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    relayLog(`[RELAY] Local delivery failed: ${reason}`);
    pushDebugEvent(config.store, {
      event: 'error',
      from,
      to,
      msgType: type,
      status: 'local-delivery-failed',
      reason,
      delivery: relayDeliveryMetadata('local-delivery-failed', reason),
      details: { traceId },
    });
    // Poisoned ciphertext and unknown local replicas cannot become valid by
    // replaying. Reject them instead of creating an immortal pending loop.
    if (NON_RECOVERABLE_LOCAL_DELIVERY_ERRORS.some(part => reason.includes(part))) {
      config.send(ws, serializeWsMessage({ type: 'error', error: reason }));
      return 'rejected';
    }
    return 'unavailable';
  }
};

const rejectUnavailableEntityInputs = (context: RelayRouteContext): boolean => {
  const { config, ws, msg, type, from, to, id } = context;
  if (type === 'entity_inputs') {
    const code = 'ENTITY_INPUT_TARGET_NOT_CONNECTED';
    relayLog(`[RELAY] → rejected ${type} (target not connected)`);
    pushDebugEvent(config.store, {
      event: 'delivery',
      from,
      to,
      msgType: type,
      encrypted: msg.encrypted === true,
      status: 'rejected',
      reason: code,
      details: routeDeliveryDetails(context),
    });
    config.send(ws, serializeWsMessage({
      type: 'error',
      error: code,
      ...(id ? { inReplyTo: id } : {}),
      ...(to ? { to } : {}),
    }));
    return true;
  }
  if (!LIVE_RECOVERY_MESSAGE_TYPES.has(type)) return false;
  const code = 'RECOVERY_TARGET_NOT_CONNECTED';
  relayLog(`[RELAY] → rejected ${type} (target not connected)`);
  pushDebugEvent(config.store, {
    event: 'delivery',
    from,
    to,
    msgType: type,
    encrypted: msg.encrypted === true,
    status: 'rejected',
    reason: code,
    details: { traceId: context.traceId },
  });
  config.send(ws, serializeWsMessage({
    type: 'error',
    error: code,
    ...(id ? { inReplyTo: id } : {}),
    ...(to ? { to } : {}),
  }));
  return true;
};

const handleRoutableMessage = async (context: RelayRouteContext): Promise<boolean> => {
  const { config, ws, msg, type, from, to, payload, toKey, traceId } = context;
  if (!isRoutableRelayType(type)) return false;
  if (rejectUnauthenticatedRoutableMessage(context)) return true;
  if (!toKey) {
    pushDebugEvent(config.store, {
      event: 'error',
      from,
      msgType: type,
      status: 'rejected',
      reason: 'Missing target runtimeId',
      details: { traceId },
    });
    config.send(ws, serializeWsMessage({ type: 'error', error: 'Missing target runtimeId' }));
    return true;
  }
  if (type === 'entity_inputs' && (msg.encrypted !== true || typeof payload !== 'string')) {
    pushDebugEvent(config.store, {
      event: 'error',
      from,
      to,
      msgType: type,
      status: 'rejected',
      reason: 'ENTITY_INPUT_MUST_BE_ENCRYPTED',
      delivery: relayDeliveryMetadata('rejected', 'ENTITY_INPUT_MUST_BE_ENCRYPTED'),
      details: { traceId },
    });
    config.send(ws, serializeWsMessage({ type: 'error', error: 'entity_inputs must be encrypted' }));
    return true;
  }
  if (
    type === 'entity_inputs' &&
    !consumeApplicationBudget(context, relayMessageByteLength(context))
  ) {
    const code = 'ENTITY_INPUT_RATE_LIMITED';
    pushDebugEvent(config.store, {
      event: 'delivery',
      from,
      to,
      msgType: type,
      status: 'deferred',
      reason: code,
      delivery: relayDeliveryMetadata('queued', code),
      details: routeDeliveryDetails(context),
    });
    config.send(ws, serializeWsMessage({
      type: 'error',
      error: code,
      ...(context.id ? { inReplyTo: context.id } : {}),
      ...(to ? { to } : {}),
    }));
    return true;
  }
  relayLog(`[RELAY] ${type} from=${from || 'none'} to=${to || 'none'} encrypted=${msg.encrypted ?? false}`);
  const localRuntimeKey = normalizeRuntimeKey(config.localRuntimeId);
  const isLocalTarget = !!localRuntimeKey && toKey === localRuntimeKey;
  if (forwardToRemoteRuntime(context, isLocalTarget)) return true;
  const local = await deliverToLocalRuntime(context, isLocalTarget);
  if (local !== 'unavailable') return true;
  if (rejectUnavailableEntityInputs(context)) return true;
  const code = 'GOSSIP_TARGET_NOT_CONNECTED';
  relayLog(`[RELAY] → rejected ${type} (target not connected)`);
  pushDebugEvent(config.store, {
    event: 'delivery',
    from,
    to,
    msgType: type,
    encrypted: msg.encrypted === true,
    status: 'rejected',
    reason: code,
    details: routeDeliveryDetails(context),
  });
  config.send(ws, serializeWsMessage({
    type: 'error',
    error: code,
    ...(context.id ? { inReplyTo: context.id } : {}),
    ...(to ? { to } : {}),
  }));
  return true;
};

const prepareRelaySession = (context: RelayRouteContext): boolean => {
  const {
    config,
    ws,
    msg,
    type,
    to,
    from,
    id,
    fromKey,
    traceId,
    rememberedRuntimeId,
    fromEncryptionPubKey,
  } = context;
  const { store, send } = config;
  const authBinding = getSocketAuthBinding(ws);
  if (rememberedRuntimeId && fromKey && rememberedRuntimeId !== fromKey) {
    pushDebugEvent(store, {
      event: 'error',
      from,
      to,
      msgType: type,
      status: 'rejected',
      reason: 'RELAY_FROM_RUNTIME_MISMATCH',
      details: { traceId, rememberedRuntimeId },
    });
    send(ws, serializeWsMessage({ type: 'error', error: 'Relay socket runtime mismatch' }));
    closeInvalidRelaySession(store, ws);
    return false;
  }
  if (type !== 'hello') {
    // The hello key is immutable for this socket. Re-caching a later advertised
    // key would redirect the next encrypted envelope to an injected key.
    const verifiedError = !rememberedRuntimeId || !fromKey || !authBinding
      ? 'Relay session authentication missing'
      : fromEncryptionPubKey?.toLowerCase() !== authBinding.encryptionPubKey.toLowerCase()
        ? 'Relay session encryption key mismatch'
        : verifyRuntimeWsFrameAuth(
            rememberedRuntimeId,
            msg,
            msg.auth,
            authBinding.audience,
            authBinding.challenge,
            authBinding.lastAuthTimestamp,
          );
    if (verifiedError) {
      pushDebugEvent(store, {
        event: 'error', from, to, msgType: type, status: 'rejected',
        reason: 'RELAY_SESSION_AUTH_INVALID', details: { traceId, authError: verifiedError },
      });
      send(ws, serializeWsMessage({ type: 'error', error: verifiedError }));
      closeInvalidRelaySession(store, ws);
      return false;
    }
    authBinding!.lastAuthTimestamp = msg.auth!.timestamp;
  }
  if (rememberedRuntimeId && fromKey && rememberedRuntimeId === fromKey) {
    const existing = store.clients.get(rememberedRuntimeId);
    if (!existing || existing.ws !== ws) {
      const registered = registerClient(store, rememberedRuntimeId, ws);
      pushDebugEvent(store, {
        event: 'ws_rebind',
        runtimeId: rememberedRuntimeId,
        from,
        msgType: type,
        status: registered ? 'reconnected' : 'rejected',
        details: { traceId: typeof id === 'string' ? id : null },
      });
    } else {
      existing.lastSeen = nextWsTimestamp(store);
    }
  }
  if (from && !fromEncryptionPubKey && type !== 'ping' && type !== 'pong') {
    pushDebugEvent(store, {
      event: 'error',
      from,
      to,
      msgType: type,
      status: 'rejected',
      reason: 'MISSING_FROM_ENCRYPTION_PUBKEY',
      details: { traceId },
    });
    send(ws, serializeWsMessage({ type: 'error', error: 'Missing fromEncryptionPubKey' }));
    return false;
  }
  if (type !== 'gossip_request' && type !== 'gossip_response' && type !== 'gossip_announce') {
    relayLog(`[RELAY-MSG] type=${type} from=${from || 'none'} to=${to || 'none'}`);
  }
  pushDebugEvent(store, {
    event: 'message',
    from,
    to,
    msgType: type,
    encrypted: msg.encrypted === true,
    size: relayMessageByteLength(context),
    details: { traceId, hasFromEncryptionPubKey: !!fromEncryptionPubKey },
  });
  return true;
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export const relayRoute = async (
  config: RelayRouterConfig,
  ws: RelaySocketLike,
  rawMsg: unknown,
  rawBytes?: Uint8Array,
): Promise<void> => {
  if (isDuplicateClosingSocket(ws)) return;
  const { store, send } = config;

  // Validate message shape
  try {
    failfastAssert(!!rawMsg && typeof rawMsg === 'object', 'RELAY_MSG_OBJECT_INVALID', 'Relay payload must be an object');
    failfastAssert(typeof (rawMsg as { type?: unknown }).type === 'string' && (rawMsg as { type: string }).type.length > 0, 'RELAY_MSG_TYPE_INVALID', 'Relay message type is required');
  } catch (error) {
    const ff = asFailFastPayload(error);
    pushDebugEvent(store, {
      event: 'error',
      msgType: 'unknown',
      status: 'rejected',
      reason: ff.code,
      details: ff,
    });
    send(ws, serializeWsMessage({ type: 'error', error: `${ff.code}: ${ff.message}` }));
    return;
  }

  const context = createRelayRouteContext(config, ws, rawMsg as RuntimeWsMessage, rawBytes);
  if (!prepareRelaySession(context)) return;
  const { type, to, from, traceId } = context;

  if (handleHello(context)) return;

  if (await handleGossipAnnounce(context)) return;

  if (handleSimpleRelayMessage(context)) return;

  if (await handleRoutableMessage(context)) return;

  // Unknown message type
  pushDebugEvent(store, {
    event: 'error',
    from,
    to,
    msgType: type,
    status: 'unsupported',
    reason: `Unknown message type: ${type}`,
    details: { traceId },
  });
  send(ws, serializeWsMessage({ type: 'error', error: `Unknown message type: ${type}` }));
};
