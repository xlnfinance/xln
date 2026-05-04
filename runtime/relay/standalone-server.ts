/**
 * Standalone relay process backed by the same relay router as runtime/server.ts.
 */

import { createRelayStore, type RelayStore } from '../relay-store';
import { forgetRelaySocketRuntimeId, relayRoute, type RelayRouterConfig } from '../relay-router';
import { deserializeWsMessage, makeMessageId, serializeWsMessage, type RuntimeWsMessage } from '../networking/ws-protocol';
import { safeStringify } from '../serialization-utils';
import { normalizeRuntimeId } from '../networking/runtime-id';

type StandaloneRelayOptions = {
  host?: string;
  port: number;
  serverId: string;
  serverRuntimeId?: string;
  onEntityInput?: (from: string | undefined, msg: unknown) => Promise<void> | void;
};

export type StandaloneRelayServer = {
  server: ReturnType<typeof Bun.serve>;
  store: RelayStore;
  close: () => void;
  sendToRuntime: (runtimeId: string, message: RuntimeWsMessage) => void;
};

const normalizeMessage = (raw: string | Buffer | ArrayBuffer): RuntimeWsMessage => {
  try {
    return deserializeWsMessage(raw);
  } catch {
    const text =
      typeof raw === 'string'
        ? raw
        : raw instanceof ArrayBuffer
          ? new TextDecoder().decode(new Uint8Array(raw))
          : Buffer.from(raw).toString('utf8');
    return JSON.parse(text) as RuntimeWsMessage;
  }
};

export const startStandaloneRelayServer = (options: StandaloneRelayOptions): StandaloneRelayServer => {
  const store = createRelayStore(options.serverId);
  const localRuntimeId = normalizeRuntimeId(options.serverRuntimeId || options.serverId) || options.serverId;
  let serverRef: ReturnType<typeof Bun.serve> | null = null;

  const routerConfig: RelayRouterConfig = {
    store,
    localRuntimeId,
    localDeliver: async (from, msg) => {
      await options.onEntityInput?.(from, msg);
    },
    send: (ws, data) => ws.send(data),
  };

  const server = Bun.serve({
    hostname: options.host || '0.0.0.0',
    port: options.port,
    fetch(request) {
      if (request.headers.get('upgrade') !== 'websocket') {
        return new Response('XLN relay websocket endpoint', { status: 200 });
      }
      if (serverRef?.upgrade(request)) return undefined;
      return new Response('WebSocket upgrade failed', { status: 400 });
    },
    websocket: {
      open() {
        store.wsCounter += 1;
      },
      message(ws, message) {
        let msg: RuntimeWsMessage;
        try {
          msg = normalizeMessage(message as string | Buffer | ArrayBuffer);
        } catch (error) {
          ws.send(safeStringify({ type: 'error', error: `Invalid relay message: ${(error as Error).message}` }));
          return;
        }
        Promise.resolve(relayRoute(routerConfig, ws, msg)).catch(error => {
          ws.send(safeStringify({ type: 'error', error: `Relay handler failed: ${(error as Error).message}` }));
        });
      },
      close(ws) {
        forgetRelaySocketRuntimeId(ws);
      },
    },
  });

  serverRef = server;
  console.log(`[WS] Runtime relay "${options.serverId}" listening on ${options.host || '0.0.0.0'}:${server.port}`);

  return {
    server,
    store,
    close: () => server.stop(true),
    sendToRuntime: (runtimeId, message) => {
      const normalized = normalizeRuntimeId(runtimeId);
      if (!normalized) return;
      const client = store.clients.get(normalized);
      if (!message.id) message.id = makeMessageId();
      if (!message.timestamp) message.timestamp = Date.now();
      if (client?.ws) client.ws.send(serializeWsMessage(message));
    },
  };
};

if (import.meta.main) {
  const args = process.argv;
  const portArgIdx = args.indexOf('--port');
  const hostArgIdx = args.indexOf('--host');
  const port = portArgIdx !== -1 && args[portArgIdx + 1]
    ? Number(args[portArgIdx + 1])
    : Number(process.env['WS_PORT'] || 8787);
  const host = hostArgIdx !== -1 && args[hostArgIdx + 1]
    ? String(args[hostArgIdx + 1])
    : process.env['WS_HOST'] || '0.0.0.0';
  const serverId = process.env['WS_SERVER_ID'] || 'relay';
  startStandaloneRelayServer({ host, port, serverId });
}
