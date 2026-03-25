import type { RoutedEntityInput } from '../types';
import { decryptJSON, deriveEncryptionKeyPair, pubKeyToHex } from './p2p-crypto';
import { deserializeWsMessage, makeMessageId, serializeWsMessage, type RuntimeWsMessage } from './ws-protocol';
import { isRuntimeId, normalizeRuntimeId } from './runtime-id';

type DirectRuntimeWsOptions = {
  runtimeId: string;
  runtimeSeed: Uint8Array | string;
  path?: string;
  onEntityInput: (from: string, input: RoutedEntityInput, timestamp?: number) => Promise<void> | void;
};

type DirectWsSession = {
  runtimeId: string | null;
  handshakeDone: boolean;
};

const send = (ws: any, msg: RuntimeWsMessage): void => {
  ws.send(serializeWsMessage(msg));
};

export const createDirectRuntimeWsRoute = (options: DirectRuntimeWsOptions) => {
  const routePath = options.path || '/ws';
  const serverRuntimeId = normalizeRuntimeId(options.runtimeId);
  if (!serverRuntimeId || !isRuntimeId(serverRuntimeId)) {
    throw new Error(`DIRECT_RUNTIME_WS_INVALID_RUNTIME_ID: ${String(options.runtimeId || '')}`);
  }
  const keyPair = deriveEncryptionKeyPair(options.runtimeSeed);
  const sessions = new WeakMap<any, DirectWsSession>();

  const ensureSession = (ws: any): DirectWsSession => {
    const existing = sessions.get(ws);
    if (existing) return existing;
    const created: DirectWsSession = { runtimeId: null, handshakeDone: false };
    sessions.set(ws, created);
    return created;
  };

  return {
    path: routePath,
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
          session.runtimeId = normalizedFrom;
          session.handshakeDone = true;
          send(ws, {
            type: 'hello',
            from: serverRuntimeId,
            fromEncryptionPubKey: pubKeyToHex(keyPair.publicKey),
          });
          return;
        }

        if (msg.type === 'ping') {
          send(ws, { type: 'pong', inReplyTo: msg.id || makeMessageId() });
          return;
        }
        if (msg.type === 'hello') {
          return;
        }
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
        sessions.delete(ws);
      },
    },
  };
};
