import { expect, test } from 'bun:test';
import { createServer } from 'node:net';

import { startStandaloneRelayServer } from '../network/relay/standalone-server';
import { RuntimeP2P } from '../network/p2p/p2p';
import { createEmptyEnv } from '../runtime';

type FakeRelayClient = {
  isOpen: () => boolean;
  isConnecting: () => boolean;
};

const waitUntil = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`WAIT_TIMEOUT:${label}`);
};

const makeRealP2P = (relayUrl: string, seed: string): RuntimeP2P => {
  const env = createEmptyEnv(seed);
  return new RuntimeP2P({
    env,
    runtimeId: String(env.runtimeId),
    relayUrls: [relayUrl],
    relayAudience: relayUrl,
    onEntityInputs: () => {},
    onGossipProfiles: () => {},
  });
};

const makeDetachedP2P = (client: FakeRelayClient): RuntimeP2P & Record<string, unknown> => {
  const p2p = Object.create(RuntimeP2P.prototype) as RuntimeP2P & Record<string, unknown>;
  p2p.clients = [client];
  p2p.registerVisibilityReconnect = () => {
    p2p.registeredVisibility = Number(p2p.registeredVisibility || 0) + 1;
  };
  p2p.startPolling = () => {
    p2p.startedPolling = Number(p2p.startedPolling || 0) + 1;
  };
  p2p.closeClients = () => {
    p2p.closedClients = Number(p2p.closedClients || 0) + 1;
  };
  return p2p;
};

test('RuntimeP2P connect is idempotent while relay client is connecting', () => {
  const p2p = makeDetachedP2P({
    isOpen: () => false,
    isConnecting: () => true,
  });

  p2p.connect();

  expect(p2p.isConnecting()).toBe(true);
  expect(p2p.closedClients).toBeUndefined();
  expect(p2p.registeredVisibility).toBe(1);
  expect(p2p.startedPolling).toBe(1);
});

test('RuntimeP2P connect is idempotent while relay client is open', () => {
  const p2p = makeDetachedP2P({
    isOpen: () => true,
    isConnecting: () => false,
  });

  p2p.connect();

  expect(p2p.isConnected()).toBe(true);
  expect(p2p.closedClients).toBeUndefined();
  expect(p2p.registeredVisibility).toBe(1);
  expect(p2p.startedPolling).toBe(1);
});

test('browser resume preserves an in-flight relay handshake across visibility and focus events', async () => {
  let acceptedConnections = 0;
  const sockets = new Set<import('node:net').Socket>();
  const blackhole = createServer(socket => {
    acceptedConnections += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    blackhole.once('error', reject);
    blackhole.listen(0, '127.0.0.1', resolve);
  });
  const address = blackhole.address();
  if (!address || typeof address === 'string') throw new Error('TEST_BLACKHOLE_ADDRESS_MISSING');
  const documentBefore = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const windowBefore = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const testDocument = new EventTarget() as EventTarget & { visibilityState: string };
  testDocument.visibilityState = 'visible';
  const testWindow = new EventTarget();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: testDocument });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: testWindow });
  const relayUrl = `ws://127.0.0.1:${address.port}/`;
  const p2p = makeRealP2P(relayUrl, 'p2p-focus-handshake-preservation');
  try {
    p2p.connect();
    await waitUntil(() => acceptedConnections === 1 && p2p.isConnecting(), 'initial relay handshake');
    const firstClient = (p2p as unknown as { clients: unknown[] }).clients[0];

    testDocument.dispatchEvent(new Event('visibilitychange'));
    testWindow.dispatchEvent(new Event('focus'));
    await Bun.sleep(25);

    expect((p2p as unknown as { clients: unknown[] }).clients).toEqual([firstClient]);
    expect(acceptedConnections).toBe(1);
  } finally {
    p2p.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => blackhole.close(() => resolve()));
    if (documentBefore) Object.defineProperty(globalThis, 'document', documentBefore);
    else delete (globalThis as { document?: unknown }).document;
    if (windowBefore) Object.defineProperty(globalThis, 'window', windowBefore);
    else delete (globalThis as { window?: unknown }).window;
  }
});

test('relay reconnect drains retired clients instead of retaining them forever', async () => {
  const relay = startStandaloneRelayServer({
    host: '127.0.0.1',
    port: 0,
    serverId: 'p2p-retired-relay-client',
  });
  const relayUrl = `ws://127.0.0.1:${relay.server.port}/`;
  const p2p = makeRealP2P(relayUrl, 'p2p-retired-relay-client');
  const internals = p2p as unknown as {
    clients: unknown[];
    retiredClients: Set<unknown>;
  };
  try {
    p2p.connect();
    await waitUntil(() => p2p.isConnected(), 'initial relay connection');
    const firstClient = internals.clients[0];

    p2p.reconnect();
    await waitUntil(
      () => p2p.isConnected() && internals.clients[0] !== firstClient,
      'replacement relay connection',
    );
    await waitUntil(() => internals.retiredClients.size === 0, 'retired relay drain');

    expect(internals.clients).toHaveLength(1);
    expect(internals.retiredClients.size).toBe(0);
  } finally {
    await p2p.closeAndWait();
    relay.close();
  }
});
