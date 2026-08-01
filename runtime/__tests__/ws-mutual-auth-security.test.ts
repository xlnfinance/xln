import { afterEach, expect, test } from 'bun:test';

import { deriveSignerAddressSync } from '../account/crypto';
import { createDirectRuntimeWsRoute } from '../network/p2p/direct-runtime-bun';
import {
  canonicalizeRuntimeWsAudience,
} from '../network/p2p/hello-transcript';
import { RuntimeWsClient } from '../network/p2p/ws-client';
import type { RuntimeWsExpectedPeer } from '../network/p2p/ws-client-handshake';
import {
  deserializeWsMessage,
  MAX_PREAUTH_WS_MESSAGE_BYTES,
  serializeWsMessage,
} from '../network/p2p/ws-protocol';
import { startStandaloneRelayServer, type StandaloneRelayServer } from '../network/relay/standalone-server';
import { deriveEncryptionKeyPair, pubKeyToHex } from '../protocol/p2p-crypto';

const VICTIM_SEED = 'relay-challenge-forwarding-victim';
const VICTIM_RUNTIME_ID = deriveSignerAddressSync(VICTIM_SEED, '1').toLowerCase();

let relays: StandaloneRelayServer[] = [];
let proxies: Array<ReturnType<typeof Bun.serve>> = [];
let clients: RuntimeWsClient[] = [];
let upstreams: WebSocket[] = [];

const waitUntil = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`WAIT_TIMEOUT:${label}`);
};

const makeClient = (
  url: string,
  errors: string[],
  expectedPeer?: RuntimeWsExpectedPeer,
  onOpen?: () => void,
): RuntimeWsClient => {
  const client = new RuntimeWsClient({
    url,
    runtimeId: VICTIM_RUNTIME_ID,
    signerId: '1',
    seed: VICTIM_SEED,
    useHelloAuth: true,
    ...(expectedPeer ? { expectedPeer } : {}),
    encryptionKeyPair: deriveEncryptionKeyPair(VICTIM_SEED),
    onError: error => errors.push(error.message),
    onOpen,
    maxReconnectAttempts: 1,
  });
  clients.push(client);
  return client;
};

const startForwardingProxy = (
  targetUrl: string,
  transformUpstream?: (payload: ArrayBuffer) => ArrayBuffer | Uint8Array,
) => {
  const upstreamBySocket = new Map<object, WebSocket>();
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
        upstreamBySocket.set(downstream, upstream);
        upstreams.push(upstream);
        upstream.onmessage = event => {
          const payload = event.data as ArrayBuffer;
          downstream.send(transformUpstream?.(payload) ?? payload);
        };
      },
      message(downstream, message) {
        const upstream = upstreamBySocket.get(downstream);
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(message as Buffer);
      },
      close(downstream) {
        const upstream = upstreamBySocket.get(downstream);
        upstreamBySocket.delete(downstream);
        upstream?.close();
      },
    },
  });
  serverRef = server;
  proxies.push(server);
  return server;
};

const startDirectServer = (
  seed: string,
  deferAudienceBinding = false,
  onRecoveryBundleRequest?: () => Promise<unknown> | unknown,
) => {
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  const encryptionPubKey = pubKeyToHex(deriveEncryptionKeyPair(seed).publicKey);
  let activeSocket: { send(data: Uint8Array): unknown } | null = null;
  let route: ReturnType<typeof createDirectRuntimeWsRoute> | null = null;
  let audience = '';
  let serverRef: ReturnType<typeof Bun.serve> | null = null;
  const server = Bun.serve<{ type: 'direct-runtime' }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      if (!route) return new Response('Starting', { status: 503 });
      const decision = route.maybeUpgrade(request, server);
      if (decision.handled) return decision.response;
      return new Response('Not found', { status: 404 });
    },
    websocket: {
      open: ws => {
        activeSocket = ws;
        route?.websocket.open(ws);
      },
      message: (ws, raw) => route?.websocket.message(ws, raw as Buffer),
      close: ws => route?.websocket.close(ws),
    },
  });
  serverRef = server;
  void serverRef;
  proxies.push(server);
  const bindAudience = (publicWsUrl: string): void => {
    if (route) throw new Error('DIRECT_TEST_AUDIENCE_ALREADY_BOUND');
    audience = publicWsUrl;
    route = createDirectRuntimeWsRoute({
      runtimeId,
      runtimeSeed: seed,
      publicWsUrl,
      onEntityInputs: () => undefined,
      ...(onRecoveryBundleRequest ? { onRecoveryBundleRequest } : {}),
    });
  };
  if (!deferAudienceBinding) bindAudience(`ws://127.0.0.1:${server.port}/ws`);
  return {
    server,
    runtimeId,
    encryptionPubKey,
    bindAudience,
    get audience() { return audience; },
    get socket() { return activeSocket; },
  };
};

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const upstream of upstreams.splice(0)) upstream.close();
  for (const proxy of proxies.splice(0)) proxy.stop(true);
  for (const relay of relays.splice(0)) relay.close();
});

test('standalone relay closes an auto-pong socket at the absolute hello deadline', async () => {
  const relay = startStandaloneRelayServer({
    host: '127.0.0.1',
    port: 0,
    serverId: 'hello-deadline-relay',
    helloTimeoutMs: 25,
  });
  relays.push(relay);
  const silent = new WebSocket(`ws://127.0.0.1:${relay.server.port}`);
  upstreams.push(silent);
  let closed: { code: number; reason: string } | null = null;
  silent.addEventListener('close', event => {
    closed = { code: event.code, reason: event.reason };
  });

  await waitUntil(() => closed !== null, 'relay absolute hello deadline');

  expect(closed).toEqual({ code: 4008, reason: 'hello-timeout' });
});

test('standalone relay rejects an oversized frame before pre-auth MessagePack decoding', async () => {
  const relay = startStandaloneRelayServer({
    host: '127.0.0.1',
    port: 0,
    serverId: 'preauth-size-relay',
  });
  relays.push(relay);
  const socket = new WebSocket(`ws://127.0.0.1:${relay.server.port}`);
  upstreams.push(socket);
  let protocolError = '';
  let closeCode = 0;
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => {
    socket.send(new Uint8Array(MAX_PREAUTH_WS_MESSAGE_BYTES + 1));
  });
  socket.addEventListener('message', event => {
    const message = deserializeWsMessage(event.data as ArrayBuffer);
    if (message.type === 'error') protocolError = String(message.error || '');
  });
  socket.addEventListener('close', event => { closeCode = event.code; });

  await waitUntil(() => closeCode !== 0, 'relay preauth size rejection');

  expect(protocolError).toContain(
    `WS_MESSAGE_TOO_LARGE:bytes=${MAX_PREAUTH_WS_MESSAGE_BYTES + 1}:max=${MAX_PREAUTH_WS_MESSAGE_BYTES}`,
  );
  expect(closeCode).toBe(4003);
});

test('a relay cannot use another relay challenge to replace a live victim session', async () => {
  const target = startStandaloneRelayServer({
    host: '127.0.0.1',
    port: 0,
    serverId: 'target-relay',
  });
  relays.push(target);
  const targetUrl = `ws://127.0.0.1:${target.server.port}`;
  const legitimateErrors: string[] = [];
  const legitimate = makeClient(targetUrl, legitimateErrors);
  await legitimate.connect();
  await waitUntil(() => legitimate.isOpen(), 'legitimate-victim-session');
  const legitimateSession = target.store.clients.get(VICTIM_RUNTIME_ID);
  expect(legitimateSession).toBeDefined();

  const proxy = startForwardingProxy(targetUrl);
  const attackErrors: string[] = [];
  const signingOracle = makeClient(`ws://127.0.0.1:${proxy.port}`, attackErrors);
  await signingOracle.connect();
  await waitUntil(
    () => attackErrors.length > 0 || target.store.clients.get(VICTIM_RUNTIME_ID) !== legitimateSession,
    'forwarded-challenge-decision',
  );

  expect(target.store.clients.get(VICTIM_RUNTIME_ID)).toBe(legitimateSession);
  expect(legitimate.isOpen()).toBeTrue();
  expect(attackErrors.some(error => error.includes('WS_HELLO_CHALLENGE_AUDIENCE_MISMATCH'))).toBeTrue();
});

test('canonical relay audiences normalize schemes, default ports, and trailing separators', () => {
  expect(canonicalizeRuntimeWsAudience('HTTPS://Relay.Example:443/relay///?token=secret#fragment'))
    .toBe('wss://relay.example/relay');
  expect(canonicalizeRuntimeWsAudience('http://relay.example:80/'))
    .toBe('ws://relay.example/');
});

test('relay server audience is configured independently from the connecting Host header', async () => {
  const relay = startStandaloneRelayServer({
    host: '127.0.0.1',
    port: 0,
    serverId: 'configured-audience-relay',
    audience: 'wss://public-relay.example/relay',
  });
  relays.push(relay);
  const errors: string[] = [];
  const client = makeClient(`ws://127.0.0.1:${relay.server.port}`, errors);
  await client.connect();
  await waitUntil(() => errors.length > 0, 'configured-relay-audience-rejection');

  expect(client.isOpen()).toBeFalse();
  expect(relay.store.clients.has(VICTIM_RUNTIME_ID)).toBeFalse();
  expect(errors.some(error => error.includes('WS_HELLO_CHALLENGE_AUDIENCE_MISMATCH'))).toBeTrue();
});

test('direct handshake verifies the signed responder challenge and signed ACK', async () => {
  const target = startDirectServer('direct-mutual-auth-target');
  const errors: string[] = [];
  let opened = false;
  const client = makeClient(
    `ws://127.0.0.1:${target.server.port}/ws`,
    errors,
    {
      role: 'direct-runtime-server',
      audience: target.audience,
      runtimeId: target.runtimeId,
      encryptionPubKey: target.encryptionPubKey,
    },
    () => { opened = true; },
  );
  await client.connect();
  await waitUntil(() => opened || errors.length > 0, 'direct-mutual-auth');

  expect(opened).toBeTrue();
  expect(client.isOpen()).toBeTrue();
  expect(errors).toEqual([]);
});

test('post-auth identity failure rejects an outstanding recovery request immediately', async () => {
  let recoveryRequested = false;
  const target = startDirectServer(
    'direct-session-mismatch-target',
    false,
    () => {
      recoveryRequested = true;
      return new Promise<never>(() => undefined);
    },
  );
  const errors: string[] = [];
  const client = makeClient(
    `ws://127.0.0.1:${target.server.port}/ws`,
    errors,
    {
      role: 'direct-runtime-server',
      audience: target.audience,
      runtimeId: target.runtimeId,
      encryptionPubKey: target.encryptionPubKey,
    },
  );
  await client.connect();
  await waitUntil(() => client.isOpen(), 'authenticated direct recovery client');
  const recoveryResult = client.requestRecoveryBundles(target.runtimeId, 'pending-bundle', 5_000)
    .then(() => 'resolved', error => (error as Error).message);
  await waitUntil(() => recoveryRequested, 'pending direct recovery request');
  target.socket?.send(serializeWsMessage({
    type: 'gossip_announce',
    from: '0x1111111111111111111111111111111111111111',
    timestamp: Date.now(),
    payload: { profiles: [] },
  }));

  expect(await recoveryResult).toBe('RECOVERY_REQUEST_HANDSHAKE_FAILED');
  expect(errors.some(error => error.includes('WS_DIRECT_SESSION_RUNTIME_MISMATCH'))).toBeTrue();
});

test('direct client rejects a challenge replayed under the relay role', async () => {
  const targetSeed = 'direct-cross-role-target';
  const targetRuntimeId = deriveSignerAddressSync(targetSeed, '1').toLowerCase();
  const targetKey = pubKeyToHex(deriveEncryptionKeyPair(targetSeed).publicKey);
  let targetAudience = '';
  let serverRef: ReturnType<typeof Bun.serve> | null = null;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (request.headers.get('upgrade') === 'websocket' && serverRef?.upgrade(request)) return undefined;
      return new Response('WebSocket required', { status: 426 });
    },
    websocket: {
      open(ws) {
        ws.send(serializeWsMessage({
          type: 'hello_challenge',
          challenge: `0x${'31'.repeat(32)}`,
          audience: targetAudience,
          initiatorRole: 'runtime-client',
          responderRole: 'relay-server',
          from: targetRuntimeId,
          fromEncryptionPubKey: targetKey,
          timestamp: Date.now(),
        }));
      },
      message() {},
    },
  });
  serverRef = server;
  targetAudience = `ws://127.0.0.1:${server.port}/`;
  proxies.push(server);
  const errors: string[] = [];
  const client = makeClient(
    `ws://127.0.0.1:${server.port}`,
    errors,
    {
      role: 'direct-runtime-server',
      audience: targetAudience,
      runtimeId: targetRuntimeId,
      encryptionPubKey: targetKey,
    },
  );
  await client.connect();
  await waitUntil(() => errors.length > 0, 'cross-role-rejection');

  expect(client.isOpen()).toBeFalse();
  expect(errors.some(error => error.includes('ROLE_OR_IDENTITY_MISMATCH'))).toBeTrue();
});

test('authenticated client rejects a legacy challenge instead of downgrading', async () => {
  let serverRef: ReturnType<typeof Bun.serve> | null = null;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => request.headers.get('upgrade') === 'websocket' && serverRef?.upgrade(request)
      ? undefined
      : new Response('WebSocket required', { status: 426 }),
    websocket: {
      open: ws => ws.send(serializeWsMessage({ type: 'hello_challenge', challenge: `0x${'77'.repeat(32)}` })),
      message() { throw new Error('LEGACY_CHALLENGE_MUST_NOT_RECEIVE_HELLO'); },
    },
  });
  serverRef = server;
  proxies.push(server);
  const errors: string[] = [];
  const client = makeClient(`ws://127.0.0.1:${server.port}`, errors);
  await client.connect();
  await waitUntil(() => errors.length > 0, 'legacy-challenge-rejection');

  expect(client.isOpen()).toBeFalse();
  expect(errors.some(error => error.includes('WS_HELLO_CHALLENGE_AUDIENCE_MISMATCH'))).toBeTrue();
});

test('authenticated client treats a pre-ACK error frame as a failed handshake', async () => {
  let serverRef: ReturnType<typeof Bun.serve> | null = null;
  let rejectedClose: { code: number; reason: string } | null = null;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => request.headers.get('upgrade') === 'websocket' && serverRef?.upgrade(request)
      ? undefined
      : new Response('WebSocket required', { status: 426 }),
    websocket: {
      open: ws => ws.send(serializeWsMessage({ type: 'error', error: 'injected-before-ack' })),
      message() { throw new Error('PRE_ACK_ERROR_MUST_NOT_RECEIVE_HELLO'); },
      close(_ws, code, reason) {
        rejectedClose ??= { code, reason };
      },
    },
  });
  serverRef = server;
  proxies.push(server);
  const errors: string[] = [];
  const client = makeClient(`ws://127.0.0.1:${server.port}`, errors);
  await client.connect();
  await waitUntil(() => rejectedClose !== null, 'pre-ACK error rejection');

  expect(client.isOpen()).toBeFalse();
  expect(rejectedClose?.code).toBe(4003);
  expect(errors.some(error => error.includes('WS_ERROR_BEFORE_HANDSHAKE_ACK:injected-before-ack'))).toBeTrue();
});

test('direct client rejects an ACK whose challenge no longer matches the signed hello', async () => {
  const target = startDirectServer('direct-ack-binding-target', true);
  const targetUrl = `ws://127.0.0.1:${target.server.port}/ws`;
  const proxy = startForwardingProxy(targetUrl, payload => {
    const message = deserializeWsMessage(payload);
    return message.type === 'hello_ack'
      ? serializeWsMessage({ ...message, challenge: `0x${'ff'.repeat(32)}` })
      : payload;
  });
  const proxyUrl = `ws://127.0.0.1:${proxy.port}/`;
  target.bindAudience(proxyUrl);
  const errors: string[] = [];
  const client = makeClient(
    proxyUrl,
    errors,
    {
      role: 'direct-runtime-server',
      audience: target.audience,
      runtimeId: target.runtimeId,
      encryptionPubKey: target.encryptionPubKey,
    },
  );
  await client.connect();
  await waitUntil(() => errors.length > 0, 'direct-ack-mismatch');

  expect(client.isOpen()).toBeFalse();
  expect(errors.some(error => error.includes('WS_HELLO_ACK_CHALLENGE_MISMATCH'))).toBeTrue();
});
