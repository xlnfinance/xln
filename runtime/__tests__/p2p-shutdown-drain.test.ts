import { expect, test } from 'bun:test';

import { reportDirectClientError, reportRelayClientError, RuntimeP2P } from '../networking/p2p';
import { RuntimeWsClient } from '../networking/ws-client';
import { deriveEncryptionKeyPair } from '../networking/p2p-crypto';
import { stopRuntimeP2P, stopRuntimeP2PAndWait } from '../machine/p2p-lifecycle';
import { createEmptyEnv } from '../runtime';
import type { Env } from '../types';

const RUNTIME_ID = `0x${'11'.repeat(20)}`;

test('offline reliable-receipt target is an explicit info-level retry race', () => {
  const env = createEmptyEnv('p2p-receipt-target-offline-severity');
  const info: string[] = [];
  const warnings: string[] = [];
  env.info = (_category, message) => { info.push(message); };
  env.warn = (_category, message) => { warnings.push(message); };

  reportRelayClientError(env, 'ws://relay', new Error('ENTITY_INPUT_RECEIPT_TARGET_NOT_CONNECTED'));
  expect(info).toEqual(['RELIABLE_RECEIPT_TARGET_OFFLINE']);
  expect(warnings).toEqual([]);

  reportRelayClientError(env, 'ws://relay', new Error(
    'INBOUND_ENTITY_RUNTIME_QUIESCING: entity=0x11 signer=0x22 txTypes=consensusOutput',
  ));
  expect(info).toEqual(['RELIABLE_RECEIPT_TARGET_OFFLINE', 'WS_CLIENT_RETRYABLE_BACKPRESSURE']);
  expect(warnings).toEqual([]);

  reportRelayClientError(env, 'ws://relay', new Error('unexpected transport failure'));
  expect(warnings).toEqual(['WS_CLIENT_ERROR']);
});

test('direct runtime quiesce is info-level backpressure, not a transport warning', () => {
  const env = createEmptyEnv('p2p-direct-quiesce-severity');
  const info: string[] = [];
  const warnings: string[] = [];
  env.info = (_category, message) => { info.push(message); };
  env.warn = (_category, message) => { warnings.push(message); };

  expect(reportDirectClientError(
    env,
    'ws://peer/ws',
    `0x${'22'.repeat(20)}`,
    new Error('INBOUND_ENTITY_RUNTIME_QUIESCING: entity=0x11 signer=0x22 txTypes=consensusOutput'),
  )).toBe('retryable-backpressure');
  expect(info).toEqual(['WS_DIRECT_RETRYABLE_BACKPRESSURE']);
  expect(warnings).toEqual([]);

  expect(reportDirectClientError(env, 'ws://peer/ws', `0x${'22'.repeat(20)}`, new Error('socket failed')))
    .toBe('transport-error');
  expect(warnings).toEqual(['WS_DIRECT_ERROR']);
});

test('websocket client remains connecting until the transport handshake settles', async () => {
  let releaseHandshake!: () => void;
  const handshakeGate = new Promise<void>((resolve) => { releaseHandshake = resolve; });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request, serverRef) {
      await handshakeGate;
      if (serverRef.upgrade(request)) return;
      return new Response('upgrade rejected', { status: 400 });
    },
    websocket: {
      open() {},
      message() {},
      close() {},
    },
  });
  const client = new RuntimeWsClient({
    url: `ws://127.0.0.1:${server.port}/relay`,
    runtimeId: RUNTIME_ID,
    encryptionKeyPair: deriveEncryptionKeyPair('p2p-handshake-lifecycle'),
    maxReconnectAttempts: 1,
  });

  await client.connect();
  const connectingDuringHandshake = client.isConnecting();
  const internals = client as unknown as { lifecycleGeneration: number };
  const generationDuringHandshake = internals.lifecycleGeneration;
  const duplicateConnect = client.connect();
  const generationAfterDuplicateConnect = internals.lifecycleGeneration;
  releaseHandshake();
  const duplicateConnectError = await duplicateConnect.then(
    () => null,
    error => error instanceof Error ? error : new Error(String(error)),
  );
  for (let attempt = 0; attempt < 100 && !client.isOpen(); attempt += 1) {
    await Bun.sleep(5);
  }
  const openedAfterHandshake = client.isOpen();
  await client.closeAndWait(1_000);
  server.stop(true);

  expect(connectingDuringHandshake).toBe(true);
  expect(duplicateConnectError).toBeNull();
  expect(generationAfterDuplicateConnect).toBe(generationDuringHandshake);
  expect(openedAfterHandshake).toBe(true);
});

test('websocket shutdown waits for the transport close handshake', async () => {
  const client = new RuntimeWsClient({
    url: 'ws://127.0.0.1:1/relay',
    runtimeId: RUNTIME_ID,
  });
  let closeObserved = false;
  const socket = {
    binaryType: 'arraybuffer',
    readyState: 1,
    onopen: null,
    onmessage: null,
    onclose: null as ((event: Event) => void) | null,
    onerror: null,
    send: () => {},
    close() {
      setTimeout(() => {
        socket.readyState = 3;
        closeObserved = true;
        socket.onclose?.(new Event('close'));
      }, 25);
    },
  };
  (client as unknown as { ws: typeof socket }).ws = socket;

  const startedAt = performance.now();
  await (client as unknown as { closeAndWait: () => Promise<void> }).closeAndWait();

  expect(closeObserved).toBe(true);
  expect(performance.now() - startedAt).toBeGreaterThanOrEqual(20);
});

test('websocket shutdown rejects a missing close handshake', async () => {
  const client = new RuntimeWsClient({
    url: 'ws://127.0.0.1:1/relay',
    runtimeId: RUNTIME_ID,
  });
  const socket = {
    binaryType: 'arraybuffer',
    readyState: 1,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: () => {},
    close: () => {},
  };
  (client as unknown as { ws: typeof socket }).ws = socket;

  await expect(client.closeAndWait(10)).rejects.toThrow('WS_CLOSE_TIMEOUT:10');
});

test('websocket shutdown observes a close racing listener registration', async () => {
  const client = new RuntimeWsClient({
    url: 'ws://127.0.0.1:1/relay',
    runtimeId: RUNTIME_ID,
  });
  let closeCalls = 0;
  const socket = {
    binaryType: 'arraybuffer',
    readyState: 2,
    send: () => {},
    close: () => { closeCalls += 1; },
    on(event: string, _listener: (...args: unknown[]) => void) {
      if (event === 'close') socket.readyState = 3;
    },
  };
  (client as unknown as { ws: typeof socket }).ws = socket;

  await client.closeAndWait(25);

  expect(socket.readyState).toBe(3);
  expect(closeCalls).toBe(0);
});

test('connect racing terminal shutdown cannot publish a late socket', async () => {
  const client = new RuntimeWsClient({
    url: 'ws://127.0.0.1:1/relay',
    runtimeId: RUNTIME_ID,
  });
  const internals = client as unknown as { ws: { close: () => void } | null };
  const connecting = client.connect().catch(() => {});

  try {
    await client.closeAndWait(50);
    await connecting;
    expect(internals.ws).toBeNull();
  } finally {
    internals.ws?.close();
  }
});

test('failed stale-socket drain retains the handle for retry', async () => {
  const client = new RuntimeWsClient({
    url: 'ws://127.0.0.1:1/relay',
    runtimeId: RUNTIME_ID,
  });
  const socket = {
    binaryType: 'arraybuffer',
    readyState: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: () => {},
    close: () => {},
  };
  const internals = client as unknown as {
    ws: typeof socket | null;
    terminalCloseTimeoutMs: number;
  };
  internals.ws = socket;
  internals.terminalCloseTimeoutMs = 10;

  await expect(client.connect()).rejects.toThrow('WS_CLOSE_TIMEOUT:10');
  expect(internals.ws).toBe(socket);

  socket.readyState = 3;
  await client.closeAndWait(10);
  expect(internals.ws).toBeNull();
});

test('concurrent websocket shutdown callers await the same drain', async () => {
  const client = new RuntimeWsClient({
    url: 'ws://127.0.0.1:1/relay',
    runtimeId: RUNTIME_ID,
  });
  let closeObserved = false;
  const socket = {
    binaryType: 'arraybuffer',
    readyState: 1,
    onopen: null,
    onmessage: null,
    onclose: null as ((event: Event) => void) | null,
    onerror: null,
    send: () => {},
    close() {
      setTimeout(() => {
        socket.readyState = 3;
        closeObserved = true;
        socket.onclose?.(new Event('close'));
      }, 25);
    },
  };
  (client as unknown as { ws: typeof socket }).ws = socket;

  const first = client.closeAndWait();
  const second = client.closeAndWait();
  await second;

  expect(closeObserved).toBe(true);
  await first;
});

test('synchronous websocket close retains ownership for a later awaited drain', async () => {
  const client = new RuntimeWsClient({
    url: 'ws://127.0.0.1:1/relay',
    runtimeId: RUNTIME_ID,
  });
  let closeObserved = false;
  const socket = {
    binaryType: 'arraybuffer',
    readyState: 1,
    onopen: null,
    onmessage: null,
    onclose: null as ((event: Event) => void) | null,
    onerror: null,
    send: () => {},
    close() {
      socket.readyState = 2;
      setTimeout(() => {
        socket.readyState = 3;
        closeObserved = true;
        socket.onclose?.(new Event('close'));
      }, 25);
    },
  };
  const internals = client as unknown as { ws: typeof socket | null };
  internals.ws = socket;

  client.close();
  const startedAt = performance.now();
  await client.closeAndWait(1_000);

  expect(closeObserved).toBe(true);
  expect(performance.now() - startedAt).toBeGreaterThanOrEqual(20);
  expect(internals.ws).toBeNull();
});

test('synchronous websocket close keeps a missing handshake loud during awaited drain', async () => {
  const client = new RuntimeWsClient({
    url: 'ws://127.0.0.1:1/relay',
    runtimeId: RUNTIME_ID,
  });
  const socket = {
    binaryType: 'arraybuffer',
    readyState: 1,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: () => {},
    close() {
      socket.readyState = 2;
    },
  };
  const internals = client as unknown as { ws: typeof socket | null };
  internals.ws = socket;

  client.close();

  await expect(client.closeAndWait(10)).rejects.toThrow('WS_CLOSE_TIMEOUT:10');
  expect(internals.ws).toBe(socket);
});

test('p2p shutdown cancels the deferred bootstrap poll', async () => {
  const env = createEmptyEnv('p2p-shutdown-drain');
  const p2p = new RuntimeP2P({
    env,
    runtimeId: RUNTIME_ID,
    onEntityInputs: () => {},
    onGossipProfiles: () => {},
  });
  let bootstrapPolls = 0;
  const internals = p2p as unknown as {
    requestSeedGossip: () => void;
    startPolling: () => void;
    closeAndWait: () => Promise<void>;
  };
  internals.requestSeedGossip = () => {
    bootstrapPolls += 1;
  };

  internals.startPolling();
  await internals.closeAndWait();
  await Bun.sleep(150);

  expect(bootstrapPolls).toBe(0);
});

test('p2p shutdown aborts an in-flight retry delay', async () => {
  const env = createEmptyEnv('p2p-shutdown-retry-delay');
  const p2p = new RuntimeP2P({
    env,
    runtimeId: RUNTIME_ID,
    onEntityInputs: () => {},
    onGossipProfiles: () => {},
  });
  const internals = p2p as unknown as {
    waitForActiveDelay: (delayMs: number) => Promise<boolean>;
  };
  const startedAt = performance.now();
  const waiting = internals.waitForActiveDelay(1_000);

  await p2p.closeAndWait();

  expect(await waiting).toBe(false);
  expect(performance.now() - startedAt).toBeLessThan(100);
});

test('p2p shutdown drains every client before reporting aggregate failure', async () => {
  const env = createEmptyEnv('p2p-shutdown-all-settled');
  const p2p = new RuntimeP2P({
    env,
    runtimeId: RUNTIME_ID,
    onEntityInputs: () => {},
    onGossipProfiles: () => {},
  });
  let slowDone = false;
  const failedClient = {
    closeAndWait: async () => {
      throw new Error('relay-close-failed');
    },
  };
  const slowClient = {
    closeAndWait: async () => {
      await Bun.sleep(40);
      slowDone = true;
    },
  };
  const internals = p2p as unknown as {
    clients: Array<typeof failedClient | typeof slowClient>;
    closeAndWait: () => Promise<void>;
  };
  internals.clients = [failedClient, slowClient];

  const startedAt = performance.now();
  const error = await internals.closeAndWait().then(() => null, (caught: Error) => caught);

  expect(error?.message).toContain('relay-close-failed');
  expect(slowDone).toBe(true);
  expect(performance.now() - startedAt).toBeGreaterThanOrEqual(35);
  expect(internals.clients).toEqual([failedClient]);
});

test('closing p2p rejects late direct-client creation', () => {
  const env = createEmptyEnv('p2p-shutdown-late-direct');
  const p2p = new RuntimeP2P({
    env,
    runtimeId: RUNTIME_ID,
    onEntityInputs: () => {},
    onGossipProfiles: () => {},
  });
  const internals = p2p as unknown as {
    closing: boolean;
    directClients: Map<string, unknown>;
    getDirectPeerEndpoint: () => string;
    ensureDirectClientForRuntime: (runtimeId: string) => void;
  };
  internals.closing = true;
  internals.getDirectPeerEndpoint = () => 'ws://127.0.0.1:1/relay';

  try {
    internals.ensureDirectClientForRuntime(`0x${'22'.repeat(20)}`);
    expect(internals.directClients.size).toBe(0);
  } finally {
    p2p.close();
  }
});

test('runtime lifecycle clears attachment only through drained shutdown', async () => {
  let drained = false;
  const env = {
    runtimeState: {
      p2p: {
        closeAndWait: async () => {
          await Bun.sleep(5);
          drained = true;
        },
      },
      lastP2PConfig: { runtimeId: RUNTIME_ID },
    },
  } as unknown as Env;

  await stopRuntimeP2PAndWait(env, {
    ensureRuntimeState: (target) => target.runtimeState!,
    notifyEnvChange: () => {},
    handleInboundP2PEntityInput: () => ({ kind: 'accepted' }),
    handleInboundReliableReceipt: () => {},
    enqueueRuntimeInputs: () => {},
  });

  expect(drained).toBe(true);
  expect(env.runtimeState?.p2p).toBeNull();
  expect(env.runtimeState?.lastP2PConfig).toBeNull();
});

test('synchronous stop retains transport ownership for a later awaited drain', async () => {
  let closeStarted = false;
  let drained = false;
  const p2p = {
    close: () => { closeStarted = true; },
    closeAndWait: async () => { drained = true; },
  };
  const env = {
    runtimeState: {
      p2p,
      lastP2PConfig: { runtimeId: RUNTIME_ID },
    },
  } as unknown as Env;
  const deps = {
    ensureRuntimeState: (target: Env) => target.runtimeState!,
    notifyEnvChange: () => {},
    handleInboundP2PEntityInput: () => ({ kind: 'accepted' as const }),
    handleInboundReliableReceipt: () => {},
    enqueueRuntimeInputs: () => {},
  };

  stopRuntimeP2P(env, deps);
  expect(closeStarted).toBe(true);
  expect(env.runtimeState?.p2p).toBe(p2p);

  await stopRuntimeP2PAndWait(env, deps);
  expect(drained).toBe(true);
  expect(env.runtimeState?.p2p).toBeNull();
});

test('synchronous runtime stop preserves actual P2P clients until awaited drain', async () => {
  const env = createEmptyEnv('p2p-sync-then-awaited-drain');
  const p2p = new RuntimeP2P({
    env,
    runtimeId: RUNTIME_ID,
    onEntityInputs: () => {},
    onGossipProfiles: () => {},
  });
  let closeStarted = false;
  let drained = false;
  const client = {
    close: () => { closeStarted = true; },
    closeAndWait: async () => {
      await Bun.sleep(25);
      drained = true;
    },
  };
  const internals = p2p as unknown as { clients: Array<typeof client> };
  internals.clients = [client];
  env.runtimeState = {
    ...env.runtimeState,
    p2p,
    lastP2PConfig: { runtimeId: RUNTIME_ID },
  };
  const deps = {
    ensureRuntimeState: (target: Env) => target.runtimeState!,
    notifyEnvChange: () => {},
    handleInboundP2PEntityInput: () => ({ kind: 'accepted' as const }),
    handleInboundReliableReceipt: () => {},
    enqueueRuntimeInputs: () => {},
  };

  stopRuntimeP2P(env, deps);
  expect(closeStarted).toBe(true);
  expect(internals.clients).toEqual([client]);

  const startedAt = performance.now();
  await stopRuntimeP2PAndWait(env, deps);

  expect(drained).toBe(true);
  expect(performance.now() - startedAt).toBeGreaterThanOrEqual(20);
  expect(internals.clients).toEqual([]);
  expect(env.runtimeState?.p2p).toBeNull();
});

test('runtime lifecycle retains the quiesced handle when drain fails', async () => {
  const p2p = {
    closeAndWait: async () => {
      throw new Error('drain-failed');
    },
  };
  const env = {
    runtimeState: {
      p2p,
      lastP2PConfig: { runtimeId: RUNTIME_ID },
    },
  } as unknown as Env;

  await expect(stopRuntimeP2PAndWait(env, {
    ensureRuntimeState: (target) => target.runtimeState!,
    notifyEnvChange: () => {},
    handleInboundP2PEntityInput: () => ({ kind: 'accepted' }),
    handleInboundReliableReceipt: () => {},
    enqueueRuntimeInputs: () => {},
  })).rejects.toThrow('drain-failed');

  expect(env.runtimeState?.p2p).toBe(p2p);
  expect(env.runtimeState?.lastP2PConfig).toEqual({ runtimeId: RUNTIME_ID });
});
