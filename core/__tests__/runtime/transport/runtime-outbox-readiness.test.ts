import { afterEach, describe, expect, test } from 'bun:test';

import { createEmptyEnv } from '../../../runtime';
import { deriveSignerAddressSync } from '../../../account/crypto';
import { deriveEncryptionKeyPair } from '../../../protocol/crypto/p2p-crypto';
import { createDirectRuntimeWsRoute } from '../../../network/p2p/direct-runtime-bun';
import { RuntimeWsClient } from '../../../network/p2p/ws-client';
import { directRuntimeWsAudience } from '../../../network/p2p/ws-protocol';
import { ensureRuntimeInfrastructure } from '../../../runtime/envelope/replica-envelope';
import { createRuntimeRoutingApi } from '../../../runtime/loop/loop-routing';
import { notifyRuntimeStateChanged } from '../../../runtime/frame/notifications';
import {
  dispatchCommittedEntityOutputs,
  flushCommittedNetworkOutputs,
} from '../../../runtime/frame/dispatch';
import { createPreparedOutputGraph } from '../../../runtime/delivery/prepared-output';
import { validateDeliverableEntityInput } from '../../../runtime/delivery/topology/routing-validation';
import type { RuntimeEntityInputsEnvelope, RoutedEntityInput } from '../../../runtime/types';

const SERVER_SEED = 'runtime-outbox-readiness-server';
const SERVER_ID = deriveSignerAddressSync(SERVER_SEED, '1').toLowerCase();
const clients: RuntimeWsClient[] = [];
const stopServers: Array<() => void> = [];

afterEach(async () => {
  try {
    await Promise.all(clients.splice(0).map(client => client.closeAndWait()));
  } finally {
    for (const stop of stopServers.splice(0)) stop();
  }
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt += 1) await Bun.sleep(5);
  expect(predicate()).toBe(true);
};

const outputFor = (runtimeId: string, entityByte: string): RoutedEntityInput =>
  validateDeliverableEntityInput({
    runtimeId,
    entityId: `0x${entityByte.repeat(32)}`,
    signerId: runtimeId,
    entityTxs: [],
    sourceRuntimeFrame: { height: 7, timestamp: 123 },
  });

const expectedEnvelope = (output: RoutedEntityInput): RuntimeEntityInputsEnvelope => {
  const { sourceRuntimeFrame, ...input } = output;
  if (!sourceRuntimeFrame) throw new Error('TEST_COMMITTED_FRAME_MISSING');
  return {
    sourceRuntimeId: SERVER_ID,
    sourceRuntimeHeight: sourceRuntimeFrame.height,
    sourceRuntimeTimestamp: sourceRuntimeFrame.timestamp,
    entityInputs: [validateDeliverableEntityInput(input)],
  };
};

const createTransport = () => {
  const inbound: RuntimeEntityInputsEnvelope[] = [];
  const failures: string[] = [];
  const readiness: Array<{ runtimeId: string; ready: boolean }> = [];
  const route = createDirectRuntimeWsRoute({
    runtimeId: SERVER_ID,
    runtimeSeed: SERVER_SEED,
    onEntityInputs: (_from, envelope) => { inbound.push(envelope); },
    onDeliveryFailure: failure => { failures.push(failure.error); },
    onRecoveryBundleRequest: (_from, lookupKey) => ({ lookupKey }),
  });
  route.onDeliveryReadyChange((runtimeId, ready) => { readiness.push({ runtimeId, ready }); });
  const server = Bun.serve<{ type: 'direct-runtime' }>({
    hostname: '127.0.0.1', port: 0,
    fetch(request, bunServer) {
      const decision = route.maybeUpgrade(request, bunServer);
      return decision.handled ? decision.response : new Response('websocket only', { status: 400 });
    },
    websocket: route.websocket,
  });
  stopServers.push(() => server.stop(true));
  const connect = async (seed: string) => {
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const envelopes: RuntimeEntityInputsEnvelope[] = [];
    const errors: string[] = [];
    const client = new RuntimeWsClient({
      url: `ws://127.0.0.1:${server.port}${route.path}`,
      runtimeId,
      helloAudience: directRuntimeWsAudience(SERVER_ID),
      signerId: '1', seed,
      encryptionKeyPair: deriveEncryptionKeyPair(seed),
      getTargetEncryptionKey: () => deriveEncryptionKeyPair(SERVER_SEED).publicKey,
      onEntityInputs: (_from, envelope) => { envelopes.push(envelope); },
      onError: error => { errors.push(error.message); },
    });
    clients.push(client);
    await client.connect();
    await waitFor(() => client.isOpen() && route.hasOpenSession(runtimeId));
    return { runtimeId, client, envelopes, errors };
  };
  return { route, connect, inbound, failures, readiness };
};

describe('committed Runtime outbox recipient readiness', () => {
  test('retires only the ready peer; the original blocked output leaves once after authenticated readiness', async () => {
    const env = createEmptyEnv(SERVER_SEED, 1);
    env.state.height = 7;
    env.state.timestamp = 123;
    const transport = createTransport();
    const first = await transport.connect('runtime-outbox-ready-peer');
    const second = await transport.connect('runtime-outbox-blocked-peer');
    const routing = createRuntimeRoutingApi({ notifyEnvChange: notifyRuntimeStateChanged });
    const deps = routing.getRuntimeOutputRoutingDeps();
    ensureRuntimeInfrastructure(env).directEntityInputsDispatch = transport.route.sendEntityInputsDelivery;
    transport.route.setReady(true);
    first.client.setReady(true);
    await waitFor(() => transport.route.canDeliver(first.runtimeId));
    expect(transport.route.canDeliver(second.runtimeId)).toBe(false);

    // Enter at the committed-outbox boundary. Authentication, envelope
    // construction, dispatch, recipient readiness, and retirement are real.
    const readyOutput = outputFor(first.runtimeId, '31');
    const blockedOutput = outputFor(second.runtimeId, '32');
    env.pendingNetworkOutputs = [readyOutput, blockedOutput];
    await dispatchCommittedEntityOutputs(env, new Set(), {
      remoteOutputs: [
        { output: readyOutput, targetRuntimeId: first.runtimeId },
        { output: blockedOutput, targetRuntimeId: second.runtimeId },
      ],
      preparedOutputGraph: createPreparedOutputGraph(),
    }, deps);
    await waitFor(() => first.envelopes.length === 1);
    expect(first.envelopes).toEqual([expectedEnvelope(readyOutput)]);
    expect(second.envelopes).toEqual([]);
    expect(env.pendingNetworkOutputs).toEqual([blockedOutput]);
    expect(env.pendingNetworkOutputs?.[0]?.sourceRuntimeFrame).toBe(blockedOutput.sourceRuntimeFrame);
    expect(env.pendingNetworkOutputs?.[0]?.entityTxs).toBe(blockedOutput.entityTxs);

    // An unrelated wake may attempt the remaining outbox while the second
    // Runtime still catches up. It must not resend the first peer's unit.
    await flushCommittedNetworkOutputs(env, deps);
    expect(env.pendingNetworkOutputs).toEqual([blockedOutput]);
    expect(second.envelopes).toEqual([]);
    second.client.setReady(true);
    await waitFor(() => transport.route.canDeliver(second.runtimeId));
    expect(transport.readiness).toContainEqual({ runtimeId: second.runtimeId, ready: true });
    await flushCommittedNetworkOutputs(env, deps);
    await waitFor(() => second.envelopes.length === 1);
    expect(second.envelopes).toEqual([expectedEnvelope(blockedOutput)]);
    expect(env.pendingNetworkOutputs).toEqual([]);
    await flushCommittedNetworkOutputs(env, deps);
    await Promise.all([
      first.client.requestRecoveryBundles(SERVER_ID, 'first-drained'),
      second.client.requestRecoveryBundles(SERVER_ID, 'second-drained'),
    ]);
    expect(first.envelopes).toHaveLength(1);
    expect(second.envelopes).toHaveLength(1);
    expect(env.state.height).toBe(7);
    expect(env.state.timestamp).toBe(123);
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(transport.failures).toEqual([]);
    expect(transport.inbound).toEqual([]);
  });
});
