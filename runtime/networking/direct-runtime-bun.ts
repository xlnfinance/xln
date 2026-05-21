import type { RoutedEntityInput } from '../types';
import { compareCanonicalText } from '../swap-keys';
import { decryptJSON, deriveEncryptionKeyPair, encryptJSON, hexToPubKey, pubKeyToHex } from './p2p-crypto';
import { deserializeWsMessage, makeMessageId, serializeWsMessage, type RuntimeWsMessage } from './ws-protocol';
import { isRuntimeId, normalizeRuntimeId } from './runtime-id';
import { verifyHelloAuth } from './hello-auth';

type DirectRuntimeWsOptions = {
  runtimeId: string;
  runtimeSeed: Uint8Array | string;
  path?: string;
  requireHelloAuth?: boolean;
  helloSkewMs?: number;
  onEntityInput: (from: string, input: RoutedEntityInput, timestamp?: number) => Promise<void> | void;
};

type DirectWsSession = {
  runtimeId: string | null;
  ws: any;
  handshakeDone: boolean;
  peerEncryptionPubKey: string | null;
  lastSeen: number;
};

const DEFAULT_HELLO_SKEW_MS = 5 * 60 * 1000;
let directWsTimestampCounter = 0;

const nextTimestamp = (): number => {
  const now = Date.now();
  if (now <= directWsTimestampCounter) {
    directWsTimestampCounter += 1;
    return directWsTimestampCounter;
  }
  directWsTimestampCounter = now;
  return directWsTimestampCounter;
};

const isSocketOpen = (ws: unknown): boolean => {
  if (!ws || (typeof ws !== 'object' && typeof ws !== 'function')) return false;
  const readyState = Number((ws as { readyState?: unknown }).readyState);
  return !Number.isFinite(readyState) || readyState === 1;
};

const normalizeEncryptionPubKey = (pubKey: unknown): string | null => {
  if (typeof pubKey !== 'string') return null;
  const normalized = pubKey.startsWith('0x') ? pubKey.toLowerCase() : `0x${pubKey.toLowerCase()}`;
  return /^0x[0-9a-f]{64}$/.test(normalized) ? normalized : null;
};

const send = (ws: any, msg: RuntimeWsMessage): void => {
  ws.send(serializeWsMessage(msg));
};

const trySend = (ws: any, msg: RuntimeWsMessage): boolean => {
  if (!isSocketOpen(ws)) return false;
  try {
    const result = ws.send(serializeWsMessage(msg));
    if (result === false) return false;
    return !(typeof result === 'number' && result < 0);
  } catch {
    return false;
  }
};

export const createDirectRuntimeWsRoute = (options: DirectRuntimeWsOptions) => {
  const routePath = options.path || '/ws';
  const serverRuntimeId = normalizeRuntimeId(options.runtimeId);
  if (!serverRuntimeId || !isRuntimeId(serverRuntimeId)) {
    throw new Error(`DIRECT_RUNTIME_WS_INVALID_RUNTIME_ID: ${String(options.runtimeId || '')}`);
  }
  const keyPair = deriveEncryptionKeyPair(options.runtimeSeed);
  const sessions = new Map<any, DirectWsSession>();
  const sessionsByRuntime = new Map<string, DirectWsSession>();

  const ensureSession = (ws: any): DirectWsSession => {
    const existing = sessions.get(ws);
    if (existing) return existing;
    const created: DirectWsSession = {
      runtimeId: null,
      ws,
      handshakeDone: false,
      peerEncryptionPubKey: null,
      lastSeen: Date.now(),
    };
    sessions.set(ws, created);
    return created;
  };

  const forgetSession = (ws: any): void => {
    const session = sessions.get(ws);
    if (!session) return;
    sessions.delete(ws);
    if (session.runtimeId && sessionsByRuntime.get(session.runtimeId)?.ws === ws) {
      sessionsByRuntime.delete(session.runtimeId);
    }
  };

  const rememberRuntimeSession = (session: DirectWsSession, runtimeId: string): boolean => {
    const existing = sessionsByRuntime.get(runtimeId);
    if (existing && existing.ws !== session.ws) {
      if (isSocketOpen(existing.ws)) {
        return false;
      }
      sessions.delete(existing.ws);
    }
    session.runtimeId = runtimeId;
    session.handshakeDone = true;
    session.lastSeen = Date.now();
    sessionsByRuntime.set(runtimeId, session);
    return true;
  };

  return {
    path: routePath,
    getSessionState(): Array<{ runtimeId: string; open: boolean; lastSeen: number }> {
      return Array.from(sessionsByRuntime.values())
        .map(session => ({
          runtimeId: session.runtimeId || '',
          open: isSocketOpen(session.ws),
          lastSeen: session.lastSeen,
        }))
        .filter(session => session.runtimeId.length > 0)
        .sort((left, right) => compareCanonicalText(left.runtimeId, right.runtimeId));
    },
    sendEntityInput(targetRuntimeId: string, input: RoutedEntityInput, ingressTimestamp?: number): boolean {
      const targetKey = normalizeRuntimeId(targetRuntimeId);
      if (!targetKey) return false;
      const session = sessionsByRuntime.get(targetKey);
      if (!session || !session.handshakeDone || !isSocketOpen(session.ws)) {
        if (session && !isSocketOpen(session.ws)) forgetSession(session.ws);
        return false;
      }
      const peerKey = normalizeEncryptionPubKey(session.peerEncryptionPubKey);
      if (!peerKey) return false;
      try {
        const payload = encryptJSON(input, hexToPubKey(peerKey));
        const msg: RuntimeWsMessage = {
          type: 'entity_input',
          id: makeMessageId(),
          from: serverRuntimeId,
          fromEncryptionPubKey: pubKeyToHex(keyPair.publicKey),
          to: targetKey,
          timestamp:
            typeof ingressTimestamp === 'number' && Number.isFinite(ingressTimestamp)
              ? ingressTimestamp
              : nextTimestamp(),
          payload,
          encrypted: true,
          entityId: input.entityId,
          txs: input.entityTxs?.length ?? 0,
        };
        const sent = trySend(session.ws, msg);
        if (!sent) forgetSession(session.ws);
        return sent;
      } catch {
        return false;
      }
    },
    maybeUpgrade(request: Request, serverRef: any): Response | undefined {
      const url = new URL(request.url);
      if (request.headers.get('upgrade') !== 'websocket' || url.pathname !== routePath) {
        return undefined;
      }
      const upgraded = serverRef.upgrade(request, { data: { type: 'direct-runtime' } });
      if (upgraded) return undefined;
      return new Response('WebSocket upgrade failed', { status: 400 });
    },
    websocket: {
      open(ws: any) {
        ensureSession(ws);
      },
      async message(ws: any, raw: string | Buffer | ArrayBuffer) {
        const session = ensureSession(ws);
        let msg: RuntimeWsMessage;
        try {
          msg = deserializeWsMessage(raw);
        } catch (error) {
          send(ws, { type: 'error', error: `Bad JSON: ${(error as Error).message}` });
          return;
        }

        if (!session.handshakeDone) {
          if (msg.type !== 'hello' || typeof msg.from !== 'string') {
            send(ws, { type: 'error', error: 'Handshake required: send hello with runtimeId' });
            ws.close();
            return;
          }
          const normalizedFrom = normalizeRuntimeId(msg.from);
          if (!normalizedFrom) {
            send(ws, { type: 'error', error: 'Invalid runtimeId in hello' });
            ws.close();
            return;
          }
          const peerKey = normalizeEncryptionPubKey(msg.fromEncryptionPubKey);
          if (!peerKey) {
            send(ws, { type: 'error', error: 'Missing or invalid fromEncryptionPubKey' });
            ws.close();
            return;
          }
          if (options.requireHelloAuth !== false) {
            const authError = verifyHelloAuth(normalizedFrom, msg.auth, options.helloSkewMs ?? DEFAULT_HELLO_SKEW_MS);
            if (authError) {
              send(ws, { type: 'error', error: authError });
              ws.close();
              return;
            }
          }
          session.peerEncryptionPubKey = peerKey;
          if (!rememberRuntimeSession(session, normalizedFrom)) {
            send(ws, { type: 'error', error: 'Runtime already connected' });
            ws.close();
            return;
          }
          send(ws, {
            type: 'hello',
            from: serverRuntimeId,
            fromEncryptionPubKey: pubKeyToHex(keyPair.publicKey),
          });
          return;
        }

        if (msg.type === 'ping') {
          session.lastSeen = Date.now();
          send(ws, { type: 'pong', inReplyTo: msg.id || makeMessageId() });
          return;
        }
        if (msg.type === 'hello') {
          return;
        }
        session.lastSeen = Date.now();
        const peerKey = normalizeEncryptionPubKey(msg.fromEncryptionPubKey);
        if (peerKey) session.peerEncryptionPubKey = peerKey;
        if (msg.type !== 'entity_input') {
          send(ws, { type: 'error', error: 'Unsupported direct ws message type' });
          return;
        }
        if (normalizeRuntimeId(msg.to || '') !== serverRuntimeId) {
          send(ws, { type: 'error', error: 'Direct target runtimeId mismatch' });
          return;
        }
        if (!msg.encrypted || typeof msg.payload !== 'string') {
          send(ws, { type: 'error', error: 'Direct entity_input must be encrypted' });
          return;
        }
        const fromRuntimeId = normalizeRuntimeId(session.runtimeId || '');
        if (!fromRuntimeId) {
          send(ws, { type: 'error', error: 'Missing source runtimeId' });
          return;
        }
        if (msg.from && normalizeRuntimeId(msg.from) !== fromRuntimeId) {
          send(ws, { type: 'error', error: 'Direct source runtimeId mismatch' });
          return;
        }
        try {
          const input = decryptJSON<RoutedEntityInput>(msg.payload, keyPair.privateKey);
          await options.onEntityInput(fromRuntimeId, input, typeof msg.timestamp === 'number' ? msg.timestamp : undefined);
        } catch (error) {
          send(ws, { type: 'error', error: `Direct delivery failed: ${(error as Error).message}` });
        }
      },
      close(ws: any) {
        forgetSession(ws);
      },
    },
  };
};
