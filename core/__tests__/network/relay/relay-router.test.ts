import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet, getBytes } from 'ethers';
import type { Profile } from '../../../entity/profile';
import { relayRoute as productionRelayRoute } from '../../../network/relay/router';
import {
  cacheEncryptionKey,
  createRelayStore,
  resolveEncryptionPublicKeyHex,
  storeVerifiedJurisdictionAnnouncement,
} from '../../../network/relay/store';
import { deserializeWsMessage, hashHelloMessage, hashRuntimeWsFrame, type RuntimeWsMessage } from '../../../network/p2p/ws-protocol';
import { deriveSignerAddressSync, signDigest } from '../../../account/crypto';
import { DEFAULT_GOSSIP_BATCH_LIMIT } from '../../../network/p2p/gossip/profile-batch';
import {
  buildCryptographicProfileFixture,
  certifySingleSignerProfileFixture,
  deriveSingleSignerFixtureEntityId,
} from '../../helpers/cryptographic-profile';
import { createJurisdictionGossipAnnouncement } from '../../../jurisdiction/gossip/announcement';

const SERVER_RUNTIME_ID = '0x9999999999999999999999999999999999999999';
const SEED_A = 'relay-router-test-seed-a';
const SEED_B = 'relay-router-test-seed-b';
const SEED_C = 'relay-router-test-seed-c';
const RUNTIME_A = deriveSignerAddressSync(SEED_A, '1');
const RUNTIME_B = deriveSignerAddressSync(SEED_B, '2');
const KEY_A = '0x' + '11'.repeat(32);
const KEY_B = '0x' + '22'.repeat(32);
const JURISDICTION_SIGNER_KEY = `0x${'33'.repeat(32)}`;
const JURISDICTION_SIGNER = new Wallet(JURISDICTION_SIGNER_KEY).address.toLowerCase();
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

const buildJurisdictionAnnouncement = (
  scope: 'community' | 'official' = 'community',
  key = 'community-chain',
) => createJurisdictionGossipAnnouncement({
  scope,
  key,
  name: 'Community Chain',
  rpcUrl: 'https://community.example/rpc',
  blockTimeMs: 1_000,
  currency: 'ETH',
  explorer: 'https://community.example/explorer',
  chainId: 42_161,
  deployer: JURISDICTION_SIGNER,
  foundationRecipient: JURISDICTION_SIGNER,
  entityProviderDeploymentBlock: 7,
  contracts: {
    account: `0x${'01'.repeat(20)}`,
    depositoryBounds: `0x${'02'.repeat(20)}`,
    hashLadderRegistry: `0x${'03'.repeat(20)}`,
    nftCustody: `0x${'04'.repeat(20)}`,
    hankoVerifier: `0x${'05'.repeat(20)}`,
    entityProvider: `0x${'06'.repeat(20)}`,
    depository: `0x${'07'.repeat(20)}`,
    deltaTransformer: `0x${'08'.repeat(20)}`,
  },
  stablecoin: { symbol: 'USDT', address: `0x${'09'.repeat(20)}`, tokenId: 1, decimals: 6 },
}, getBytes(JURISDICTION_SIGNER_KEY), scope === 'official' ? JURISDICTION_SIGNER : undefined);

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
      payload: {
        profiles: Array.from({ length: DEFAULT_GOSSIP_BATCH_LIMIT + 1 }, () => ({})),
        jurisdictions: [],
      },
    });

    expect(verifies).toBe(0);
    expect(sent.at(-1)).toEqual({ type: 'error', error: 'GOSSIP_ANNOUNCE_RATE_LIMITED' });
    expect(closed).toEqual({ code: 4003, reason: 'relay-gossip-rate-limited' });
    expect(store.clients.has(RUNTIME_A)).toBeFalse();
  });

  test('relay router verbose diagnostics use structured logging and the relay carries no financial path', () => {
    const routerSource = readFileSync(join(process.cwd(), 'core/network/relay/router.ts'), 'utf8');

    expect(routerSource).toContain("const relayRouterLog = createStructuredLogger('relay.router');");
    expect(routerSource).toContain("relayRouterLog.debug('verbose'");
    expect(routerSource).not.toContain('console.');
    expect(routerSource).not.toContain('catch { size = 0; }');
    expect(routerSource).toContain('relayMessageByteLength');
    expect(routerSource).not.toContain('safeStringify(msg)');
    // entity_inputs and peer error frames are not relay-routable; there is no
    // local delivery hook a relay could decrypt financial bytes into.
    expect(routerSource).not.toContain('localDeliver');
    expect(routerSource).not.toContain("type === 'entity_inputs' ||");
    expect(routerSource).not.toContain("type === 'error' ||");
  });

  test('records a nonzero message size for tagged BigInt payloads', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const ws: FakeWs = { label: 'bigint' };
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
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

  test('stores announced profiles without pushing them; peers pull by set/ids', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
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
        jurisdictions: [],
      },
    });

    // Profiles are pull-only: nobody receives a gossip_update for a profile.
    const isGossipUpdate = (message: unknown) => !!message && typeof message === 'object'
      && (message as { type?: string }).type === 'gossip_update';
    expect((sentBySocket.get(wsB) ?? []).some(isGossipUpdate)).toBeFalse();
    expect((sentBySocket.get(wsA) ?? []).some(isGossipUpdate)).toBeFalse();
    expect(store.gossipProfiles.get(ENTITY_A)?.profile?.name).toBe('alice');

    await relayRoute(config, wsB, {
      type: 'gossip_request',
      id: 'req-1',
      from: RUNTIME_B,
      fromEncryptionPubKey: KEY_B,
      to: SERVER_RUNTIME_ID,
      payload: { ids: [ENTITY_A] },
    });
    const response = (sentBySocket.get(wsB) ?? []).find(message =>
      !!message && typeof message === 'object' && (message as { type?: string }).type === 'gossip_response',
    ) as { payload?: { profiles?: Array<{ entityId?: string }> } } | undefined;
    expect(response?.payload?.profiles?.[0]?.entityId).toBe(ENTITY_A);
  });

  test('verifies and broadcasts signed community jurisdiction discovery', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      send: (ws: FakeWs, raw: Uint8Array) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(deserializeWsMessage(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs = { label: 'jurisdiction-source' };
    const wsB: FakeWs = { label: 'jurisdiction-target' };
    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, wsB, signedHello(RUNTIME_B, SEED_B, KEY_B, '2'));
    const announcement = buildJurisdictionAnnouncement();

    await relayRoute(config, wsA, {
      type: 'gossip_announce',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      payload: { profiles: [], jurisdictions: [announcement] },
    });

    expect(store.gossipJurisdictions.size).toBe(1);
    expect(sentBySocket.get(wsB)?.some((message) =>
      (message as { payload?: { jurisdictions?: unknown[] } }).payload?.jurisdictions?.length === 1,
    )).toBeTrue();

    await relayRoute(config, wsA, {
      type: 'gossip_announce',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      payload: {
        profiles: [],
        jurisdictions: [{ ...announcement, rpcUrl: 'https://attacker.example/rpc' }],
      },
    });
    expect(store.gossipJurisdictions.size).toBe(1);
    expect(store.debugEvents.some((event) => event.reason === 'GOSSIP_JURISDICTION_DROPPED_INVALID')).toBeTrue();
  });

  test('community discovery capacity cannot block an official Foundation announcement', () => {
    const community = buildJurisdictionAnnouncement();
    const store = createRelayStore(SERVER_RUNTIME_ID, {
      officialFoundationSignerId: JURISDICTION_SIGNER,
    });
    for (let index = 0; index < 128; index += 1) {
      store.gossipJurisdictions.set(`community-${index}`, community);
    }
    const official = buildJurisdictionAnnouncement('official', 'official-chain');

    expect(storeVerifiedJurisdictionAnnouncement(store, official)).toEqual(official);
    expect(store.gossipJurisdictions.size).toBe(129);
    expect(() => storeVerifiedJurisdictionAnnouncement(
      store,
      buildJurisdictionAnnouncement('community', 'community-over-cap'),
    )).toThrow('RELAY_JURISDICTION_GOSSIP_CAP_EXCEEDED');
  });

  test('accepts one reconnect batch above a single jurisdiction authority-scope cap', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID, {
      officialFoundationSignerId: JURISDICTION_SIGNER,
    });
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      send: (ws: FakeWs, raw: Uint8Array) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(deserializeWsMessage(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs = { label: 'full-scope-source' };
    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));
    const announcement = buildJurisdictionAnnouncement();

    await relayRoute(config, wsA, {
      type: 'gossip_announce',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      payload: {
        profiles: [],
        jurisdictions: Array.from({ length: 129 }, () => announcement),
      },
    });

    expect(store.gossipJurisdictions.size).toBe(1);
    expect(store.debugEvents.some(event => event.reason === 'GOSSIP_ANNOUNCE_RATE_LIMITED')).toBeFalse();
  });

  test('serves batched gossip by ids and set filters', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      send: (ws: FakeWs, raw: Uint8Array) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(deserializeWsMessage(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs = { label: 'A' };
    const wsB: FakeWs = { label: 'B' };

    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, wsB, signedHello(RUNTIME_B, SEED_B, KEY_B));

    await relayRoute(config, wsA, {
      type: 'gossip_announce',
      id: 'announce-a',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: SERVER_RUNTIME_ID,
      payload: {
        profiles: [buildProfile(ENTITY_A, RUNTIME_A, KEY_A, { lastUpdated: 100, name: 'leaf-a' })],
        jurisdictions: [],
      },
    });
    // A Runtime announces only its own Entities' profiles.
    await relayRoute(config, wsB, {
      type: 'gossip_announce',
      id: 'announce-b',
      from: RUNTIME_B,
      fromEncryptionPubKey: KEY_B,
      to: SERVER_RUNTIME_ID,
      payload: {
        profiles: [
          buildProfile(ENTITY_B, RUNTIME_B, KEY_B, {
            lastUpdated: 200,
            name: 'hub-b',
            isHub: true,
          }),
          buildProfile(ENTITY_C, RUNTIME_B, KEY_B, { lastUpdated: 300, name: 'leaf-c' }),
        ],
        jurisdictions: [],
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
      },
    });

    const responses = (sentBySocket.get(wsA) ?? []).filter(
      (message) => (message as { type?: string }).type === 'gossip_response',
    ) as Array<{ payload?: { profiles?: Array<{ entityId?: string }> } }>;
    const lastResponse = responses.at(-1);

    expect(lastResponse).toBeDefined();
    expect(lastResponse?.payload?.profiles?.map((profile) => profile.entityId)).toEqual([ENTITY_B, ENTITY_A]);
  });

  test('duplicate authenticated hello preserves the live writer and rejects the newcomer', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    let replacementClose: { code?: number; reason?: string } | null = null;
    let freshCloseCount = 0;
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
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
      id: 'original-followup',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: SERVER_RUNTIME_ID,
      payload: { profiles: [], jurisdictions: [] },
    });

    expect(store.clients.get(RUNTIME_A)?.ws).toBe(wsA);
    expect(replacementClose).toBeNull();
    expect(freshCloseCount).toBe(1);
    expect(sentBySocket.get(fresh)?.at(-1)).toEqual({ type: 'error', error: `DUPLICATE_RUNTIME_CONNECTION:${RUNTIME_A.toLowerCase()}` });
    expect(sentBySocket.get(wsA)).toEqual([{ type: 'hello_ack', to: RUNTIME_A.toLowerCase() }]);
  });

  test('allows signed reconnect after the previous runtime socket is closed', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
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

  test('never forwards gossip responses or recovery frames between clients', async () => {
    // Receivers treat relay-session frames as relay-authored. Forwarding let any
    // client forge a gossip response or a recovery error to another Runtime and
    // kill its relay session; no production sender uses these routes.
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      send: (ws: FakeWs, raw: Uint8Array) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(deserializeWsMessage(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const sender: FakeWs = { label: 'sender', readyState: 1 };
    const target: FakeWs = { label: 'target', readyState: 1 };
    await relayRoute(config, sender, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, target, signedHello(RUNTIME_B, SEED_B, KEY_B, '2'));

    const peerTypes = ['gossip_response', 'recovery_bundle_request', 'recovery_bundle_response'] as const;
    for (const type of peerTypes) {
      await relayRoute(config, sender, {
        type,
        id: `peer-${type}`,
        from: RUNTIME_A,
        fromEncryptionPubKey: KEY_A,
        to: RUNTIME_B,
        payload: { forged: true },
      });
    }

    expect(sentBySocket.get(target)).toEqual([{ type: 'hello_ack', to: RUNTIME_B.toLowerCase() }]);
    expect(sentBySocket.get(sender)?.slice(1)).toEqual(peerTypes.map(type => ({
      type: 'error',
      error: 'RELAY_PEER_FRAME_NOT_ROUTABLE',
      inReplyTo: `peer-${type}`,
      to: RUNTIME_B,
    })));
  });

  test('rejects every routable message before authenticated hello', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
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

  test('relay_never_forwards_error_frames', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const closes: string[] = [];
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
      send: (ws: FakeWs, raw: Uint8Array) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(deserializeWsMessage(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const attacker: FakeWs = { label: 'A', readyState: 1, close: () => closes.push('A') };
    const victim: FakeWs = { label: 'B', readyState: 1, close: () => closes.push('B') };
    await relayRoute(config, attacker, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, victim, signedHello(RUNTIME_B, SEED_B, KEY_B, '2'));
    const attackerFramesBefore = (sentBySocket.get(attacker) ?? []).length;

    // A fresh relay registration is all the attacker needs; the "rejection"
    // names an output id of the victim. It must never reach the victim socket.
    for (const [index, inReplyTo] of ['victim-output-7', undefined].entries()) {
      await relayRoute(config, attacker, {
        type: 'error',
        id: `forged-rejection-${index}`,
        from: RUNTIME_A,
        fromEncryptionPubKey: KEY_A,
        to: RUNTIME_B,
        ...(inReplyTo ? { inReplyTo } : {}),
        error: 'P2P_INBOUND_ENTITY_INPUT_REJECTED:forged',
      });
    }

    expect(sentBySocket.get(victim)).toEqual([{ type: 'hello_ack', to: RUNTIME_B.toLowerCase() }]);
    // Dropped for audit, not answered: an error reply to an error would loop.
    expect((sentBySocket.get(attacker) ?? []).length).toBe(attackerFramesBefore);
    expect(closes).toEqual([]);
    expect(store.clients.has(RUNTIME_A)).toBe(true);
    expect(store.clients.has(RUNTIME_B)).toBe(true);
    const dropped = store.debugEvents.filter(event => event.reason === 'RELAY_ERROR_FRAME_NOT_ROUTABLE');
    expect(dropped).toHaveLength(2);
    expect(dropped[0]).toMatchObject({ event: 'error', status: 'rejected', msgType: 'error', from: RUNTIME_A, to: RUNTIME_B });
    expect(dropped[0]?.details).toMatchObject({ inReplyTo: 'victim-output-7' });
    expect(dropped[1]?.details).toMatchObject({ inReplyTo: null });
  });

  test('relay_inbound_entity_inputs_rejected', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
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

    // Both a remote target and the relay's own runtime id: neither is forwarded
    // nor decrypted locally. Financial bytes only travel over direct sessions.
    for (const [index, to] of [RUNTIME_B, SERVER_RUNTIME_ID].entries()) {
      await relayRoute(config, wsA, {
        type: 'entity_inputs',
        id: `relayed-account-input-${index}`,
        from: RUNTIME_A,
        fromEncryptionPubKey: KEY_A,
        to,
        payload: new TextEncoder().encode('encrypted-account-input'),
        encrypted: true,
        entityId: ENTITY_B,
        txs: 1,
      });
      expect(sentBySocket.get(wsA)?.at(-1)).toMatchObject({
        type: 'error',
        error: 'RELAY_ENTITY_INPUTS_FORBIDDEN',
        inReplyTo: `relayed-account-input-${index}`,
        to,
      });
    }

    expect(sentBySocket.get(wsB)).toEqual([{ type: 'hello_ack', to: RUNTIME_B.toLowerCase() }]);
    expect(store.debugEvents.filter(event => event.reason === 'RELAY_ENTITY_INPUTS_FORBIDDEN')).toHaveLength(2);
    expect(store.debugEvents.some(event => event.event === 'delivery' && event.msgType === 'entity_inputs')).toBe(false);
    expect(store.clients.has(RUNTIME_A)).toBe(true);
    expect(store.clients.has(RUNTIME_B)).toBe(true);
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

  test('runtime_input is not a relay protocol message', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
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

  test('rejects unsigned hello by default', async () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const sentBySocket = new Map<FakeWs, unknown[]>();
    const config = {
      store,
      localRuntimeId: SERVER_RUNTIME_ID,
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
      payload: {
        profiles: [buildProfile(ENTITY_A, RUNTIME_A, KEY_A, { certified: false })],
        jurisdictions: [],
      },
    });

    expect(store.gossipProfiles.size).toBe(0);
    expect(store.debugEvents.some(event => event.reason === 'GOSSIP_PROFILE_SIGNATURE_INVALID')).toBe(true);
  });

  test('drops a gossip profile that claims another runtime than its announcer', async () => {
    // Anyone can self-sign a lazy Entity profile. Unbound, it claimed a victim
    // Runtime's id with another key or endpoint (Rust RUNTIME_BINDING).
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const config = { store, localRuntimeId: SERVER_RUNTIME_ID, send: () => {}, verifyProfile: async () => ({ valid: true }) };
    const wsA: FakeWs = { label: 'A' };

    await relayRoute(config, wsA, signedHello(RUNTIME_A, SEED_A, KEY_A));
    await relayRoute(config, wsA, {
      type: 'gossip_announce',
      id: 'announce-foreign-runtime',
      from: RUNTIME_A,
      fromEncryptionPubKey: KEY_A,
      to: SERVER_RUNTIME_ID,
      payload: {
        profiles: [
          buildProfile(ENTITY_A, RUNTIME_A, KEY_A),
          buildProfile(ENTITY_B, RUNTIME_B, KEY_A),
        ],
        jurisdictions: [],
      },
    });

    expect([...store.gossipProfiles.keys()]).toEqual([ENTITY_A.toLowerCase()]);
    expect(store.debugEvents.some(event => event.reason === 'GOSSIP_PROFILE_RUNTIME_BINDING')).toBe(true);
  });

  test('prefers verified relay socket encryption key over gossip profile cache', () => {
    const store = createRelayStore(SERVER_RUNTIME_ID);
    const profile = buildProfile(ENTITY_A, RUNTIME_A, KEY_A, { lastUpdated: 123 });

    expect(cacheEncryptionKey(store, RUNTIME_A, KEY_B)).toBeUndefined();
    store.gossipProfiles.set(ENTITY_A, { profile, timestamp: profile.lastUpdated });

    expect(resolveEncryptionPublicKeyHex(store, RUNTIME_A)).toBe(KEY_B);
  });
});
