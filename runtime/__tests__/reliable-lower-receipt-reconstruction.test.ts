import { describe, expect, test } from 'bun:test';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account/crypto';
import {
  commitReliableIngress,
  finalizeReliableIngressCommit,
  registerReliableIngress,
  rollbackReliableIngressCommit,
} from '../machine/reliable-delivery';
import {
  MAX_RELIABLE_INGRESS_SOURCE_LANES,
  receiverFrontierKey,
} from '../machine/reliable-frontier';
import {
  buildCanonicalEntityReplicaSnapshot,
  buildDurableRuntimeMachineSnapshot,
  restoreDurableRuntimeSnapshot,
} from '../wal/snapshot';
import { createEmptyEnv, process as processRuntime } from '../runtime';
import type { Env } from '../types';
import {
  buildCatchupFixtureCertificate,
  catchupFixtureDeliverable,
  createCatchupFixtureState,
  prepareCatchupFixtureReplica,
  registerCatchupFixtureSigners,
} from './fixtures/reliable-local-catchup-fixture';

const runtime = (seed: string): Env => {
  const env = createEmptyEnv(seed);
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  registerSignerKey(env, runtimeId, deriveSignerKeySync(seed, '1'));
  env.runtimeId = runtimeId;
  env.runtimeSeed = seed;
  env.runtimeState ??= {};
  env.scenarioMode = true;
  env.quietRuntimeLogs = true;
  env.runtimeConfig = { storage: { enabled: false } };
  return env;
};

describe('bounded lower reliable receipt reconstruction', () => {
  test('retains source A H1 after source B advances the same lane to H2 and history is pruned', async () => {
    const receiverSeed = 'reliable lower receipt receiver';
    const receiver = runtime(receiverSeed);
    const sourceA = runtime('reliable lower receipt source a');
    const sourceB = runtime('reliable lower receipt source b');
    const fixtureSeed = 'reliable lower receipt entity';
    const { leaderSignerId, targetSignerId } = registerCatchupFixtureSigners(receiver, fixtureSeed);
    const initialState = createCatchupFixtureState(leaderSignerId, targetSignerId);
    await prepareCatchupFixtureReplica(receiver, initialState, leaderSignerId, targetSignerId);

    const heightOne = await buildCatchupFixtureCertificate(receiver, initialState, 100);
    const heightTwo = await buildCatchupFixtureCertificate(receiver, heightOne.nextState, 200);
    const h1 = catchupFixtureDeliverable(
      receiver.runtimeId!,
      initialState.entityId,
      targetSignerId,
      heightOne.frame,
    );
    const h2 = catchupFixtureDeliverable(
      receiver.runtimeId!,
      initialState.entityId,
      targetSignerId,
      heightTwo.frame,
    );

    expect(registerReliableIngress(receiver, sourceA.runtimeId!, h1).kind).toBe('enqueue');
    await processRuntime(receiver, [h1]);
    expect(receiver.eReplicas.get(`${initialState.entityId}:${targetSignerId}`)?.state.height).toBe(1);

    expect(registerReliableIngress(receiver, sourceB.runtimeId!, h2).kind).toBe('enqueue');
    await processRuntime(receiver, [h2]);
    const replica = receiver.eReplicas.get(`${initialState.entityId}:${targetSignerId}`);
    expect(replica?.state.height).toBe(2);
    expect(replica?.certifiedFrameLineage?.some(link => link.frame.hash === heightOne.frame.hash)).toBe(true);

    const runtimeSnapshot = buildDurableRuntimeMachineSnapshot(receiver);
    const replicaSnapshot = buildCanonicalEntityReplicaSnapshot(replica!);
    delete replicaSnapshot.certifiedFrameLineage;
    delete replicaSnapshot.certifiedFrameAnchor;
    const restored = runtime(receiverSeed);
    restored.eReplicas.set(`${initialState.entityId}:${targetSignerId}`, replicaSnapshot);
    restoreDurableRuntimeSnapshot(restored, runtimeSnapshot);

    const retry = registerReliableIngress(restored, sourceA.runtimeId!, h1);
    expect(retry.kind).toBe('receipt');
    if (retry.kind !== 'receipt') throw new Error('TEST_EXACT_LOWER_RECEIPT_MISSING');
    expect(retry.receipt.body.coverage).toBe('terminal');
    expect(retry.receipt.body.identity.height).toBe(1);
    expect(retry.receipt.body.identity.frameHash).toBe(heightOne.frame.hash);
    expect(restored.runtimeState?.reliableIngressTerminalWatermarks?.size).toBe(2);
    expect(restored.runtimeState?.reliableIngressReceiptLedger?.size ?? 0).toBe(0);

    const proposal = structuredClone(h1);
    delete proposal.proposedFrame!.hankos;
    proposal.proposedFrame!.collectedSigs = new Map([[
      leaderSignerId,
      heightOne.frame.collectedSigs!.get(leaderSignerId)!,
    ]]);
    const proposalRetry = registerReliableIngress(restored, sourceA.runtimeId!, proposal);
    expect(proposalRetry.kind).toBe('receipt');
    if (proposalRetry.kind !== 'receipt') throw new Error('TEST_EXACT_LOWER_PROPOSAL_RECEIPT_MISSING');
    expect(proposalRetry.receipt.body.coverage).toBe('terminal');
    expect(proposalRetry.receipt.body.identity.evidenceKind).toBe('entity-certificate');

    const forgedProposal = structuredClone(proposal);
    forgedProposal.proposedFrame!.collectedSigs = new Map([[leaderSignerId, ['0xforged']]]);
    const forgedRetry = registerReliableIngress(restored, sourceA.runtimeId!, forgedProposal);
    expect(forgedRetry.kind).toBe('receipt');
    if (forgedRetry.kind !== 'receipt') throw new Error('TEST_TERMINAL_CERTIFICATE_RECEIPT_MISSING');
    expect(forgedRetry.receipt.body.identity.frameHash).toBe(heightOne.frame.hash);
  });

  test('fans one exact applied identity out to two source frontiers atomically', async () => {
    const receiverSeed = 'reliable fanout receiver';
    const receiver = runtime(receiverSeed);
    const sourceA = runtime('reliable fanout source a');
    const sourceB = runtime('reliable fanout source b');
    const fixtureSeed = 'reliable fanout entity';
    const { leaderSignerId, targetSignerId } = registerCatchupFixtureSigners(receiver, fixtureSeed);
    const initialState = createCatchupFixtureState(leaderSignerId, targetSignerId);
    await prepareCatchupFixtureReplica(receiver, initialState, leaderSignerId, targetSignerId);
    const heightOne = await buildCatchupFixtureCertificate(receiver, initialState, 100);
    const h1 = catchupFixtureDeliverable(
      receiver.runtimeId!,
      initialState.entityId,
      targetSignerId,
      heightOne.frame,
    );

    expect(registerReliableIngress(receiver, sourceA.runtimeId!, h1).kind).toBe('enqueue');
    expect(registerReliableIngress(receiver, sourceB.runtimeId!, h1).kind).toBe('pending');
    const replica = receiver.eReplicas.get(`${initialState.entityId}:${targetSignerId}`)!;
    replica.state = structuredClone(heightOne.nextState);

    const firstAttempt = commitReliableIngress(receiver, [h1]);
    expect(firstAttempt).toHaveLength(2);
    expect(receiver.runtimeState?.reliableIngressTerminalWatermarks?.size).toBe(2);
    rollbackReliableIngressCommit(receiver, firstAttempt);
    expect(receiver.runtimeState?.reliableIngressTerminalWatermarks?.size).toBe(0);
    expect(receiver.runtimeState?.reliableIngressReceiptLedger?.size).toBe(0);
    expect(receiver.runtimeState?.pendingReliableIngress?.size).toBe(1);

    const committed = commitReliableIngress(receiver, [h1]);
    const deliveries = finalizeReliableIngressCommit(receiver, committed);
    expect(committed).toHaveLength(2);
    expect(deliveries.map(entry => entry.runtimeId).sort()).toEqual([
      sourceA.runtimeId!,
      sourceB.runtimeId!,
    ].sort());
    expect(receiver.runtimeState?.reliableIngressTerminalWatermarks?.size).toBe(2);
    expect(receiver.runtimeState?.pendingReliableIngress?.size).toBe(0);

    const snapshot = buildDurableRuntimeMachineSnapshot(receiver);
    const restored = runtime(receiverSeed);
    restoreDurableRuntimeSnapshot(restored, snapshot);
    for (const source of [sourceA, sourceB]) {
      const retry = registerReliableIngress(restored, source.runtimeId!, h1);
      expect(retry.kind).toBe('receipt');
      if (retry.kind !== 'receipt') throw new Error('TEST_FANOUT_RECEIPT_MISSING');
      expect(retry.receipt.body.identity.frameHash).toBe(heightOne.frame.hash);
    }
  });

  test('hard cap preserves existing source lanes and rejects a new lane before mutation', async () => {
    const receiver = runtime('reliable source lane cap receiver');
    const source = runtime('reliable source lane cap source');
    const fixtureSeed = 'reliable source lane cap entity';
    const { leaderSignerId, targetSignerId } = registerCatchupFixtureSigners(receiver, fixtureSeed);
    const initialState = createCatchupFixtureState(leaderSignerId, targetSignerId);
    await prepareCatchupFixtureReplica(receiver, initialState, leaderSignerId, targetSignerId);
    const heightOne = await buildCatchupFixtureCertificate(receiver, initialState, 100);
    const h1 = catchupFixtureDeliverable(
      receiver.runtimeId!,
      initialState.entityId,
      targetSignerId,
      heightOne.frame,
    );
    expect(registerReliableIngress(receiver, source.runtimeId!, h1).kind).toBe('enqueue');
    const replica = receiver.eReplicas.get(`${initialState.entityId}:${targetSignerId}`)!;
    replica.state = structuredClone(heightOne.nextState);
    const committed = commitReliableIngress(receiver, [h1]);
    finalizeReliableIngressCommit(receiver, committed);
    const receipt = committed[0]?.receipt;
    if (!receipt) throw new Error('TEST_SOURCE_LANE_CAP_RECEIPT_MISSING');

    const sourceRuntimeIds = Array.from(
      { length: MAX_RELIABLE_INGRESS_SOURCE_LANES },
      (_, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`,
    );
    receiver.runtimeState!.reliableIngressTerminalWatermarks = new Map(
      sourceRuntimeIds.map(runtimeId => [
        receiverFrontierKey(runtimeId, receipt.body.identity),
        receipt,
      ]),
    );
    receiver.runtimeState!.reliableIngressReceiptLedger = new Map();

    expect(registerReliableIngress(receiver, sourceRuntimeIds[0]!, h1).kind).toBe('receipt');
    const before = receiver.runtimeState!.reliableIngressTerminalWatermarks.size;
    const newSource = `0x${(MAX_RELIABLE_INGRESS_SOURCE_LANES + 1).toString(16).padStart(40, '0')}`;
    expect(() => registerReliableIngress(receiver, newSource, h1))
      .toThrow('RELIABLE_INGRESS_SOURCE_LANE_CAPACITY_EXCEEDED');
    expect(receiver.runtimeState!.reliableIngressTerminalWatermarks.size).toBe(before);
    expect(receiver.runtimeState!.pendingReliableIngress?.size ?? 0).toBe(0);
  });
});
