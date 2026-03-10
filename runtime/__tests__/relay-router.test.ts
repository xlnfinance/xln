import { describe, expect, test } from 'bun:test';
import type { Profile } from '../networking/gossip';
import { relayRoute } from '../relay-router';
import { createRelayStore } from '../relay-store';

const SERVER_RUNTIME_ID = '0x9999999999999999999999999999999999999999';
const RUNTIME_A = '0x1111111111111111111111111111111111111111';
const RUNTIME_B = '0x2222222222222222222222222222222222222222';
const KEY_A = '0x' + '11'.repeat(32);
const KEY_B = '0x' + '22'.repeat(32);
const ENTITY_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ENTITY_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ENTITY_C = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

type FakeWs = { label: string };

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
  endpoints: [],
  relays: [],
  metadata: {
    entityEncPubKey: runtimeEncPubKey,
    isHub: false,
    routingFeePPM: 100,
    baseFee: 0n,
    entityPublicKey: `pub:${entityId.slice(2, 10)}`,
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
      send: (ws: FakeWs, raw: string) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(JSON.parse(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs = { label: 'A' };
    const wsB: FakeWs = { label: 'B' };

    await relayRoute(config, wsA, { type: 'hello', from: RUNTIME_A, fromEncryptionPubKey: KEY_A });
    await relayRoute(config, wsB, { type: 'hello', from: RUNTIME_B, fromEncryptionPubKey: KEY_B });

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
      send: (ws: FakeWs, raw: string) => {
        const bucket = sentBySocket.get(ws) ?? [];
        bucket.push(JSON.parse(raw));
        sentBySocket.set(ws, bucket);
      },
    };
    const wsA: FakeWs = { label: 'A' };

    await relayRoute(config, wsA, { type: 'hello', from: RUNTIME_A, fromEncryptionPubKey: KEY_A });

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
              entityPublicKey: `pub:${ENTITY_B.slice(2, 10)}`,
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
});
