/**
 * Relay Router — pure message routing. No Env, no decryption.
 *
 * Receives parsed relay messages, looks up targets in the store,
 * and delegates to callbacks for local delivery and sending.
 */

import { asFailFastPayload, failfastAssert } from '../networking/failfast';
import { serializeWsMessage, type RuntimeWsMessage } from '../networking/ws-protocol';
import {
  type RelaySocketLike,
  type RelaySendResult,
  type RelayStore,
  isCanonicalRuntimeId,
  isRelaySendResultFailure,
  normalizeRuntimeKey,
  nextWsTimestamp,
  pushDebugEvent,
  storeVerifiedGossipProfile,
  getDefaultGossipProfiles,
  getProfileBatch,
  DEFAULT_GOSSIP_SYNC_LIMIT,
  registerClient,
  removeClient,
  deliverPendingMessages,
  enqueueMessage,
  cacheEncryptionKey,
  isRelaySocketOpen,
  classifyRelayDeliveryEvent,
} from './store';
import type { Profile } from '../networking/gossip';
import { verifyProfileSignature, type ProfileVerifyResult } from '../networking/profile-signing';
import { verifyHelloAuth } from '../networking/hello-auth';
import { isDeliveryDelivered, type DeliveryResult } from '../protocol/payments/delivery-result';
import { createStructuredLogger } from '../infra/logger';
import { safeStringify } from '../protocol/serialization';

const SOCKET_RUNTIME_ID = Symbol.for('xln.relay.socketRuntimeId');
const SOCKET_DUPLICATE_CLOSING = Symbol.for('xln.relay.duplicateClosing');
type RememberedRelaySocket = object & { [SOCKET_RUNTIME_ID]?: string };
type DuplicateClosingRelaySocket = object & { [SOCKET_DUPLICATE_CLOSING]?: boolean };
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

export const forgetRelaySocketRuntimeId = (ws: unknown): void => {
  if (!ws || (typeof ws !== 'object' && typeof ws !== 'function')) return;
  delete (ws as RememberedRelaySocket)[SOCKET_RUNTIME_ID];
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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type RelayRouterConfig = {
  store: RelayStore;
  localRuntimeId: string;
  /** Called when an entity_input or its signed durable receipt targets this runtime. */
  localDeliver: (from: string | undefined, msg: RuntimeWsMessage) => Promise<void>;
  /** Thin wrapper over the binary production WebSocket codec. */
  send: (ws: RelaySocketLike, data: Uint8Array) => RelaySendResult;
  /** Hook to mirror gossip into env. */
  onGossipStore?: (profile: Profile) => void;
  /** Defaults to true. Unsigned hello cannot claim a runtime slot. */
  requireHelloAuth?: boolean;
  helloSkewMs?: number;
  consumeHelloChallenge?: (ws: object, challenge: unknown) => boolean;
  verifyProfile?: (profile: Profile) => Promise<ProfileVerifyResult> | ProfileVerifyResult;
};

const DEFAULT_HELLO_SKEW_MS = 5 * 60 * 1000;

const flushPendingToSocket = <Socket>(
  store: RelayStore,
  runtimeId: string,
  ws: Socket,
  send: (ws: Socket, data: Uint8Array) => RelaySendResult,
): number => {
  const result = deliverPendingMessages(store, runtimeId, (pendingMsg) =>
    send(ws, serializeWsMessage(pendingMsg as RuntimeWsMessage)),
  );
  if (result.failure) {
    pushDebugEvent(store, {
      event: 'delivery',
      to: runtimeId,
      status: 'send-failed',
      reason: result.failure.reason,
      queueSize: result.retained,
      details: {
        delivered: result.delivered,
        expired: result.expired,
        retained: result.retained,
      },
    });
  }
  return result.delivered;
};

const relayDeliveryMetadata = (status: string, reason?: string) =>
  classifyRelayDeliveryEvent({ status, ...(reason ? { reason } : {}) }) ?? undefined;

const requireRelayDeliveryMetadata = (status: string, reason?: string): DeliveryResult => {
  const delivery = relayDeliveryMetadata(status, reason);
  if (!delivery) throw new Error(`RELAY_DELIVERY_CLASSIFICATION_MISSING: status=${status}`);
  return delivery;
};

const sendRelayDelivery = (
  config: RelayRouterConfig,
  ws: RelaySocketLike,
  msg: unknown,
): DeliveryResult => {
  if (!isRelaySocketOpen(ws)) {
    return requireRelayDeliveryMetadata('stale-target', 'TARGET_SOCKET_NOT_OPEN');
  }
  try {
    const result = config.send(ws, serializeWsMessage(msg as RuntimeWsMessage));
    if (isRelaySendResultFailure(result)) {
      return requireRelayDeliveryMetadata('send-failed', 'RELAY_SEND_FALSE');
    }
    return requireRelayDeliveryMetadata('delivered');
  } catch (error) {
    return requireRelayDeliveryMetadata('send-failed', error instanceof Error ? error.message : String(error));
  }
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export const relayRoute = async (
  config: RelayRouterConfig,
  ws: RelaySocketLike,
  rawMsg: unknown,
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

  const msg = rawMsg as RuntimeWsMessage;
  const type = String((rawMsg as { type: string }).type);
  const { to, from, payload, id } = msg;
  const fromKey = normalizeRuntimeKey(from);
  const toKey = normalizeRuntimeKey(to);
  const traceId = typeof id === 'string' && id.length > 0
    ? id
    : `relay-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const rememberedRuntimeId = getRememberedSocketRuntimeId(ws);

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
    return;
  }

  if (rememberedRuntimeId && fromKey && rememberedRuntimeId === fromKey) {
    const existing = store.clients.get(rememberedRuntimeId);
    if (!existing || existing.ws !== ws) {
      const registered = registerClient(store, rememberedRuntimeId, ws);
      const flushedPending = registered
        ? flushPendingToSocket(store, rememberedRuntimeId, ws, send)
        : 0;
      pushDebugEvent(store, {
        event: 'ws_rebind',
        runtimeId: rememberedRuntimeId,
        from,
        msgType: type,
        status: registered ? 'reconnected' : 'rejected',
        details: { traceId: typeof id === 'string' ? id : null, flushedPending },
      });
    } else {
      existing.lastSeen = nextWsTimestamp(store);
    }
  }

  // Cache encryption public key if provided
  const fromEncryptionPubKey = typeof msg.fromEncryptionPubKey === 'string'
    ? msg.fromEncryptionPubKey
    : null;
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
    return;
  }
  if (from && fromEncryptionPubKey && rememberedRuntimeId === fromKey) {
    cacheEncryptionKey(store, fromKey, fromEncryptionPubKey);
  }
  const deliveryEntityId = typeof msg.entityId === 'string' && msg.entityId.length > 0 ? msg.entityId : undefined;
  const deliveryTxCount = typeof msg.txs === 'number' && Number.isFinite(msg.txs) ? msg.txs : undefined;

  const size = new TextEncoder().encode(safeStringify(msg)).byteLength;

  // Log non-gossip messages
  if (type !== 'gossip_request' && type !== 'gossip_response' && type !== 'gossip_announce') {
    relayLog(`[RELAY-MSG] type=${type} from=${from || 'none'} to=${to || 'none'}`);
  }

  pushDebugEvent(store, {
    event: 'message',
    from,
    to,
    msgType: type,
    encrypted: msg.encrypted === true,
    size,
    details: { traceId, hasFromEncryptionPubKey: !!fromEncryptionPubKey },
  });

  // ----- hello -----
  if (type === 'hello' && from) {
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
      return;
    }
    if (config.requireHelloAuth !== false) {
      const challengeAccepted = config.consumeHelloChallenge?.(ws as object, msg.auth?.nonce) ?? true;
      const authError = challengeAccepted
        ? verifyHelloAuth(fromKey, fromEncryptionPubKey!, msg.auth, config.helloSkewMs ?? DEFAULT_HELLO_SKEW_MS)
        : 'Hello challenge missing, expired, or already consumed';
      if (authError) {
        pushDebugEvent(store, {
          event: 'hello',
          runtimeId: from,
          from,
          msgType: type,
          status: 'rejected',
          reason: 'HELLO_AUTH_INVALID',
          details: { traceId, authError },
        });
        send(ws, serializeWsMessage({ type: 'error', error: authError }));
        return;
      }
    }
    const existingClient = store.clients.get(fromKey);
    if (existingClient && existingClient.ws !== ws) {
      // This hello passed a fresh relay challenge and a signature by the same
      // runtime key. It is therefore a reconnect, not an unauthenticated
      // displacement. Replace atomically before closing the stale transport:
      // its later close callback is socket-scoped and cannot delete `ws`.
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
    const registered = registerClient(store, from, ws);
    if (!registered) {
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
      return;
    }
    rememberSocketRuntimeId(ws, fromKey);
    if (fromEncryptionPubKey) {
      cacheEncryptionKey(store, fromKey, fromEncryptionPubKey);
    }
    pushDebugEvent(store, {
      event: 'hello',
      runtimeId: from,
      from,
      msgType: type,
      status: 'connected',
      details: { traceId },
    });

    send(ws, serializeWsMessage({ type: 'hello_ack', to: fromKey }));
    flushPendingToSocket(store, fromKey, ws, send);

    return;
  }

  // ----- gossip_announce: store + fanout -----
  if (type === 'gossip_announce') {
    if (!fromKey || rememberedRuntimeId !== fromKey) {
      pushDebugEvent(store, {
        event: 'error',
        from,
        msgType: type,
        status: 'rejected',
        reason: 'GOSSIP_ANNOUNCE_UNREGISTERED_RUNTIME',
        details: { traceId },
      });
      send(ws, serializeWsMessage({ type: 'error', error: 'Gossip announce requires registered relay hello' }));
      return;
    }
    const payloadRecord = payload && typeof payload === 'object' ? payload as { profiles?: unknown } : {};
    const profiles = (Array.isArray(payloadRecord.profiles) ? payloadRecord.profiles : []) as Profile[];
    let stored = 0;
    let droppedMalformed = 0;
    let droppedInvalidSignature = 0;
    const storedProfiles: Profile[] = [];
    const verifyProfile = config.verifyProfile ?? verifyProfileSignature;
    for (const profile of profiles) {
      if (!profile || typeof profile !== 'object') continue;
      const normalized: Profile = {
        ...profile,
        runtimeId: profile.runtimeId || fromKey,
      };
      try {
        const verified = await verifyProfile(normalized);
        if (!verified.valid) {
          droppedInvalidSignature += 1;
          pushDebugEvent(store, {
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
        if (storeVerifiedGossipProfile(store, normalized)) {
          stored += 1;
          storedProfiles.push(normalized);
        }
        // Mirror into env gossip cache via hook
        config.onGossipStore?.(normalized);
      } catch (error) {
        droppedMalformed += 1;
        pushDebugEvent(store, {
          event: 'error',
          from,
          msgType: type,
          status: 'rejected',
          reason: 'GOSSIP_PROFILE_DROPPED_MALFORMED',
          details: {
            entityId: typeof normalized.entityId === 'string' ? normalized.entityId : null,
            message: error instanceof Error ? error.message : String(error),
            traceId,
          },
        });
        continue;
      }
    }
    let broadcastTargets = 0;
    if (storedProfiles.length > 0) {
      const defaultEntityIds = new Set(
        getDefaultGossipProfiles(store, DEFAULT_GOSSIP_SYNC_LIMIT).map(profile => profile.entityId.toLowerCase()),
      );
      const broadcastProfiles = storedProfiles.filter(
        profile =>
          defaultEntityIds.has(profile.entityId.toLowerCase()) ||
          profile.metadata.isHub === true,
      );
      if (broadcastProfiles.length === 0) {
        pushDebugEvent(store, {
          event: 'gossip_store',
          from,
          msgType: type,
          status: 'stored',
          details: { received: profiles.length, stored, droppedMalformed, droppedInvalidSignature, broadcastTargets, traceId },
        });
        return;
      }
      for (const [runtimeId, client] of store.clients.entries()) {
        if (!client?.ws) continue;
        if (fromKey && runtimeId === fromKey) continue;
        send(client.ws, serializeWsMessage({
          type: 'gossip_update',
          id: `gossip_update_${Date.now()}`,
          from: store.serverId,
          to: runtimeId,
          timestamp: Date.now(),
          payload: { profiles: broadcastProfiles },
          ...(id ? { inReplyTo: id } : {}),
        }));
        broadcastTargets += 1;
      }
    }
    pushDebugEvent(store, {
      event: 'gossip_store',
      from,
      msgType: type,
      status: 'stored',
      details: { received: profiles.length, stored, droppedMalformed, droppedInvalidSignature, broadcastTargets, traceId },
    });

    return;
  }

  // ----- gossip_request -----
  if (type === 'gossip_request') {
    const request = payload && typeof payload === 'object' ? payload as {
      ids?: string[];
      set?: 'default' | 'hubs';
      updatedSince?: number;
      limit?: number;
    } : {};
    const profiles = getProfileBatch(store, request);
    pushDebugEvent(store, {
      event: 'gossip_request',
      from,
      to,
      msgType: type,
      details: {
        returnedProfiles: profiles.length,
        ids: request.ids ?? [],
        set: request.set ?? 'default',
        updatedSince: request.updatedSince ?? null,
        limit: request.limit ?? DEFAULT_GOSSIP_SYNC_LIMIT,
        traceId,
      },
    });
    send(ws, serializeWsMessage({
      type: 'gossip_response',
      id: `gossip_${Date.now()}`,
      from: store.serverId,
      ...(from ? { to: from } : {}),
      timestamp: Date.now(),
      payload: { profiles },
      ...(id ? { inReplyTo: id } : {}),
    }));
    return;
  }

  // ----- debug_event -----
  if (type === 'debug_event') {
    pushDebugEvent(store, {
      event: 'debug_event',
      from,
      to,
      msgType: type,
      details: { traceId, payload },
    });
    return;
  }

  // ----- ping -----
  if (type === 'ping') {
    send(ws, serializeWsMessage({ type: 'pong', ...(id ? { inReplyTo: id } : {}) }));
    return;
  }

  // ----- routable messages -----
  if (
    type === 'entity_input' ||
    type === 'entity_input_receipt' ||
    type === 'gossip_response' ||
    LIVE_RECOVERY_MESSAGE_TYPES.has(type)
  ) {
    if (!toKey) {
      pushDebugEvent(store, {
        event: 'error',
        from,
        msgType: type,
        status: 'rejected',
        reason: 'Missing target runtimeId',
        details: { traceId },
      });
      send(ws, serializeWsMessage({ type: 'error', error: 'Missing target runtimeId' }));
      return;
    }

    if (type === 'entity_input' && (msg.encrypted !== true || typeof payload !== 'string')) {
      pushDebugEvent(store, {
        event: 'error',
        from,
        to,
        msgType: type,
        status: 'rejected',
        reason: 'ENTITY_INPUT_MUST_BE_ENCRYPTED',
        delivery: relayDeliveryMetadata('rejected', 'ENTITY_INPUT_MUST_BE_ENCRYPTED'),
        details: { traceId },
      });
      send(ws, serializeWsMessage({ type: 'error', error: 'entity_input must be encrypted' }));
      return;
    }

    relayLog(`[RELAY] ${type} from=${from || 'none'} to=${to || 'none'} encrypted=${msg.encrypted ?? false}`);

    const localRuntimeKey = normalizeRuntimeKey(config.localRuntimeId);
    const isLocalTarget = !!localRuntimeKey && toKey === localRuntimeKey;

    // If addressed to a remote WS client (not local), forward directly
    const target = store.clients.get(toKey);
    if (target && !isLocalTarget) {
      const relayDelivery = sendRelayDelivery(config, target.ws, msg);
      if (isDeliveryDelivered(relayDelivery)) {
        relayLog(`[RELAY] → forwarding to WS client`);
        pushDebugEvent(store, {
          event: 'delivery',
          from,
          to,
          msgType: type,
          encrypted: msg.encrypted === true,
          status: 'delivered',
          delivery: relayDelivery,
          details: {
            traceId,
            ...(deliveryEntityId ? { entityId: deliveryEntityId } : {}),
            ...(deliveryTxCount !== undefined ? { txs: deliveryTxCount } : {}),
          },
        });
        return;
      }
      removeClient(store, target.ws);
      const sendFailure = relayDelivery.code !== 'TARGET_SOCKET_NOT_OPEN' && relayDelivery.code !== 'DELIVERY_STALE_TARGET';
      pushDebugEvent(store, {
        event: 'delivery',
        from,
        to,
        msgType: type,
        encrypted: msg.encrypted === true,
        status: sendFailure ? 'send-failed' : 'stale-target',
        reason: relayDelivery.failure?.message ?? relayDelivery.code,
        delivery: relayDelivery,
        details: {
          traceId,
          ...(deliveryEntityId ? { entityId: deliveryEntityId } : {}),
          ...(deliveryTxCount !== undefined ? { txs: deliveryTxCount } : {}),
        },
      });
    }

    // Local application delivery for scoped reliable protocol messages.
    if ((type === 'entity_input' || type === 'entity_input_receipt') && payload && isLocalTarget) {
      try {
        await config.localDeliver(from, msg);
        return;
      } catch (error) {
        const reason = (error as Error).message;
        relayLog(`[RELAY] Local delivery failed: ${reason}`);
        pushDebugEvent(store, {
          event: 'error',
          from,
          to,
          msgType: type,
          status: 'local-delivery-failed',
          reason,
          delivery: relayDeliveryMetadata('local-delivery-failed', reason),
          details: { traceId },
        });
        // Non-recoverable decrypt/auth errors should be dropped immediately.
        // Re-queuing poisoned ciphertext for the same local runtime just causes
        // endless pending loops and hides the true root cause.
        if (NON_RECOVERABLE_LOCAL_DELIVERY_ERRORS.some((part) => reason.includes(part))) {
          send(ws, serializeWsMessage({ type: 'error', error: reason }));
          return;
        }
        // Fall through to queue
      }
    }

    if (type === 'entity_input' || type === 'entity_input_receipt') {
      const unavailableCode = type === 'entity_input'
        ? 'ENTITY_INPUT_TARGET_NOT_CONNECTED'
        : 'ENTITY_INPUT_RECEIPT_TARGET_NOT_CONNECTED';
      relayLog(`[RELAY] → rejected ${type} (target not connected)`);
      pushDebugEvent(store, {
        event: 'delivery',
        from,
        to,
        msgType: type,
        encrypted: msg.encrypted === true,
        status: 'rejected',
        reason: unavailableCode,
        details: {
          traceId,
          ...(deliveryEntityId ? { entityId: deliveryEntityId } : {}),
          ...(deliveryTxCount !== undefined ? { txs: deliveryTxCount } : {}),
        },
      });
      send(ws, serializeWsMessage({
        type: 'error',
        error: unavailableCode,
        ...(id ? { inReplyTo: id } : {}),
        ...(to ? { to } : {}),
      }));
      return;
    }

    if (LIVE_RECOVERY_MESSAGE_TYPES.has(type)) {
      const reason = 'RECOVERY_TARGET_NOT_CONNECTED';
      relayLog(`[RELAY] → rejected ${type} (target not connected)`);
      pushDebugEvent(store, {
        event: 'delivery',
        from,
        to,
        msgType: type,
        encrypted: msg.encrypted === true,
        status: 'rejected',
        reason,
        details: { traceId },
      });
      send(ws, serializeWsMessage({
        type: 'error',
        error: reason,
        ...(id ? { inReplyTo: id } : {}),
        ...(to ? { to } : {}),
      }));
      return;
    }

    // Queue gossip for offline clients. Financial entity_input traffic is never
    // queued here because the sender would otherwise continue with a pending
    // consensus frame while the target runtime never saw the input. Recovery
    // request/response traffic is a live probe and must not be replayed later.
    const queueSize = enqueueMessage(store, toKey, msg);
    relayLog(`[RELAY] → queued (no client, queue=${queueSize})`);
    pushDebugEvent(store, {
      event: 'delivery',
      from,
      to,
      msgType: type,
      encrypted: msg.encrypted === true,
      status: 'queued',
      queueSize,
      details: {
        traceId,
        ...(deliveryEntityId ? { entityId: deliveryEntityId } : {}),
        ...(deliveryTxCount !== undefined ? { txs: deliveryTxCount } : {}),
      },
    });
    return;
  }

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
