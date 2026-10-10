/**
 * Relay Router — pure message routing. No RuntimeReplica, no decryption.
 *
 * Receives parsed relay messages, looks up targets in the store,
 * and delegates to callbacks for local delivery and sending.
 */

import { asFailFastPayload, failfastAssert } from '../p2p/failfast';
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
  getProfileBatchPage,
  getAllGossipJurisdictions,
  storeVerifiedJurisdictionAnnouncement,
  DEFAULT_GOSSIP_SYNC_LIMIT,
  registerClient,
  removeClient,
} from './store';
import { parseProfile, type Profile } from '../../entity/profile';
import { verifyProfileSignature, type ProfileVerifyResult } from '../../entity/profile/profile-signing';
import { verifyHelloAuth, verifyRuntimeWsFrameAuth } from '../p2p/auth/hello-auth';
import type { HelloChallengeBinding } from '../p2p/auth/hello-challenge';
import { createStructuredLogger } from '../../support/logger';
import { safeStringify } from '../../protocol/serialization';
import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../protocol/boundary-validation';
import {
  MAX_JURISDICTION_GOSSIP_BATCH_RECORDS,
  type JurisdictionGossipAnnouncement,
} from '../../jurisdiction/gossip/announcement';
import { decodeGossipProfileBatchRequest } from '../p2p/gossip/profile-batch';
import { countOp } from '../../support/performance/op-counters';

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
// Peer-to-peer frames the relay never forwards: receivers treat relay-session
// frames as relay-authored, so forwarding them let any client forge a gossip
// response or recovery error to another Runtime and kill its relay session.
const PEER_ONLY_MESSAGE_TYPES = new Set([
  'gossip_response',
  'recovery_bundle_request',
  'recovery_bundle_response',
]);
const relayRouterLog = createStructuredLogger('relay.router');
const relayLog = process.env['RELAY_VERBOSE_LOGS'] === '1'
  ? (message: string): void => relayRouterLog.debug('verbose', { line: message })
  : (_message: string): void => {};

type RelayMeterCategory = 'gossip' | 'recovery' | 'debug' | 'control' | 'error';

const relayMeterCategory = (type: string): RelayMeterCategory => {
  if (type.startsWith('gossip_')) return 'gossip';
  if (type.startsWith('recovery_bundle_')) return 'recovery';
  if (type === 'debug_event') return 'debug';
  if (type === 'error') return 'error';
  return 'control';
};

const countRelaySocket = (
  direction: 'in' | 'out',
  type: string,
  bytes: number,
): void => {
  countOp(`socket.relayRouter.${direction}`, bytes);
  countOp(`socket.relayRouter.${direction}.${relayMeterCategory(type)}`, bytes);
};

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

/** A relay socket is authenticated once its verified hello bound a Runtime id to it. */
export const isRelaySocketAuthenticated = (ws: unknown): boolean =>
  getRememberedSocketRuntimeId(ws) !== '';

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

/**
 * A relay is a directory/control plane: hello, gossip, live recovery reads and
 * their correlated relay-originated errors. Financial `entity_inputs` travel
 * only over an authenticated direct session (core/network/p2p/p2p.ts
 * enqueueEntityInputsDelivery); a relay never forwards them and never
 * forwards a peer `error` frame, so a relay registration alone can never
 * inject a negative delivery signal into another Runtime.
 */
export type RelayRouterConfig = {
  store: RelayStore;
  localRuntimeId: string;
  /** Thin wrapper over the binary production WebSocket codec. */
  send: (ws: RelaySocketLike, data: Uint8Array) => RelaySendResult;
  /** Hook to mirror gossip into env. */
  onGossipStore?: (profile: Profile) => void;
  helloSkewMs?: number;
  consumeHelloChallenge?: (ws: object, claim: unknown) => HelloChallengeBinding | null;
  verifyProfile?: (profile: Profile) => Promise<ProfileVerifyResult> | ProfileVerifyResult;
};

const DEFAULT_HELLO_SKEW_MS = 5 * 60 * 1000;

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
  // Match the direct Account transport's single-writer admission: possessing
  // the same key does not prove the old session drained its committed ACKs.
  // A second wallet must not evict the live writer and strand both runtimes.
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
    send(ws, serializeWsMessage({ type: 'error', error: `DUPLICATE_RUNTIME_CONNECTION:${fromKey}` }));
    closeDuplicateRuntimeSocket(ws);
    return true;
  }
  rememberSocketRuntimeId(ws, fromKey);
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
  droppedRuntimeBinding: number;
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
    droppedRuntimeBinding: 0,
    profiles: [],
  };
  const verifyProfile = config.verifyProfile ?? verifyProfileSignature;
  for (const value of profiles) {
    try {
      const profile = parseProfile(value);
      // A Runtime announces only its own Entities' routes (Rust RUNTIME_BINDING).
      // Anyone can self-sign a lazy Entity profile; without this binding it
      // could claim a victim Runtime's id with another key or endpoint.
      if (profile.runtimeId && normalizeRuntimeKey(profile.runtimeId) !== fromKey) {
        result.droppedRuntimeBinding += 1;
        pushDebugEvent(config.store, {
          event: 'error',
          from,
          msgType: type,
          status: 'rejected',
          reason: 'GOSSIP_PROFILE_RUNTIME_BINDING',
          details: { entityId: String(profile.entityId ?? ''), traceId },
        });
        continue;
      }
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
      droppedRuntimeBinding: stored.droppedRuntimeBinding,
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
    const page = getProfileBatchPage(config.store, request);
    const { profiles } = page;
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
      payload: {
        profiles,
        jurisdictions,
        ...(page.cursor === undefined ? {} : {
          cursor: page.cursor,
          hasMore: page.hasMore ?? false,
        }),
      },
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
  if (type === 'error') {
    // A peer's negative delivery signal is meaningful only on the direct
    // session that carried the output. The relay records it for audit and
    // drops it; forwarding would let any relay registration reject another
    // Runtime's committed output. No reply: an error for an error would loop.
    pushDebugEvent(config.store, {
      event: 'error',
      from,
      to,
      msgType: type,
      status: 'rejected',
      reason: 'RELAY_ERROR_FRAME_NOT_ROUTABLE',
      details: { traceId, inReplyTo: typeof context.msg.inReplyTo === 'string' ? context.msg.inReplyTo : null },
    });
    return true;
  }
  const code = type === 'entity_inputs'
    ? 'RELAY_ENTITY_INPUTS_FORBIDDEN'
    : PEER_ONLY_MESSAGE_TYPES.has(type) ? 'RELAY_PEER_FRAME_NOT_ROUTABLE' : null;
  if (code) {
    pushDebugEvent(config.store, {
      event: 'error',
      from,
      to,
      msgType: type,
      status: 'rejected',
      reason: code,
      details: { traceId },
    });
    config.send(ws, serializeWsMessage({
      type: 'error',
      error: code,
      ...(id ? { inReplyTo: id } : {}),
      ...(to ? { to } : {}),
    }));
    return true;
  }
  return false;
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
  countRelaySocket('in', context.type, relayMessageByteLength(context));
  if (!prepareRelaySession(context)) return;
  const { type, to, from, traceId } = context;

  if (handleHello(context)) return;

  if (await handleGossipAnnounce(context)) return;

  if (handleSimpleRelayMessage(context)) return;

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
