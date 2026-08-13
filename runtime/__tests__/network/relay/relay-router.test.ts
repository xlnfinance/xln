import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Profile } from '../../../entity/profile';
import { relayRoute as productionRelayRoute } from '../../../network/relay/router';
import { cacheEncryptionKey, createRelayStore, resolveEncryptionPublicKeyHex } from '../../../network/relay/store';
import { deserializeWsMessage, hashHelloMessage, hashRuntimeWsFrame, type RuntimeWsMessage } from '../../../network/p2p/ws-protocol';
import { deriveSignerAddressSync, signDigest } from '../../../account/crypto';
import { encryptJSON, deriveEncryptionKeyPair } from '../../../protocol/crypto/p2p-crypto';
import { DEFAULT_GOSSIP_BATCH_LIMIT } from '../../../network/p2p/gossip/profile-batch';
import { createLocalDeliveryHandler } from '../../../network/relay/local-delivery';
import { createEmptyEnv } from '../../../runtime';
import { signRuntimeEntityInputsEnvelope } from '../../../runtime/entity-input/entity-input-envelope-auth.ts';
import {
  buildCryptographicProfileFixture,
  certifySingleSignerProfileFixture,
  deriveSingleSignerFixtureEntityId,
} from '../../helpers/cryptographic-profile';

const SERVER_RUNTIME_ID = '0x9999999999999999999999999999999999999999';
const SEED_A = 'relay-router-test-seed-a';
const SEED_B = 'relay-router-test-seed-b';
const SEED_C = 'relay-router-test-seed-c';
const RUNTIME_A = deriveSignerAddressSync(SEED_A, '1');
const RUNTIME_B = deriveSignerAddressSync(SEED_B, '2');
const KEY_A = '0x' + '11'.repeat(32);
const KEY_B = '0x' + '22'.repeat(32);
const ENTITY_A = deriveSingleSignerFixtureEntityId(SEED_A, '1');
const ENTITY_B = deriveSingleSignerFixtureEntityId(SEED_B, '2');
const ENTITY_C = deriveSingleSignerFixtureEntityId(SEED_C, '3');
let helloNonceCounter = 0;
const makeHelloNonce = (): string => `nonce_${helloNonceCounter++}`;

type FakeWs = { label: string; readyState?: number; close?: (code?: number, reason?: string) => void };

const helloAuth = (runtimeId: string, seed: string, key: string, signerId = '1') => {
  const timestamp = Date.now();
  const nonce = makeHelloNonce();
  const signature = signDigest(seed, signerId, hashHelloMessage(runtimeId, key, timestamp, nonce));
  return { nonce, signature, timestamp };
};

const signedHello = (runtimeId: string, seed: string, key: string, signerId = '1') => ({
  type: 'hello',
  from: runtimeId,
  fromEncryptionPubKey: key,
  auth: helloAuth(runtimeId, seed, key, signerId),
});

const TEST_RELAY_AUDIENCE = 'wss://relay.test/relay';
const relayIdentity = new Map([
  [RUNTIME_A.toLowerCase(), { seed: SEED_A, signerId: '1' }],
  [RUNTIME_B.toLowerCase(), { seed: SEED_B, signerId: '2' }],
]);
type TestAuthState = {
  pending: Map<object, { challenge: string; audience: string }>;
  sessions: Map<object, { challenge: string; audience: string }>;
};
const relayAuthStates = new Map<object, TestAuthState>();
let relayAuthCounter = 0;
let relayAuthClock = 0;
afterEach(() => relayAuthStates.clear());
const relayRoute = async (
  config: Parameters<typeof productionRelayRoute>[0],
  ws: Parameters<typeof productionRelayRoute>[1],
  rawMessage: Parameters<typeof productionRelayRoute>[2],
): Promise<boolean> => {
  const configKey = config as object;
  const state = relayAuthStates.get(configKey) ?? {
    pending: new Map(),
    sessions: new Map(),
  };
  relayAuthStates.set(configKey, state);
  const consumeHelloChallenge = (socket: object, claim: unknown) => {
    const binding = state.pending.get(socket);
    state.pending.delete(socket);
    const received = claim as { challenge?: unknown; audience?: unknown } | null;
    return binding && received?.challenge === binding.challenge && received.audience === binding.audience
      ? binding
      : null;
  };
  let message = rawMessage;
  const identity = message.from ? relayIdentity.get(message.from.toLowerCase()) : undefined;
  if (message.type === 'hello' && identity) {
    relayAuthCounter += 1;
    const binding = { challenge: `relay-test-${relayAuthCounter}`, audience: TEST_RELAY_AUDIENCE };
    const timestamp = relayAuthClock = Math.max(Date.now(), relayAuthClock + 1);
    state.pending.set(ws as object, binding);
    state.sessions.set(ws as object, binding);
    message = {
      ...message,
      timestamp,
      audience: binding.audience,
      auth: {
        nonce: binding.challenge,
        timestamp,
        signature: signDigest(
          identity.seed,
          identity.signerId,
          hashHelloMessage(
            message.from!,
            message.fromEncryptionPubKey!,
            timestamp,
            binding.challenge,
            binding.audience,
          ),
        ),
      },
    };
  } else if (identity) {
    const binding = state.sessions.get(ws as object);
    if (binding) {
      const timestamp = relayAuthClock = Math.max(Date.now(), relayAuthClock + 1);
      message = {
        ...message,
        auth: {
          nonce: binding.challenge,
          timestamp,
          signature: signDigest(
            identity.seed,
            identity.signerId,
            hashRuntimeWsFrame(message, binding.audience, binding.challenge, timestamp),
          ),
        },
      };
    }
  }
  return productionRelayRoute({ ...config, consumeHelloChallenge }, ws, message);
};

const buildProfile = (
  entityId: string,
  runtimeId: string,
  runtimeEncPubKey: string,
  overrides: Readonly<{
    lastUpdated?: number;
    name?: string;
    isHub?: boolean;
    certified?: boolean;
  }> = {},
): Profile => {
  const signer = entityId === ENTITY_A
    ? { seed: SEED_A, signerId: '1' }
    : entityId === ENTITY_B
      ? { seed: SEED_B, signerId: '2' }
      : { seed: SEED_C, signerId: '3' };
  const profile = buildCryptographicProfileFixture({
    entityId,
    signingSeed: signer.seed,
    signerId: signer.signerId,
    runtimeId,
    runtimeEncPubKey,
    name: overrides.name ?? (entityId === ENTITY_A ? 'alice' : entityId === ENTITY_B ? 'hub-b' : 'leaf-c'),
    lastUpdated: overrides.lastUpdated,
    isHub: overrides.isHub,
  });
  return overrides.certified === false
    ? profile
    : certifySingleSignerProfileFixture(profile, signer.seed, signer.signerId);
};

describe('relay-router gossip fanout', () => {
  test('rejects oversized gossip before signature verification and closes the session', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sent: RuntimeWsMessage[] = [];
    let verifies = 0;
    let closed: { code?: number; reason?: string } | null = null;
    const ws: FakeWs = {
      label: 'oversize-gossip',
      close: (code, reason) => { closed = { code, reason }; },
    };
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      verifyProfile: async () => {
        verifies += 1;
        return { valid: false };
      },
      send: (_ws: FakeWs, raw: Uint8Array) => sent.push(deserializeWsMessage(raw)),
    };
    await relayRoute(config, ws, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, ws, {
      type: 'gossip_announce',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      payload: { profiles: Array.from({ length: DEFAULT_GOSSIP_BATCH_LIMIT + 1 }, () => ({})) },
    });

    expect(verifies).toBe(0);
    expect(sent.at(-1)).toEqual({ type: 'error', error: 'GOSSIP_ANNOUNCE_RATE_LIMITED' });
    expect(closed).toEqual({ code: 4003, reason: 'relay-gossip-rate-limited' });
    expect(store.clients.has(RUNTIME_A)).toBeFalse();
  });

  test('relay router and local delivery verbose diagnostics use structured logging', () => {
    const routerSource = readFileSync(join(process.cwd(), 'runtime/network/relay/router.ts'), 'utf8');
    const localDeliverySource = readFileSync(join(process.cwd(), 'runtime/network/relay/local-delivery.ts'), 'utf8');

    expect(routerSource).toContain("const relayRouterLog = createStructuredLogger('relay.router');");
    expect(routerSource).toContain("relayRouterLog.debug('verbose'");
    expect(routerSource).not.toContain('console.');
    expect(routerSource).not.toContain('catch { size = 0; }');
    expect(routerSource).toContain('safeStringify(msg)');
    expect(localDeliverySource).toContain("const relayLocalDeliveryLog = createStructuredLogger('relay.local_delivery');");
    expect(localDeliverySource).toContain("relayLocalDeliveryLog.debug('verbose'");
    expect(localDeliverySource).not.toContain('console.');
  });

  test('records a nonzero message size for tagged BigInt payloads', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const ws: FakeWs = { label: 'bigint' };
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: () => {},
    };
    await relayRoute(config, ws, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, ws, {
      type: 'unsupported_bigint_probe',
      id: 'bigint-probe',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      amount: 1n,
    });

    const event = store.debugEvents.find((candidate) => candidate.event === 'message');
    expect(event?.size).toBeGreaterThan(0);
  });

  test('bounds pre-auth metadata and records authenticated debug payload size only', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const ws: FakeWs = { label: 'bounded-debug' };
    const sent: RuntimeWsMessage[] = [];
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (_ws: FakeWs, raw: Uint8Array) => sent.push(deserializeWsMessage(raw)),
    };

    await expect(productionRelayRoute(config, ws, {
      type: 'ping',
      from: 'x'.repeat(128),
    })).resolves.toBeUndefined();
    await relayRoute(config, ws, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, ws, {
      type: 'debug_event',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      payload: { message: 'p'.repeat(1024 * 1024) },
    });

    const debugEvent = store.debugEvents.find(event => event.event === 'debug_event');
    expect(debugEvent?.details).toMatchObject({
      payloadBytes: expect.any(Number),
    });
    expect(debugEvent?.details).not.toHaveProperty('payload');
    expect(store.debugEvents.every(event => event.reason !== 'DEBUG_EVENT_TOO_LARGE')).toBe(true);
  });

  test('broadcasts fresh gossip updates to other connected clients', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: Uint8Array) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(deserializeWsMessage(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs = { label: 'A' };
    const wsB: FakeWs = { label: 'B' };

    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, wsB, signedHello(RUNTIME_B, SEED_B, KEY_B, '2'));

    expect(sentBySocket.get(wsA)).toContainEqual({ type: 'hello_ack', to: RUNTIME_A.toLowerCase() });
    expect(sentBySocket.get(wsB)).toContainEqual({ type: 'hello_ack', to: RUNTIME_B.toLowerCase() });

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
      send: (ws: FakeWs, raw: Uint8Array) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(deserializeWsMessage(raw));
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
            isHub: true,
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

  test('new authenticated hello atomically replaces the previous runtime socket', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    let replacementClose: { code?: number; reason?: string } | null = null;
    let freshCloseCount = 0;
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: Uint8Array) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(deserializeWsMessage(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs & { close: (code?: number, reason?: string) => void } = {
      label: 'A',
      close: (code?: number, reason?: string) => {
        replacementClose = { code, reason };
      },
    };
    const fresh: FakeWs & { close: () => void } = {
      label: 'fresh',
      close: () => { freshCloseCount += 1; },
    };

    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, fresh, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, wsA, {
      type: 'gossip_announce',
      id: 'superseded-followup',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: SERVER_RUNTIME_ID,
      payload: { profiles: [] },
    });

    expect(store.clients.get(RUNTIME_A)?.ws).toBe(fresh);
    expect(replacementClose).toEqual({ code: 4009, reason: 'superseded-runtime' });
    expect(freshCloseCount).toBe(0);
    expect(sentBySocket.get(fresh)?.at(-1)).toEqual({ type: 'hello_ack', to: RUNTIME_A.toLowerCase() });
    expect(sentBySocket.get(wsA)).toEqual([{ type: 'hello_ack', to: RUNTIME_A.toLowerCase() }]);
  });

  test('allows signed reconnect after the previous runtime socket is closed', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: Uint8Array) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(deserializeWsMessage(raw));
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

  test('rejects entity_inputs when the registered target socket is stale', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: Uint8Array) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(deserializeWsMessage(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs = { label: 'A', readyState: 1 };
    const staleB: FakeWs = { label: 'stale-B', readyState: 1 };

    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, staleB, signedHello(RUNTIME_B, SEED_B, KEY_B, '2'));
    staleB.readyState = 3;

    await relayRoute(config, wsA, {
      type: 'entity_inputs',
      id: 'deliver-to-stale',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: RUNTIME_B,
      payload: 'encrypted-payload',
      encrypted: true,
      entityId: ENTITY_B,
      txs: 1,
    });

    expect(sentBySocket.get(staleB) ?? []).toEqual([
      { type: 'hello_ack', to: RUNTIME_B.toLowerCase() },
    ]);
    expect(store.clients.has(RUNTIME_B)).toBe(false);
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

  test('defers over-budget entity inputs without closing either authenticated peer', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, RuntimeWsMessage[]>();
    const closes: string[] = [];
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      applicationBudget: { maxMessages: 1, maxBytes: 1024 * 1024 },
      send: (ws: FakeWs, raw: Uint8Array) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(deserializeWsMessage(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs = { label: 'A', readyState: 1, close: () => closes.push('A') };
    const wsB: FakeWs = { label: 'B', readyState: 1, close: () => closes.push('B') };
    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, wsB, signedHello(RUNTIME_B, SEED_B, KEY_B, '2'));
    const sendInput = (id: string) => relayRoute(config, wsA, {
      type: 'entity_inputs',
      id,
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: RUNTIME_B,
      payload: 'encrypted-payload',
      encrypted: true,
    });
    await sendInput('within-budget');
    await sendInput('over-budget');
    expect(sentBySocket.get(wsB)?.some(message => message.id === 'within-budget')).toBe(true);
    expect(sentBySocket.get(wsB)?.some(message => message.id === 'over-budget')).toBe(false);
    expect(sentBySocket.get(wsA)?.at(-1)).toMatchObject({
      type: 'error',
      error: 'ENTITY_INPUT_RATE_LIMITED',
      inReplyTo: 'over-budget',
    });
    expect(closes).toEqual([]);
    expect(store.clients.has(RUNTIME_A)).toBe(true);
    expect(store.clients.has(RUNTIME_B)).toBe(true);
  });

  test('accepts Bun backpressure and rejects a zero-byte forward to an active target', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: Uint8Array) => {
        const message = deserializeWsMessage(raw);
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(message);
        sentBySocket.set(ws, bucket);
        if (ws.label === 'B' && (message as { id?: string }).id === 'deliver-backpressured') {
          return -1;
        }
        if (ws.label === 'B' && (message as { id?: string }).id === 'deliver-invalid') {
          return Number.NaN;
        }
        if (ws.label === 'B' && (message as { id?: string }).id === 'deliver-dropped') {
          return 0;
        }
      },
    };
    const wsA: FakeWs = { label: 'A', readyState: 1 };
    const wsB: FakeWs = { label: 'B', readyState: 1 };

    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, wsB, signedHello(RUNTIME_B, SEED_B, KEY_B, '2'));
    await relayRoute(config, wsA, {
      type: 'entity_inputs',
      id: 'deliver-backpressured',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: RUNTIME_B,
      payload: 'encrypted-account-input',
      encrypted: true,
      entityId: ENTITY_B,
      txs: 1,
    });

    expect(store.clients.get(RUNTIME_B)?.ws).toBe(wsB);
    expect(store.debugEvents.find(event =>
      event.event === 'delivery' &&
      event.status === 'delivered' &&
      event.details &&
      (event.details as { traceId?: string }).traceId === 'deliver-backpressured'
    )).toBeDefined();

    await expect(relayRoute(config, wsA, {
      type: 'entity_inputs',
      id: 'deliver-invalid',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: RUNTIME_B,
      payload: 'encrypted-account-input',
      encrypted: true,
      entityId: ENTITY_B,
      txs: 1,
    })).rejects.toThrow('WEBSOCKET_SEND_RESULT_INVALID');
    expect(store.clients.get(RUNTIME_B)?.ws).toBe(wsB);

    await relayRoute(config, wsA, {
      type: 'entity_inputs',
      id: 'deliver-dropped',
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
      inReplyTo: 'deliver-dropped',
      to: RUNTIME_B,
    });
    expect(store.debugEvents.find(event =>
      event.event === 'delivery' &&
      event.status === 'send-failed' &&
      event.to === RUNTIME_B
    )).toMatchObject({
      reason: 'RELAY_SEND_DROPPED',
      delivery: {
        outcome: 'failed',
        code: 'RELAY_SEND_DROPPED',
        retryable: true,
        fatal: false,
        terminal: false,
        failure: {
          category: 'TransientRace',
          code: 'RELAY_SEND_DROPPED',
        },
      },
      details: {
        traceId: 'deliver-dropped',
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
      send: (ws: FakeWs, raw: Uint8Array) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(deserializeWsMessage(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs = { label: 'A', readyState: 1 };
    const wsB: FakeWs = { label: 'B', readyState: 1 };

    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, wsB, signedHello(RUNTIME_B, SEED_B, KEY_B, '2'));
    await relayRoute(config, wsA, {
      type: 'entity_inputs',
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
      type: 'entity_inputs',
      id: 'deliver-account-input',
      from: RUNTIME_A,
      to: RUNTIME_B,
      encrypted: true,
      entityId: ENTITY_B,
      txs: 1,
    });
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

  test('forwards scoped application receipts live without relay persistence', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: Uint8Array) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(deserializeWsMessage(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const receiver: FakeWs = { label: 'receiver', readyState: 1 };
    const sender: FakeWs = { label: 'sender', readyState: 1 };
    await relayRoute(config, receiver, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, sender, signedHello(RUNTIME_B, SEED_B, KEY_B, '2'));
    const receipt = {
      body: {
        version: 1,
        receiverRuntimeId: RUNTIME_A,
        identity: { kind: 'entity-frame', height: 4, frameHash: '0xframe' },
      },
      signature: '0xsigned',
    };

    await relayRoute(config, receiver, {
      type: 'entity_input_receipt',
      id: 'receipt-live-1',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: RUNTIME_B,
      payload: receipt,
    });

    expect(sentBySocket.get(sender)?.at(-1)).toMatchObject({
      type: 'entity_input_receipt',
      id: 'receipt-live-1',
      from: RUNTIME_A,
      to: RUNTIME_B,
      payload: receipt,
    });
  });

  test('routes live recovery bundle request and response without queueing', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: Uint8Array) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(deserializeWsMessage(raw));
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
  });

  test('rejects recovery bundle requests when the target runtime is offline', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: Uint8Array) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(deserializeWsMessage(raw));
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

  test('rejects offline gossip instead of retaining attacker-controlled relay payloads', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: Uint8Array) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(deserializeWsMessage(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const sender: FakeWs = { label: 'sender', readyState: 1 };

    await relayRoute(config, sender, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, sender, {
      type: 'gossip_response',
      id: 'offline-gossip',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: RUNTIME_B,
      payload: { profiles: [] },
    });

    expect(sentBySocket.get(sender)?.at(-1)).toMatchObject({
      type: 'error',
      error: 'GOSSIP_TARGET_NOT_CONNECTED',
      inReplyTo: 'offline-gossip',
      to: RUNTIME_B,
    });
    expect(store.debugEvents.some(event =>
      event.msgType === 'gossip_response' &&
      event.status === 'rejected' &&
      event.reason === 'GOSSIP_TARGET_NOT_CONNECTED'
    )).toBe(true);
    expect('pendingMessages' in store).toBe(false);
  });

  test('rejects every routable message before authenticated hello', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: Uint8Array) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(deserializeWsMessage(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const attacker: FakeWs = { label: 'unauthenticated', readyState: 1 };
    const target: FakeWs = { label: 'target', readyState: 1 };
    await relayRoute(config, target, signedHello(RUNTIME_B, SEED_B, KEY_B, '2'));

    const routableTypes = [
      'entity_inputs',
      'entity_input_receipt',
      'gossip_response',
      'recovery_bundle_request',
      'recovery_bundle_response',
    ] as const;
    for (const [index, type] of routableTypes.entries()) {
      await relayRoute(config, attacker, {
        type,
        id: `unauthenticated-${index}`,
        from: RUNTIME_A,
        fromEncryptionPubKey: KEY_A,
        to: RUNTIME_B,
        payload: type === 'entity_inputs' ? 'attacker-ciphertext' : { forged: true },
        ...(type === 'entity_inputs' ? { encrypted: true } : {}),
      });
    }

    expect(sentBySocket.get(target)).toEqual([{ type: 'hello_ack', to: RUNTIME_B.toLowerCase() }]);
    expect(sentBySocket.get(attacker)).toHaveLength(routableTypes.length);
    for (const [index, response] of (sentBySocket.get(attacker) ?? []).entries()) {
      expect(response).toMatchObject({
        type: 'error',
        error: 'Relay session authentication missing',
      });
    }
    expect(store.debugEvents.filter(event => event.reason === 'RELAY_SESSION_AUTH_INVALID')).toHaveLength(
      routableTypes.length,
    );
  });

  test('closes and forgets an authenticated relay socket after one invalid frame signature', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const closes: Array<{ code?: number; reason?: string }> = [];
    const sender: FakeWs = {
      label: 'sender',
      readyState: 1,
      close: (code, reason) => closes.push({ code, reason }),
    };
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: () => true,
    };
    await relayRoute(config, sender, signedHello(RUNTIME_A, SEED_A, KEY_A));
    expect(store.clients.get(RUNTIME_A.toLowerCase())?.ws).toBe(sender);

    await productionRelayRoute(config, sender, {
      type: 'ping',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      auth: { nonce: 'wrong', timestamp: Date.now(), signature: `0x${'00'.repeat(65)}` },
    });

    expect(closes).toEqual([{ code: 4003, reason: 'relay-session-auth-invalid' }]);
    expect(store.clients.has(RUNTIME_A.toLowerCase())).toBe(false);
    expect(store.runtimeEncryptionKeys.has(RUNTIME_A.toLowerCase())).toBe(false);
  });

  test('rejects unencrypted entity_inputs at relay ingress', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: Uint8Array) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(deserializeWsMessage(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs = { label: 'A', readyState: 1 };

    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, wsA, {
      type: 'entity_inputs',
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
      error: 'entity_inputs must be encrypted',
    });
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

  test('local entity_inputs delivery failures expose typed delivery metadata', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {
        throw new Error('NO_LOCAL_REPLICA: entityId=0xabc');
      },
      send: (ws: FakeWs, raw: Uint8Array) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(deserializeWsMessage(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs = { label: 'A', readyState: 1 };

    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, wsA, {
      type: 'entity_inputs',
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
      send: (ws: FakeWs, raw: Uint8Array) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(deserializeWsMessage(raw));
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
    const envelope = signRuntimeEntityInputsEnvelope(createEmptyEnv(SEED_A), env.runtimeId!, {
      sourceRuntimeId: RUNTIME_A,
      sourceRuntimeHeight: 1,
      sourceRuntimeTimestamp: 1,
      entityInputs: [unknownEntityInput],
    });

    await expect(handler(RUNTIME_A, {
      type: 'entity_inputs',
      to: env.runtimeId,
      encrypted: true,
      payload: encryptJSON(envelope, deriveEncryptionKeyPair(env.runtimeSeed).publicKey),
    })).rejects.toThrow('NO_LOCAL_REPLICA');

    expect(store.debugEvents.some(event => {
      return event.status === 'rejected-no-local-replica' && event.reason === 'NO_LOCAL_REPLICA';
    })).toBe(true);
  });

  test('local delivery rejects forged source before local entity lookup', async () => {
    const env = createEmptyEnv('relay-local-forged-source');
    const store = createRelayStore(env.runtimeId);
    let entityLookups = 0;
    const handler = createLocalDeliveryHandler(env, store, () => {
      entityLookups += 1;
      return null;
    });
    const source = createEmptyEnv(SEED_A);
    const envelope = signRuntimeEntityInputsEnvelope(source, env.runtimeId!, {
      sourceRuntimeId: source.runtimeId!,
      sourceRuntimeHeight: 1,
      sourceRuntimeTimestamp: 1,
      entityInputs: [{
        entityId: ENTITY_C,
        runtimeId: env.runtimeId!,
        signerId: env.runtimeId!,
        entityTxs: [],
      }],
    });

    await expect(handler(source.runtimeId, {
      type: 'entity_inputs',
      to: env.runtimeId,
      encrypted: true,
      payload: encryptJSON({
        ...envelope,
        sourceRuntimeHeight: 2,
      }, deriveEncryptionKeyPair(env.runtimeSeed).publicKey),
    })).rejects.toThrow('INBOUND_ENTITY_INPUTS_SOURCE_SIGNATURE_INVALID');
    expect(entityLookups).toBe(0);
    expect(store.debugEvents).toEqual([]);
  });

  test('rejects unsigned hello by default', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: Uint8Array) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(deserializeWsMessage(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs = { label: 'A' };

    await productionRelayRoute(config, wsA, {
      type: 'hello',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
    });

    expect(store.clients.has(RUNTIME_A)).toBe(false);
    expect(sentBySocket.get(wsA)?.at(-1)).toMatchObject({
      type: 'error',
      error: 'Hello challenge missing, expired, or already consumed',
    });
  });

  test('drops unsigned gossip profiles when no verifier override is installed', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => {},
      send: (ws: FakeWs, raw: Uint8Array) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(deserializeWsMessage(raw));
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
      payload: { profiles: [buildProfile(ENTITY_A, RUNTIME_A, KEY_A, { certified: false })] },
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
