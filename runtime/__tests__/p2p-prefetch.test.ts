import { expect, test } from 'bun:test';

import type { RoutedEntityInput } from '../types';
import { RuntimeP2P } from '../networking/p2p';

const TARGET_RUNTIME_ID = '0x1111111111111111111111111111111111111111';
const SOURCE_ENTITY_ID = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('enqueueEntityInput starts profile prefetch before transport resolution', () => {
  const p2p = Object.create(RuntimeP2P.prototype) as RuntimeP2P & Record<string, unknown>;

  let prefetched = false;
  let resolvedAfterPrefetch = false;

  p2p.env = {
    warn: () => undefined,
  };
  p2p.sendDebugEvent = () => false;
  p2p.ensureRelayConnectionsForEntity = () => undefined;
  p2p.prefetchProfilesForInput = () => {
    prefetched = true;
  };
  p2p.resolveTransportClient = () => {
    resolvedAfterPrefetch = prefetched;
    return { client: null, transport: 'relay' };
  };
  p2p.clients = [];
  p2p.directClients = new Map();
  p2p.directClientUrls = new Map();
  p2p.pendingByRuntime = new Map();

  const input: RoutedEntityInput = {
    entityId: SOURCE_ENTITY_ID,
    signerId: '0x2222222222222222222222222222222222222222',
    entityTxs: [{
      type: 'openAccount',
      data: {
        targetEntityId: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    }],
  };

  expect(() => p2p.enqueueEntityInput(TARGET_RUNTIME_ID, input)).toThrow(/P2P_ENTITY_INPUT_NOT_DELIVERED/);

  expect(prefetched).toBe(true);
  expect(resolvedAfterPrefetch).toBe(true);
  expect((p2p.pendingByRuntime as Map<string, unknown[]>).get(TARGET_RUNTIME_ID)?.length || 0).toBe(0);
});
