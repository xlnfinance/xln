import { describe, expect, test } from 'bun:test';

import {
  buildPendingNetworkOutputs,
  dispatchEntityOutputs,
  getNextNetworkRetryTimestamp,
  getReliableOutputIdentity,
  hasReadyPendingNetworkOutputs,
  rescheduleDeferredOutputs,
  sendEntityInputWithRouting,
  type RuntimeOutputRoutingDeps,
} from '../machine/output-routing';
import {
  applyReliableDeliveryReceipts,
  createReliableDeliveryReceipt,
} from '../machine/reliable-delivery';
import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
} from '../account/crypto';
import { createEmptyEnv } from '../runtime';
import { deliveryAccepted, deliveryFailure } from '../protocol/payments/delivery-result';
import type { DeliverableEntityInput, Env, JPrefixAttestation, RoutedEntityInput } from '../types';

const runtimeId = (byte: string): string => `0x${byte.repeat(20)}`;
const entityId = (byte: string): string => `0x${byte.repeat(32)}`;

const targetRuntimeId = runtimeId('91');
const targetEntityId = entityId('92');
const targetSignerId = runtimeId('93');
const accountPeerId = entityId('94');

const entityFrameOutput = (
  height: number,
  target = targetEntityId,
  hankos?: string[],
): DeliverableEntityInput => ({
  runtimeId: targetRuntimeId,
  entityId: target,
  signerId: targetSignerId,
  proposedFrame: {
    height,
    timestamp: height,
    hash: `0xentity-frame-${height}`,
    txs: [],
    leader: { proposerSignerId: targetSignerId, view: 0 },
    collectedSigs: new Map([[targetSignerId, [`0xsignature-${height}`]]]),
    ...(hankos ? { hankos } : {}),
  } as never,
});

const accountAckOutput = (height: number): DeliverableEntityInput => ({
  runtimeId: targetRuntimeId,
  entityId: targetEntityId,
  signerId: targetSignerId,
  entityTxs: [{
    type: 'accountInput',
    data: {
      kind: 'ack',
      fromEntityId: accountPeerId,
      toEntityId: targetEntityId,
      ack: {
        height,
        frameHash: `0xaccount-frame-${height}`,
        frameHanko: `0xaccount-hanko-${height}`,
      },
    },
  } as never],
});

const jFinalityOutput = (height: number): DeliverableEntityInput => ({
  runtimeId: targetRuntimeId,
  entityId: targetEntityId,
  signerId: targetSignerId,
  entityTxs: [{
    type: 'j_event',
    data: {
      from: targetSignerId,
      jurisdictionRef: 'stack:31337:0x0000000000000000000000000000000000000095',
      baseHeight: height - 1,
      scannedThroughHeight: height,
      observedAt: height,
      blocks: [],
      tipBlockHash: `0xj-tip-${height}`,
      rangeHash: `0xj-range-${height}`,
      eventHistoryRoot: `0xj-root-${height}`,
      signature: `0xj-signature-${height}`,
    },
  } as never],
});

const hashPrecommitOutput = (height: number): DeliverableEntityInput => ({
  runtimeId: targetRuntimeId,
  entityId: targetEntityId,
  signerId: targetSignerId,
  hashPrecommitFrame: {
    height,
    frameHash: `0xentity-frame-${height}`,
  },
  hashPrecommits: new Map([[runtimeId('96'), [`0xprecommit-${height}`]]]),
} as never);

const jPrefixOutput = (height: number): DeliverableEntityInput => {
  const sourceValidatorId = runtimeId('96');
  const scannedThroughHeight = 10 + height;
  const attestation: JPrefixAttestation = {
    version: 1,
    entityId: targetEntityId,
    targetEntityHeight: height,
    parentFrameHash: height === 1 ? 'genesis' : `0x${'31'.repeat(32)}`,
    validatorId: sourceValidatorId,
    jurisdictionRef: 'stack:31337:0x0000000000000000000000000000000000000095',
    baseHeight: 10,
    scannedThroughHeight,
    tipBlockHash: `0x${scannedThroughHeight.toString(16).padStart(64, '0')}`,
    eventHistoryRoot: `0x${'32'.repeat(32)}`,
    rangeHash: `0x${'33'.repeat(32)}`,
    headers: Array.from({ length: height }, (_, index) => ({
      jHeight: 11 + index,
      jBlockHash: `0x${(11 + index).toString(16).padStart(64, '0')}`,
    })),
    blocks: [],
    signature: `0x${height.toString(16).padStart(2, '0').repeat(65)}`,
  };
  return {
    runtimeId: targetRuntimeId,
    entityId: targetEntityId,
    signerId: targetSignerId,
    jPrefixAttestations: new Map([[sourceValidatorId, attestation]]),
  };
};

const reliableOrder = (output: RoutedEntityInput): number => {
  if (output.proposedFrame) return output.proposedFrame.height;
  if ((output as RoutedEntityInput & { hashPrecommitFrame?: { height: number } }).hashPrecommitFrame) {
    return (output as RoutedEntityInput & { hashPrecommitFrame: { height: number } }).hashPrecommitFrame.height;
  }
  for (const tx of output.entityTxs ?? []) {
    if (tx.type === 'accountInput' && (tx.data.kind === 'ack' || tx.data.kind === 'frame_ack')) {
      return tx.data.ack.height;
    }
    if (tx.type === 'j_event') return tx.data.scannedThroughHeight;
  }
  const prefix = output.jPrefixAttestations?.values().next().value;
  if (prefix) return prefix.targetEntityHeight;
  throw new Error('TEST_RELIABLE_OUTPUT_IDENTITY_MISSING');
};

const routingDeps = (
  getP2P: RuntimeOutputRoutingDeps['getP2P'],
): RuntimeOutputRoutingDeps => ({
  ensureRuntimeState: env => env.runtimeState!,
  getP2P,
  enqueueRuntimeInputs: () => {},
  extractEntityId: replicaKey => String(replicaKey).split(':')[0] || '',
  hasLocalSignerForEntity: () => false,
  hasLocalSignerForEntitySigner: () => false,
  resolveSoleLocalSignerForEntity: () => null,
  resolveRuntimeIdForEntity: () => targetRuntimeId,
  resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
});

const orderedCases = [
  ['entity frame', entityFrameOutput],
  ['hash precommit', hashPrecommitOutput],
  ['account ACK', accountAckOutput],
  ['J-prefix attestation', jPrefixOutput],
  ['J finality', jFinalityOutput],
] as const;

const receiptGatedCases = orderedCases.filter(([label]) => label !== 'account ACK');

describe('ordered reliable output lanes', () => {
  test('keeps Account ACK retry cadence below the bilateral liveness timeout', () => {
    const output = accountAckOutput(5);
    const env = {
      scenarioMode: true,
      timestamp: 0,
      runtimeState: {},
      pendingNetworkOutputs: [],
    } as unknown as Env;
    const deps = {
      ensureRuntimeState: (targetEnv: Env) => targetEnv.runtimeState ??= {},
    } as RuntimeOutputRoutingDeps;
    let pending: RoutedEntityInput[] = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      pending = rescheduleDeferredOutputs(env, pending, [output], [], deps);
      env.pendingNetworkOutputs = pending;
      const nextRetryAt = getNextNetworkRetryTimestamp(env, deps);
      expect(nextRetryAt).not.toBeNull();
      expect(nextRetryAt! - env.timestamp).toBeLessThanOrEqual(4_000);
      env.timestamp = nextRetryAt!;
    }
  });

  for (const [label, createOutput] of receiptGatedCases) {
    test(`${label}: a transient lower-height failure blocks higher output in the same dispatch`, () => {
      const attempted: number[] = [];
      const env = {
        runtimeId: runtimeId('90'),
        timestamp: 1_000,
        runtimeState: {},
        warn: () => {},
        error: () => {},
      } as unknown as Env;
      const outputs = [createOutput(2), createOutput(1)];
      const deferred = dispatchEntityOutputs(
        env,
        outputs.map(output => ({ output, targetRuntimeId })),
        routingDeps(() => ({
          enqueueEntityInputDelivery: (_runtimeId, output) => {
            const order = reliableOrder(output);
            attempted.push(order);
            return order === 1
              ? deliveryFailure({
                  category: 'TransientRace',
                  code: 'TEST_LOWER_HEIGHT_DEFERRED',
                  message: 'lower output is temporarily unavailable',
                  terminal: false,
                })
              : deliveryAccepted('TEST_HIGHER_HEIGHT_DELIVERED');
          },
        })),
      );

      expect(attempted).toEqual([1]);
      expect(deferred.map(reliableOrder)).toEqual([1, 2]);
    });

    test(`${label}: a lower-height retry window blocks a newly produced higher output`, () => {
      let transportAvailable = false;
      const attempted: number[] = [];
      const env = {
        runtimeId: runtimeId('90'),
        timestamp: 1_000,
        runtimeState: {},
        pendingNetworkOutputs: [],
        warn: () => {},
        error: () => {},
      } as unknown as Env;
      const deps = routingDeps(() => transportAvailable
        ? {
            enqueueEntityInputDelivery: (_runtimeId, output) => {
              attempted.push(reliableOrder(output));
              return deliveryAccepted('TEST_DELIVERED');
            },
          }
        : null);

      sendEntityInputWithRouting(env, createOutput(1), deps);
      transportAvailable = true;
      sendEntityInputWithRouting(env, createOutput(2), deps);

      expect(attempted).toEqual([]);
      expect((env.pendingNetworkOutputs ?? []).map(reliableOrder)).toEqual([1, 2]);
    });

  }

  for (const [label, createOutput] of orderedCases) {
    test(`${label}: pending outputs use numeric height order`, () => {
      const pending = buildPendingNetworkOutputs([2, 10, 11, 100].map(createOutput));
      expect(pending.map(reliableOrder)).toEqual([2, 10, 11, 100]);
    });
  }

  test('a new sparse ACK H8 wakes backed-off H5, then H8 waits for the exact H5 receipt', () => {
    let transportAvailable = false;
    const attempted: number[] = [];
    const receiver = createEmptyEnv('sparse-account-ack-receiver');
    receiver.runtimeId = deriveSignerAddressSync('sparse-account-ack-receiver', '1').toLowerCase();
    registerSignerKey(
      receiver,
      receiver.runtimeId,
      deriveSignerKeySync('sparse-account-ack-receiver', '1'),
    );
    const h5 = { ...accountAckOutput(5), runtimeId: receiver.runtimeId };
    const h8 = { ...accountAckOutput(8), runtimeId: receiver.runtimeId };
    const env = {
      runtimeId: runtimeId('90'),
      timestamp: 1_000,
      runtimeState: {},
      pendingNetworkOutputs: [],
      warn: () => {},
      error: () => {},
    } as unknown as Env;
    const deps = routingDeps(() => transportAvailable
      ? {
          enqueueEntityInputDelivery: (_runtimeId, output) => {
            attempted.push(reliableOrder(output));
            return deliveryAccepted('TEST_ACCOUNT_ACK_DELIVERED');
          },
        }
      : null);

    sendEntityInputWithRouting(env, h5, deps);
    transportAvailable = true;
    sendEntityInputWithRouting(env, h8, deps);

    expect(attempted).toEqual([5]);
    expect((env.pendingNetworkOutputs ?? []).map(reliableOrder)).toEqual([5, 8]);
    expect(env.runtimeState?.deferredNetworkMeta?.size).toBe(1);
    const h5RetryAt = getNextNetworkRetryTimestamp(env, deps);
    expect(h5RetryAt).not.toBeNull();
    expect(hasReadyPendingNetworkOutputs(env, deps, h5RetryAt! - 1)).toBe(false);
    expect(hasReadyPendingNetworkOutputs(env, deps, h5RetryAt!)).toBe(true);

    const h5Identity = getReliableOutputIdentity(h5);
    if (!h5Identity) throw new Error('TEST_ACCOUNT_ACK_H5_IDENTITY_MISSING');
    const h5Receipt = createReliableDeliveryReceipt(receiver, h5Identity, 'terminal');
    expect(applyReliableDeliveryReceipts(env, [h5Receipt])).toEqual({ removed: 1 });
    expect((env.pendingNetworkOutputs ?? []).map(reliableOrder)).toEqual([8]);
    expect(getNextNetworkRetryTimestamp(env, deps)).toBe(0);
    expect(hasReadyPendingNetworkOutputs(env, deps, 0)).toBe(true);

    sendEntityInputWithRouting(env, h8, deps);
    expect(attempted).toEqual([5, 8]);
  });

  test('a deterministic ACK reissue already covered by a durable receipt cannot block the next ACK', () => {
    const attempted: number[] = [];
    const receiver = createEmptyEnv('receipted-account-ack-reissue-receiver');
    receiver.runtimeId = deriveSignerAddressSync(
      'receipted-account-ack-reissue-receiver',
      '1',
    ).toLowerCase();
    registerSignerKey(
      receiver,
      receiver.runtimeId,
      deriveSignerKeySync('receipted-account-ack-reissue-receiver', '1'),
    );
    const h11 = { ...accountAckOutput(11), runtimeId: receiver.runtimeId };
    const h12 = { ...accountAckOutput(12), runtimeId: receiver.runtimeId };
    const h11Identity = getReliableOutputIdentity(h11);
    if (!h11Identity) throw new Error('TEST_ACCOUNT_ACK_H11_IDENTITY_MISSING');
    const receipt = createReliableDeliveryReceipt(receiver, h11Identity, 'terminal');
    const env = {
      runtimeId: runtimeId('90'),
      timestamp: 1_000,
      runtimeState: {},
      pendingNetworkOutputs: [h11],
      warn: () => {},
      error: () => {},
    } as unknown as Env;
    expect(applyReliableDeliveryReceipts(env, [receipt])).toEqual({ removed: 1 });

    // Entity replay can reproduce an already-ACKed output after the receipt
    // frame. It must be collected before lane ordering sees the new H12.
    env.pendingNetworkOutputs = [h11];
    sendEntityInputWithRouting(
      env,
      h12,
      routingDeps(() => ({
        enqueueEntityInputDelivery: (_runtimeId, output) => {
          attempted.push(reliableOrder(output));
          return deliveryAccepted('TEST_ACCOUNT_ACK_NEXT_DELIVERED');
        },
      })),
    );

    expect(attempted).toEqual([12]);
    expect((env.pendingNetworkOutputs ?? []).map(reliableOrder)).toEqual([12]);
  });

  test('a delayed Account ACK H9 cannot be handed off after H10', () => {
    const attempted: number[] = [];
    const env = {
      runtimeId: runtimeId('90'),
      timestamp: 1_000,
      runtimeState: {},
      warn: () => {},
      error: () => {},
    } as unknown as Env;

    const deferred = dispatchEntityOutputs(
      env,
      [accountAckOutput(10), accountAckOutput(9)].map(output => ({ output, targetRuntimeId })),
      routingDeps(() => ({
        enqueueEntityInputDelivery: (_runtimeId, output) => {
          const order = reliableOrder(output);
          attempted.push(order);
          return order === 9
            ? deliveryFailure({
                category: 'TransientRace',
                code: 'TEST_OLD_ACCOUNT_ACK_DEFERRED',
                terminal: false,
              })
            : deliveryAccepted('TEST_NEW_ACCOUNT_ACK_DELIVERED');
        },
      })),
    );

    expect(attempted).toEqual([9]);
    expect(deferred.map(reliableOrder)).toEqual([9, 10]);
  });

  test('a blocked Entity A lane does not block Entity B', () => {
    const entityA = entityId('82');
    const entityB = entityId('83');
    const attempted: string[] = [];
    const env = {
      runtimeId: runtimeId('90'),
      timestamp: 1_000,
      runtimeState: {},
      warn: () => {},
      error: () => {},
    } as unknown as Env;
    const outputs = [
      entityFrameOutput(2, entityA),
      entityFrameOutput(1, entityB),
      entityFrameOutput(1, entityA),
    ];

    const deferred = dispatchEntityOutputs(
      env,
      outputs.map(output => ({ output, targetRuntimeId })),
      routingDeps(() => ({
        enqueueEntityInputDelivery: (_runtimeId, output) => {
          const label = `${output.entityId === entityA ? 'A' : 'B'}${reliableOrder(output)}`;
          attempted.push(label);
          return label === 'A1'
            ? deliveryFailure({
                category: 'TransientRace',
                code: 'TEST_ENTITY_A_HEAD_DEFERRED',
                terminal: false,
              })
            : deliveryAccepted('TEST_OTHER_LANE_DELIVERED');
        },
      })),
    );

    expect(attempted).toEqual(['A1', 'B1']);
    expect(deferred.map(output => `${output.entityId === entityA ? 'A' : 'B'}${reliableOrder(output)}`))
      .toEqual(['A1', 'A2', 'B1']);
  });

  test('a blocked reliable lane does not block ordinary output', () => {
    const attempted: Array<number | 'ordinary'> = [];
    const env = {
      runtimeId: runtimeId('90'),
      timestamp: 1_000,
      runtimeState: {},
      warn: () => {},
      error: () => {},
    } as unknown as Env;
    const ordinary = {
      runtimeId: targetRuntimeId,
      entityId: targetEntityId,
      signerId: targetSignerId,
      entityTxs: [{ type: 'profile-update', data: { name: 'ordinary' } } as never],
    } satisfies DeliverableEntityInput;

    const deferred = dispatchEntityOutputs(
      env,
      [entityFrameOutput(2), ordinary, entityFrameOutput(1)].map(output => ({ output, targetRuntimeId })),
      routingDeps(() => ({
        enqueueEntityInputDelivery: (_runtimeId, output) => {
          const order = output.proposedFrame ? reliableOrder(output) : 'ordinary';
          attempted.push(order);
          return order === 1
            ? deliveryFailure({ category: 'TransientRace', code: 'TEST_HEAD_DEFERRED', terminal: false })
            : deliveryAccepted('TEST_ORDINARY_DELIVERED');
        },
      })),
    );

    expect(attempted).toEqual([1, 'ordinary']);
    expect(deferred.map(reliableOrder)).toEqual([1, 2]);
  });

  test('HOL is scoped to a comparable protocol lane, not every message for one Entity', () => {
    const attempted: string[] = [];
    const env = {
      runtimeId: runtimeId('90'),
      timestamp: 1_000,
      runtimeState: {},
      warn: () => {},
      error: () => {},
    } as unknown as Env;
    const outputs = [entityFrameOutput(1), accountAckOutput(1)];

    const deferred = dispatchEntityOutputs(
      env,
      outputs.map(output => ({ output, targetRuntimeId })),
      routingDeps(() => ({
        enqueueEntityInputDelivery: (_runtimeId, output) => {
          const kind = output.proposedFrame ? 'entity-frame' : 'account-ack';
          attempted.push(kind);
          return attempted.length === 1
            ? deliveryFailure({ category: 'TransientRace', code: 'TEST_LANE_HEAD_DEFERRED', terminal: false })
            : deliveryAccepted('TEST_INDEPENDENT_LANE_DELIVERED');
        },
      })),
    );

    expect(attempted.sort()).toEqual(['account-ack', 'entity-frame']);
    expect(deferred).toHaveLength(2);
  });

  test('Entity H+1 waits until the prior proposal has a durable certificate receipt', () => {
    const proposalIdentity = getReliableOutputIdentity(entityFrameOutput(1));
    const certificateIdentity = getReliableOutputIdentity(
      entityFrameOutput(1, targetEntityId, ['0xquorum-hanko']),
    );
    if (!proposalIdentity || !certificateIdentity) throw new Error('TEST_RELIABLE_IDENTITY_MISSING');
    const receipt = (identity: typeof proposalIdentity) => ({
      body: {
        version: 2 as const,
        coverage: 'terminal' as const,
        receiverRuntimeId: targetRuntimeId,
        identity,
        appliedRuntimeHeight: 1,
      },
      signature: '0xtest-receipt-signature',
    });
    const env = {
      runtimeId: runtimeId('90'),
      timestamp: 1_000,
      runtimeState: {
        receivedReliableReceiptLedger: new Map([['proposal', receipt(proposalIdentity)]]),
      },
      warn: () => {},
      error: () => {},
    } as unknown as Env;
    const attempted: number[] = [];
    const deliver = () => dispatchEntityOutputs(
      env,
      [{ output: entityFrameOutput(2), targetRuntimeId }],
      routingDeps(() => ({
        enqueueEntityInputDelivery: (_runtimeId, output) => {
          attempted.push(reliableOrder(output));
          return deliveryAccepted('TEST_DELIVERED_AFTER_CERTIFICATE');
        },
      })),
    );

    expect(deliver().map(reliableOrder)).toEqual([2]);
    expect(attempted).toEqual([]);
    env.runtimeState!.receivedReliableReceiptLedger!.clear();
    env.runtimeState!.receivedReliableTerminalWatermarks = new Map([
      ['certificate', receipt(certificateIdentity)],
    ]);
    expect(deliver().map(reliableOrder)).toEqual([2]);
    expect(attempted).toEqual([2]);
  });

  test('transport handoff does not GC a reliable output before durable application receipt', () => {
    const env = {
      runtimeId: runtimeId('90'),
      timestamp: 1_000,
      runtimeState: {},
      warn: () => {},
      error: () => {},
    } as unknown as Env;
    const output = entityFrameOutput(1);

    const deferred = dispatchEntityOutputs(
      env,
      [{ output, targetRuntimeId }],
      routingDeps(() => ({
        enqueueEntityInputDelivery: () => deliveryAccepted('TEST_TRANSPORT_HANDOFF_ONLY'),
      })),
    );

    expect(deferred).toEqual([output]);
  });
});
