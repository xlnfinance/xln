import { describe, expect, test } from 'bun:test';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account/crypto';
import {
  commitReliableIngress,
  finalizeReliableIngressCommit,
  registerReliableIngress,
} from '../machine/reliable-delivery';
import { buildDurableRuntimeMachineSnapshot, restoreDurableRuntimeSnapshot } from '../wal/snapshot';
import { createEmptyEnv } from '../runtime';
import type { DeliverableEntityInput, EntityReplica, Env, JPrefixAttestation } from '../types';

const entityId = (byte: string): string => `0x${byte.repeat(32)}`;
const signerId = (byte: string): string => `0x${byte.repeat(20)}`;

const runtime = (seed: string): Env => {
  const env = createEmptyEnv(seed);
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  registerSignerKey(env, runtimeId, deriveSignerKeySync(seed, '1'));
  env.runtimeId = runtimeId;
  env.runtimeSeed = seed;
  env.runtimeState ??= {};
  return env;
};

const jPrefixOutput = (
  receiverRuntimeId: string,
  scannedThroughHeight: number,
  signatureByte: string,
): DeliverableEntityInput => {
  const sourceValidatorId = signerId('c3');
  const attestation: JPrefixAttestation = {
    version: 1,
    entityId: entityId('b1'),
    targetEntityHeight: 1,
    parentFrameHash: 'genesis',
    validatorId: sourceValidatorId,
    jurisdictionRef: 'stack:31337:0x00000000000000000000000000000000000000aa',
    baseHeight: 10,
    scannedThroughHeight,
    tipBlockHash: `0x${scannedThroughHeight.toString(16).padStart(64, '0')}`,
    eventHistoryRoot: `0x${'41'.repeat(32)}`,
    rangeHash: `0x${'42'.repeat(32)}`,
    headers: Array.from({ length: scannedThroughHeight - 10 }, (_, index) => ({
      jHeight: 11 + index,
      jBlockHash: `0x${(11 + index).toString(16).padStart(64, '0')}`,
    })),
    blocks: [],
    signature: `0x${signatureByte.repeat(65)}`,
  };
  return {
    runtimeId: receiverRuntimeId,
    entityId: entityId('b1'),
    signerId: signerId('b2'),
    jPrefixAttestations: new Map([[sourceValidatorId, attestation]]),
  };
};

const installTargetReplica = (
  env: Env,
  output: DeliverableEntityInput,
  entityHeight: number,
  retainAppliedRound: boolean,
): void => {
  const attestation = output.jPrefixAttestations?.values().next().value;
  if (!attestation) throw new Error('TEST_J_PREFIX_ATTESTATION_MISSING');
  env.eReplicas.set(`${output.entityId}:${output.signerId}`, {
    entityId: output.entityId,
    signerId: output.signerId,
    isProposer: false,
    mempool: [],
    state: {
      entityId: output.entityId,
      height: entityHeight,
      prevFrameHash: entityHeight === 0 ? 'genesis' : `0x${'a7'.repeat(32)}`,
      lastFinalizedJHeight: 10,
      jBlockChain: [],
      accounts: new Map(),
      config: {
        mode: 'proposer-based',
        threshold: 1n,
        validators: [attestation.validatorId],
        shares: { [attestation.validatorId]: 1n },
        jurisdiction: {
          name: 'ReliableJPrefixFrontier',
          address: 'http://127.0.0.1:8545',
          chainId: 31337,
          depositoryAddress: '0x00000000000000000000000000000000000000aa',
        },
      },
    },
    ...(retainAppliedRound
      ? {
          jPrefixRound: {
            targetEntityHeight: attestation.targetEntityHeight,
            parentFrameHash: attestation.parentFrameHash,
            jurisdictionRef: attestation.jurisdictionRef,
            baseHeight: attestation.baseHeight,
            attestations: new Map([[attestation.validatorId, structuredClone(attestation)]]),
          },
        }
      : {}),
  } as unknown as EntityReplica);
};

describe('reliable applied J-prefix active frontier', () => {
  test('retires after restart when the target Entity height commits without retaining its attestation', () => {
    const sender = runtime('reliable-j-prefix-frontier-sender');
    const receiver = runtime('reliable-j-prefix-frontier-receiver');
    const output = jPrefixOutput(receiver.runtimeId!, 11, '51');
    installTargetReplica(receiver, output, 0, true);

    expect(registerReliableIngress(receiver, sender.runtimeId!, output).kind).toBe('enqueue');
    const applied = commitReliableIngress(receiver, [output]);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.receipt?.body.coverage).toBe('exact');
    finalizeReliableIngressCommit(receiver, applied);
    expect(receiver.runtimeState?.reliableIngressReceiptLedger?.size).toBe(1);

    const restored = runtime('reliable-j-prefix-frontier-receiver');
    restoreDurableRuntimeSnapshot(restored, buildDurableRuntimeMachineSnapshot(receiver));
    installTargetReplica(restored, output, 1, false);

    const retired = commitReliableIngress(restored, []);
    expect(retired).toHaveLength(1);
    expect(retired[0]?.receipt).toBeNull();
    expect(restored.runtimeState?.reliableIngressReceiptLedger?.size).toBe(0);
    expect(restored.runtimeState?.reliableIngressTerminalWatermarks?.size).toBe(1);
    expect(registerReliableIngress(restored, sender.runtimeId!, output).kind).toBe('receipt');

    const conflicting = jPrefixOutput(restored.runtimeId!, 12, '52');
    expect(() => registerReliableIngress(restored, sender.runtimeId!, conflicting))
      .toThrow('RELIABLE_FRONTIER_LANE_ORDER_CONFLICT:j-prefix-attestation:1');
  });

  test('does not terminalize an unapplied pending attestation from Entity height alone', () => {
    const sender = runtime('reliable-j-prefix-pending-sender');
    const receiver = runtime('reliable-j-prefix-pending-receiver');
    const output = jPrefixOutput(receiver.runtimeId!, 11, '61');
    installTargetReplica(receiver, output, 1, false);

    expect(registerReliableIngress(receiver, sender.runtimeId!, output).kind).toBe('enqueue');
    expect(commitReliableIngress(receiver, [])).toEqual([]);
    expect(receiver.runtimeState?.pendingReliableIngress?.size).toBe(1);
    expect(receiver.runtimeState?.reliableIngressTerminalWatermarks?.size ?? 0).toBe(0);
  });
});
