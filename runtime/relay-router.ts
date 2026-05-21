/**
 * Relay Router — pure message routing. No Env, no decryption.
 *
 * Receives parsed relay messages, looks up targets in the store,
 * and delegates to callbacks for local delivery and sending.
 */

import { safeStringify } from './serialization-utils';
import { asFailFastPayload, failfastAssert } from './networking/failfast';
import {
  type RelayStore,
  isCanonicalRuntimeId,
  normalizeRuntimeKey,
  nextWsTimestamp,
  pushDebugEvent,
  storeVerifiedGossipProfile,
  getDefaultGossipProfiles,
  getProfileBatch,
  DEFAULT_GOSSIP_SYNC_LIMIT,
  registerClient,
  removeClient,
  flushPendingMessages,
  enqueueMessage,
  cacheEncryptionKey,
  isRelaySocketOpen,
} from './relay-store';
import type { Profile } from './networking/gossip';
import { verifyProfileSignature, type ProfileVerifyResult } from './networking/profile-signing';
import { verifyHelloAuth } from './networking/hello-auth';
import type { RuntimeWsMessage } from './networking/ws-protocol';

const SOCKET_RUNTIME_ID = Symbol.for('xln.relay.socketRuntimeId');
type RememberedRelaySocket = object & { [SOCKET_RUNTIME_ID]?: string };
const NON_RECOVERABLE_LOCAL_DELIVERY_ERRORS = [
  'invalid tag',
  'P2P_DECRYPT_ERROR',
  'NO_LOCAL_REPLICA',
];
const relayLog = process.env['RELAY_VERBOSE_LOGS'] === '1'
  ? (message: string): void => console.log(message)
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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type RelaySendResult = boolean | number | void;
export type RelaySocketLike = { send(data: string): RelaySendResult; readyState?: number };

export type RelayRouterConfig<Socket = RelaySocketLike> = {
  store: RelayStore;
  localRuntimeId: string;
  /** Called when an entity_input is addressed to this runtime. */
  localDeliver: (from: string | undefined, msg: RuntimeWsMessage) => Promise<void>;
  /** Thin wrapper: (ws, data: string) => boolean | number | void */
  send: (ws: Socket, data: string) => RelaySendResult;
  /** Hook to mirror gossip into env. */
  onGossipStore?: (profile: Profile) => void;
  /** Defaults to true. Unsigned hello cannot claim a runtime slot. */
  requireHelloAuth?: boolean;
  helloSkewMs?: number;
  verifyProfile?: (profile: Profile) => Promise<ProfileVerifyResult> | ProfileVerifyResult;
};

const DEFAULT_HELLO_SKEW_MS = 5 * 60 * 1000;

const flushPendingToSocket = <Socket>(
  store: RelayStore,
  runtimeId: string,
  ws: Socket,
  send: RelayRouterConfig<Socket>['send'],
): number => {
  const pending = flushPendingMessages(store, runtimeId);
  for (const pendingMsg of pending) {
    send(ws, safeStringify(pendingMsg));
  }
  return pending.length;
};

const trySendRelay = <Socket>(
  config: RelayRouterConfig<Socket>,
  ws: Socket,
  msg: unknown,
): boolean => {
  if (!isRelaySocketOpen(ws)) return false;
  try {
    const result = config.send(ws, safeStringify(msg));
    if (result === false) return false;
    return !(typeof result === 'number' && result < 0);
  } catch (error) {
    pushDebugEvent(config.store, {
      event: 'delivery',
      status: 'send-failed',
      reason: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export const relayRoute = async <Socket = RelaySocketLike>(
  config: RelayRouterConfig<Socket>,
  ws: Socket,
  rawMsg: unknown,
): Promise<void> => {
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
    send(ws, safeStringify({ type: 'error', error: `${ff.code}: ${ff.message}` }));
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
    send(ws, safeStringify({ type: 'error', error: 'Relay socket runtime mismatch' }));
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
    send(ws, safeStringify({ type: 'error', error: 'Missing fromEncryptionPubKey' }));
    return;
  }
  if (from && fromEncryptionPubKey && rememberedRuntimeId === fromKey) {
    cacheEncryptionKey(store, fromKey, fromEncryptionPubKey);
  }
  const deliveryEntityId = typeof msg.entityId === 'string' && msg.entityId.length > 0 ? msg.entityId : undefined;
  const deliveryTxCount = typeof msg.txs === 'number' && Number.isFinite(msg.txs) ? msg.txs : undefined;

  let size = 0;
  try { size = JSON.stringify(msg).length; } catch { size = 0; }

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
      send(ws, safeStringify({ type: 'error', error: 'Invalid runtimeId in hello' }));
      return;
    }
    if (config.requireHelloAuth !== false) {
      const authError = verifyHelloAuth(fromKey, msg.auth, config.helloSkewMs ?? DEFAULT_HELLO_SKEW_MS);
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
        send(ws, safeStringify({ type: 'error', error: authError }));
        return;
      }
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
      send(ws, safeStringify({ type: 'error', error: 'Runtime already connected' }));
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
      send(ws, safeStringify({ type: 'error', error: 'Gossip announce requires registered relay hello' }));
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
        send(client.ws, safeStringify({
          type: 'gossip_update',
          id: `gossip_update_${Date.now()}`,
          from: store.serverId,
          to: runtimeId,
          timestamp: Date.now(),
          payload: { profiles: broadcastProfiles },
          inReplyTo: id,
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
    send(ws, safeStringify({
      type: 'gossip_response',
      id: `gossip_${Date.now()}`,
      from: store.serverId,
      to: from,
      timestamp: Date.now(),
      payload: { profiles },
      inReplyTo: id,
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
    send(ws, safeStringify({ type: 'pong', inReplyTo: id }));
    return;
  }

  // ----- routable messages (entity_input, legacy runtime_input reject, gossip_response) -----
  if (type === 'entity_input' || type === 'runtime_input' || type === 'gossip_response') {
    if (!toKey) {
      pushDebugEvent(store, {
        event: 'error',
        from,
        msgType: type,
        status: 'rejected',
        reason: 'Missing target runtimeId',
        details: { traceId },
      });
      send(ws, safeStringify({ type: 'error', error: 'Missing target runtimeId' }));
      return;
    }

    // Legacy runtime_input is intentionally not part of the advertised WS
    // protocol. Keep this raw-string reject so old clients or hostile JSON
    // cannot recreate a plaintext control plane by bypassing TypeScript.
    if (type === 'runtime_input') {
      pushDebugEvent(store, {
        event: 'error',
        from,
        to,
        msgType: type,
        status: 'rejected',
        reason: 'RUNTIME_INPUT_DISABLED',
        details: { traceId },
      });
      send(ws, safeStringify({ type: 'error', error: 'runtime_input is disabled' }));
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
        details: { traceId },
      });
      send(ws, safeStringify({ type: 'error', error: 'entity_input must be encrypted' }));
      return;
    }

    relayLog(`[RELAY] ${type} from=${from || 'none'} to=${to || 'none'} encrypted=${msg.encrypted ?? false}`);

    const localRuntimeKey = normalizeRuntimeKey(config.localRuntimeId);
    const isLocalTarget = !!localRuntimeKey && toKey === localRuntimeKey;

    // If addressed to a remote WS client (not local), forward directly
    const target = store.clients.get(toKey);
    if (target && !isLocalTarget) {
      if (trySendRelay(config, target.ws, msg)) {
        relayLog(`[RELAY] → forwarding to WS client`);
        pushDebugEvent(store, {
          event: 'delivery',
          from,
          to,
          msgType: type,
          encrypted: msg.encrypted === true,
          status: 'delivered',
          details: {
            traceId,
            ...(deliveryEntityId ? { entityId: deliveryEntityId } : {}),
            ...(deliveryTxCount !== undefined ? { txs: deliveryTxCount } : {}),
          },
        });
        return;
      }
      removeClient(store, target.ws);
      pushDebugEvent(store, {
        event: 'delivery',
        from,
        to,
        msgType: type,
        encrypted: msg.encrypted === true,
        status: 'stale-target',
        reason: 'TARGET_SOCKET_NOT_OPEN',
        details: { traceId },
      });
    }

    // Local delivery for entity_input addressed to this runtime
    if (type === 'entity_input' && payload && isLocalTarget) {
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
          details: { traceId },
        });
        // Non-recoverable decrypt/auth errors should be dropped immediately.
        // Re-queuing poisoned ciphertext for the same local runtime just causes
        // endless pending loops and hides the true root cause.
        if (NON_RECOVERABLE_LOCAL_DELIVERY_ERRORS.some((part) => reason.includes(part))) {
          send(ws, safeStringify({ type: 'error', error: reason }));
          return;
        }
        // Fall through to queue
      }
    }

    // Queue for offline client
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
  send(ws, safeStringify({ type: 'error', error: `Unknown message type: ${type}` }));
};
