import { describe, expect, test } from 'bun:test';
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
          {
            entityId: ENTITY_A,
            runtimeId: RUNTIME_A,
            name: 'alice',
            avatar: '',
            bio: '',
            website: '',
            lastUpdated: 123,
            capabilities: ['routing'],
            runtimeEncPubKey: KEY_A,
            publicAccounts: [],
            endpoints: [],
            relays: [],
            metadata: {
              entityEncPubKey: KEY_A,
              isHub: false,
              routingFeePPM: 100,
              baseFee: '0',
              board: {
                threshold: 1,
                validators: [{ signer: '0x1111111111111111111111111111111111111111', weight: 1 }],
              },
            },
            accounts: [],
          },
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
          {
            entityId: ENTITY_A,
            runtimeId: RUNTIME_A,
            name: 'leaf-a',
            avatar: '',
            bio: '',
            website: '',
            lastUpdated: 100,
            capabilities: [],
            runtimeEncPubKey: KEY_A,
            publicAccounts: [],
            endpoints: [],
            relays: [],
            metadata: {
              entityEncPubKey: KEY_A,
              isHub: false,
              routingFeePPM: 100,
              baseFee: '0',
              board: {
                threshold: 1,
                validators: [{ signer: '0x1111111111111111111111111111111111111111', weight: 1 }],
              },
            },
            accounts: [],
          },
          {
            entityId: ENTITY_B,
            runtimeId: RUNTIME_B,
            name: 'hub-b',
            avatar: '',
            bio: '',
            website: '',
            lastUpdated: 200,
            capabilities: ['hub', 'routing'],
            runtimeEncPubKey: KEY_B,
            publicAccounts: [],
            endpoints: [],
            relays: [],
            metadata: {
              isHub: true,
              entityEncPubKey: KEY_B,
              routingFeePPM: 100,
              baseFee: '0',
              board: {
                threshold: 1,
                validators: [{ signer: '0x2222222222222222222222222222222222222222', weight: 1 }],
              },
            },
            accounts: [],
          },
          {
            entityId: ENTITY_C,
            runtimeId: RUNTIME_B,
            name: 'leaf-c',
            avatar: '',
            bio: '',
            website: '',
            lastUpdated: 300,
            capabilities: [],
            runtimeEncPubKey: KEY_B,
            publicAccounts: [],
            endpoints: [],
            relays: [],
            metadata: {
              entityEncPubKey: KEY_B,
              isHub: false,
              routingFeePPM: 100,
              baseFee: '0',
              board: {
                threshold: 1,
                validators: [{ signer: '0x2222222222222222222222222222222222222222', weight: 1 }],
              },
            },
            accounts: [],
          },
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
