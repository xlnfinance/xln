import { expect, test } from 'bun:test';

import type { RoutedEntityInput, RuntimeEntityInputsEnvelope } from '../types';
import { RuntimeP2P } from '../networking/p2p';

const TARGET_RUNTIME_ID = '0x1111111111111111111111111111111111111111';
const SOURCE_RUNTIME_ID = '0x3333333333333333333333333333333333333333';
const SOURCE_ENTITY_ID = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const envelopeFor = (input: RoutedEntityInput): RuntimeEntityInputsEnvelope => ({
  sourceRuntimeId: SOURCE_RUNTIME_ID,
  sourceRuntimeHeight: 7,
  sourceRuntimeTimestamp: 7000,
  entityInputs: [{ ...input, runtimeId: TARGET_RUNTIME_ID }],
});

test('enqueueEntityInputsDelivery starts profile prefetch before transport resolution', () => {
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

  expect(() => p2p.enqueueEntityInputsDelivery(TARGET_RUNTIME_ID, envelopeFor(input))).toThrow(/P2P_ENTITY_INPUTS_NOT_DELIVERED/);

  expect(prefetched).toBe(true);
  expect(resolvedAfterPrefetch).toBe(true);
});

test('enqueueEntityInputsDelivery reports typed delivery result when no transport is open', () => {
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

  const input: RoutedEntityInput = {
    entityId: SOURCE_ENTITY_ID,
    signerId: '0x2222222222222222222222222222222222222222',
    entityTxs: [],
  };

  expect(() => p2p.enqueueEntityInputsDelivery(TARGET_RUNTIME_ID, envelopeFor(input))).toThrow(/P2P_ENTITY_INPUTS_NOT_DELIVERED/);
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

test('enqueueEntityInputsDelivery reports typed delivery result when transport send returns false', () => {
  const p2p = Object.create(RuntimeP2P.prototype) as RuntimeP2P & Record<string, any>;
  const debugEvents: unknown[] = [];
  const warnings: unknown[][] = [];
  const relayClient = {
    isOpen: () => true,
    sendEntityInputsRaw: () => false,
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

  const input: RoutedEntityInput = {
    entityId: SOURCE_ENTITY_ID,
    signerId: '0x2222222222222222222222222222222222222222',
    entityTxs: [],
  };

  expect(() => p2p.enqueueEntityInputsDelivery(TARGET_RUNTIME_ID, envelopeFor(input))).toThrow(/P2P_ENTITY_INPUTS_NOT_DELIVERED/);
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

test('enqueueEntityInputsDelivery refreshes gossip from typed no-pubkey delivery code', () => {
  const p2p = Object.create(RuntimeP2P.prototype) as RuntimeP2P & Record<string, any>;
  const debugEvents: unknown[] = [];
  let refreshes = 0;
  const relayClient = {
    isOpen: () => true,
    sendEntityInputsRaw: () => {
      throw new Error('P2P_NO_PUBKEY missing gossip profile');
    },
  };

  p2p.env = {
    warn: () => undefined,
  };
  p2p.sendDebugEvent = (payload: unknown) => {
    debugEvents.push(payload);
    return true;
  };
  p2p.refreshGossip = () => {
    refreshes += 1;
  };
  p2p.ensureRelayConnectionsForEntity = () => undefined;
  p2p.prefetchProfilesForInput = () => undefined;
  p2p.resolveTransportClient = () => ({ client: relayClient, transport: 'relay' });
  p2p.clients = [relayClient];
  p2p.directClients = new Map();
  p2p.directClientUrls = new Map();
  p2p.directClientErrors = new Map();

  const input: RoutedEntityInput = {
    entityId: SOURCE_ENTITY_ID,
    signerId: '0x2222222222222222222222222222222222222222',
    entityTxs: [],
  };

  expect(() => p2p.enqueueEntityInputsDelivery(TARGET_RUNTIME_ID, envelopeFor(input))).toThrow(/P2P_ENTITY_INPUTS_SEND_THROW/);
  expect(refreshes).toBe(1);
  expect(debugEvents.at(-1)).toMatchObject({
    level: 'error',
    code: 'P2P_NO_PUBKEY_DELIVERY_FAILED',
    targetRuntimeId: TARGET_RUNTIME_ID,
    entityIds: [SOURCE_ENTITY_ID],
    transport: 'relay',
    delivery: {
      outcome: 'failed',
      code: 'P2P_NO_PUBKEY',
      retryable: true,
      fatal: false,
      terminal: false,
    },
  });
});

test('enqueueEntityInputsDelivery uses official relay when advertised hub direct endpoint is not open', () => {
  const p2p = Object.create(RuntimeP2P.prototype) as RuntimeP2P & Record<string, any>;
  const sent: Array<{ to: string; input: RoutedEntityInput; timestamp?: number }> = [];
  const debugEvents: unknown[] = [];

  const relayClient = {
    isOpen: () => true,
    sendEntityInputsRaw: (to: string, input: RuntimeEntityInputsEnvelope, timestamp?: number) => {
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

  expect(p2p.enqueueEntityInputsDelivery(TARGET_RUNTIME_ID, envelopeFor(input), 1234)).toMatchObject({
    outcome: 'delivered',
    code: 'P2P_ENTITY_INPUT_HANDED_TO_TRANSPORT',
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
});

test('enqueueEntityInputsDelivery returns typed success with transport', () => {
  const p2p = Object.create(RuntimeP2P.prototype) as RuntimeP2P & Record<string, any>;
  const sent: Array<{ to: string; input: RoutedEntityInput; timestamp?: number }> = [];
  const relayClient = {
    isOpen: () => true,
    sendEntityInputsRaw: (to: string, input: RuntimeEntityInputsEnvelope, timestamp?: number) => {
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

  const input: RoutedEntityInput = {
    entityId: SOURCE_ENTITY_ID,
    signerId: '0x2222222222222222222222222222222222222222',
    entityTxs: [],
  };

  expect(p2p.enqueueEntityInputsDelivery(TARGET_RUNTIME_ID, envelopeFor(input), 2345)).toMatchObject({
    outcome: 'delivered',
    code: 'P2P_ENTITY_INPUT_HANDED_TO_TRANSPORT',
    retryable: false,
    fatal: false,
    terminal: true,
    transport: 'relay',
  });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.timestamp).toBe(2345);
});

test('enqueueEntityInputsDelivery relays an intent-only cross-j envelope', () => {
  const p2p = Object.create(RuntimeP2P.prototype) as RuntimeP2P & Record<string, any>;
  const sent: RuntimeEntityInputsEnvelope[] = [];
  const relayClient = {
    isOpen: () => true,
    sendEntityInputsRaw: (_to: string, envelope: RuntimeEntityInputsEnvelope) => {
      sent.push(envelope);
      return true;
    },
  };

  p2p.env = { warn: () => undefined };
  p2p.sendDebugEvent = () => true;
  p2p.resolveTransportClient = () => ({ client: relayClient, transport: 'relay' });
  p2p.clients = [relayClient];
  p2p.directClients = new Map();
  p2p.directClientUrls = new Map();
  p2p.directClientErrors = new Map();

  const envelope = {
    sourceRuntimeId: SOURCE_RUNTIME_ID,
    sourceRuntimeHeight: 8,
    sourceRuntimeTimestamp: 8000,
    entityInputs: [],
    crossJurisdictionIntent: { orderId: 'intent-only' },
  } as unknown as RuntimeEntityInputsEnvelope;

  expect(p2p.enqueueEntityInputsDelivery(TARGET_RUNTIME_ID, envelope)).toMatchObject({
    outcome: 'delivered',
    transport: 'relay',
  });
  expect(sent).toEqual([envelope]);
});

test('enqueueEntityInputsDelivery prefers open direct transport over relay', () => {
  const p2p = Object.create(RuntimeP2P.prototype) as RuntimeP2P & Record<string, any>;
  const relaySent: unknown[] = [];
  const directSent: Array<{ to: string; input: RoutedEntityInput; timestamp?: number }> = [];

  const relayClient = {
    isOpen: () => true,
    sendEntityInputsRaw: () => {
      relaySent.push(true);
      return true;
    },
  };
  const directClient = {
    isOpen: () => true,
    isConnecting: () => false,
    sendEntityInputsRaw: (to: string, input: RuntimeEntityInputsEnvelope, timestamp?: number) => {
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

  const input: RoutedEntityInput = {
    entityId: SOURCE_ENTITY_ID,
    signerId: '0x2222222222222222222222222222222222222222',
    entityTxs: [],
  };

  expect(p2p.enqueueEntityInputsDelivery(TARGET_RUNTIME_ID, envelopeFor(input), 5678)).toMatchObject({
    outcome: 'delivered',
    code: 'P2P_ENTITY_INPUT_HANDED_TO_TRANSPORT',
    transport: 'direct',
  });
  expect(directSent).toHaveLength(1);
  expect(directSent[0]?.to).toBe(TARGET_RUNTIME_ID);
  expect(directSent[0]?.timestamp).toBe(5678);
  expect(relaySent).toHaveLength(0);
});

test('enqueueEntityInputsDelivery uses relay when direct transport is not authoritative for entity inputs', () => {
  const p2p = Object.create(RuntimeP2P.prototype) as RuntimeP2P & Record<string, any>;
  const relaySent: Array<{ to: string; input: RoutedEntityInput; timestamp?: number }> = [];
  const directSent: unknown[] = [];

  const relayClient = {
    isOpen: () => true,
    sendEntityInputsRaw: (to: string, input: RuntimeEntityInputsEnvelope, timestamp?: number) => {
      relaySent.push({ to, input, timestamp });
      return true;
    },
  };
  const directClient = {
    isOpen: () => true,
    isConnecting: () => false,
    sendEntityInputsRaw: () => {
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

  expect(p2p.enqueueEntityInputsDelivery(TARGET_RUNTIME_ID, envelopeFor(input), 6789)).toMatchObject({
    outcome: 'delivered',
    code: 'P2P_ENTITY_INPUT_HANDED_TO_TRANSPORT',
    transport: 'relay',
  });
  expect(relaySent).toHaveLength(1);
  expect(relaySent[0]?.to).toBe(TARGET_RUNTIME_ID);
  expect(relaySent[0]?.timestamp).toBe(6789);
  expect(directSent).toHaveLength(0);
});

test('getQueueState reports the runtime-owned durable outbox', () => {
  const p2p = Object.create(RuntimeP2P.prototype) as RuntimeP2P & Record<string, any>;
  p2p.env = {
    timestamp: 1_500,
    pendingNetworkOutputs: [{
      runtimeId: TARGET_RUNTIME_ID,
      entityId: SOURCE_ENTITY_ID,
      signerId: '0x2222222222222222222222222222222222222222',
      entityTxs: [],
      sourceRuntimeFrame: { height: 7, timestamp: 1_000 },
    }],
  };

  expect(p2p.getQueueState()).toEqual({
    targetCount: 1,
    totalMessages: 1,
    oldestEntryAge: 500,
    perTarget: { [TARGET_RUNTIME_ID]: 1 },
  });
});

test('verified profile routes advance monotonically and never replay backward', () => {
  const p2p = Object.create(RuntimeP2P.prototype) as RuntimeP2P & Record<string, any>;
  p2p.env = { runtimeState: {} };
  p2p.verifiedProfileRoutes = new Map();
  const profile = (runtimeId: string, lastUpdated: number) => ({
    entityId: SOURCE_ENTITY_ID,
    runtimeId,
    runtimeEncPubKey: `0x${'11'.repeat(32)}`,
    lastUpdated,
  });

  p2p.rememberVerifiedProfileRoute(profile(TARGET_RUNTIME_ID, 20));
  p2p.rememberVerifiedProfileRoute(profile('0x3333333333333333333333333333333333333333', 10));

  expect(p2p.getVerifiedRuntimeRoute(SOURCE_ENTITY_ID)).toEqual({
    runtimeId: TARGET_RUNTIME_ID,
    lastUpdated: 20,
  });
  expect(p2p.env.runtimeState.verifiedProfileRoutes).toBe(p2p.verifiedProfileRoutes);
});
