import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveSignerAddressSync } from '../account-crypto';
import { deriveEncryptionKeyPair } from '../networking/p2p-crypto';
import { RuntimeWsClient } from '../networking/ws-client';
import { startStandaloneRelayServer, type StandaloneRelayServer } from '../relay/standalone-server';

const SERVER_RUNTIME_ID = '0x9999999999999999999999999999999999999999';
const SEED_A = 'runtime-ws-recovery-client-a';
const SEED_B = 'runtime-ws-recovery-client-b';
const RUNTIME_A = deriveSignerAddressSync(SEED_A, '1').toLowerCase();
const RUNTIME_B = deriveSignerAddressSync(SEED_B, '2').toLowerCase();

let servers: StandaloneRelayServer[] = [];
let rawServers: Array<ReturnType<typeof Bun.serve>> = [];
let clients: RuntimeWsClient[] = [];

const waitUntil = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`WAIT_TIMEOUT:${label}`);
};

const startRelay = (): StandaloneRelayServer => {
  const server = startStandaloneRelayServer({
    host: '127.0.0.1',
    port: 0,
    serverId: SERVER_RUNTIME_ID,
  });
  servers.push(server);
  return server;
};

const makeClient = (options: {
  url: string;
  seed: string;
  runtimeId: string;
  signerId: string;
  onRecoveryBundleRequest?: (from: string, lookupKey: string) => Promise<unknown> | unknown;
  onError?: (error: Error) => void;
}): RuntimeWsClient => {
  const client = new RuntimeWsClient({
    url: options.url,
    runtimeId: options.runtimeId,
    signerId: options.signerId,
    seed: options.seed,
    useHelloAuth: true,
    encryptionKeyPair: deriveEncryptionKeyPair(options.seed),
    onRecoveryBundleRequest: options.onRecoveryBundleRequest,
    onError: options.onError,
  });
  clients.push(client);
  return client;
};

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) server.close();
  for (const server of rawServers.splice(0)) server.stop(true);
});

describe('runtime websocket recovery requests', () => {
  test('standalone relay uses structured startup logging', () => {
    const source = readFileSync(join(process.cwd(), 'runtime/relay/standalone-server.ts'), 'utf8');

    expect(source).toContain("createStructuredLogger('relay.standalone')");
    expect(source).toContain("relayStandaloneLog.info('service.listen'");
    expect(source).not.toContain('console.');
    expect(source).not.toContain('[WS] Runtime relay');
  });

  test('requestRecoveryBundles resolves a correlated peer response through relay', async () => {
    const relay = startRelay();
    const url = `ws://127.0.0.1:${relay.server.port}`;
    const seenRequests: Array<{ from: string; lookupKey: string }> = [];
    const requesterErrors: string[] = [];
    const responderErrors: string[] = [];
    const requester = makeClient({
      url,
      seed: SEED_A,
      runtimeId: RUNTIME_A,
      signerId: '1',
      onError: error => requesterErrors.push(error.message),
    });
    const responder = makeClient({
      url,
      seed: SEED_B,
      runtimeId: RUNTIME_B,
      signerId: '2',
      onRecoveryBundleRequest: (from, lookupKey) => {
        seenRequests.push({ from: from.toLowerCase(), lookupKey });
        return { ok: true, runtimeId: RUNTIME_B, lookupKey, bundles: [{ lookupKey, height: 7 }] };
      },
      onError: error => responderErrors.push(error.message),
    });

    await requester.connect();
    await responder.connect();
    await waitUntil(() => relay.store.clients.has(RUNTIME_A) && relay.store.clients.has(RUNTIME_B), 'relay clients');

    const response = await requester.requestRecoveryBundles(RUNTIME_B, 'lookup/key', 1_000);

    expect(response).toMatchObject({
      ok: true,
      runtimeId: RUNTIME_B,
      lookupKey: 'lookup/key',
      bundles: [{ lookupKey: 'lookup/key', height: 7 }],
    });
    expect(seenRequests).toEqual([{ from: RUNTIME_A, lookupKey: 'lookup/key' }]);
    expect(requesterErrors).toEqual([]);
    expect(responderErrors).toEqual([]);
  });

  test('requestRecoveryBundles rejects relay offline-target errors by request id', async () => {
    const relay = startRelay();
    const url = `ws://127.0.0.1:${relay.server.port}`;
    const requesterErrors: string[] = [];
    const requester = makeClient({
      url,
      seed: SEED_A,
      runtimeId: RUNTIME_A,
      signerId: '1',
      onError: error => requesterErrors.push(error.message),
    });

    await requester.connect();
    await waitUntil(() => relay.store.clients.has(RUNTIME_A), 'requester relay client');

    await expect(requester.requestRecoveryBundles(RUNTIME_B, 'lookup/key', 1_000))
      .rejects.toThrow('RECOVERY_TARGET_NOT_CONNECTED');
    expect(requesterErrors).toEqual([]);
  });

  test('requestRecoveryBundles times out when a connected peer never answers', async () => {
    let rawServer: ReturnType<typeof Bun.serve> | null = null;
    rawServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        if (request.headers.get('upgrade') === 'websocket' && rawServer?.upgrade(request)) {
          return undefined;
        }
        return new Response('websocket only', { status: 400 });
      },
      websocket: {
        message() {},
      },
    });
    rawServers.push(rawServer);
    const client = makeClient({
      url: `ws://127.0.0.1:${rawServer.port}`,
      seed: SEED_A,
      runtimeId: RUNTIME_A,
      signerId: '1',
    });

    await client.connect();
    await waitUntil(() => client.isOpen(), 'dummy ws open');

    await expect(client.requestRecoveryBundles(RUNTIME_B, 'lookup/key', 50))
      .rejects.toThrow('RECOVERY_REQUEST_TIMEOUT');
  });
});
