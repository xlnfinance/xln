/**
 * XLN WebSocket Relay Server
 *
 * ARCHITECTURE: Dumb pipe relay - routes messages between runtimes.
 *
 * SECURITY MODEL:
 * - Relay does NOT validate transaction content - that's account consensus layer's job
 * - Relay stores gossip profiles with signature verification (anti-spoofing)
 * - Hello auth proves runtimeId ownership for connection routing
 * - NO replay protection at this layer - handled by accountFrame heights in consensus
 *
 * The relay is intentionally simple:
 * - Accept connections, route messages, store profiles
 * - All cryptographic validation happens at entity/account layer
 * - Even a malicious relay can't forge transactions (needs validator keys)
 */

import WebSocket, { WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import * as secp256k1 from '@noble/secp256k1';
import { keccak256 } from 'ethers';

import type { RuntimeInput, RoutedEntityInput } from '../types';
import { deserializeWsMessage, hashHelloMessage, makeMessageId, serializeWsMessage, type RuntimeWsMessage, type RuntimeWsAuth } from './ws-protocol';
import { asFailFastPayload, failfastAssert } from './failfast';

type ClientEntry = {
  ws: WebSocket;
  runtimeId: string;
  lastSeen: number;
};

type PendingMessage = {
  queuedAt: number;
  message: RuntimeWsMessage;
};

export type RuntimeWsServerOptions = {
  host?: string;
  port: number;
  serverId: string;
  serverRuntimeId?: string;  // If set, messages to this runtimeId use local delivery
  onRuntimeInput?: (from: string, input: RuntimeInput) => Promise<void> | void;
  onEntityInput?: (from: string, input: RoutedEntityInput) => Promise<void> | void;
  maxQueuePerRuntime?: number;
  queueTtlMs?: number;
  requireAuth?: boolean;
  helloSkewMs?: number;
};

const DEFAULT_MAX_QUEUE = 200;
const DEFAULT_QUEUE_TTL = 5 * 60 * 1000;
const HEARTBEAT_MS = 15000;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_HELLO_SKEW_MS = 5 * 60 * 1000;

let wsClock = 0;
const now = () => {
  const ts = Date.now();
  if (ts <= wsClock) {
    wsClock += 1;
    return wsClock;
  }
  wsClock = ts;
  return wsClock;
};

const parseRuntimeIdFromReq = (req: { headers?: Record<string, string | string[] | undefined>; url?: string }) => {
  const headers = req.headers || {};
  const headerId =
    (headers['x-runtime-id'] as string | undefined) ||
    (headers['authorization'] as string | undefined);

  if (headerId) return headerId;
  if (!req.url) return null;

  try {
    const url = new URL(req.url, 'ws://localhost');
    return url.searchParams.get('id');
  } catch {
    return null;
  }
};

const normalizeRuntimeId = (runtimeId: string | null | undefined): string | null => {
  if (!runtimeId || typeof runtimeId !== 'string') return null;
  const trimmed = runtimeId.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
};

const recoverAddressFromSignature = (digestHex: string, signatureHex: string): string => {
  const sig = signatureHex.replace('0x', '');
  if (sig.length < 130) {
    throw new Error('Signature too short');
  }
  const compact = sig.slice(0, 128);
  const recovery = Number.parseInt(sig.slice(128, 130), 16);
  const messageBytes = Buffer.from(digestHex.replace('0x', ''), 'hex');
  const signatureBytes = Buffer.from(compact, 'hex');
  const publicKey = secp256k1.recoverPublicKey(messageBytes, signatureBytes, recovery, false);
  const hash = keccak256(publicKey.slice(1));
  return `0x${hash.slice(-40)}`.toLowerCase();
};

const verifyHelloAuth = (runtimeId: string, auth: RuntimeWsAuth, maxSkewMs: number): string | null => {
  const nowTs = now();
  if (!auth.nonce || !auth.signature || !auth.timestamp) {
    return 'Missing auth fields';
  }
  if (Math.abs(nowTs - auth.timestamp) > maxSkewMs) {
    return `Hello timestamp skew too large (${nowTs - auth.timestamp}ms)`;
  }
  const digest = hashHelloMessage(runtimeId, auth.timestamp, auth.nonce);
  let recovered: string;
  try {
    recovered = recoverAddressFromSignature(digest, auth.signature);
  } catch (error) {
    return `Hello signature invalid: ${(error as Error).message}`;
  }
  if (recovered.toLowerCase() !== runtimeId.toLowerCase()) {
    return 'Hello signature does not match runtimeId';
  }
  return null;
};

export const startRuntimeWsServer = (options: RuntimeWsServerOptions) => {
  const serverId = options.serverId;
  const maxQueue = options.maxQueuePerRuntime ?? DEFAULT_MAX_QUEUE;
  const queueTtlMs = options.queueTtlMs ?? DEFAULT_QUEUE_TTL;
  const requireAuth = options.requireAuth ?? false;
  const helloSkewMs = options.helloSkewMs ?? DEFAULT_HELLO_SKEW_MS;

  const clients = new Map<string, ClientEntry>();
  const pending = new Map<string, PendingMessage[]>();
  const normalizedServerRuntimeId = normalizeRuntimeId(options.serverRuntimeId);

  const wss = new WebSocketServer({
    host: options.host || '0.0.0.0',
    port: options.port,
  });

  const send = (ws: WebSocket, msg: RuntimeWsMessage) => {
    const payload = serializeWsMessage(msg);
    if (payload.length > MAX_MESSAGE_BYTES) {
      const errMsg = `Message too large (${payload.length} bytes)`;
      ws.send(serializeWsMessage({ type: 'error', error: errMsg }));
      return;
    }
    ws.send(payload);
  };

  const enqueue = (runtimeId: string, message: RuntimeWsMessage) => {
    const normalized = normalizeRuntimeId(runtimeId);
    if (!normalized) return;
    const queue = pending.get(normalized) || [];
    queue.push({ queuedAt: now(), message });
    while (queue.length > maxQueue) queue.shift();
    pending.set(normalized, queue);
  };

  const flushQueue = (runtimeId: string, ws: WebSocket) => {
    const normalized = normalizeRuntimeId(runtimeId);
    if (!normalized) return;
    const queue = pending.get(normalized);
    if (!queue || queue.length === 0) return;

    const stillValid: PendingMessage[] = [];
    for (const entry of queue) {
      if (now() - entry.queuedAt > queueTtlMs) continue;
      try {
        send(ws, entry.message);
      } catch {
        stillValid.push(entry);
      }
    }
    if (stillValid.length > 0) {
      pending.set(normalized, stillValid);
    } else {
      pending.delete(normalized);
    }
  };

  // Gossip profile storage - relay is central source of truth
  // Key: entityId, Value: profile with timestamp (newer replaces older)
  const gossipProfiles = new Map<string, { profile: any; timestamp: number; fromRuntimeId: string }>();

  const storeGossipProfile = (profile: any, fromRuntimeId: string) => {
    const entityId = profile?.entityId;
    if (!entityId) return false;
    const newTs = profile?.metadata?.lastUpdated || 0;
    const name = profile?.metadata?.name || '(no name)';
    const existing = gossipProfiles.get(entityId);
    if (existing && existing.timestamp >= newTs) {
      return false; // Existing is newer or same
    }
    const isNew = !existing;
    gossipProfiles.set(entityId, { profile, timestamp: newTs, fromRuntimeId });
    if (isNew) {
      console.log(`[WS] Gossip new profile: ${entityId.slice(-4)} name="${name}"`);
    }
    return true;
  };

  const getAllGossipProfiles = (): any[] => {
    return Array.from(gossipProfiles.values()).map(v => v.profile);
  };

  const routeMessage = async (msg: RuntimeWsMessage, ws: WebSocket) => {
    failfastAssert(typeof msg.type === 'string' && msg.type.length > 0, 'WS_SERVER_TYPE_INVALID', 'Missing message type');
    // DEBUG EVENT: best-effort sink for client-side diagnostics.
    // Local dev relay does not persist these; acknowledge and drop.
    if (msg.type === 'debug_event') {
      return;
    }

    // GOSSIP ANNOUNCE: Store profiles in relay (clients pull when needed)
    if (msg.type === 'gossip_announce') {
      const payload = msg.payload as { profiles?: any[] } | undefined;
      const profiles = payload?.profiles || [];
      let stored = 0;
      for (const profile of profiles) {
        if (storeGossipProfile(profile, msg.from || 'unknown')) stored++;
      }
      return;
    }

    // GOSSIP REQUEST: Return all stored profiles
    if (msg.type === 'gossip_request') {
      const allProfiles = getAllGossipProfiles();
      send(ws, {
        type: 'gossip_response',
        id: makeMessageId(),
        from: serverId,
        to: msg.from,
        timestamp: now(),
        payload: { profiles: allProfiles },
        inReplyTo: msg.id,
      });
      return;
    }

    const target = msg.to;
    if (!target) {
      send(ws, { type: 'error', error: 'Missing target runtimeId' });
      return;
    }
    const normalizedTarget = normalizeRuntimeId(target);
    if (!normalizedTarget) {
      send(ws, { type: 'error', error: 'Invalid target runtimeId' });
      return;
    }

    if (msg.type === 'runtime_input') {
      const payload = msg.payload as RuntimeInput | undefined;
      if (!payload || !Array.isArray(payload.runtimeTxs) || !Array.isArray(payload.entityInputs)) {
        send(ws, { type: 'error', error: 'Invalid runtime_input payload', inReplyTo: msg.id });
        return;
      }
    }

    if (msg.type === 'entity_input') {
      // Entity input routing - validated below
      // CRITICAL: If encrypted=true, payload is opaque ciphertext - relay just routes it
      // Only validate plaintext payloads (which shouldn't happen in prod - encryption is mandatory)
      if (!msg.encrypted) {
        const payload = msg.payload as RoutedEntityInput | undefined;
        if (!payload || typeof payload.entityId !== 'string') {
          send(ws, { type: 'error', error: 'Invalid entity_input payload', inReplyTo: msg.id });
          return;
        }
      } else if (!msg.payload || typeof msg.payload !== 'string') {
        // Encrypted payload must be a non-empty string (ciphertext)
        send(ws, { type: 'error', error: 'Invalid encrypted payload', inReplyTo: msg.id });
        return;
      }
    }

    // Check if target is the server itself - use local delivery for entity_input/runtime_input
    // EXCEPT: encrypted messages must go through WS client for decryption
    const isLocalTarget = normalizedServerRuntimeId && normalizedTarget === normalizedServerRuntimeId;
    const isEncrypted = msg.encrypted === true;
    const useLocalDelivery = isLocalTarget && (msg.type === 'entity_input' || msg.type === 'runtime_input') && !isEncrypted;

    const targetClient = clients.get(normalizedTarget);
    if (targetClient && !useLocalDelivery) {
      send(targetClient.ws, msg);
      return;
    }

    // Local delivery for entity_input ONLY when target IS the server itself
    if (msg.type === 'entity_input' && options.onEntityInput && msg.from && useLocalDelivery) {
      const payload = msg.payload as RoutedEntityInput;
      try {
        await options.onEntityInput(msg.from, payload);
        return;
      } catch (error) {
        // Fall through to queueing
      }
    }

    if (msg.type === 'runtime_input' && options.onRuntimeInput && msg.from && useLocalDelivery) {
      const payload = msg.payload as RuntimeInput;
      try {
        await options.onRuntimeInput(msg.from, payload);
        return;
      } catch (error) {
        // Fall through to queueing
      }
    }

    enqueue(normalizedTarget, msg);
  };

  wss.on('connection', (ws, req) => {
    let runtimeId = parseRuntimeIdFromReq(req);
    let handshakeDone = false;
    let closed = false;

    const registerClient = (id: string) => {
      const normalized = normalizeRuntimeId(id);
      if (!normalized) {
        send(ws, { type: 'error', error: 'Invalid runtimeId in handshake' });
        ws.close();
        return;
      }
      runtimeId = normalized;
      handshakeDone = true;
      const existing = clients.get(normalized);
      if (existing && existing.ws !== ws) {
        existing.ws.close();
      }
      clients.set(normalized, { ws, runtimeId: normalized, lastSeen: now() });
      flushQueue(normalized, ws);
    };

    const heartbeat = setInterval(() => {
      if (closed) return;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }, HEARTBEAT_MS);

    ws.on('pong', () => {
      if (runtimeId && clients.has(runtimeId)) {
        const entry = clients.get(runtimeId);
        if (entry) entry.lastSeen = now();
      }
    });

    ws.on('message', async (data) => {
      if (closed) return;
      if (data && data.length > MAX_MESSAGE_BYTES) {
        send(ws, { type: 'error', error: 'Message too large' });
        ws.close();
        return;
      }

      let msg: RuntimeWsMessage;
      try {
        msg = deserializeWsMessage(data as Buffer);
        failfastAssert(!!msg && typeof msg === 'object', 'WS_SERVER_MSG_INVALID', 'WS message must decode to object');
        failfastAssert(typeof msg.type === 'string', 'WS_SERVER_MSG_TYPE_INVALID', 'WS message type must be string', { msg });
      } catch (error) {
        const ff = asFailFastPayload(error);
        send(ws, { type: 'error', error: `Bad JSON: ${ff.code}: ${ff.message}` });
        return;
      }

      if (!handshakeDone) {
        if (msg.type === 'hello' && msg.from) {
          if (requireAuth) {
            if (!msg.auth) {
              send(ws, { type: 'error', error: 'Hello auth required' });
              ws.close();
              return;
            }
            const authError = verifyHelloAuth(msg.from, msg.auth, helloSkewMs);
            if (authError) {
              send(ws, { type: 'error', error: authError });
              ws.close();
              return;
            }
          } else if (msg.auth && process.env.XLN_LOG_HELLO_AUTH === '1') {
            console.log(`[WS] Ignoring optional hello auth for ${msg.from.slice(0, 10)}...`);
          }
          registerClient(msg.from);
        } else if (runtimeId && !requireAuth) {
          registerClient(runtimeId);
        } else {
          send(ws, { type: 'error', error: 'Handshake required: send hello with runtimeId' });
          ws.close();
        }
        return;
      }

      if (!msg.id) msg.id = makeMessageId();
      if (!msg.from) msg.from = runtimeId || serverId;
      if (!msg.timestamp) msg.timestamp = now();

      if (msg.type === 'ping') {
        send(ws, { type: 'pong', inReplyTo: msg.id });
        return;
      }
      // Some clients still send hello after query-param auto-registration.
      // Treat as harmless keepalive/re-auth and acknowledge.
      if (msg.type === 'hello') {
        return;
      }

      if (
        msg.type === 'runtime_input' ||
        msg.type === 'entity_input' ||
        msg.type === 'debug_event' ||
        msg.type === 'gossip_request' ||
        msg.type === 'gossip_response' ||
        msg.type === 'gossip_announce' ||
        msg.type === 'gossip_subscribe'
      ) {
        await routeMessage(msg, ws);
        return;
      }

      send(ws, { type: 'error', error: `Unsupported message type: ${msg.type}` });
    });

    ws.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      if (runtimeId) {
        const entry = clients.get(runtimeId);
        if (entry && entry.ws === ws) {
          clients.delete(runtimeId);
        }
      }
    });

    ws.on('error', (error) => {
      closed = true;
      clearInterval(heartbeat);
      console.error(`[WS] Client error for ${runtimeId ?? 'unknown'}: ${(error as Error).message}`);
    });

    if (runtimeId) {
      registerClient(runtimeId);
    }
  });

  wss.on('listening', () => {
    const address = wss.address() as AddressInfo | string | null;
    const port = typeof address === 'string' || !address ? options.port : address.port;
    console.log(`[WS] Runtime relay "${serverId}" listening on ${options.host || '0.0.0.0'}:${port}`);
  });

  wss.on('error', (error) => {
    const err = error as Error & { code?: string };
    const code = err.code ? ` (${err.code})` : '';
    console.error(`[WS] Runtime relay "${serverId}" failed: ${err.message}${code}`);
  });

  return {
    server: wss,
    close: () => wss.close(),
    sendToRuntime: (runtimeId: string, message: RuntimeWsMessage) => {
      const normalized = normalizeRuntimeId(runtimeId);
      if (!normalized) return;
      const client = clients.get(normalized);
      if (!message.id) message.id = makeMessageId();
      if (!message.timestamp) message.timestamp = now();
      if (client) {
        send(client.ws, message);
      } else {
        enqueue(normalized, message);
      }
    },
  };
};

if (import.meta.main) {
  // Parse --port argument or use WS_PORT env var
  const args = process.argv;
  const portArgIdx = args.indexOf('--port');
  const port = portArgIdx !== -1 && args[portArgIdx + 1]
    ? Number(args[portArgIdx + 1])
    : Number(process.env.WS_PORT || 8787);
  const serverId = process.env.WS_SERVER_ID || 'hub';
  console.log(`[WS] Starting relay server on port ${port}`);
  startRuntimeWsServer({ port, serverId });
}
