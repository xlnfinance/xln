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

test('enqueueEntityInput uses official relay when advertised hub direct endpoint is not open', () => {
  const p2p = Object.create(RuntimeP2P.prototype) as RuntimeP2P & Record<string, any>;
  const sent: Array<{ to: string; input: RoutedEntityInput; timestamp?: number }> = [];
  const debugEvents: unknown[] = [];

  const relayClient = {
    isOpen: () => true,
    sendEntityInput: (to: string, input: RoutedEntityInput, timestamp?: number) => {
      sent.push({ to, input, timestamp });
      return true;
    },
  };
  const directClient = {
    isOpen: () => false,
    isConnecting: () => true,
  };

  p2p.env = {
    warn: () => undefined,
  };
  p2p.sendDebugEvent = (payload: unknown) => {
    debugEvents.push(payload);
    return true;
  };
  p2p.ensureRelayConnectionsForEntity = () => undefined;
  p2p.prefetchProfilesForInput = () => undefined;
  p2p.getDirectPeerEndpoint = () => 'wss://hub.example/direct';
  p2p.ensureDirectClientForRuntime = () => undefined;
  p2p.directClients = new Map([[TARGET_RUNTIME_ID, directClient]]);
  p2p.directClientUrls = new Map([[TARGET_RUNTIME_ID, 'wss://hub.example/direct']]);
  p2p.directClientErrors = new Map();
  p2p.clients = [relayClient];
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

  expect(p2p.enqueueEntityInput(TARGET_RUNTIME_ID, input, 1234)).toBe(true);

  expect(sent).toHaveLength(1);
  expect(sent[0]?.to).toBe(TARGET_RUNTIME_ID);
  expect(sent[0]?.timestamp).toBe(1234);
  expect(debugEvents.some((event) =>
    typeof event === 'object' &&
    event !== null &&
    (event as { code?: string }).code === 'P2P_ENTITY_INPUT_NOT_DELIVERED',
  )).toBe(false);
  expect((p2p.pendingByRuntime as Map<string, unknown[]>).get(TARGET_RUNTIME_ID)?.length || 0).toBe(0);
});

test('enqueueEntityInput prefers open direct transport over relay', () => {
  const p2p = Object.create(RuntimeP2P.prototype) as RuntimeP2P & Record<string, any>;
  const relaySent: unknown[] = [];
  const directSent: Array<{ to: string; input: RoutedEntityInput; timestamp?: number }> = [];

  const relayClient = {
    isOpen: () => true,
    sendEntityInput: () => {
      relaySent.push(true);
      return true;
    },
  };
  const directClient = {
    isOpen: () => true,
    isConnecting: () => false,
    sendEntityInput: (to: string, input: RoutedEntityInput, timestamp?: number) => {
      directSent.push({ to, input, timestamp });
      return true;
    },
  };

  p2p.env = {
    warn: () => undefined,
  };
  p2p.sendDebugEvent = () => true;
  p2p.ensureRelayConnectionsForEntity = () => undefined;
  p2p.prefetchProfilesForInput = () => undefined;
  p2p.getDirectPeerEndpoint = () => 'wss://hub.example/direct';
  p2p.ensureDirectClientForRuntime = () => undefined;
  p2p.directClients = new Map([[TARGET_RUNTIME_ID, directClient]]);
  p2p.directClientUrls = new Map([[TARGET_RUNTIME_ID, 'wss://hub.example/direct']]);
  p2p.directClientErrors = new Map();
  p2p.clients = [relayClient];
  p2p.pendingByRuntime = new Map();

  const input: RoutedEntityInput = {
    entityId: SOURCE_ENTITY_ID,
    signerId: '0x2222222222222222222222222222222222222222',
    entityTxs: [],
  };

  expect(p2p.enqueueEntityInput(TARGET_RUNTIME_ID, input, 5678)).toBe(true);
  expect(directSent).toHaveLength(1);
  expect(directSent[0]?.to).toBe(TARGET_RUNTIME_ID);
  expect(directSent[0]?.timestamp).toBe(5678);
  expect(relaySent).toHaveLength(0);
});

test('enqueueEntityInput uses relay when direct transport is not authoritative for entity inputs', () => {
  const p2p = Object.create(RuntimeP2P.prototype) as RuntimeP2P & Record<string, any>;
  const relaySent: Array<{ to: string; input: RoutedEntityInput; timestamp?: number }> = [];
  const directSent: unknown[] = [];

  const relayClient = {
    isOpen: () => true,
    sendEntityInput: (to: string, input: RoutedEntityInput, timestamp?: number) => {
      relaySent.push({ to, input, timestamp });
      return true;
    },
  };
  const directClient = {
    isOpen: () => true,
    isConnecting: () => false,
    sendEntityInput: () => {
      directSent.push(true);
      return true;
    },
  };

  p2p.env = {
    warn: () => undefined,
  };
  p2p.preferRelayForEntityInput = true;
  p2p.sendDebugEvent = () => true;
  p2p.ensureRelayConnectionsForEntity = () => undefined;
  p2p.prefetchProfilesForInput = () => undefined;
  p2p.getDirectPeerEndpoint = () => 'wss://hub.example/direct';
  p2p.ensureDirectClientForRuntime = () => undefined;
  p2p.directClients = new Map([[TARGET_RUNTIME_ID, directClient]]);
  p2p.directClientUrls = new Map([[TARGET_RUNTIME_ID, 'wss://hub.example/direct']]);
  p2p.directClientErrors = new Map();
  p2p.clients = [relayClient];
  p2p.pendingByRuntime = new Map();

  const input: RoutedEntityInput = {
    entityId: SOURCE_ENTITY_ID,
    signerId: '0x2222222222222222222222222222222222222222',
    entityTxs: [{
      type: 'accountInput',
      data: {
        fromEntityId: SOURCE_ENTITY_ID,
        toEntityId: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    }],
  };

  expect(p2p.enqueueEntityInput(TARGET_RUNTIME_ID, input, 6789)).toBe(true);
  expect(relaySent).toHaveLength(1);
  expect(relaySent[0]?.to).toBe(TARGET_RUNTIME_ID);
  expect(relaySent[0]?.timestamp).toBe(6789);
  expect(directSent).toHaveLength(0);
});
