/**
 * Standalone relay process backed by the same relay router as core/api/server/index.ts.
 */

import { createRelayStore, removeClient, type RelayStore } from './store';
import { isRelaySocketAuthenticated, forgetRelaySocketRuntimeId, relayRoute, type RelayRouterConfig } from './router';
import {
  canonicalizeRuntimeWsAudience,
  deserializeWsMessage,
  resolveRuntimeWsMaxMessageBytes,
  serializeWsMessage,
  toRuntimeWsBytes,
  type RuntimeWsMessage,
} from '../p2p/ws-protocol';
import { normalizeRuntimeId } from '../p2p/auth/runtime-id';
import { createStructuredLogger } from '../../support/logger';
import { createHelloChallengeRegistry } from '../p2p/auth/hello-challenge';

type StandaloneRelayOptions = {
  host?: string;
  port: number;
  serverId: string;
  audience?: string;
  serverRuntimeId?: string;
};

export type StandaloneRelayServer = {
  server: Bun.Server<undefined>;
  store: RelayStore;
  close: () => void;
};

const relayStandaloneLog = createStructuredLogger('relay.standalone');

const normalizeMessage = (ws: unknown, raw: string | Buffer | ArrayBuffer): RuntimeWsMessage =>
  deserializeWsMessage(raw, { authenticated: isRelaySocketAuthenticated(ws) });

export const startStandaloneRelayServer = (options: StandaloneRelayOptions): StandaloneRelayServer => {
  const store = createRelayStore(options.serverId);
  const localRuntimeId = normalizeRuntimeId(options.serverRuntimeId || options.serverId) || options.serverId;
  const helloChallenges = createHelloChallengeRegistry();
  let serverRef: Bun.Server<undefined> | null = null;
  let relayAudience = '';

  const routerConfig: RelayRouterConfig = {
    store,
    localRuntimeId,
    send: (ws, data) => ws.send(data),
    consumeHelloChallenge: (ws, challenge) => helloChallenges.consume(ws, challenge),
  };

  const server = Bun.serve<undefined>({
    hostname: options.host || '0.0.0.0',
    port: options.port,
    maxRequestBodySize: 1024 * 1024,
    fetch(request) {
      if (request.headers.get('upgrade') !== 'websocket') {
        return new Response('XLN relay websocket endpoint', { status: 200 });
      }
      if (serverRef?.upgrade(request)) return undefined;
      return new Response('WebSocket upgrade failed', { status: 400 });
    },
    websocket: {
      maxPayloadLength: resolveRuntimeWsMaxMessageBytes(),
      open(ws) {
        store.wsCounter += 1;
        helloChallenges.issue(ws, relayAudience);
      },
      message(ws, message) {
        let msg: RuntimeWsMessage;
        try {
          msg = normalizeMessage(ws, message as string | Buffer | ArrayBuffer);
        } catch (error) {
          ws.send(serializeWsMessage({ type: 'error', error: `Invalid relay message: ${(error as Error).message}` }));
          return;
        }
        Promise.resolve(relayRoute(routerConfig, ws, msg, typeof message === 'string' ? undefined : toRuntimeWsBytes(message as Buffer | ArrayBuffer))).catch(error => {
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
  const audienceHost = !options.host || options.host === '0.0.0.0' || options.host === '::'
    ? '127.0.0.1'
    : options.host;
  relayAudience = canonicalizeRuntimeWsAudience(
    options.audience || `ws://${audienceHost}:${server.port}/`,
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
  startStandaloneRelayServer({
    host,
    port,
    serverId,
    ...(process.env['RELAY_URL'] ? { audience: process.env['RELAY_URL'] } : {}),
  });
}
