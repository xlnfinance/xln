import { expect, test } from 'bun:test';

import type { RoutedEntityInput } from '../types';
import { RuntimeP2P } from '../networking/p2p';

const TARGET_RUNTIME_ID = '0x1111111111111111111111111111111111111111';
const SOURCE_ENTITY_ID = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('enqueueEntityInputDelivery starts profile prefetch before transport resolution', () => {
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

  expect(() => p2p.enqueueEntityInputDelivery(TARGET_RUNTIME_ID, input)).toThrow(/P2P_ENTITY_INPUT_NOT_DELIVERED/);

  expect(prefetched).toBe(true);
  expect(resolvedAfterPrefetch).toBe(true);
  expect((p2p.pendingByRuntime as Map<string, unknown[]>).get(TARGET_RUNTIME_ID)?.length || 0).toBe(0);
});

test('enqueueEntityInputDelivery reports typed delivery result when no transport is open', () => {
  const p2p = Object.create(RuntimeP2P.prototype) as RuntimeP2P & Record<string, any>;
  const debugEvents: unknown[] = [];

  p2p.env = {
    warn: () => undefined,
  };
  p2p.sendDebugEvent = (payload: unknown) => {
    debugEvents.push(payload);
    return true;
  };
  p2p.ensureRelayConnectionsForEntity = () => undefined;
  p2p.prefetchProfilesForInput = () => undefined;
  p2p.resolveTransportClient = () => ({ client: null, transport: 'relay' });
  p2p.clients = [];
  p2p.directClients = new Map();
  p2p.directClientUrls = new Map();
  p2p.directClientErrors = new Map();
  p2p.pendingByRuntime = new Map();

  const input: RoutedEntityInput = {
    entityId: SOURCE_ENTITY_ID,
    signerId: '0x2222222222222222222222222222222222222222',
    entityTxs: [],
  };

  expect(() => p2p.enqueueEntityInputDelivery(TARGET_RUNTIME_ID, input)).toThrow(/P2P_ENTITY_INPUT_NOT_DELIVERED/);
  expect(debugEvents.at(-1)).toMatchObject({
    code: 'P2P_ENTITY_INPUT_NOT_DELIVERED',
    delivery: {
      outcome: 'failed',
      code: 'P2P_ENTITY_INPUT_NOT_DELIVERED',
      retryable: true,
      fatal: false,
      terminal: false,
      transport: 'relay',
      failure: {
        category: 'TransientRace',
      },
    },
  });
});

test('enqueueEntityInputDelivery reports typed delivery result when transport send returns false', () => {
  const p2p = Object.create(RuntimeP2P.prototype) as RuntimeP2P & Record<string, any>;
  const debugEvents: unknown[] = [];
  const warnings: unknown[][] = [];
  const relayClient = {
    isOpen: () => true,
    sendEntityInput: () => false,
  };

  p2p.env = {
    warn: (...args: unknown[]) => {
      warnings.push(args);
    },
  };
  p2p.sendDebugEvent = (payload: unknown) => {
    debugEvents.push(payload);
    return true;
  };
  p2p.ensureRelayConnectionsForEntity = () => undefined;
  p2p.prefetchProfilesForInput = () => undefined;
  p2p.resolveTransportClient = () => ({ client: relayClient, transport: 'relay' });
  p2p.clients = [relayClient];
  p2p.directClients = new Map();
  p2p.directClientUrls = new Map();
  p2p.directClientErrors = new Map();
  p2p.pendingByRuntime = new Map();

  const input: RoutedEntityInput = {
    entityId: SOURCE_ENTITY_ID,
    signerId: '0x2222222222222222222222222222222222222222',
    entityTxs: [],
  };

  expect(() => p2p.enqueueEntityInputDelivery(TARGET_RUNTIME_ID, input)).toThrow(/P2P_ENTITY_INPUT_NOT_DELIVERED/);
  expect(warnings[0]?.[2]).toMatchObject({
    delivery: {
      outcome: 'failed',
      code: 'P2P_SEND_RETURNED_FALSE',
      retryable: true,
      fatal: false,
      terminal: false,
      transport: 'relay',
    },
  });
  expect(debugEvents.at(-1)).toMatchObject({
    code: 'P2P_ENTITY_INPUT_NOT_DELIVERED',
    delivery: {
      code: 'P2P_SEND_RETURNED_FALSE',
      retryable: true,
      fatal: false,
      terminal: false,
      transport: 'relay',
    },
  });
});

test('enqueueEntityInputDelivery uses official relay when advertised hub direct endpoint is not open', () => {
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

  expect(p2p.enqueueEntityInputDelivery(TARGET_RUNTIME_ID, input, 1234)).toMatchObject({
    outcome: 'delivered',
    code: 'P2P_ENTITY_INPUT_DELIVERED',
    transport: 'relay',
  });

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

test('enqueueEntityInputDelivery returns typed success with transport', () => {
  const p2p = Object.create(RuntimeP2P.prototype) as RuntimeP2P & Record<string, any>;
  const sent: Array<{ to: string; input: RoutedEntityInput; timestamp?: number }> = [];
  const relayClient = {
    isOpen: () => true,
    sendEntityInput: (to: string, input: RoutedEntityInput, timestamp?: number) => {
      sent.push({ to, input, timestamp });
      return true;
    },
  };

  p2p.env = {
    warn: () => undefined,
  };
  p2p.sendDebugEvent = () => true;
  p2p.ensureRelayConnectionsForEntity = () => undefined;
  p2p.prefetchProfilesForInput = () => undefined;
  p2p.resolveTransportClient = () => ({ client: relayClient, transport: 'relay' });
  p2p.clients = [relayClient];
  p2p.directClients = new Map();
  p2p.directClientUrls = new Map();
  p2p.directClientErrors = new Map();
  p2p.pendingByRuntime = new Map();

  const input: RoutedEntityInput = {
    entityId: SOURCE_ENTITY_ID,
    signerId: '0x2222222222222222222222222222222222222222',
    entityTxs: [],
  };

  expect(p2p.enqueueEntityInputDelivery(TARGET_RUNTIME_ID, input, 2345)).toMatchObject({
    outcome: 'delivered',
    code: 'P2P_ENTITY_INPUT_DELIVERED',
    retryable: false,
    fatal: false,
    terminal: true,
    transport: 'relay',
  });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.timestamp).toBe(2345);
});

test('enqueueEntityInputDelivery prefers open direct transport over relay', () => {
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

  expect(p2p.enqueueEntityInputDelivery(TARGET_RUNTIME_ID, input, 5678)).toMatchObject({
    outcome: 'delivered',
    code: 'P2P_ENTITY_INPUT_DELIVERED',
    transport: 'direct',
  });
  expect(directSent).toHaveLength(1);
  expect(directSent[0]?.to).toBe(TARGET_RUNTIME_ID);
  expect(directSent[0]?.timestamp).toBe(5678);
  expect(relaySent).toHaveLength(0);
});

test('enqueueEntityInputDelivery uses relay when direct transport is not authoritative for entity inputs', () => {
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

  expect(p2p.enqueueEntityInputDelivery(TARGET_RUNTIME_ID, input, 6789)).toMatchObject({
    outcome: 'delivered',
    code: 'P2P_ENTITY_INPUT_DELIVERED',
    transport: 'relay',
  });
  expect(relaySent).toHaveLength(1);
  expect(relaySent[0]?.to).toBe(TARGET_RUNTIME_ID);
  expect(relaySent[0]?.timestamp).toBe(6789);
  expect(directSent).toHaveLength(0);
});

test('flushPending retains retryable typed delivery failures', () => {
  const p2p = Object.create(RuntimeP2P.prototype) as RuntimeP2P & Record<string, any>;
  const debugEvents: unknown[] = [];
  const relayClient = {
    isOpen: () => true,
    sendEntityInput: () => false,
  };
  const input: RoutedEntityInput = {
    entityId: SOURCE_ENTITY_ID,
    signerId: '0x2222222222222222222222222222222222222222',
    entityTxs: [],
  };

  p2p.sendDebugEvent = (payload: unknown) => {
    debugEvents.push(payload);
    return true;
  };
  p2p.resolveTransportClient = () => ({ client: relayClient, transport: 'relay' });
  p2p.pendingByRuntime = new Map([[
    TARGET_RUNTIME_ID,
    [{ input, enqueuedAt: Date.now(), ingressTimestamp: 7777 }],
  ]]);

  (p2p as any).flushPending();

  expect((p2p.pendingByRuntime as Map<string, unknown[]>).get(TARGET_RUNTIME_ID)).toHaveLength(1);
  expect(debugEvents.at(-1)).toMatchObject({
    level: 'warn',
    code: 'P2P_PENDING_DELIVERY_RETRY',
    targetRuntimeId: TARGET_RUNTIME_ID,
    entityId: SOURCE_ENTITY_ID,
    transport: 'relay',
    delivery: {
      outcome: 'failed',
      code: 'P2P_SEND_RETURNED_FALSE',
      retryable: true,
      fatal: false,
      terminal: false,
    },
  });
});

test('flushPending drops terminal typed delivery failures', () => {
  const p2p = Object.create(RuntimeP2P.prototype) as RuntimeP2P & Record<string, any>;
  const debugEvents: unknown[] = [];
  const relayClient = {
    isOpen: () => true,
    sendEntityInput: () => {
      throw new Error('socket exploded');
    },
  };
  const input: RoutedEntityInput = {
    entityId: SOURCE_ENTITY_ID,
    signerId: '0x2222222222222222222222222222222222222222',
    entityTxs: [],
  };

  p2p.sendDebugEvent = (payload: unknown) => {
    debugEvents.push(payload);
    return true;
  };
  p2p.refreshGossip = () => undefined;
  p2p.resolveTransportClient = () => ({ client: relayClient, transport: 'relay' });
  p2p.pendingByRuntime = new Map([[
    TARGET_RUNTIME_ID,
    [{ input, enqueuedAt: Date.now(), ingressTimestamp: 8888 }],
  ]]);

  (p2p as any).flushPending();

  expect((p2p.pendingByRuntime as Map<string, unknown[]>).get(TARGET_RUNTIME_ID)).toBeUndefined();
  expect(debugEvents.at(-1)).toMatchObject({
    level: 'error',
    code: 'P2P_PENDING_DELIVERY_DROPPED',
    targetRuntimeId: TARGET_RUNTIME_ID,
    entityId: SOURCE_ENTITY_ID,
    transport: 'relay',
    delivery: {
      outcome: 'failed',
      code: 'P2P_SEND_THROW',
      retryable: false,
      fatal: true,
      terminal: true,
    },
  });
});
