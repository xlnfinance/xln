import { afterEach, expect, test } from 'bun:test';

import { deriveSignerAddressSync } from '../account/crypto';
import { createDirectRuntimeWsRoute } from '../network/p2p/direct-runtime-bun';
import { canonicalizeDirectRuntimeWsAudience } from '../network/p2p/hello-transcript';
import { RuntimeWsClient } from '../network/p2p/ws-client';
import { resolveUnifiedRelayEndpoints } from '../network/relay/audience-config';
import { deriveEncryptionKeyPair, pubKeyToHex } from '../protocol/p2p-crypto';

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const clients: RuntimeWsClient[] = [];
const upstreams: WebSocket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const upstream of upstreams.splice(0)) upstream.close();
  for (const server of servers.splice(0)) server.stop(true);
  await Bun.sleep(5);
});

const waitUntil = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`WAIT_TIMEOUT:${label}`);
};

const startDirectTarget = (seed: string) => {
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  const encryptionPubKey = pubKeyToHex(deriveEncryptionKeyPair(seed).publicKey);
  let route: ReturnType<typeof createDirectRuntimeWsRoute> | null = null;
  const server = Bun.serve<{ type: 'direct-runtime' }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, bunServer) {
      if (!route) return new Response('Starting', { status: 503 });
      const decision = route.maybeUpgrade(request, bunServer);
      if (decision.handled) return decision.response;
      return new Response('Not found', { status: 404 });
    },
    websocket: {
      open: ws => route?.websocket.open(ws),
      message: (ws, raw) => route?.websocket.message(ws, raw as Buffer),
      close: ws => route?.websocket.close(ws),
    },
  });
  const wsUrl = `ws://127.0.0.1:${server.port}/ws`;
  route = createDirectRuntimeWsRoute({
    runtimeId,
    runtimeSeed: seed,
    publicWsUrl: wsUrl,
    onEntityInputs: () => undefined,
  });
  servers.push(server);
  return { runtimeId, encryptionPubKey, wsUrl };
};

const startTransparentProxy = (targetUrl: string): string => {
  const upstreamByDownstream = new Map<object, WebSocket>();
  let serverRef: ReturnType<typeof Bun.serve> | null = null;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (request.headers.get('upgrade') === 'websocket' && serverRef?.upgrade(request)) return undefined;
      return new Response('WebSocket upgrade required', { status: 426 });
    },
    websocket: {
      open(downstream) {
        const upstream = new WebSocket(targetUrl);
        upstream.binaryType = 'arraybuffer';
        upstreamByDownstream.set(downstream, upstream);
        upstreams.push(upstream);
        upstream.onmessage = event => downstream.send(event.data as ArrayBuffer);
      },
      message(downstream, message) {
        const upstream = upstreamByDownstream.get(downstream);
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(message as Buffer);
      },
      close(downstream) {
        const upstream = upstreamByDownstream.get(downstream);
        upstreamByDownstream.delete(downstream);
        upstream?.close();
      },
    },
  });
  serverRef = server;
  servers.push(server);
  return `ws://127.0.0.1:${server.port}/ws`;
};

test('direct handshake rejects a transparent proxy serving a different signed endpoint', async () => {
  const target = startDirectTarget('endpoint-bound-direct-target');
  const proxyUrl = startTransparentProxy(target.wsUrl);
  const errors: string[] = [];
  let opened = false;
  const victimSeed = 'endpoint-bound-direct-victim';
  const client = new RuntimeWsClient({
    url: proxyUrl,
    runtimeId: deriveSignerAddressSync(victimSeed, '1').toLowerCase(),
    signerId: '1',
    seed: victimSeed,
    useHelloAuth: true,
    expectedPeer: {
      role: 'direct-runtime-server',
      audience: proxyUrl,
      runtimeId: target.runtimeId,
      encryptionPubKey: target.encryptionPubKey,
    },
    encryptionKeyPair: deriveEncryptionKeyPair(victimSeed),
    onOpen: () => { opened = true; },
    onError: error => errors.push(error.message),
    maxReconnectAttempts: 1,
  });
  clients.push(client);

  await client.connect();
  await waitUntil(() => errors.length > 0, 'endpoint-audience-rejection');

  expect(opened).toBeFalse();
  expect(client.isOpen()).toBeFalse();
  expect(errors.some(error => error.includes('WS_HELLO_CHALLENGE_AUDIENCE_MISMATCH'))).toBeTrue();
});

test('direct public endpoints require TLS while loopback remains available for local dev', () => {
  expect(canonicalizeDirectRuntimeWsAudience('ws://127.0.0.1:8080/ws')).toBe('ws://127.0.0.1:8080/ws');
  expect(canonicalizeDirectRuntimeWsAudience('ws://localhost:8080/ws')).toBe('ws://localhost:8080/ws');
  expect(canonicalizeDirectRuntimeWsAudience('ws://[::1]:8080/ws')).toBe('ws://[::1]:8080/ws');
  expect(canonicalizeDirectRuntimeWsAudience('wss://Hub.Example/ws')).toBe('wss://hub.example/ws');
  expect(() => canonicalizeDirectRuntimeWsAudience('ws://hub.example/ws'))
    .toThrow('DIRECT_RUNTIME_WS_PLAINTEXT_PUBLIC_FORBIDDEN');
});

test('unified relay keeps internal transport separate from one public crypto audience', () => {
  expect(resolveUnifiedRelayEndpoints({
    port: 8080,
    publicRelayUrl: 'ws://127.0.0.1:8080/relay',
    internalRelayUrl: 'ws://127.0.0.1:8080/relay',
  })).toEqual({
    internalUrl: 'ws://127.0.0.1:8080/relay',
    publicAudience: 'ws://127.0.0.1:8080/relay',
  });

  expect(resolveUnifiedRelayEndpoints({
    port: 8080,
    publicRelayUrl: 'wss://wallet.example/relay',
    internalRelayUrl: 'ws://127.0.0.1:8080/relay',
  })).toEqual({
    internalUrl: 'ws://127.0.0.1:8080/relay',
    publicAudience: 'wss://wallet.example/relay',
  });
});

test('unified relay fails before startup when public audience is absent or malformed', () => {
  expect(() => resolveUnifiedRelayEndpoints({
    port: 8080,
    internalRelayUrl: 'ws://127.0.0.1:8080/relay',
  })).toThrow('PUBLIC_RELAY_AUDIENCE_REQUIRED');
  expect(() => resolveUnifiedRelayEndpoints({
    port: 8080,
    publicRelayUrl: 'https://wallet.example/not-websocket',
  })).toThrow('PUBLIC_RELAY_AUDIENCE_PATH_INVALID');
});
