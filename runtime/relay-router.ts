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
  normalizeRuntimeKey,
  nextWsTimestamp,
  pushDebugEvent,
  storeGossipProfile,
  getAllGossipProfiles,
  registerClient,
  flushPendingMessages,
  enqueueMessage,
  cacheEncryptionKey,
} from './relay-store';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type RelayRouterConfig = {
  store: RelayStore;
  localRuntimeId: string;
  /** Called when an entity_input is addressed to this runtime. */
  localDeliver: (from: string | undefined, msg: any) => Promise<void>;
  /** Thin wrapper: (ws, data: string) => void */
  send: (ws: any, data: string) => void;
  /** Hook to mirror gossip into env. */
  onGossipStore?: (profile: any) => void;
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export const relayRoute = async (config: RelayRouterConfig, ws: any, msg: any): Promise<void> => {
  const { store, send } = config;

  // Validate message shape
  try {
    failfastAssert(!!msg && typeof msg === 'object', 'RELAY_MSG_OBJECT_INVALID', 'Relay payload must be an object');
    failfastAssert(typeof msg.type === 'string' && msg.type.length > 0, 'RELAY_MSG_TYPE_INVALID', 'Relay message type is required');
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

  const { type, to, from, payload, id } = msg;
  const fromKey = normalizeRuntimeKey(from);
  const toKey = normalizeRuntimeKey(to);

  // Cache encryption public key if provided
  const fromEncryptionPubKey = typeof msg.fromEncryptionPubKey === 'string'
    ? msg.fromEncryptionPubKey
    : null;
  if (from && fromEncryptionPubKey) {
    cacheEncryptionKey(store, fromKey, fromEncryptionPubKey);
  }

  const traceId = typeof id === 'string' && id.length > 0
    ? id
    : `relay-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  let size = 0;
  try { size = JSON.stringify(msg).length; } catch { size = 0; }

  // Log non-gossip messages
  if (type !== 'gossip_request' && type !== 'gossip_response' && type !== 'gossip_announce') {
    console.log(`[RELAY-MSG] type=${type} from=${from?.slice?.(0, 10) || 'none'} to=${to?.slice?.(0, 10) || 'none'}`);
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
    registerClient(store, from, ws);
    pushDebugEvent(store, {
      event: 'hello',
      runtimeId: from,
      from,
      msgType: type,
      status: 'connected',
      details: { traceId },
    });

    // Flush pending messages
    const pending = flushPendingMessages(store, fromKey);
    for (const pendingMsg of pending) {
      send(ws, safeStringify(pendingMsg));
    }

    return;
  }

  // ----- gossip_announce: store (NO broadcast) -----
  if (type === 'gossip_announce') {
    const profiles = (payload?.profiles || []) as any[];
    let stored = 0;
    for (const profile of profiles) {
      if (!profile || typeof profile !== 'object') continue;
      const normalized = {
        ...profile,
        runtimeId: profile.runtimeId || from,
      };
      if (storeGossipProfile(store, normalized)) {
        stored += 1;
      }
      // Mirror into env gossip cache via hook
      config.onGossipStore?.(normalized);
    }
    pushDebugEvent(store, {
      event: 'gossip_store',
      from,
      msgType: type,
      status: 'stored',
      details: { received: profiles.length, stored, traceId },
    });

    return;
  }

  // ----- gossip_request -----
  if (type === 'gossip_request') {
    const profiles = getAllGossipProfiles(store);
    pushDebugEvent(store, {
      event: 'gossip_request',
      from,
      to,
      msgType: type,
      details: { returnedProfiles: profiles.length, traceId },
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

  // ----- routable messages (entity_input, runtime_input, gossip_*) -----
  if (type === 'entity_input' || type === 'runtime_input' || type === 'gossip_request' || type === 'gossip_response' || type === 'gossip_announce') {
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

    console.log(`[RELAY] ${type} from=${from?.slice(0, 10)} to=${to?.slice(0, 10)} encrypted=${msg.encrypted ?? false}`);

    const localRuntimeKey = normalizeRuntimeKey(config.localRuntimeId);
    const isLocalTarget = !!localRuntimeKey && toKey === localRuntimeKey;

    // If addressed to a remote WS client (not local), forward directly
    const target = store.clients.get(toKey);
    if (target && !isLocalTarget) {
      console.log(`[RELAY] → forwarding to WS client`);
      send(target.ws, safeStringify(msg));
      pushDebugEvent(store, {
        event: 'delivery',
        from,
        to,
        msgType: type,
        encrypted: msg.encrypted === true,
        status: 'delivered',
        details: { traceId },
      });
      return;
    }

    // Local delivery for entity_input addressed to this runtime
    if (type === 'entity_input' && payload && isLocalTarget) {
      try {
        await config.localDeliver(from, msg);
        return;
      } catch (error) {
        console.warn(`[RELAY] Local delivery failed: ${(error as Error).message}`);
        pushDebugEvent(store, {
          event: 'error',
          from,
          to,
          msgType: type,
          status: 'local-delivery-failed',
          reason: (error as Error).message,
          details: { traceId },
        });
        // Fall through to queue
      }
    }

    // Queue for offline client
    const queueSize = enqueueMessage(store, toKey, msg);
    console.log(`[RELAY] → queued (no client, queue=${queueSize})`);
    pushDebugEvent(store, {
      event: 'delivery',
      from,
      to,
      msgType: type,
      encrypted: msg.encrypted === true,
      status: 'queued',
      queueSize,
      details: { traceId },
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
