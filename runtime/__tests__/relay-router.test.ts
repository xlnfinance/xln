import { describe, expect, test } from 'bun:test';
import type { Profile } from '../networking/gossip';
import { relayRoute } from '../relay-router';
import { cacheEncryptionKey, createRelayStore, enqueueMessage, resolveEncryptionPublicKeyHex } from '../relay-store';
import { hashHelloMessage, makeHelloNonce } from '../networking/ws-protocol';
import { deriveSignerAddressSync, signDigest } from '../account-crypto';
import { encryptJSON, deriveEncryptionKeyPair } from '../networking/p2p-crypto';
import { createLocalDeliveryHandler } from '../relay-local-delivery';
import { createEmptyEnv } from '../runtime';

const SERVER_RUNTIME_ID = '0x9999999999999999999999999999999999999999';
const SEED_A = 'relay-router-test-seed-a';
const SEED_B = 'relay-router-test-seed-b';
const RUNTIME_A = deriveSignerAddressSync(SEED_A, '1');
const RUNTIME_B = deriveSignerAddressSync(SEED_B, '2');
const KEY_A = '0x' + '11'.repeat(32);
const KEY_B = '0x' + '22'.repeat(32);
const ENTITY_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ENTITY_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ENTITY_C = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

type FakeWs = { label: string; readyState?: number };

const helloAuth = (runtimeId: string, seed: string, signerId = '1') => {
  const timestamp = Date.now();
  const nonce = makeHelloNonce();
  const signature = signDigest(seed, signerId, hashHelloMessage(runtimeId, timestamp, nonce));
  return { nonce, signature, timestamp };
};

const signedHello = (runtimeId: string, seed: string, key: string, signerId = '1') => ({
  type: 'hello',
  from: runtimeId,
  fromEncryptionPubKey: key,
  auth: helloAuth(runtimeId, seed, signerId),
});

const buildProfile = (
  entityId: string,
  runtimeId: string,
  runtimeEncPubKey: string,
  overrides: Partial<Profile> = {},
): Profile => ({
  entityId,
  runtimeId,
  name: entityId === ENTITY_A ? 'alice' : entityId === ENTITY_B ? 'hub-b' : 'leaf-c',
  avatar: '',
  bio: '',
  website: '',
  lastUpdated: 1,
  runtimeEncPubKey,
  publicAccounts: [],
  wsUrl: null,
  relays: [],
  metadata: {
    entityEncPubKey: runtimeEncPubKey,
    isHub: false,
    routingFeePPM: 100,
    baseFee: 0n,
    board: {
      threshold: 1,
      validators: [{
        signer: runtimeId,
        signerId: runtimeId,
        weight: 1,
        publicKey: `board:${entityId.slice(2, 10)}`,
      }],
    },
  },
  accounts: [],
  ...overrides,
});

describe('relay-router gossip fanout', () => {
  test('broadcasts fresh gossip updates to other connected clients', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      verifyProfile: async () => ({ valid: true }),
      send: (ws: FakeWs, raw: string) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(JSON.parse(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs = { label: 'A' };
    const wsB: FakeWs = { label: 'B' };

    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, wsB, signedHello(RUNTIME_B, SEED_B, KEY_B, '2'));

    await relayRoute(config, wsA, {
      type: 'gossip_announce',
      id: 'announce-1',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: SERVER_RUNTIME_ID,
      payload: {
        profiles: [
          buildProfile(ENTITY_A, RUNTIME_A, KEY_A, { lastUpdated: 123, name: 'alice' }),
        ],
      },
    });

    const clientBMessages = sentBySocket.get(wsB) ?? [];
    const gossipUpdate = clientBMessages.find((message) => {
      return !!message && typeof message === 'object' && 'type' in (message as Record<string, unknown>) &&
        (message as { type?: string }).type === 'gossip_update';
    }) as { payload?: { profiles?: Array<{ entityId?: string }> } } | undefined;

    expect(gossipUpdate).toBeDefined();
    expect(gossipUpdate?.payload?.profiles?.[0]?.entityId).toBe(ENTITY_A);
    expect(sentBySocket.get(wsA)?.some((message) => (message as { type?: string }).type === 'gossip_update') ?? false).toBeFalse();
    expect(store.gossipProfiles.get(ENTITY_A)?.profile?.name).toBe('alice');
  });

  test('serves batched gossip by ids and set filters', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      verifyProfile: async () => ({ valid: true }),
      send: (ws: FakeWs, raw: string) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(JSON.parse(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs = { label: 'A' };

    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));

    await relayRoute(config, wsA, {
      type: 'gossip_announce',
      id: 'announce-a',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: SERVER_RUNTIME_ID,
      payload: {
        profiles: [
          buildProfile(ENTITY_A, RUNTIME_A, KEY_A, { lastUpdated: 100, name: 'leaf-a' }),
          buildProfile(ENTITY_B, RUNTIME_B, KEY_B, {
            lastUpdated: 200,
            name: 'hub-b',
            metadata: {
              entityEncPubKey: KEY_B,
              isHub: true,
              routingFeePPM: 100,
              baseFee: 0n,
              board: {
                threshold: 1,
                validators: [{
                  signer: RUNTIME_B,
                  signerId: RUNTIME_B,
                  weight: 1,
                  publicKey: `board:${ENTITY_B.slice(2, 10)}`,
                }],
              },
            },
          }),
          buildProfile(ENTITY_C, RUNTIME_B, KEY_B, { lastUpdated: 300, name: 'leaf-c' }),
        ],
      },
    });

    await relayRoute(config, wsA, {
      type: 'gossip_request',
      id: 'request-1',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: SERVER_RUNTIME_ID,
      payload: {
        ids: [ENTITY_A],
        set: 'hubs',
        updatedSince: 150,
      },
    });

    const responses = (sentBySocket.get(wsA) ?? []).filter(
      (message) => (message as { type?: string }).type === 'gossip_response',
    ) as Array<{ payload?: { profiles?: Array<{ entityId?: string }> } }>;
    const lastResponse = responses.at(-1);

    expect(lastResponse).toBeDefined();
    expect(lastResponse?.payload?.profiles?.map((profile) => profile.entityId)).toEqual([ENTITY_B, ENTITY_A]);
  });

  test('rebinds an already-identified socket if the client registry entry is lost', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: string) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(JSON.parse(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs = { label: 'A' };

    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));
    expect(store.clients.get(RUNTIME_A)?.ws).toBe(wsA);

    store.clients.clear();
    enqueueMessage(store, RUNTIME_A, {
      type: 'entity_input',
      id: 'pending-ack',
      from: RUNTIME_B,
      to: RUNTIME_A,
      payload: 'encrypted-payload',
      encrypted: true,
    });
    expect(store.clients.size).toBe(0);

    await relayRoute(config, wsA, {
      type: 'gossip_request',
      id: 'request-rebind',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: SERVER_RUNTIME_ID,
      payload: {
        ids: [],
      },
    });

    expect(store.clients.get(RUNTIME_A)?.ws).toBe(wsA);
    const messages = sentBySocket.get(wsA) ?? [];
    const pending = messages.filter(
      (message) => (message as { id?: string }).id === 'pending-ack',
    );
    const responses = messages.filter(
      (message) => (message as { type?: string }).type === 'gossip_response',
    );
    expect(pending).toHaveLength(1);
    expect(responses.length).toBeGreaterThan(0);
    expect(store.pendingMessages.has(RUNTIME_A)).toBe(false);
  });

  test('retains pending messages when reconnect flush send fails', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    let failPendingOnce = true;
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: string) => {
        const message = JSON.parse(raw);
        if ((message as { id?: string }).id === 'pending-ack' && failPendingOnce) {
          failPendingOnce = false;
          return false;
        }
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(message);
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs = { label: 'A' };

    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));
    enqueueMessage(store, RUNTIME_A, {
      type: 'entity_input',
      id: 'pending-ack',
      from: RUNTIME_B,
      to: RUNTIME_A,
      payload: 'encrypted-payload',
      encrypted: true,
    });
    store.clients.clear();

    await relayRoute(config, wsA, {
      type: 'gossip_request',
      id: 'request-failed-flush',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: SERVER_RUNTIME_ID,
      payload: { ids: [] },
    });

    expect(store.clients.get(RUNTIME_A)?.ws).toBe(wsA);
    expect(store.pendingMessages.get(RUNTIME_A)).toHaveLength(1);
    expect(store.debugEvents.find(event => event.status === 'send-failed')?.delivery).toMatchObject({
      outcome: 'failed',
      code: 'RELAY_PENDING_SEND_FAILED',
      retryable: true,
      fatal: false,
      terminal: false,
    });
    store.clients.clear();

    await relayRoute(config, wsA, {
      type: 'gossip_request',
      id: 'request-successful-flush',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: SERVER_RUNTIME_ID,
      payload: { ids: [] },
    });

    const deliveredPending = (sentBySocket.get(wsA) ?? []).filter(
      (message) => (message as { id?: string }).id === 'pending-ack',
    );
    expect(deliveredPending).toHaveLength(1);
    expect(store.pendingMessages.has(RUNTIME_A)).toBe(false);
  });

  test('rejects duplicate hello without closing the existing runtime socket', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    let closeCount = 0;
    let duplicateClose: { code?: number; reason?: string } | null = null;
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: string) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(JSON.parse(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs & { close: () => void } = { label: 'A', close: () => { closeCount += 1; } };
    const attacker: FakeWs & { close: (code?: number, reason?: string) => void } = {
      label: 'attacker',
      close: (code?: number, reason?: string) => {
        duplicateClose = { code, reason };
      },
    };

    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, attacker, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, attacker, {
      type: 'gossip_announce',
      id: 'duplicate-followup',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: SERVER_RUNTIME_ID,
      payload: { profiles: [] },
    });

    expect(store.clients.get(RUNTIME_A)?.ws).toBe(wsA);
    expect(closeCount).toBe(0);
    expect(duplicateClose).toEqual({ code: 4009, reason: 'duplicate-runtime' });
    expect(sentBySocket.get(attacker) ?? []).toEqual([]);
  });

  test('allows signed reconnect after the previous runtime socket is closed', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: string) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(JSON.parse(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const stale: FakeWs = { label: 'stale', readyState: 1 };
    const fresh: FakeWs = { label: 'fresh', readyState: 1 };

    await relayRoute(config, stale, signedHello(RUNTIME_A, SEED_A, KEY_A));
    expect(store.clients.get(RUNTIME_A)?.ws).toBe(stale);

    stale.readyState = 3;
    await relayRoute(config, fresh, signedHello(RUNTIME_A, SEED_A, KEY_A));

    expect(store.clients.get(RUNTIME_A)?.ws).toBe(fresh);
    expect((sentBySocket.get(fresh)?.at(-1) as { type?: string; error?: string } | undefined)?.type).not.toBe('error');
  });

  test('rejects entity_input when the registered target socket is stale', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: string) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(JSON.parse(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs = { label: 'A', readyState: 1 };
    const staleB: FakeWs = { label: 'stale-B', readyState: 1 };

    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, staleB, signedHello(RUNTIME_B, SEED_B, KEY_B, '2'));
    staleB.readyState = 3;

    await relayRoute(config, wsA, {
      type: 'entity_input',
      id: 'deliver-to-stale',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: RUNTIME_B,
      payload: 'encrypted-payload',
      encrypted: true,
      entityId: ENTITY_B,
      txs: 1,
    });

    expect(sentBySocket.get(staleB) ?? []).toHaveLength(0);
    expect(store.clients.has(RUNTIME_B)).toBe(false);
    expect(store.pendingMessages.get(RUNTIME_B)).toBeUndefined();
    expect((sentBySocket.get(wsA)?.at(-1) as { type?: string; error?: string } | undefined)).toMatchObject({
      type: 'error',
      error: 'ENTITY_INPUT_TARGET_NOT_CONNECTED',
    });
    expect(store.debugEvents.some(event => event.status === 'stale-target')).toBe(true);
    expect(store.debugEvents.some(event =>
      event.status === 'rejected' &&
      event.reason === 'ENTITY_INPUT_TARGET_NOT_CONNECTED',
    )).toBe(true);
  });

  test('reports typed send failure when forwarding to active target socket returns false', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: string) => {
        const message = JSON.parse(raw);
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(message);
        sentBySocket.set(ws, bucket);
        if (ws.label === 'B' && (message as { id?: string }).id === 'deliver-send-false') {
          return false;
        }
      },
    };
    const wsA: FakeWs = { label: 'A', readyState: 1 };
    const wsB: FakeWs = { label: 'B', readyState: 1 };

    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, wsB, signedHello(RUNTIME_B, SEED_B, KEY_B, '2'));
    await relayRoute(config, wsA, {
      type: 'entity_input',
      id: 'deliver-send-false',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: RUNTIME_B,
      payload: 'encrypted-account-input',
      encrypted: true,
      entityId: ENTITY_B,
      txs: 1,
    });

    expect(store.clients.has(RUNTIME_B)).toBe(false);
    expect(sentBySocket.get(wsA)?.at(-1)).toMatchObject({
      type: 'error',
      error: 'ENTITY_INPUT_TARGET_NOT_CONNECTED',
      inReplyTo: 'deliver-send-false',
      to: RUNTIME_B,
    });
    expect(store.debugEvents.find(event =>
      event.event === 'delivery' &&
      event.status === 'send-failed' &&
      event.to === RUNTIME_B
    )).toMatchObject({
      reason: 'RELAY_SEND_FALSE',
      delivery: {
        outcome: 'failed',
        code: 'RELAY_SEND_FALSE',
        retryable: true,
        fatal: false,
        terminal: false,
        failure: {
          category: 'TransientRace',
          code: 'RELAY_SEND_FALSE',
        },
      },
      details: {
        traceId: 'deliver-send-false',
        entityId: ENTITY_B,
        txs: 1,
      },
    });
  });

  test('forwards encrypted accountInput to the active target runtime socket', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: string) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(JSON.parse(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs = { label: 'A', readyState: 1 };
    const wsB: FakeWs = { label: 'B', readyState: 1 };

    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, wsB, signedHello(RUNTIME_B, SEED_B, KEY_B, '2'));
    await relayRoute(config, wsA, {
      type: 'entity_input',
      id: 'deliver-account-input',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: RUNTIME_B,
      payload: 'encrypted-account-input',
      encrypted: true,
      entityId: ENTITY_B,
      txs: 1,
    });

    expect(sentBySocket.get(wsB)?.at(-1)).toMatchObject({
      type: 'entity_input',
      id: 'deliver-account-input',
      from: RUNTIME_A,
      to: RUNTIME_B,
      encrypted: true,
      entityId: ENTITY_B,
      txs: 1,
    });
    expect(store.pendingMessages.get(RUNTIME_B)).toBeUndefined();
    expect(store.debugEvents.some(event =>
      event.event === 'delivery' &&
      event.status === 'delivered' &&
      event.delivery?.outcome === 'delivered' &&
      event.delivery?.code === 'DELIVERY_ACCEPTED' &&
      event.to === RUNTIME_B &&
      (event.details as { entityId?: string; txs?: number } | undefined)?.entityId === ENTITY_B &&
      (event.details as { entityId?: string; txs?: number } | undefined)?.txs === 1,
    )).toBe(true);
  });

  test('routes live recovery bundle request and response without queueing', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: string) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(JSON.parse(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const requester: FakeWs = { label: 'requester', readyState: 1 };
    const responder: FakeWs = { label: 'responder', readyState: 1 };

    await relayRoute(config, requester, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, responder, signedHello(RUNTIME_B, SEED_B, KEY_B, '2'));
    await relayRoute(config, requester, {
      type: 'recovery_bundle_request',
      id: 'psr-request-1',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: RUNTIME_B,
      payload: { lookupKey: 'lookup/key' },
    });
    await relayRoute(config, responder, {
      type: 'recovery_bundle_response',
      id: 'psr-response-1',
      inReplyTo: 'psr-request-1',
      from: RUNTIME_B,
      fromEncryptionPubKey: KEY_B,
      to: RUNTIME_A,
      payload: { ok: true, lookupKey: 'lookup/key', bundles: [] },
    });

    expect(sentBySocket.get(responder)?.at(-1)).toMatchObject({
      type: 'recovery_bundle_request',
      id: 'psr-request-1',
      from: RUNTIME_A,
      to: RUNTIME_B,
      payload: { lookupKey: 'lookup/key' },
    });
    expect(sentBySocket.get(requester)?.at(-1)).toMatchObject({
      type: 'recovery_bundle_response',
      id: 'psr-response-1',
      inReplyTo: 'psr-request-1',
      from: RUNTIME_B,
      to: RUNTIME_A,
      payload: { ok: true, lookupKey: 'lookup/key', bundles: [] },
    });
    expect(store.pendingMessages.get(RUNTIME_A)).toBeUndefined();
    expect(store.pendingMessages.get(RUNTIME_B)).toBeUndefined();
  });

  test('rejects recovery bundle requests when the target runtime is offline', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: string) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(JSON.parse(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const requester: FakeWs = { label: 'requester', readyState: 1 };

    await relayRoute(config, requester, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, requester, {
      type: 'recovery_bundle_request',
      id: 'psr-request-offline',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: RUNTIME_B,
      payload: { lookupKey: 'lookup/key' },
    });

    expect(sentBySocket.get(requester)?.at(-1)).toMatchObject({
      type: 'error',
      error: 'RECOVERY_TARGET_NOT_CONNECTED',
      inReplyTo: 'psr-request-offline',
      to: RUNTIME_B,
    });
    expect(store.pendingMessages.get(RUNTIME_B)).toBeUndefined();
    expect(store.debugEvents.some(event =>
      event.msgType === 'recovery_bundle_request' &&
      event.status === 'rejected' &&
      event.reason === 'RECOVERY_TARGET_NOT_CONNECTED',
    )).toBe(true);
    expect(store.debugEvents.find(event =>
      event.msgType === 'recovery_bundle_request' &&
      event.reason === 'RECOVERY_TARGET_NOT_CONNECTED',
    )?.delivery).toMatchObject({
      outcome: 'failed',
      code: 'RECOVERY_TARGET_NOT_CONNECTED',
      retryable: true,
      fatal: false,
      failure: {
        category: 'TransientRace',
      },
    });
  });

  test('rejects unencrypted entity_input at relay ingress', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: string) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(JSON.parse(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs = { label: 'A', readyState: 1 };

    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, wsA, {
      type: 'entity_input',
      id: 'plaintext-entity-input',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: RUNTIME_B,
      payload: { entityId: ENTITY_B, entityTxs: [] },
      encrypted: false,
      entityId: ENTITY_B,
      txs: 0,
    });

    expect(sentBySocket.get(wsA)?.at(-1)).toMatchObject({
      type: 'error',
      error: 'entity_input must be encrypted',
    });
    expect(store.pendingMessages.get(RUNTIME_B)).toBeUndefined();
    expect(store.debugEvents.some(event => event.reason === 'ENTITY_INPUT_MUST_BE_ENCRYPTED')).toBe(true);
    expect(store.debugEvents.find(event => event.reason === 'ENTITY_INPUT_MUST_BE_ENCRYPTED')?.delivery).toMatchObject({
      outcome: 'failed',
      code: 'ENTITY_INPUT_MUST_BE_ENCRYPTED',
      retryable: false,
      fatal: true,
      terminal: true,
      failure: {
        category: 'Contradiction',
        code: 'ENTITY_INPUT_MUST_BE_ENCRYPTED',
      },
    });
  });

  test('local entity_input delivery failures expose typed delivery metadata', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {
        throw new Error('NO_LOCAL_REPLICA: entityId=0xabc');
      },
      send: (ws: FakeWs, raw: string) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(JSON.parse(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs = { label: 'A', readyState: 1 };

    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, wsA, {
      type: 'entity_input',
      id: 'local-delivery-fail',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: SERVER_RUNTIME_ID,
      payload: 'encrypted-payload',
      encrypted: true,
      entityId: ENTITY_C,
      txs: 1,
    });

    expect(sentBySocket.get(wsA)?.at(-1)).toMatchObject({
      type: 'error',
      error: 'NO_LOCAL_REPLICA: entityId=0xabc',
    });
    expect(store.pendingMessages.get(SERVER_RUNTIME_ID)).toBeUndefined();
    expect(store.debugEvents.find(event => event.status === 'local-delivery-failed')?.delivery).toMatchObject({
      outcome: 'failed',
      code: 'NO_LOCAL_REPLICA',
      retryable: false,
      fatal: true,
      terminal: true,
      failure: {
        category: 'Contradiction',
        code: 'NO_LOCAL_REPLICA',
      },
    });
  });

  test('runtime_input is not a relay protocol message', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: string) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(JSON.parse(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs = { label: 'A', readyState: 1 };

    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, wsA, {
      type: 'runtime_input',
      id: 'plaintext-runtime-input',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: RUNTIME_B,
      payload: { runtimeTxs: [], entityInputs: [] },
    });

    expect(sentBySocket.get(wsA)?.at(-1)).toMatchObject({
      type: 'error',
      error: 'Unknown message type: runtime_input',
    });
    expect(store.pendingMessages.get(RUNTIME_B)).toBeUndefined();
    expect(store.debugEvents.some(event => event.reason === 'Unknown message type: runtime_input')).toBe(true);
  });

  test('local delivery rejects unknown local entity instead of queueing forever', async () => {
    const env = createEmptyEnv('relay-local-unknown-entity');
    const store = createRelayStore(env.runtimeId);
    const handler = createLocalDeliveryHandler(env, store, () => null);
    const unknownEntityInput = {
      entityId: ENTITY_C,
      runtimeId: env.runtimeId,
      signerId: env.runtimeId,
      entityTxs: [],
    };

    await expect(handler(RUNTIME_A, {
      to: env.runtimeId,
      encrypted: true,
      payload: encryptJSON(unknownEntityInput, deriveEncryptionKeyPair(env.runtimeSeed).publicKey),
    })).rejects.toThrow('NO_LOCAL_REPLICA');

    expect(store.pendingMessages.get(env.runtimeId)).toBeUndefined();
    expect(store.debugEvents.some(event => {
      return event.status === 'rejected-no-local-replica' && event.reason === 'NO_LOCAL_REPLICA';
    })).toBe(true);
  });

  test('rejects unsigned hello by default', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: string) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(JSON.parse(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs = { label: 'A' };

    await relayRoute(config, wsA, { type: 'hello', from: RUNTIME_A, fromEncryptionPubKey: KEY_A });

    expect(store.clients.has(RUNTIME_A)).toBe(false);
    expect(sentBySocket.get(wsA)?.at(-1)).toMatchObject({ type: 'error', error: 'Missing auth fields' });
  });

  test('drops unsigned gossip profiles when no verifier override is installed', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: string) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(JSON.parse(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs = { label: 'A' };

    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, wsA, {
      type: 'gossip_announce',
      id: 'announce-unsigned',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: SERVER_RUNTIME_ID,
      payload: { profiles: [buildProfile(ENTITY_A, RUNTIME_A, KEY_A)] },
    });

    expect(store.gossipProfiles.size).toBe(0);
    expect(store.debugEvents.some(event => event.reason === 'GOSSIP_PROFILE_SIGNATURE_INVALID')).toBe(true);
  });

  test('prefers verified relay socket encryption key over gossip profile cache', () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const profile = buildProfile(ENTITY_A, RUNTIME_A, KEY_A, { lastUpdated: 123 });

    expect(cacheEncryptionKey(store, RUNTIME_A, KEY_B)).toBeUndefined();
    store.gossipProfiles.set(ENTITY_A, { profile, timestamp: profile.lastUpdated });

    expect(resolveEncryptionPublicKeyHex(store, RUNTIME_A)).toBe(KEY_B);
  });
});
