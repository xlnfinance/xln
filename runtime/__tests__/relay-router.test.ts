import { describe, expect, test } from 'bun:test';
import { relayRoute } from '../relay-router';
import { createRelayStore } from '../relay-store';

const SERVER_RUNTIME_ID = '0x9999999999999999999999999999999999999999';
const RUNTIME_A = '0x1111111111111111111111111111111111111111';
const RUNTIME_B = '0x2222222222222222222222222222222222222222';
const ENTITY_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

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

    await relayRoute(config, wsA, { type: 'hello', from: RUNTIME_A });
    await relayRoute(config, wsB, { type: 'hello', from: RUNTIME_B });

    await relayRoute(config, wsA, {
      type: 'gossip_announce',
      id: 'announce-1',
      from: RUNTIME_A,
      to: SERVER_RUNTIME_ID,
      payload: {
        profiles: [
          {
            entityId: ENTITY_A,
            runtimeId: RUNTIME_A,
            capabilities: ['routing'],
            metadata: {
              name: 'alice',
              lastUpdated: 123,
              encryptionPublicKey: '0x' + '11'.repeat(32),
            },
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
    expect(store.gossipProfiles.get(ENTITY_A)?.profile?.metadata?.name).toBe('alice');
  });
});
