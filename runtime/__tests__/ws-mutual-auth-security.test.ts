import { afterEach, expect, test } from 'bun:test';

import { deriveSignerAddressSync } from '../account/crypto';
import { RuntimeWsClient } from '../network/p2p/ws-client';
import { startStandaloneRelayServer, type StandaloneRelayServer } from '../network/relay/standalone-server';
import { deriveEncryptionKeyPair } from '../protocol/p2p-crypto';

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

const makeClient = (url: string, errors: string[]): RuntimeWsClient => {
  const client = new RuntimeWsClient({
    url,
    runtimeId: VICTIM_RUNTIME_ID,
    signerId: '1',
    seed: VICTIM_SEED,
    useHelloAuth: true,
    encryptionKeyPair: deriveEncryptionKeyPair(VICTIM_SEED),
    onError: error => errors.push(error.message),
    maxReconnectAttempts: 1,
  });
  clients.push(client);
  return client;
};

const startBlindForwardingProxy = (targetUrl: string) => {
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
        upstream.onmessage = event => downstream.send(event.data as ArrayBuffer);
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

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const upstream of upstreams.splice(0)) upstream.close();
  for (const proxy of proxies.splice(0)) proxy.stop(true);
  for (const relay of relays.splice(0)) relay.close();
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

  const proxy = startBlindForwardingProxy(targetUrl);
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
