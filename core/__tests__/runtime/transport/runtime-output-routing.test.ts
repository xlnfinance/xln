import { describe, expect, test } from 'bun:test';
import { keccak256, toUtf8Bytes } from 'ethers';

import { routeInboundP2PEntityInput, resolveRuntimeIdForEntity } from '../../../runtime/delivery/topology/entity-routing';
import {
  buildPendingNetworkOutputs,
  buildRouteOutputKey,
  carriesEntityCommitNotification,
  dispatchEntityOutputs as dispatchEntityOutputsRaw,
  mergeRoutedEntityOutput,
  planEntityOutputs,
  rescheduleDeferredOutputs,
  sendEntityInputWithRouting as sendEntityInputWithRoutingRaw,
  splitPendingOutputsByRetryWindow,
} from '../../../runtime/delivery/topology/output-routing';
import { deliveryAccepted, deliveryDeferred, deliveryFailure } from '../../../protocol/payments/delivery-result';
import type { DeliverableEntityInput, RuntimeReplica, RoutedEntityInput, RuntimeEntityInputsEnvelope } from '../../../runtime/types';
import type { EntityLeaderTimeoutVote } from '../../../entity/types';
import { getWallClockMs } from '../../../support/time';
import { deriveSignerAddressSync, signDigest } from '../../../account/crypto';
import type { Profile } from '../../../entity/profile';
import { computeProfileRouteHash } from '../../../entity/profile/profile-signing';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';

const withRuntimeOwner = (env: RuntimeReplica): RuntimeReplica => {
  const seed = `runtime-output-routing:${String(env.runtimeId || 'anonymous')}`;
  env.runtimeSeed = seed;
  env.runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  return env;
};

const dispatchEntityOutputs: typeof dispatchEntityOutputsRaw = (env, outputs, deps) =>
  dispatchEntityOutputsRaw(withRuntimeOwner(env), outputs, deps);

const sendEntityInputWithRouting: typeof sendEntityInputWithRoutingRaw = (env, input, deps) =>
  sendEntityInputWithRoutingRaw(withRuntimeOwner(env), input, deps);

const runtimeId = (byte: string): string => `0x${byte.repeat(20)}`;
const entityId = (byte: string): string => `0x${byte.repeat(32)}`;

const frameParentHash = (height: number): string => `0x${height.toString(16).padStart(64, '0')}`;
const testFrameHash = (value: string): string => keccak256(toUtf8Bytes(value));

const emptyEntityContext = (
  targetEntityId: string,
  proposerSignerId: string,
  height: number,
  parentFrameHash: string,
) => ({
  version: 1 as const,
  proposerReplicaId: `${targetEntityId}:${proposerSignerId}`,
  entityId: targetEntityId,
  proposerSignerId,
  parentFrameHash,
  height,
  gossipProfiles: [],
  peerAssertions: [],
  htlc: { version: 1 as const, entries: [], originated: [] },
});

const signedRouteProfile = (
  targetEntityId: string,
  targetRuntimeId: string,
  signingSeed: string,
): Profile => {
  const signerId = deriveSignerAddressSync(signingSeed, '1').toLowerCase();
  const unsigned: Profile = {
    entityId: targetEntityId,
    entityEncryptionPublicKey: `0x${'12'.repeat(32)}`,
    name: 'route authority', avatar: '', bio: '', website: '', lastUpdated: 1,
    runtimeId: targetRuntimeId,
    runtimeEncPubKey: `0x${'13'.repeat(32)}`,
    publicAccounts: [], wsUrl: null, relays: [],
    metadata: { isHub: false, routingFeePPM: 0, baseFee: 0n },
    accounts: [],
  };
  return {
    ...unsigned,
    runtimeSignature: signDigest(signingSeed, '1', computeProfileRouteHash(unsigned)),
  };
};

const timeoutVote = (voterId: string, signature: string): EntityLeaderTimeoutVote => ({
  entityId: entityId('75'),
  targetHeight: 7,
  previousFrameHash: `0x${'cd'.repeat(32)}`,
  fromView: 1,
  toView: 2,
  previousLeaderId: runtimeId('76'),
  nextLeaderId: runtimeId('77'),
  voterId,
  signature,
});

const committedOutput = (
  targetRuntimeId: string,
  targetEntityId: string,
  targetSignerId: string,
  height: number,
  hash: string,
  signature: string,
): DeliverableEntityInput => {
  const frameHash = testFrameHash(hash);
  return {
    runtimeId: targetRuntimeId,
    entityId: targetEntityId,
    signerId: targetSignerId,
    entityTxs: [],
    proposedFrame: {
      height,
      timestamp: height,
      hash: frameHash,
      parentFrameHash: frameParentHash(height - 1),
      stateRoot: `0x${'11'.repeat(32)}`,
      authorityRoot: `0x${'22'.repeat(32)}`,
      txs: [],
      events: [],
      entityContext: emptyEntityContext(
        targetEntityId,
        targetSignerId,
        height,
        frameParentHash(height - 1),
      ),
      leader: { proposerSignerId: targetSignerId, view: 0 },
      hashesToSign: [{ hash: frameHash, type: 'entityFrame', context: `entity-frame:${height}` }],
      collectedSigs: new Map([[targetSignerId, [signature]]]),
      hankos: [`0xhanko-${signature}`],
    } as never,
  };
};

const proposalOutput = (
  targetRuntimeId: string,
  targetEntityId: string,
  targetSignerId: string,
  height: number,
  hash: string,
  signature: string,
): DeliverableEntityInput => {
  const committed = committedOutput(
    targetRuntimeId,
    targetEntityId,
    targetSignerId,
    height,
    hash,
    signature,
  );
  const { hankos: _hankos, ...proposedFrame } = committed.proposedFrame!;
  return { ...committed, proposedFrame };
};

const dispatchFrameOutputs = (outputs: DeliverableEntityInput[]): {
  deferred: RoutedEntityInput[];
  delivered: DeliverableEntityInput[];
} => {
  const targetRuntimeId = outputs[0]?.runtimeId;
  if (!targetRuntimeId) throw new Error('TEST_COMMIT_TARGET_RUNTIME_MISSING');
  const delivered: DeliverableEntityInput[] = [];
  const env = {
    runtimeId: runtimeId('10'),
    state: {
  height: 25,
  timestamp: 2_500,
    },
    infrastructure: {
      directEntityInputsDispatch: (_runtimeId: string, envelope: RuntimeEntityInputsEnvelope) => {
        delivered.push(...envelope.entityInputs);
        return deliveryAccepted('ROUTE_DIRECT_DELIVERED');
      },
    },
  } as unknown as RuntimeReplica;
  const deferred = dispatchEntityOutputs(env, outputs.map(output => ({
    output: {
      ...output,
      sourceRuntimeFrame: output.sourceRuntimeFrame ?? { height: env.state.height, timestamp: env.state.timestamp },
    },
    targetRuntimeId,
  })), {
    ensureRuntimeInfrastructure: target => target.infrastructure!,
    getP2P: () => null,
    enqueueRuntimeInputs: () => {},
    extractEntityId: key => String(key).split(':')[0] || '',
    hasLocalSignerForEntity: () => false,
    hasLocalSignerForEntitySigner: () => false,
    resolveSoleLocalSignerForEntity: () => null,
    resolveRuntimeIdForEntity: () => targetRuntimeId,
    resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
  });
  return { deferred, delivered };
};

describe('runtime output routing', () => {
  test('defers a certified output until the target runtime route is advertised', () => {
    const sourceEntityId = entityId('a4');
    const targetEntityId = entityId('a5');
    const targetSignerId = runtimeId('a6');
    const infoCodes: string[] = [];
    const output: RoutedEntityInput = {
      entityId: targetEntityId,
      signerId: targetSignerId,
      entityTxs: [{
        type: 'consensusOutput',
        data: {
          origin: {
            sourceEntityId,
            lane: 'generic',
            sequence: 1n,
            semanticHash: `0x${'a7'.repeat(32)}`,
            height: 1,
            frameHash: `0x${'a8'.repeat(32)}`,
            outputIndex: 0,
          },
          outputHanko: '0x01',
          targetEntityId,
          entityTxs: [{ type: 'chat', data: { text: 'route after profile' } } as never],
        },
      }],
    };
    const env = {
      runtimeId: runtimeId('a3'),
      state: {
  timestamp: 1,
      },
      infrastructure: {},
      gossip: { getProfiles: () => [] },
      info: (_scope: string, code: string) => infoCodes.push(code),
      warn: () => {},
      error: () => {},
    } as unknown as RuntimeReplica;

    const planned = planEntityOutputs(env, [output], {
      ensureRuntimeInfrastructure: target => target.infrastructure!,
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: key => String(key).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => null,
      resolveRuntimeIdForCrossJurisdictionEntity: () => null,
    });

    expect(planned.localOutputs).toEqual([]);
    expect(planned.remoteOutputs).toEqual([]);
    expect(planned.deferredOutputs).toEqual([output]);
    expect(infoCodes).toContain('ROUTE_SEND_DEFERRED');
  });

  test('normalizes batched certified generic outputs into contiguous source sequence', () => {
    const sourceEntityId = entityId('41');
    const targetEntityId = entityId('42');
    const targetRuntimeId = runtimeId('43');
    const targetSignerId = runtimeId('44');
    const txFor = (sequence: bigint) => ({
      type: 'consensusOutput' as const,
      data: {
        origin: {
          sourceEntityId,
          lane: 'generic' as const,
          sequence,
          semanticHash: `0x${sequence.toString(16).padStart(64, '0')}`,
          height: Number(sequence),
          frameHash: `0x${'45'.repeat(32)}`,
          outputIndex: 0,
        },
        outputHanko: '0x01',
        targetEntityId,
        entityTxs: [{ type: 'chat', data: { text: `seq-${sequence}` } } as never],
      },
    });
    const output = (sequence: bigint): DeliverableEntityInput => ({
      runtimeId: targetRuntimeId,
      entityId: targetEntityId,
      signerId: targetSignerId,
      entityTxs: [txFor(sequence)],
    });

    const sequences = [10n, 3n, 8n, 1n, 6n, 4n, 9n, 2n, 7n, 5n];
    const pending = buildPendingNetworkOutputs(sequences.map(output));

    expect(pending.flatMap(candidate => candidate.entityTxs ?? [])
      .map(tx => tx.type === 'consensusOutput' && tx.data.origin.sequence))
      .toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n]);
  });

  test('uses existing proposal identity to distinguish transport envelopes', () => {
    const base = {
      entityId: entityId('10'),
      signerId: runtimeId('11'),
      entityTxs: [],
    } satisfies RoutedEntityInput;
    const first = {
      ...base,
      proposedFrame: {
        height: 1,
        timestamp: 1,
        hash: '0xaaa',
        hashesToSign: [{ hash: '0xaaa', type: 'entityFrame', context: 'entity-frame:1' }],
        txs: [],
        leader: { proposerSignerId: runtimeId('11'), view: 0 },
      },
    } as RoutedEntityInput;
    const second = {
      ...base,
      proposedFrame: {
        height: 1,
        timestamp: 1,
        hash: '0xbbb',
        hashesToSign: [{ hash: '0xbbb', type: 'entityFrame', context: 'entity-frame:1' }],
        txs: [],
        leader: { proposerSignerId: runtimeId('11'), view: 0 },
      },
    } as RoutedEntityInput;
    const nextHeightSameHash = {
      ...base,
      proposedFrame: {
        height: 2,
        timestamp: 2,
        hash: '0xaaa',
        hashesToSign: [{ hash: '0xaaa', type: 'entityFrame', context: 'entity-frame:2' }],
        txs: [],
        leader: { proposerSignerId: runtimeId('11'), view: 0 },
      },
    } as RoutedEntityInput;

    expect(buildRouteOutputKey(first)).not.toBe(buildRouteOutputKey(second));
    expect(buildRouteOutputKey(first)).not.toBe(buildRouteOutputKey(nextHeightSameHash));
  });

  test('keeps distinct leader-timeout votes in separate deterministic route envelopes', () => {
    const base = {
      runtimeId: runtimeId('74'),
      entityId: entityId('75'),
      signerId: runtimeId('77'),
      entityTxs: [],
    } satisfies RoutedEntityInput;
    const first = { ...base, leaderTimeoutVote: timeoutVote(runtimeId('78'), '0xsig-a') };
    const second = { ...base, leaderTimeoutVote: timeoutVote(runtimeId('79'), '0xsig-b') };

    expect(buildRouteOutputKey(first)).not.toBe(buildRouteOutputKey(second));
    expect(buildPendingNetworkOutputs([first, second])).toHaveLength(2);
    expect(buildPendingNetworkOutputs([second, first]).map(buildRouteOutputKey)).toEqual(
      buildPendingNetworkOutputs([first, second]).map(buildRouteOutputKey),
    );
    const deliveredForward = dispatchFrameOutputs([first, second] as DeliverableEntityInput[]).delivered;
    const deliveredReverse = dispatchFrameOutputs([second, first] as DeliverableEntityInput[]).delivered;
    expect(deliveredForward).toHaveLength(2);
    expect(deliveredReverse.map(buildRouteOutputKey)).toEqual(deliveredForward.map(buildRouteOutputKey));
  });

  test('accepts only exact duplicate precommit bundles and rejects arrival-order equivocation', () => {
    const base = {
      runtimeId: runtimeId('7a'),
      entityId: entityId('7b'),
      signerId: runtimeId('7c'),
      entityTxs: [],
    } satisfies RoutedEntityInput;
    const voter = runtimeId('7d');
    const output = (signature: string): RoutedEntityInput => ({
      ...base,
      hashPrecommitFrame: { height: 7, frameHash: '0xframe-7' },
      hashPrecommits: new Map([[voter, [signature]]]),
    });

    const exact = mergeRoutedEntityOutput(output('0xsig-a'), output('0xsig-a'));
    expect(exact.hashPrecommits).toEqual(new Map([[voter, ['0xsig-a']]]));
    for (const [left, right] of [
      [output('0xsig-a'), output('0xsig-b')],
      [output('0xsig-b'), output('0xsig-a')],
    ] as const) {
      const before = structuredClone(left.hashPrecommits);
      expect(() => mergeRoutedEntityOutput(left, right)).toThrow('ROUTE_PRECOMMIT_EQUIVOCATION');
      expect(left.hashPrecommits).toEqual(before);
    }
    const caseDuplicate = output('0xsig-a');
    caseDuplicate.hashPrecommits?.set(`0x${voter.slice(2).toUpperCase()}`, ['0xsig-a']);
    expect(() => mergeRoutedEntityOutput(output('0xsig-a'), caseDuplicate))
      .toThrow('ROUTE_PRECOMMIT_DUPLICATE_SIGNER');
  });

  test('backs off retryable envelopes without treating them as fatal', () => {
    const output = {
      runtimeId: runtimeId('12'),
      entityId: entityId('13'),
      signerId: runtimeId('14'),
      entityTxs: [],
    } satisfies RoutedEntityInput;
    const env = {
      state: {
  timestamp: 1_000,
      },
      pendingNetworkOutputs: [],
      infrastructure: {},
    } as unknown as RuntimeReplica;
    const deps = {
      ensureRuntimeInfrastructure: (targetEnv: RuntimeReplica) => targetEnv.infrastructure!,
    } as any;

    const pending = rescheduleDeferredOutputs(env, [], [output], [], deps);
    expect(pending).toEqual([output]);
    expect(splitPendingOutputsByRetryWindow(env, pending, deps)).toEqual({ ready: [], waiting: [output] });
  });

  test('uses deterministic Entity time for scenario retry scheduling and readiness', () => {
    const output = {
      runtimeId: runtimeId('15'),
      entityId: entityId('16'),
      signerId: runtimeId('17'),
      entityTxs: [],
    } satisfies RoutedEntityInput;
    const env = {
      scenarioMode: true,
      state: {
  timestamp: 1_000,
      },
      pendingNetworkOutputs: [],
      infrastructure: {},
    } as unknown as RuntimeReplica;
    const deps = {
      ensureRuntimeInfrastructure: (targetEnv: RuntimeReplica) => targetEnv.infrastructure!,
    } as any;

    const pending = rescheduleDeferredOutputs(env, [], [output], [], deps);
    const retry = env.infrastructure?.deferredNetworkMeta?.get(buildRouteOutputKey(output));
    expect(retry?.nextRetryAt).toBe(2_000);
    env.state.timestamp = 1_999;
    expect(splitPendingOutputsByRetryWindow(env, pending, deps).ready).toHaveLength(0);
    env.state.timestamp = 2_000;
    expect(splitPendingOutputsByRetryWindow(env, pending, deps).ready).toEqual([output]);
  });

  test('uses wall clock for production retry scheduling even when Entity time is stale', () => {
    const output = {
      runtimeId: runtimeId('18'),
      entityId: entityId('19'),
      signerId: runtimeId('1a'),
      entityTxs: [],
    } satisfies RoutedEntityInput;
    const env = {
      scenarioMode: false,
      state: {
  timestamp: 1,
      },
      pendingNetworkOutputs: [],
      infrastructure: {},
    } as unknown as RuntimeReplica;
    const deps = {
      ensureRuntimeInfrastructure: (targetEnv: RuntimeReplica) => targetEnv.infrastructure!,
    } as any;
    const before = getWallClockMs();
    const pending = rescheduleDeferredOutputs(env, [], [output], [], deps);
    const after = getWallClockMs();
    const retry = env.infrastructure?.deferredNetworkMeta?.get(buildRouteOutputKey(output));

    expect(retry?.nextRetryAt).toBeGreaterThanOrEqual(before + 1_000);
    expect(retry?.nextRetryAt).toBeLessThanOrEqual(after + 1_000);
    expect(splitPendingOutputsByRetryWindow(env, pending, deps).ready).toHaveLength(0);
  });

  test('rebinds a durable output to the entity current runtime instead of creating a poison loop', () => {
    const persistedRuntimeId = runtimeId('15');
    const resolvedRuntimeId = runtimeId('16');
    const warnings: string[] = [];
    const output = {
      runtimeId: persistedRuntimeId,
      entityId: entityId('17'),
      signerId: runtimeId('18'),
      entityTxs: [],
    } satisfies RoutedEntityInput;
    const env = {
      runtimeId: runtimeId('19'),
      warn: (_scope: string, code: string) => warnings.push(code),
    } as unknown as RuntimeReplica;

    const planned = planEntityOutputs(env, [output], {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure ??= {},
      getP2P: () => ({
        enqueueEntityInputsDelivery: () => deliveryAccepted('TEST_DELIVERED'),
        getVerifiedRuntimeRoute: () => ({ runtimeId: resolvedRuntimeId, lastUpdated: 2 }),
      }),
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => resolvedRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => resolvedRuntimeId,
    });

    expect(planned.remoteOutputs[0]?.targetRuntimeId).toBe(resolvedRuntimeId);
    expect(planned.remoteOutputs[0]?.output.runtimeId).toBe(resolvedRuntimeId);
    expect(warnings).toEqual(['ROUTE_TARGET_RUNTIME_REBOUND']);
  });

  test('records first verified runtime binding without reporting a route rebound', () => {
    const resolvedRuntimeId = runtimeId('16');
    const info: string[] = [];
    const warnings: string[] = [];
    const output = {
      entityId: entityId('17'),
      signerId: runtimeId('18'),
      entityTxs: [],
    } satisfies RoutedEntityInput;
    const env = {
      runtimeId: runtimeId('19'),
      info: (_scope: string, code: string) => info.push(code),
      warn: (_scope: string, code: string) => warnings.push(code),
    } as unknown as RuntimeReplica;

    const planned = planEntityOutputs(env, [output], {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure ??= {},
      getP2P: () => ({
        enqueueEntityInputsDelivery: () => deliveryAccepted('TEST_DELIVERED'),
        getVerifiedRuntimeRoute: () => ({ runtimeId: resolvedRuntimeId, lastUpdated: 2 }),
      }),
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => resolvedRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => resolvedRuntimeId,
    });

    expect(planned.remoteOutputs[0]?.targetRuntimeId).toBe(resolvedRuntimeId);
    expect(planned.remoteOutputs[0]?.output.runtimeId).toBe(resolvedRuntimeId);
    expect(info).toEqual(['ROUTE_TARGET_RUNTIME_BOUND']);
    expect(warnings).toEqual([]);
  });

  test('verified profile route supersedes matching stale durable and cached routes', () => {
    const staleRuntimeId = runtimeId('1a');
    const currentRuntimeId = runtimeId('1b');
    const warnings: string[] = [];
    const output = {
      runtimeId: staleRuntimeId,
      entityId: entityId('1c'),
      signerId: runtimeId('1d'),
      entityTxs: [],
    } satisfies RoutedEntityInput;
    const env = {
      runtimeId: runtimeId('1e'),
      warn: (_scope: string, code: string) => warnings.push(code),
    } as unknown as RuntimeReplica;

    const planned = planEntityOutputs(env, [output], {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure ??= {},
      getP2P: () => ({
        enqueueEntityInputsDelivery: () => deliveryAccepted('TEST_DELIVERED'),
        getVerifiedRuntimeRoute: () => ({ runtimeId: currentRuntimeId, lastUpdated: 2 }),
      }),
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => staleRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => staleRuntimeId,
    });

    expect(planned.remoteOutputs[0]?.targetRuntimeId).toBe(currentRuntimeId);
    expect(planned.remoteOutputs[0]?.output.runtimeId).toBe(currentRuntimeId);
    expect(warnings).toEqual(['ROUTE_TARGET_RUNTIME_REBOUND']);
  });

  test('does not rebind a durable output from an unverified runtime hint', () => {
    const persistedRuntimeId = runtimeId('1a');
    const hintedRuntimeId = runtimeId('1b');
    const warnings: string[] = [];
    const output = {
      runtimeId: persistedRuntimeId,
      entityId: entityId('1c'),
      signerId: runtimeId('1d'),
      entityTxs: [],
    } satisfies RoutedEntityInput;
    const env = {
      runtimeId: runtimeId('1e'),
      warn: (_scope: string, code: string) => warnings.push(code),
    } as unknown as RuntimeReplica;

    const planned = planEntityOutputs(env, [output], {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure ??= {},
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => hintedRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => hintedRuntimeId,
    });

    expect(planned.remoteOutputs[0]?.targetRuntimeId).toBe(persistedRuntimeId);
    expect(warnings).toEqual(['ROUTE_TARGET_RUNTIME_CHANGE_UNVERIFIED']);
  });

  test('fails over to encrypted P2P delivery after direct dispatch misses', () => {
    const targetRuntimeId = runtimeId('22');
    const warnings: string[] = [];
    const p2pCalls: Array<{ targetRuntimeId: string; envelope: RuntimeEntityInputsEnvelope; ingressTimestamp?: number }> = [];
    const env = {
      runtimeId: runtimeId('11'),
      state: {
  timestamp: 1234,
      },
      infrastructure: {
        directEntityInputsDispatch: () => deliveryDeferred({ outcome: 'deferred', code: 'ROUTE_DIRECT_MISS_FAILOVER' }),
      },
      warn: (_scope: string, code: string) => {
        warnings.push(code);
      },
    } as unknown as RuntimeReplica;
    const output: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: entityId('33'),
      signerId: runtimeId('34'),
      sourceRuntimeFrame: { height: 9, timestamp: 1234 },
      entityTxs: [{
        type: 'registerCrossJurisdictionSwap',
        data: { route: { orderId: 'route-1' } },
      } as any],
    };

    const deferred = dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      getP2P: () => ({
        enqueueEntityInputsDelivery: (runtimeId, envelope, ingressTimestamp) => {
          p2pCalls.push({ targetRuntimeId: runtimeId, envelope, ingressTimestamp });
          return deliveryAccepted('P2P_ENTITY_INPUT_DELIVERED');
        },
      }),
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    });

    expect(deferred).toEqual([]);
    expect(p2pCalls).toHaveLength(1);
    expect(p2pCalls[0]?.targetRuntimeId).toBe(targetRuntimeId);
    expect(p2pCalls[0]?.envelope).toMatchObject({
      sourceRuntimeId: env.runtimeId,
      sourceRuntimeHeight: 9,
      sourceRuntimeTimestamp: 1234,
      entityInputs: [expect.objectContaining({ entityId: output.entityId })],
    });
    expect(p2pCalls[0]?.ingressTimestamp).toBe(1234);
    expect(warnings).not.toContain('ROUTE_DIRECT_SOCKET_REQUIRED');
  });

  test('uses typed P2P delivery dispatch', () => {
    const targetRuntimeId = runtimeId('21');
    const p2pCalls: Array<{ targetRuntimeId: string; envelope: RuntimeEntityInputsEnvelope; ingressTimestamp?: number }> = [];
    const env = {
      runtimeId: runtimeId('11'),
      state: {
  timestamp: 4321,
      },
      infrastructure: {
        directEntityInputsDispatch: () => deliveryDeferred({ outcome: 'deferred', code: 'ROUTE_DIRECT_MISS_FAILOVER' }),
      },
      warn: () => {},
      error: () => {},
    } as unknown as RuntimeReplica;
    const output: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: entityId('31'),
      signerId: runtimeId('32'),
      sourceRuntimeFrame: { height: 10, timestamp: 4321 },
      entityTxs: [],
    };

    const deferred = dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      getP2P: () => ({
        enqueueEntityInputsDelivery: (runtimeId, envelope, ingressTimestamp) => {
          p2pCalls.push({ targetRuntimeId: runtimeId, envelope, ingressTimestamp });
          return {
            outcome: 'delivered',
            code: 'P2P_ENTITY_INPUT_DELIVERED',
            retryable: false,
            fatal: false,
            terminal: true,
          };
        },
      }),
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    });

    expect(deferred).toEqual([]);
    expect(p2pCalls).toHaveLength(1);
    expect(p2pCalls[0]?.targetRuntimeId).toBe(targetRuntimeId);
    expect(p2pCalls[0]?.ingressTimestamp).toBe(4321);
  });

  test('rejects malformed typed P2P delivery results', () => {
    const targetRuntimeId = runtimeId('2b');
    const env = {
      runtimeId: runtimeId('11'),
      state: {
  timestamp: 4331,
      },
      infrastructure: {
        directEntityInputsDispatch: () => deliveryDeferred({ outcome: 'deferred', code: 'ROUTE_DIRECT_MISS_FAILOVER' }),
      },
      warn: () => {},
      error: () => {},
    } as unknown as RuntimeReplica;
    const output: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: entityId('41'),
      signerId: runtimeId('42'),
      sourceRuntimeFrame: { height: 11, timestamp: 4331 },
      entityTxs: [],
    };

    expect(() => dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      getP2P: () => ({
        enqueueEntityInputsDelivery: (() => true) as any,
      }),
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    })).toThrow(/ROUTE_P2P_INVALID_DELIVERY_RESULT/);
  });

  test('accepts typed direct dispatch delivery without touching P2P', () => {
    const targetRuntimeId = runtimeId('24');
    const p2pCalls: unknown[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      state: {
  timestamp: 2468,
      },
      infrastructure: {
        directEntityInputsDispatch: () => ({
          outcome: 'delivered',
          code: 'ROUTE_DIRECT_DELIVERED',
          retryable: false,
          fatal: false,
          terminal: true,
        }),
      },
      warn: () => {},
      error: () => {},
    } as unknown as RuntimeReplica;
    const output: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: entityId('3a'),
      signerId: runtimeId('3b'),
      sourceRuntimeFrame: { height: 12, timestamp: 2468 },
      entityTxs: [],
    };

    const deferred = dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      getP2P: () => ({
        enqueueEntityInputsDelivery: () => {
          p2pCalls.push(true);
          return deliveryAccepted('P2P_ENTITY_INPUT_DELIVERED');
        },
      }),
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    });

    expect(deferred).toEqual([]);
    expect(p2pCalls).toHaveLength(0);
  });

  test('a same-frame commit certificate supersedes its still-pending proposal', () => {
    const targetRuntimeId = runtimeId('2c');
    const targetEntityId = entityId('2d');
    const targetSignerId = runtimeId('2e');
    const proposal = proposalOutput(
      targetRuntimeId,
      targetEntityId,
      targetSignerId,
      4,
      '0xframe04',
      '0xproposer-sig',
    );
    const certificate = committedOutput(
      targetRuntimeId,
      targetEntityId,
      targetSignerId,
      4,
      '0xframe04',
      '0xquorum-sig',
    );

    expect(carriesEntityCommitNotification(proposal)).toBe(false);
    expect(carriesEntityCommitNotification(certificate)).toBe(true);

    for (const outputs of [[proposal, certificate], [certificate, proposal]]) {
      const pending = buildPendingNetworkOutputs(outputs);
      expect(pending).toHaveLength(1);
      expect(carriesEntityCommitNotification(pending[0]!)).toBe(true);

      const { deferred, delivered } = dispatchFrameOutputs(pending as DeliverableEntityInput[]);
      expect(deferred).toHaveLength(0);
      expect(delivered).toHaveLength(1);
      expect(carriesEntityCommitNotification(delivered[0]!)).toBe(true);
    }
  });

  test('rejects untyped boolean direct dispatch results', () => {
    const targetRuntimeId = runtimeId('2a');
    const p2pCalls: unknown[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      state: {
  timestamp: 2469,
      },
      infrastructure: {
        directEntityInputsDispatch: (() => true) as any,
      },
      warn: () => {},
      error: () => {},
    } as unknown as RuntimeReplica;
    const output: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: entityId('3e'),
      signerId: runtimeId('3f'),
      sourceRuntimeFrame: { height: 13, timestamp: 2469 },
      entityTxs: [],
    };

    expect(() => dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      getP2P: () => ({
        enqueueEntityInputsDelivery: () => {
          p2pCalls.push(true);
          return deliveryAccepted('P2P_ENTITY_INPUT_DELIVERED');
        },
      }),
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    })).toThrow(/ROUTE_DIRECT_INVALID_DELIVERY_RESULT/);
    expect(p2pCalls).toHaveLength(0);
  });

  test('fails over to P2P after typed direct dispatch defer', () => {
    const targetRuntimeId = runtimeId('25');
    const p2pCalls: Array<{ targetRuntimeId: string; envelope: RuntimeEntityInputsEnvelope; ingressTimestamp?: number }> = [];
    const env = {
      runtimeId: runtimeId('11'),
      state: {
  timestamp: 1357,
      },
      infrastructure: {
        directEntityInputsDispatch: () => ({
          outcome: 'deferred',
          code: 'ROUTE_DIRECT_MISS_FAILOVER',
          retryable: true,
          fatal: false,
          terminal: false,
        }),
      },
      warn: () => {},
      error: () => {},
    } as unknown as RuntimeReplica;
    const output: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: entityId('3c'),
      signerId: runtimeId('3d'),
      sourceRuntimeFrame: { height: 14, timestamp: 1357 },
      entityTxs: [],
    };

    const deferred = dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      getP2P: () => ({
        enqueueEntityInputsDelivery: (runtimeId, envelope, ingressTimestamp) => {
          p2pCalls.push({ targetRuntimeId: runtimeId, envelope, ingressTimestamp });
          return deliveryAccepted('P2P_ENTITY_INPUT_DELIVERED');
        },
      }),
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    });

    expect(deferred).toEqual([]);
    expect(p2pCalls).toHaveLength(1);
    expect(p2pCalls[0]?.targetRuntimeId).toBe(targetRuntimeId);
    expect(p2pCalls[0]?.ingressTimestamp).toBe(1357);
  });

  test('sendEntityInputWithRouting exposes typed remote delivery result', () => {
    const targetRuntimeId = runtimeId('23');
    const p2pCalls: Array<{ targetRuntimeId: string; envelope: RuntimeEntityInputsEnvelope; ingressTimestamp?: number }> = [];
    const env = {
      runtimeId: runtimeId('11'),
      state: {
  height: 15,
  timestamp: 2345,
      },
      infrastructure: {
        directEntityInputsDispatch: () => deliveryDeferred({ outcome: 'deferred', code: 'ROUTE_DIRECT_MISS_FAILOVER' }),
      },
      warn: () => {},
      error: () => {},
    } as unknown as RuntimeReplica;
    const input: RoutedEntityInput = {
      entityId: entityId('35'),
      signerId: runtimeId('36'),
      entityTxs: [{
        type: 'openAccount',
        data: { targetEntityId: entityId('37') },
      } as any],
    };

    const result = sendEntityInputWithRouting(env, input, {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      getP2P: () => ({
        enqueueEntityInputsDelivery: (runtimeId, envelope, ingressTimestamp) => {
          p2pCalls.push({ targetRuntimeId: runtimeId, envelope, ingressTimestamp });
          return deliveryAccepted('P2P_ENTITY_INPUT_DELIVERED');
        },
      }),
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    });

    expect(result).toMatchObject({
      delivery: {
        outcome: 'delivered',
        code: 'ROUTE_REMOTE_DELIVERED',
        retryable: false,
        fatal: false,
        terminal: true,
      },
    });
    expect(p2pCalls).toHaveLength(1);
    expect(p2pCalls[0]?.envelope).toMatchObject({
      sourceRuntimeHeight: 15,
      sourceRuntimeTimestamp: 2345,
      entityInputs: [expect.objectContaining({ runtimeId: targetRuntimeId })],
    });
  });

  test('sendEntityInputWithRouting exposes typed local queue result', () => {
    const queued: RoutedEntityInput[] = [];
    const localEntityId = entityId('38');
    const localSignerId = runtimeId('39');
    const env = {
      runtimeId: runtimeId('11'),
      state: {
  timestamp: 3456,
      },
      infrastructure: {},
      warn: () => {},
      error: () => {},
    } as unknown as RuntimeReplica;
    const input: RoutedEntityInput = {
      entityId: localEntityId,
      signerId: localSignerId,
      entityTxs: [],
    };

    const result = sendEntityInputWithRouting(env, input, {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      getP2P: () => null,
      enqueueRuntimeInputs: (_env, entityInputs) => {
        queued.push(...entityInputs);
      },
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => true,
      hasLocalSignerForEntitySigner: (_env, entity, signer) => entity === localEntityId && signer === localSignerId,
      resolveSoleLocalSignerForEntity: () => localSignerId,
      resolveRuntimeIdForEntity: () => null,
      resolveRuntimeIdForCrossJurisdictionEntity: () => null,
    });

    expect(result).toMatchObject({
      delivery: {
        outcome: 'queued',
        code: 'ROUTE_LOCAL_QUEUED',
        retryable: false,
        fatal: false,
        terminal: true,
      },
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.entityId).toBe(localEntityId);
  });

  test('defers when P2P reports a retryable transport failure', () => {
    const targetRuntimeId = runtimeId('77');
    const output: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: entityId('78'),
      signerId: runtimeId('79'),
      sourceRuntimeFrame: { height: 16, timestamp: 9012 },
      entityTxs: [{
        type: 'openAccount',
        data: { targetEntityId: entityId('80') },
      } as any],
    };
    const errors: Array<{ code: string; entityId?: string; runtimeId?: string; error?: string; delivery?: unknown }> = [];
    const warnings: string[] = [];
    const infos: string[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      state: {
  timestamp: 9012,
      },
      infrastructure: {
        directEntityInputsDispatch: () => deliveryDeferred({ outcome: 'deferred', code: 'ROUTE_DIRECT_MISS_FAILOVER' }),
      },
      warn: (_scope: string, code: string) => warnings.push(code),
      info: (_scope: string, code: string) => infos.push(code),
      error: (_scope: string, code: string, payload: any) => {
        errors.push({ code, ...payload });
      },
    } as unknown as RuntimeReplica;

    const deferred = dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      getP2P: () => ({
        enqueueEntityInputsDelivery: () => deliveryFailure({
          category: 'TransientRace',
          code: 'P2P_SEND_RETURNED_FALSE',
          message: 'P2P enqueue returned false',
          terminal: false,
        }),
      }),
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    });

    expect(deferred).toEqual([output]);
    expect(errors).toHaveLength(0);
    expect(warnings).toEqual([]);
    expect(infos).toEqual(['ROUTE_SEND_DEFERRED']);

    env.infrastructure!.deferredNetworkMeta = new Map([
      [buildRouteOutputKey(output), { attempts: 3, nextRetryAt: env.state.timestamp }],
    ]);
    dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      getP2P: () => ({
        enqueueEntityInputsDelivery: () => deliveryFailure({
          category: 'TransientRace',
          code: 'P2P_SEND_RETURNED_FALSE',
          message: 'P2P enqueue returned false',
          terminal: false,
        }),
      }),
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    });
    expect(warnings).toEqual([]);
    expect(infos).toEqual(['ROUTE_SEND_DEFERRED', 'ROUTE_SEND_DEFERRED']);
  });

  test('defers when neither direct dispatch nor P2P is available', () => {
    const targetRuntimeId = runtimeId('44');
    const output: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: entityId('55'),
      signerId: runtimeId('56'),
      sourceRuntimeFrame: { height: 17, timestamp: 5678 },
      entityTxs: [],
    };
    const warnings: string[] = [];
    const infos: string[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      state: {
  timestamp: 5678,
      },
      infrastructure: {
        directEntityInputsDispatch: () => deliveryDeferred({ outcome: 'deferred', code: 'ROUTE_DIRECT_MISS_FAILOVER' }),
      },
      warn: (_scope: string, code: string) => warnings.push(code),
      info: (_scope: string, code: string) => infos.push(code),
    } as unknown as RuntimeReplica;

    const deferred = dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    });
    expect(deferred).toEqual([output]);
    expect(warnings).toEqual([]);
    expect(infos).toEqual(['ROUTE_DEFERRED_NO_P2P']);
  });

  test('fails fast when P2P reports a routing contradiction', () => {
    const targetRuntimeId = runtimeId('81');
    const output: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: entityId('82'),
      signerId: runtimeId('83'),
      sourceRuntimeFrame: { height: 19, timestamp: 5678 },
      entityTxs: [],
    };
    const env = {
      runtimeId: runtimeId('11'),
      state: {
  timestamp: 5678,
      },
      infrastructure: {},
      warn: () => {},
      error: () => {},
    } as unknown as RuntimeReplica;

    expect(() => dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      getP2P: () => ({
        enqueueEntityInputsDelivery: () => deliveryFailure({
          category: 'Contradiction',
          code: 'P2P_ROUTE_CORRUPT',
          terminal: true,
        }),
      }),
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    })).toThrow(/ROUTE_SEND_NOT_DELIVERED/);
  });

  test('retargets trigger-only local outputs to the exact sole local signer before enqueue', () => {
    const localEntityId = entityId('66');
    const staleSignerId = runtimeId('67');
    const actualSignerId = runtimeId('68');
    const warnings: string[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      warn: (_scope: string, code: string) => warnings.push(code),
      error: () => {},
      infrastructure: { entityRuntimeHints: new Map() },
    } as unknown as RuntimeReplica;

    const result = planEntityOutputs(env, [{
      entityId: localEntityId,
      signerId: staleSignerId,
      entityTxs: [],
    }], {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => true,
      hasLocalSignerForEntitySigner: (_env, _entity, signerId) => signerId === actualSignerId,
      resolveSoleLocalSignerForEntity: () => actualSignerId,
      resolveRuntimeIdForEntity: () => null,
      resolveRuntimeIdForCrossJurisdictionEntity: () => null,
    });

    expect(result.localOutputs).toHaveLength(1);
    expect(result.localOutputs[0]?.signerId).toBe(actualSignerId);
    expect(result.deferredOutputs).toEqual([]);
    expect(warnings).toContain('ROUTE_RETARGET_LOCAL_TRIGGER_SIGNER');
  });

  test('retargets trigger-only remote outputs to the signed Profile authority before delivery', () => {
    const targetRuntimeId = runtimeId('69');
    const targetEntityId = entityId('6a');
    const staleSenderSignerId = runtimeId('6b');
    const profileSeed = 'runtime-routing-trigger-profile';
    const targetSignerId = deriveSignerAddressSync(profileSeed, '1').toLowerCase();
    const warnings: string[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      warn: (_scope: string, code: string) => warnings.push(code),
      error: () => {},
      infrastructure: {},
      gossip: {
        getProfiles: () => [signedRouteProfile(targetEntityId, targetRuntimeId, profileSeed)],
      },
    } as unknown as RuntimeReplica;

    const result = planEntityOutputs(env, [{
      entityId: targetEntityId,
      signerId: staleSenderSignerId,
      entityTxs: [],
    }], {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    });

    expect(result.remoteOutputs).toHaveLength(1);
    expect(result.remoteOutputs[0]?.output.signerId).toBe(targetSignerId);
    expect(warnings).toContain('ROUTE_RETARGET_REMOTE_PROFILE_SIGNER');
  });

  test('fails fast on tx-bearing remote outputs with stale signer instead of gossip retargeting', () => {
    const targetRuntimeId = runtimeId('69');
    const targetEntityId = entityId('6a');
    const staleSenderSignerId = runtimeId('6b');
    const profileSeed = 'runtime-routing-stale-profile';
    const targetSignerId = deriveSignerAddressSync(profileSeed, '1').toLowerCase();
    const errors: string[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      warn: () => {},
      error: (_scope: string, code: string) => errors.push(code),
      infrastructure: {},
      gossip: {
        getProfiles: () => [signedRouteProfile(targetEntityId, targetRuntimeId, profileSeed)],
      },
    } as unknown as RuntimeReplica;

    expect(() => planEntityOutputs(env, [{
      entityId: targetEntityId,
      signerId: staleSenderSignerId,
      entityTxs: [{ type: 'accountInput', data: { fromEntityId: entityId('6d'), toEntityId: targetEntityId } } as any],
    }], {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    })).toThrow('ROUTE_REMOTE_SIGNER_MISMATCH');

    expect(errors).toContain('ROUTE_REMOTE_SIGNER_MISMATCH');
  });

  test('routes tx-bearing remote outputs when signer matches signed Profile authority', () => {
    const targetRuntimeId = runtimeId('69');
    const targetEntityId = entityId('6a');
    const profileSeed = 'runtime-routing-tx-profile';
    const profileSignerId = deriveSignerAddressSync(profileSeed, '1').toLowerCase();
    const errors: string[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      warn: () => {},
      error: (_scope: string, code: string) => errors.push(code),
      infrastructure: {},
      gossip: {
        getProfiles: () => [signedRouteProfile(targetEntityId, targetRuntimeId, profileSeed)],
      },
    } as unknown as RuntimeReplica;

    const result = planEntityOutputs(env, [{
      entityId: targetEntityId,
      signerId: profileSignerId,
      entityTxs: [{ type: 'accountInput', data: { fromEntityId: entityId('6d'), toEntityId: targetEntityId } } as any],
    }], {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    });

    expect(result.remoteOutputs).toHaveLength(1);
    expect(result.remoteOutputs[0]?.output.signerId).toBe(profileSignerId);
    expect(errors).not.toContain('ROUTE_REMOTE_SIGNER_MISMATCH');
  });

  test('routes consensus-only remote outputs without retargeting to primary gossip validator', () => {
    const targetRuntimeId = runtimeId('69');
    const targetEntityId = entityId('6a');
    const profileSeed = 'runtime-routing-consensus-profile';
    const primarySignerId = deriveSignerAddressSync(profileSeed, '1').toLowerCase();
    const secondarySignerId = runtimeId('6c');
    const warnings: string[] = [];
    const errors: string[] = [];
    const proposalHash = testFrameHash('0xproposal');
    const env = {
      runtimeId: runtimeId('11'),
      warn: (_scope: string, code: string) => warnings.push(code),
      error: (_scope: string, code: string) => errors.push(code),
      infrastructure: {},
      gossip: {
        getProfiles: () => [signedRouteProfile(targetEntityId, targetRuntimeId, profileSeed)],
      },
    } as unknown as RuntimeReplica;

    const proposedFrameResult = planEntityOutputs(env, [{
      entityId: targetEntityId,
      signerId: secondarySignerId,
      proposedFrame: {
        height: 7,
        timestamp: 7,
        hash: proposalHash,
        parentFrameHash: frameParentHash(6),
        stateRoot: `0x${'11'.repeat(32)}`,
        authorityRoot: `0x${'22'.repeat(32)}`,
        txs: [],
        events: [],
        entityContext: emptyEntityContext(
          targetEntityId,
          primarySignerId,
          7,
          frameParentHash(6),
        ),
        leader: { proposerSignerId: primarySignerId, view: 0 },
        hashesToSign: [{ hash: proposalHash, type: 'entityFrame', context: 'entity-frame:7' }],
        collectedSigs: new Map(),
      } as never,
    }], {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    });
    const precommitResult = planEntityOutputs(env, [{
      entityId: targetEntityId,
      signerId: secondarySignerId,
      hashPrecommitFrame: { height: 7, frameHash: proposalHash },
      hashPrecommits: new Map([[primarySignerId, ['0xsig']]]),
    }], {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    });

    expect(proposedFrameResult.remoteOutputs[0]?.output.signerId).toBe(secondarySignerId);
    expect(precommitResult.remoteOutputs[0]?.output.signerId).toBe(secondarySignerId);
    expect(warnings).not.toContain('ROUTE_RETARGET_REMOTE_PROFILE_SIGNER');
    expect(errors).not.toContain('ROUTE_REMOTE_SIGNER_MISMATCH');
  });

  test('resolves remote runtime directly from gossip profile when hint cache is empty', () => {
    const targetRuntimeId = runtimeId('6e');
    const targetEntityId = entityId('6f');
    const env = {
      state: {
  timestamp: 1234,
      },
      infrastructure: {},
      gossip: {
        getProfiles: () => [{
          entityId: targetEntityId,
          runtimeId: targetRuntimeId,
          metadata: { board: { validators: [{ signerId: runtimeId('70') }] } },
        }],
      },
    } as unknown as RuntimeReplica;

    const resolved = resolveRuntimeIdForEntity(env, targetEntityId, {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
    });

    expect(resolved).toBe(targetRuntimeId);
    expect(env.infrastructure.entityRuntimeHints?.get(targetEntityId)?.seenAt).toBe(1234);
  });

  test('entity runtime hint ttl uses deterministic env timestamp', () => {
    const targetRuntimeId = runtimeId('71');
    const targetEntityId = entityId('72');
    const env = {
      state: {
  timestamp: 10_000,
      },
      infrastructure: { entityRuntimeHints: new Map() },
      gossip: {
        getProfiles: () => [{
          entityId: targetEntityId,
          runtimeId: targetRuntimeId,
          metadata: { board: { validators: [{ signerId: runtimeId('73') }] } },
        }],
      },
    } as unknown as RuntimeReplica;
    const deps = {
      ensureRuntimeInfrastructure: (targetEnv: RuntimeReplica) => targetEnv.infrastructure!,
    };

    expect(resolveRuntimeIdForEntity(env, targetEntityId, deps)).toBe(targetRuntimeId);
    expect(env.infrastructure!.entityRuntimeHints!.get(targetEntityId)?.seenAt).toBe(10_000);

    env.state.timestamp = 70_001;
    env.gossip = { getProfiles: () => [] } as never;
    expect(resolveRuntimeIdForEntity(env, targetEntityId, deps)).toBeNull();
  });

  test('fails fast on tx-bearing local outputs with stale signer instead of enqueueing a retry loop', () => {
    const localEntityId = entityId('69');
    const staleSignerId = runtimeId('6a');
    const actualSignerId = runtimeId('6b');
    const errors: string[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      warn: () => {},
      error: (_scope: string, code: string) => errors.push(code),
      infrastructure: {},
    } as unknown as RuntimeReplica;

    expect(() => planEntityOutputs(env, [{
      entityId: localEntityId,
      signerId: staleSignerId,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: entityId('6c'),
          tokenId: 1,
          amount: 1n,
          route: [localEntityId, entityId('6c')],
        },
      } as any],
    }], {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => true,
      hasLocalSignerForEntitySigner: (_env, _entity, signerId) => signerId === actualSignerId,
      resolveSoleLocalSignerForEntity: () => actualSignerId,
      resolveRuntimeIdForEntity: () => null,
      resolveRuntimeIdForCrossJurisdictionEntity: () => null,
    })).toThrow(/ROUTE_LOCAL_SIGNER_MISMATCH/);
    expect(errors).toContain('ROUTE_LOCAL_SIGNER_MISMATCH');
  });

  test('routes multi-signer outputs remotely when this runtime lacks the target signer', () => {
    const multiEntityId = entityId('74');
    const remoteSignerId = runtimeId('75');
    const targetRuntimeId = runtimeId('76');
    const errors: string[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      warn: () => {},
      error: (_scope: string, code: string) => errors.push(code),
      infrastructure: {},
    } as unknown as RuntimeReplica;

    const result = planEntityOutputs(env, [{
      entityId: multiEntityId,
      signerId: remoteSignerId,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: entityId('77'),
          tokenId: 1,
          amount: 1n,
          route: [multiEntityId, entityId('77')],
        },
      } as any],
    }], {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => true,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    });

    expect(result.localOutputs).toEqual([]);
    expect(result.remoteOutputs).toHaveLength(1);
    expect(result.remoteOutputs[0]?.targetRuntimeId).toBe(targetRuntimeId);
    expect(result.remoteOutputs[0]?.output.signerId).toBe(remoteSignerId);
    expect(errors).not.toContain('ROUTE_LOCAL_SIGNER_MISMATCH');
  });

  test('fails fast on unavailable consensus-only local signer', () => {
    const localEntityId = entityId('78');
    const missingSignerId = runtimeId('79');
    const actualSignerId = runtimeId('7a');
    const warnings: string[] = [];
    const errors: string[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      warn: (_scope: string, code: string) => warnings.push(code),
      error: (_scope: string, code: string) => errors.push(code),
      infrastructure: {},
    } as unknown as RuntimeReplica;

    expect(() => planEntityOutputs(env, [{
      entityId: localEntityId,
      signerId: missingSignerId,
      proposedFrame: {
        height: 7,
        timestamp: 7,
        hash: '0xproposal',
        txs: [],
        leader: { proposerSignerId: actualSignerId, view: 0 },
        hashesToSign: [{ hash: '0xproposal', type: 'entityFrame', context: 'entity-frame:7' }],
        collectedSigs: new Map(),
      } as any,
    }], {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => true,
      hasLocalSignerForEntitySigner: (_env, _entity, signerId) => signerId === actualSignerId,
      resolveSoleLocalSignerForEntity: () => actualSignerId,
      resolveRuntimeIdForEntity: () => null,
      resolveRuntimeIdForCrossJurisdictionEntity: () => null,
    })).toThrow('ROUTE_LOCAL_SIGNER_MISMATCH');

    expect(warnings).not.toContain('ROUTE_CONSENSUS_SIGNER_UNAVAILABLE');
    expect(errors).toContain('ROUTE_LOCAL_SIGNER_MISMATCH');
  });

  test('fails fast on inbound tx-bearing P2P input with stale signer', () => {
    const localEntityId = entityId('70');
    const actualSignerId = runtimeId('71');
    const staleSignerId = runtimeId('72');
    const errors: string[] = [];
    const enqueued: RoutedEntityInput[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      state: {
  eReplicas: new Map([[`${localEntityId}:${actualSignerId}`, { entityId: localEntityId, signerId: actualSignerId }]]),
      },
      infrastructure: { entityRuntimeHints: new Map() },
      warn: () => {},
      info: () => {},
      error: (_scope: string, code: string) => errors.push(code),
    } as unknown as RuntimeReplica;

    expect(() => routeInboundP2PEntityInput(env, runtimeId('12'), {
      runtimeId: runtimeId('11'),
      entityId: localEntityId,
      signerId: staleSignerId,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: entityId('73'),
          tokenId: 1,
          amount: 1n,
          route: [localEntityId, entityId('73')],
        },
      } as any],
    }, {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      enqueueRuntimeInputs: (_targetEnv, inputs) => {
        enqueued.push(...(inputs ?? []));
      },
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => true,
      hasLocalSignerForEntitySigner: (_targetEnv, _entity, signerId) => signerId === actualSignerId,
      resolveSoleLocalSignerForEntity: () => actualSignerId,
      getP2P: () => null,
      startRuntimeLoop: () => {},
      processRuntime: async () => undefined,
    })).toThrow(/INBOUND_ENTITY_SIGNER_MISMATCH/);
    expect(errors).toContain('INBOUND_ENTITY_SIGNER_MISMATCH');
    expect(enqueued).toHaveLength(0);
  });

  test('rejects a certified cross-j intent whose user siblings resolve to different Runtimes', () => {
    const localRuntimeId = runtimeId('11');
    const authenticatedUserRuntimeId = runtimeId('12');
    const otherUserRuntimeId = runtimeId('13');
    const sourceUserId = entityId('70');
    const targetUserId = entityId('71');
    const sourceHubId = entityId('72');
    const targetHubId = entityId('73');
    const sourceUserSignerId = runtimeId('74');
    const targetUserSignerId = runtimeId('75');
    const sourceHubSignerId = runtimeId('76');
    const targetHubSignerId = runtimeId('77');
    const route = {
      orderId: 'cross-j-invalid-runtime-topology',
      makerEntityId: sourceUserId,
      hubEntityId: sourceHubId,
      sourceSignerId: sourceUserSignerId,
      targetSignerId: targetUserSignerId,
      sourceHubSignerId,
      targetHubSignerId,
      source: {
        jurisdiction: 'stack:1:source', entityId: sourceUserId,
        counterpartyEntityId: sourceHubId, tokenId: 1, amount: 1n,
      },
      target: {
        jurisdiction: 'stack:2:target', entityId: targetHubId,
        counterpartyEntityId: targetUserId, tokenId: 2, amount: 1n,
      },
      sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      status: 'intent', createdAt: 1, updatedAt: 1, expiresAt: 10,
    } satisfies CrossJurisdictionSwapRoute;
    const enqueued: RoutedEntityInput[] = [];
    const env = {
      runtimeId: localRuntimeId,
      state: {
        eReplicas: new Map([
          [`${sourceHubId}:${sourceHubSignerId}`, { entityId: sourceHubId, signerId: sourceHubSignerId }],
          [`${targetHubId}:${targetHubSignerId}`, { entityId: targetHubId, signerId: targetHubSignerId }],
        ]),
      },
      infrastructure: {
        verifiedProfileRoutes: new Map([
          [sourceUserId, { runtimeId: authenticatedUserRuntimeId, runtimeSignerId: sourceUserSignerId }],
          [targetUserId, { runtimeId: otherUserRuntimeId, runtimeSignerId: targetUserSignerId }],
        ]),
      },
      warn: () => {}, info: () => {}, error: () => {},
    } as unknown as RuntimeReplica;

    expect(() => routeInboundP2PEntityInput(env, authenticatedUserRuntimeId, {
      entityId: sourceHubId,
      signerId: sourceHubSignerId,
      entityTxs: [{
        type: 'consensusOutput',
        data: {
          origin: {
            sourceEntityId: sourceUserId, lane: 'generic', sequence: 1n,
            semanticHash: `0x${'78'.repeat(32)}`, height: 1,
            frameHash: `0x${'79'.repeat(32)}`, outputIndex: 0,
          },
          outputHanko: '0x01',
          targetEntityId: sourceHubId,
          entityTxs: [{ type: 'prepareCrossJurisdictionSwap', data: { route } }],
        },
      }],
    }, {
      ensureRuntimeInfrastructure: target => target.infrastructure!,
      enqueueRuntimeInputs: (_target, inputs) => enqueued.push(...(inputs ?? [])),
      extractEntityId: key => String(key).split(':')[0] || '',
      hasLocalSignerForEntity: () => true,
      hasLocalSignerForEntitySigner: (_target, entity, signer) =>
        (entity === sourceHubId && signer === sourceHubSignerId) ||
        (entity === targetHubId && signer === targetHubSignerId),
      resolveSoleLocalSignerForEntity: () => sourceHubSignerId,
      getP2P: () => null,
    })).toThrow('CROSS_J_RUNTIME_TOPOLOGY_INVALID:cross-j-invalid-runtime-topology:OWNER_RUNTIME_MISMATCH');
    expect(enqueued).toEqual([]);
  });

  test('fails fast on inbound tx-bearing P2P input for an unknown local entity', () => {
    const targetEntityId = entityId('7b');
    const signerId = runtimeId('7c');
    const errors: string[] = [];
    const enqueued: RoutedEntityInput[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      state: {
  eReplicas: new Map(),
      },
      infrastructure: { entityRuntimeHints: new Map() },
      warn: () => {},
      info: () => {},
      error: (_scope: string, code: string) => errors.push(code),
    } as unknown as RuntimeReplica;

    expect(() => routeInboundP2PEntityInput(env, runtimeId('12'), {
      runtimeId: runtimeId('11'),
      entityId: targetEntityId,
      signerId,
      entityTxs: [{
        type: 'openAccount',
        data: {
          targetEntityId: entityId('7d'),
          tokenIds: [1],
        },
      } as any],
    }, {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      enqueueRuntimeInputs: (_targetEnv, inputs) => {
        enqueued.push(...(inputs ?? []));
      },
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      getP2P: () => null,
      startRuntimeLoop: () => {},
      processRuntime: async () => undefined,
    })).toThrow(/INBOUND_ENTITY_UNKNOWN_TARGET/);
    expect(errors).toContain('INBOUND_ENTITY_UNKNOWN_TARGET');
    expect(enqueued).toHaveLength(0);
  });

  test('fails fast before enqueueing tx-bearing P2P input into a halted runtime', () => {
    const localEntityId = entityId('7e');
    const signerId = runtimeId('7f');
    const errors: string[] = [];
    const enqueued: RoutedEntityInput[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      state: {
  eReplicas: new Map([[`${localEntityId}:${signerId}`, { entityId: localEntityId, signerId }]]),
      },
      infrastructure: { entityRuntimeHints: new Map(), halted: true },
      warn: () => {},
      info: () => {},
      error: (_scope: string, code: string) => errors.push(code),
    } as unknown as RuntimeReplica;

    expect(() => routeInboundP2PEntityInput(env, runtimeId('12'), {
      runtimeId: runtimeId('11'),
      entityId: localEntityId,
      signerId,
      entityTxs: [{
        type: 'accountInput',
        data: {
          fromEntityId: entityId('80'),
          toEntityId: localEntityId,
          height: 1,
        },
      } as any],
    }, {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      enqueueRuntimeInputs: (_targetEnv, inputs) => {
        enqueued.push(...(inputs ?? []));
      },
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => true,
      hasLocalSignerForEntitySigner: () => true,
      resolveSoleLocalSignerForEntity: () => signerId,
      getP2P: () => null,
      startRuntimeLoop: () => {},
      processRuntime: async () => undefined,
    })).toThrow(/INBOUND_ENTITY_RUNTIME_HALTED/);
    expect(errors).toContain('INBOUND_ENTITY_RUNTIME_HALTED');
    expect(enqueued).toHaveLength(0);
    expect(env.infrastructure.entityRuntimeHints.size).toBe(0);
  });

  test('returns retryable backpressure before enqueueing inbound P2P input during persistence quiesce', () => {
    const localEntityId = entityId('81');
    const signerId = runtimeId('82');
    const errors: string[] = [];
    const infos: string[] = [];
    const enqueued: RoutedEntityInput[] = [];
    let startCalls = 0;
    const env = {
      runtimeId: runtimeId('11'),
      state: {
  eReplicas: new Map([[`${localEntityId}:${signerId}`, { entityId: localEntityId, signerId }]]),
      },
      infrastructure: { entityRuntimeHints: new Map(), loopActive: false, persistenceQuiescing: true },
      warn: () => {},
      info: (_scope: string, code: string) => infos.push(code),
      error: (_scope: string, code: string) => errors.push(code),
    } as unknown as RuntimeReplica;

    expect(() => routeInboundP2PEntityInput(env, runtimeId('12'), {
      runtimeId: runtimeId('11'),
      entityId: localEntityId,
      signerId,
      entityTxs: [{
        type: 'accountInput',
        data: {
          fromEntityId: entityId('83'),
          toEntityId: localEntityId,
          height: 1,
        },
      } as any],
    }, {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      enqueueRuntimeInputs: (_targetEnv, inputs) => {
        enqueued.push(...(inputs ?? []));
      },
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => true,
      hasLocalSignerForEntitySigner: () => true,
      resolveSoleLocalSignerForEntity: () => signerId,
      getP2P: () => null,
      startRuntimeLoop: () => {
        startCalls += 1;
      },
      processRuntime: async () => undefined,
    })).toThrow(/INBOUND_ENTITY_RUNTIME_QUIESCING/);

    expect(errors).toEqual([]);
    expect(infos).toContain('INBOUND_ENTITY_RUNTIME_QUIESCING');
    expect(enqueued).toHaveLength(0);
    expect(startCalls).toBe(0);
    expect(env.infrastructure.entityRuntimeHints.size).toBe(0);
  });

  test('drains exact ingress accepted before persistence quiesce began', () => {
    const localEntityId = entityId('84');
    const signerId = runtimeId('85');
    const sourceRuntimeId = runtimeId('86');
    const enqueued: RoutedEntityInput[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      state: {
  height: 9,
  eReplicas: new Map([[`${localEntityId}:${signerId}`, { entityId: localEntityId, signerId }]]),
      },
      infrastructure: { entityRuntimeHints: new Map(), persistenceQuiescing: true },
      warn: () => {},
      info: () => {},
    } as unknown as RuntimeReplica;
    const input: RoutedEntityInput = {
      runtimeId: runtimeId('11'),
      entityId: localEntityId,
      signerId,
      hashPrecommitFrame: { height: 3, frameHash: `0x${'87'.repeat(32)}` },
      hashPrecommits: new Map([[runtimeId('88'), [`0x${'89'.repeat(65)}`]]]),
    };

    expect(routeInboundP2PEntityInput(env, sourceRuntimeId, input, {
      ensureRuntimeInfrastructure: (targetEnv) => targetEnv.infrastructure!,
      enqueueRuntimeInputs: (_targetEnv, inputs) => enqueued.push(...(inputs ?? [])),
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => true,
      hasLocalSignerForEntitySigner: () => true,
      resolveSoleLocalSignerForEntity: () => signerId,
      getP2P: () => null,
    }, env.state.timestamp, { acceptedBeforeQuiesce: true })).toEqual({ kind: 'queued' });

    expect(enqueued).toEqual([{ ...input, from: sourceRuntimeId }]);
  });
});
