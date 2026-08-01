/**
 * Standalone relay process backed by the same relay router as runtime/api/server/index.ts.
 */

import { createRelayStore, removeClient, type RelayStore } from './store';
import { forgetRelaySocketRuntimeId, relayRoute, type RelayRouterConfig } from './router';
import { deserializeWsMessage, makeMessageId, serializeWsMessage, type RuntimeWsMessage } from '../p2p/ws-protocol';
import { normalizeRuntimeId } from '../p2p/runtime-id';
import { createStructuredLogger } from '../../infra/logger';
import { createHelloChallengeRegistry } from '../p2p/hello-challenge';
import {
  canonicalizeRuntimeWsAudience,
  createRelayHandshakeBinding,
} from '../p2p/hello-transcript';

type StandaloneRelayOptions = {
  host?: string;
  port: number;
  serverId: string;
  serverRuntimeId?: string;
  audience?: string;
  onEntityInput?: (from: string | undefined, msg: RuntimeWsMessage, store: RelayStore) => Promise<void> | void;
};

export type StandaloneRelayServer = {
  server: Bun.Server<undefined>;
  store: RelayStore;
  close: () => void;
  sendToRuntime: (runtimeId: string, message: RuntimeWsMessage) => void;
};

const relayStandaloneLog = createStructuredLogger('relay.standalone');

const normalizeMessage = (raw: string | Buffer | ArrayBuffer): RuntimeWsMessage =>
  deserializeWsMessage(raw);

export const startStandaloneRelayServer = (options: StandaloneRelayOptions): StandaloneRelayServer => {
  const store = createRelayStore(options.serverId);
  const localRuntimeId = normalizeRuntimeId(options.serverRuntimeId || options.serverId) || options.serverId;
  const helloChallenges = createHelloChallengeRegistry();
  const listenHost = options.host || '0.0.0.0';
  const configuredAudience = String(options.audience || process.env['XLN_RELAY_AUDIENCE'] || '').trim();
  if (!configuredAudience && ['0.0.0.0', '::', '[::]'].includes(listenHost)) {
    throw new Error('RELAY_AUDIENCE_REQUIRED_FOR_WILDCARD_LISTENER');
  }
  let relayAudience = '';
  let serverRef: Bun.Server<undefined> | null = null;

  const routerConfig: RelayRouterConfig = {
    store,
    localRuntimeId,
    localDeliver: async (from, msg) => {
      await options.onEntityInput?.(from, msg, store);
    },
    send: (ws, data) => ws.send(data),
    consumeHelloChallenge: (ws, hello) => helloChallenges.consume(ws, hello),
  };

  const server = Bun.serve<undefined>({
    hostname: listenHost,
    port: options.port,
    fetch(request) {
      if (request.headers.get('upgrade') !== 'websocket') {
        return new Response('XLN relay websocket endpoint', { status: 200 });
      }
      if (serverRef?.upgrade(request)) return undefined;
      return new Response('WebSocket upgrade failed', { status: 400 });
    },
    websocket: {
      open(ws) {
        store.wsCounter += 1;
        if (!relayAudience) throw new Error('RELAY_AUDIENCE_NOT_INITIALIZED');
        helloChallenges.issue(ws, createRelayHandshakeBinding(relayAudience));
      },
      message(ws, message) {
        let msg: RuntimeWsMessage;
        try {
          msg = normalizeMessage(message as string | Buffer | ArrayBuffer);
        } catch (error) {
          ws.send(serializeWsMessage({ type: 'error', error: `Invalid relay message: ${(error as Error).message}` }));
          return;
        }
        Promise.resolve(relayRoute(routerConfig, ws, msg)).catch(error => {
          ws.send(serializeWsMessage({ type: 'error', error: `Relay handler failed: ${(error as Error).message}` }));
        });
      },
      close(ws) {
        helloChallenges.forget(ws);
        forgetRelaySocketRuntimeId(ws);
        removeClient(store, ws);
      },
    },
  });

  serverRef = server;
  relayAudience = canonicalizeRuntimeWsAudience(
    configuredAudience || `ws://${listenHost}:${server.port}/`,
  );
  relayStandaloneLog.info('service.listen', {
    serverId: options.serverId,
    host: options.host || '0.0.0.0',
    port: server.port,
  });

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
