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

  p2p.enqueueEntityInput(TARGET_RUNTIME_ID, input);

  expect(prefetched).toBe(true);
  expect(resolvedAfterPrefetch).toBe(true);
  expect((p2p.pendingByRuntime as Map<string, unknown[]>).get(TARGET_RUNTIME_ID)?.length).toBe(1);
});
