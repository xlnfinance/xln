import WebSocket, { WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import * as secp256k1 from '@noble/secp256k1';
import { keccak256 } from 'ethers';

import type { RuntimeInput, EntityInput } from './types';
import { deserializeWsMessage, hashHelloMessage, makeMessageId, serializeWsMessage, type RuntimeWsMessage, type RuntimeWsAuth } from './ws-protocol';

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
  onEntityInput?: (from: string, input: EntityInput) => Promise<void> | void;
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
  wsClock += 1;
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
    const queue = pending.get(runtimeId) || [];
    queue.push({ queuedAt: now(), message });
    while (queue.length > maxQueue) queue.shift();
    pending.set(runtimeId, queue);
  };

  const flushQueue = (runtimeId: string, ws: WebSocket) => {
    const queue = pending.get(runtimeId);
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
      pending.set(runtimeId, stillValid);
    } else {
      pending.delete(runtimeId);
    }
  };

  const routeMessage = async (msg: RuntimeWsMessage, ws: WebSocket) => {
    const target = msg.to;
    if (!target) {
      send(ws, { type: 'error', error: 'Missing target runtimeId' });
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
      const payload = msg.payload as EntityInput | undefined;
      if (!payload || typeof payload.entityId !== 'string' || typeof payload.signerId !== 'string') {
        send(ws, { type: 'error', error: 'Invalid entity_input payload', inReplyTo: msg.id });
        return;
      }
    }

    // Check if target is the server itself - use local delivery for entity_input/runtime_input
    const isLocalTarget = options.serverRuntimeId && target === options.serverRuntimeId;
    const useLocalDelivery = isLocalTarget && (msg.type === 'entity_input' || msg.type === 'runtime_input');

    const targetClient = clients.get(target);
    if (targetClient && !useLocalDelivery) {
      send(targetClient.ws, msg);
      send(ws, { type: 'ack', inReplyTo: msg.id, status: 'delivered' });
      return;
    }

    // Local delivery for entity_input ONLY when target IS the server itself
    if (msg.type === 'entity_input' && options.onEntityInput && msg.from && useLocalDelivery) {
      const payload = msg.payload as EntityInput;
      try {
        await options.onEntityInput(msg.from, payload);
        send(ws, { type: 'ack', inReplyTo: msg.id, status: 'delivered' });
        return;
      } catch (error) {
        // Fall through to queueing
      }
    }

    if (msg.type === 'runtime_input' && options.onRuntimeInput && msg.from && useLocalDelivery) {
      const payload = msg.payload as RuntimeInput;
      try {
        await options.onRuntimeInput(msg.from, payload);
        send(ws, { type: 'ack', inReplyTo: msg.id, status: 'delivered' });
        return;
      } catch (error) {
        // Fall through to queueing
      }
    }

    enqueue(target, msg);
    send(ws, { type: 'ack', inReplyTo: msg.id, status: 'queued' });
  };

  wss.on('connection', (ws, req) => {
    let runtimeId = parseRuntimeIdFromReq(req);
    let handshakeDone = false;
    let closed = false;

    const registerClient = (id: string) => {
      runtimeId = id;
      handshakeDone = true;
      const existing = clients.get(id);
      if (existing && existing.ws !== ws) {
        existing.ws.close();
      }
      clients.set(id, { ws, runtimeId: id, lastSeen: now() });
      flushQueue(id, ws);
      send(ws, { type: 'ack', inReplyTo: 'hello', status: 'delivered' });
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
      } catch (error) {
        send(ws, { type: 'error', error: `Bad JSON: ${(error as Error).message}` });
        return;
      }

      if (!handshakeDone) {
        if (msg.type === 'hello' && msg.from) {
          if (msg.auth) {
            const authError = verifyHelloAuth(msg.from, msg.auth, helloSkewMs);
            if (authError) {
              send(ws, { type: 'error', error: authError });
              ws.close();
              return;
            }
          } else if (requireAuth) {
            send(ws, { type: 'error', error: 'Hello auth required' });
            ws.close();
            return;
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

      if (
        msg.type === 'runtime_input' ||
        msg.type === 'entity_input' ||
        msg.type === 'gossip_request' ||
        msg.type === 'gossip_response' ||
        msg.type === 'gossip_announce'
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
      const client = clients.get(runtimeId);
      if (!message.id) message.id = makeMessageId();
      if (!message.timestamp) message.timestamp = now();
      if (client) {
        send(client.ws, message);
      } else {
        enqueue(runtimeId, message);
      }
    },
  };
};

if (import.meta.main) {
  const port = Number(process.env.WS_PORT || 8787);
  const serverId = process.env.WS_SERVER_ID || 'hub';
  startRuntimeWsServer({ port, serverId });
}
