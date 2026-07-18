import { describe, expect, test } from 'bun:test';
import { handleInboundP2PEntityInput, resolveRuntimeIdForEntity } from '../machine/entity-routing';
import {
  buildPendingNetworkOutputs,
  buildRouteOutputKey,
  carriesEntityCommitNotification,
  dispatchEntityOutputs,
  getReliableOutputIdentity,
  mergeRoutedEntityOutput,
  planEntityOutputs,
  rescheduleDeferredOutputs,
  sendEntityInputWithRouting,
  splitPendingOutputsByRetryWindow,
} from '../machine/output-routing';
import { deliveryAccepted, deliveryDeferred, deliveryFailure } from '../protocol/payments/delivery-result';
import type { DeliverableEntityInput, EntityLeaderTimeoutVote, Env, RoutedEntityInput } from '../types';
import { getWallClockMs } from '../utils';

const runtimeId = (byte: string): string => `0x${byte.repeat(20)}`;
const entityId = (byte: string): string => `0x${byte.repeat(32)}`;

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
): DeliverableEntityInput => ({
  runtimeId: targetRuntimeId,
  entityId: targetEntityId,
  signerId: targetSignerId,
  entityTxs: [],
  proposedFrame: {
    height,
    timestamp: height,
    hash,
    txs: [],
    leader: { proposerSignerId: targetSignerId, view: 0 },
    collectedSigs: new Map([[targetSignerId, [signature]]]),
    hankos: [`0xhanko-${signature}`],
  } as never,
});

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
    timestamp: 2_500,
    runtimeState: {
      directEntityInputDispatch: (_runtimeId: string, input: DeliverableEntityInput) => {
        delivered.push(input);
        return deliveryAccepted('ROUTE_DIRECT_DELIVERED');
      },
    },
  } as unknown as Env;
  const deferred = dispatchEntityOutputs(env, outputs.map(output => ({ output, targetRuntimeId })), {
    ensureRuntimeState: target => target.runtimeState!,
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
      timestamp: 1,
      runtimeState: {},
      gossip: { getProfiles: () => [] },
      info: (_scope: string, code: string) => infoCodes.push(code),
      warn: () => {},
      error: () => {},
    } as unknown as Env;

    const planned = planEntityOutputs(env, [output], {
      ensureRuntimeState: target => target.runtimeState!,
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
        txs: [],
        leader: { proposerSignerId: runtimeId('11'), view: 0 },
      },
    } as RoutedEntityInput;

    expect(buildRouteOutputKey(first)).not.toBe(buildRouteOutputKey(second));
    expect(buildRouteOutputKey(first)).not.toBe(buildRouteOutputKey(nextHeightSameHash));
  });

  test('binds the exact Entity frame body while allowing only certificate evidence enrichment', () => {
    const targetRuntimeId = runtimeId('81');
    const targetEntityId = entityId('82');
    const targetSignerId = runtimeId('83');
    const withProvider = (provider: string, committed: boolean): DeliverableEntityInput => {
      const output = committed
        ? committedOutput(targetRuntimeId, targetEntityId, targetSignerId, 7, '0xclaimed-frame', '0xsig')
        : proposalOutput(targetRuntimeId, targetEntityId, targetSignerId, 7, '0xclaimed-frame', '0xsig');
      output.proposedFrame!.txs = [{
        type: 'chatMessage',
        data: {
          message: 'transport body binding',
          timestamp: 7,
          metadata: { type: 'provider-test', provider },
        },
      }];
      return output;
    };
    const honest = withProvider('alpha', false);
    const poisoned = withProvider('beta', false);
    const honestIdentity = getReliableOutputIdentity(honest);
    const poisonedIdentity = getReliableOutputIdentity(poisoned);

    expect(honestIdentity?.logicalKey).toBe(poisonedIdentity?.logicalKey);
    expect(honestIdentity?.bodyDigest).not.toBe(poisonedIdentity?.bodyDigest);
    expect(buildRouteOutputKey(honest)).not.toBe(buildRouteOutputKey(poisoned));
    for (const [first, second] of [
      [honest, poisoned],
      [poisoned, honest],
    ] as const) {
      expect(() => mergeRoutedEntityOutput(structuredClone(first), structuredClone(second)))
        .toThrow('ROUTE_ENTITY_FRAME_BODY_CONFLICT');
    }

    const enriched = mergeRoutedEntityOutput(
      structuredClone(honest),
      withProvider('alpha', true),
    );
    expect(carriesEntityCommitNotification(enriched)).toBe(true);
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
      timestamp: 1_000,
      pendingNetworkOutputs: [],
      runtimeState: {},
    } as unknown as Env;
    const deps = {
      ensureRuntimeState: (targetEnv: Env) => targetEnv.runtimeState!,
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
      timestamp: 1_000,
      pendingNetworkOutputs: [],
      runtimeState: {},
    } as unknown as Env;
    const deps = {
      ensureRuntimeState: (targetEnv: Env) => targetEnv.runtimeState!,
    } as any;

    const pending = rescheduleDeferredOutputs(env, [], [output], [], deps);
    const retry = env.runtimeState?.deferredNetworkMeta?.get(buildRouteOutputKey(output));
    expect(retry?.nextRetryAt).toBe(2_000);
    env.timestamp = 1_999;
    expect(splitPendingOutputsByRetryWindow(env, pending, deps).ready).toHaveLength(0);
    env.timestamp = 2_000;
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
      timestamp: 1,
      pendingNetworkOutputs: [],
      runtimeState: {},
    } as unknown as Env;
    const deps = {
      ensureRuntimeState: (targetEnv: Env) => targetEnv.runtimeState!,
    } as any;
    const before = getWallClockMs();
    const pending = rescheduleDeferredOutputs(env, [], [output], [], deps);
    const after = getWallClockMs();
    const retry = env.runtimeState?.deferredNetworkMeta?.get(buildRouteOutputKey(output));

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
    } as unknown as Env;

    const planned = planEntityOutputs(env, [output], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState ??= {},
      getP2P: () => ({
        enqueueEntityInputDelivery: () => deliveryAccepted('TEST_DELIVERED'),
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
    } as unknown as Env;

    const planned = planEntityOutputs(env, [output], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState ??= {},
      getP2P: () => ({
        enqueueEntityInputDelivery: () => deliveryAccepted('TEST_DELIVERED'),
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
    } as unknown as Env;

    const planned = planEntityOutputs(env, [output], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState ??= {},
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

  test('falls back to encrypted P2P delivery after direct dispatch misses', () => {
    const targetRuntimeId = runtimeId('22');
    const warnings: string[] = [];
    const p2pCalls: Array<{ targetRuntimeId: string; input: DeliverableEntityInput; ingressTimestamp?: number }> = [];
    const env = {
      runtimeId: runtimeId('11'),
      timestamp: 1234,
      runtimeState: {
        directEntityInputDispatch: () => deliveryDeferred({ outcome: 'deferred', code: 'ROUTE_DIRECT_MISS_FALLBACK' }),
      },
      warn: (_scope: string, code: string) => {
        warnings.push(code);
      },
    } as unknown as Env;
    const output: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: entityId('33'),
      signerId: runtimeId('34'),
      entityTxs: [{
        type: 'registerCrossJurisdictionSwap',
        data: { route: { orderId: 'route-1' } },
      } as any],
    };

    const deferred = dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      getP2P: () => ({
        enqueueEntityInputDelivery: (runtimeId, input, ingressTimestamp) => {
          p2pCalls.push({ targetRuntimeId: runtimeId, input, ingressTimestamp });
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
    expect(p2pCalls[0]?.input.entityId).toBe(output.entityId);
    expect(p2pCalls[0]?.ingressTimestamp).toBe(1234);
    expect(warnings).not.toContain('ROUTE_DIRECT_SOCKET_REQUIRED');
  });

  test('uses typed P2P delivery dispatch', () => {
    const targetRuntimeId = runtimeId('21');
    const p2pCalls: Array<{ targetRuntimeId: string; input: DeliverableEntityInput; ingressTimestamp?: number }> = [];
    const env = {
      runtimeId: runtimeId('11'),
      timestamp: 4321,
      runtimeState: {
        directEntityInputDispatch: () => deliveryDeferred({ outcome: 'deferred', code: 'ROUTE_DIRECT_MISS_FALLBACK' }),
      },
      warn: () => {},
      error: () => {},
    } as unknown as Env;
    const output: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: entityId('31'),
      signerId: runtimeId('32'),
      entityTxs: [],
    };

    const deferred = dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      getP2P: () => ({
        enqueueEntityInputDelivery: (runtimeId, input, ingressTimestamp) => {
          p2pCalls.push({ targetRuntimeId: runtimeId, input, ingressTimestamp });
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
      timestamp: 4331,
      runtimeState: {
        directEntityInputDispatch: () => deliveryDeferred({ outcome: 'deferred', code: 'ROUTE_DIRECT_MISS_FALLBACK' }),
      },
      warn: () => {},
      error: () => {},
    } as unknown as Env;
    const output: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: entityId('41'),
      signerId: runtimeId('42'),
      entityTxs: [],
    };

    expect(() => dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      getP2P: () => ({
        enqueueEntityInputDelivery: (() => true) as any,
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
      timestamp: 2468,
      runtimeState: {
        directEntityInputDispatch: () => ({
          outcome: 'delivered',
          code: 'ROUTE_DIRECT_DELIVERED',
          retryable: false,
          fatal: false,
          terminal: true,
        }),
      },
      warn: () => {},
      error: () => {},
    } as unknown as Env;
    const output: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: entityId('3a'),
      signerId: runtimeId('3b'),
      entityTxs: [],
    };

    const deferred = dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      getP2P: () => ({
        enqueueEntityInputDelivery: () => {
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

  test('hands off only the lane head and retains higher frames pending its receipt', () => {
    const targetRuntimeId = runtimeId('26');
    const targetEntityId = entityId('27');
    const targetSignerId = runtimeId('28');
    const outputs = [
      committedOutput(targetRuntimeId, targetEntityId, targetSignerId, 10, '0xcommit10', '0xsig10'),
      proposalOutput(targetRuntimeId, targetEntityId, targetSignerId, 2, '0xcommit02', '0xsig02'),
      committedOutput(targetRuntimeId, targetEntityId, targetSignerId, 1, '0xcommit01', '0xsig01'),
      proposalOutput(targetRuntimeId, targetEntityId, targetSignerId, 3, '0xcommit03', '0xsig03'),
    ];
    const { deferred, delivered } = dispatchFrameOutputs(outputs);

    expect(deferred.map(input => ({
      height: input.proposedFrame?.height,
      hash: input.proposedFrame?.hash,
    }))).toEqual([
      { height: 1, hash: '0xcommit01' },
      { height: 2, hash: '0xcommit02' },
      { height: 3, hash: '0xcommit03' },
      { height: 10, hash: '0xcommit10' },
    ]);
    expect(delivered.map(input => ({
      height: input.proposedFrame?.height,
      hash: input.proposedFrame?.hash,
    }))).toEqual([{ height: 1, hash: '0xcommit01' }]);
  });

  test('deduplicates exact certificates but preserves different evidence variants', () => {
    const targetRuntimeId = runtimeId('29');
    const targetEntityId = entityId('2a');
    const targetSignerId = runtimeId('2b');
    const first = committedOutput(
      targetRuntimeId,
      targetEntityId,
      targetSignerId,
      3,
      '0xcommit03',
      '0xsig03a',
    );
    const duplicate = committedOutput(
      targetRuntimeId,
      targetEntityId,
      targetSignerId,
      3,
      '0xcommit03',
      '0xsig03b',
    );
    const conflictingHash = committedOutput(
      targetRuntimeId,
      targetEntityId,
      targetSignerId,
      3,
      '0xcommit03-conflict',
      '0xsig03c',
    );

    expect(buildRouteOutputKey(first)).not.toBe(buildRouteOutputKey(duplicate));
    expect(buildRouteOutputKey(first)).not.toBe(buildRouteOutputKey(conflictingHash));
    expect(buildPendingNetworkOutputs([first, structuredClone(first)])).toHaveLength(1);

    const { deferred, delivered } = dispatchFrameOutputs([first, duplicate]);

    expect(deferred).toHaveLength(2);
    expect(delivered).toHaveLength(1);
    expect(buildRouteOutputKey(delivered[0]!)).toBe(buildRouteOutputKey(deferred[0]!));
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
    expect(buildRouteOutputKey(proposal)).not.toBe(buildRouteOutputKey(certificate));

    for (const outputs of [[proposal, certificate], [certificate, proposal]]) {
      const pending = buildPendingNetworkOutputs(outputs);
      expect(pending).toHaveLength(1);
      expect(carriesEntityCommitNotification(pending[0]!)).toBe(true);

      const { deferred, delivered } = dispatchFrameOutputs(pending as DeliverableEntityInput[]);
      expect(deferred).toHaveLength(1);
      expect(delivered).toHaveLength(1);
      expect(carriesEntityCommitNotification(delivered[0]!)).toBe(true);
    }
  });

  test('rejects legacy boolean direct dispatch results', () => {
    const targetRuntimeId = runtimeId('2a');
    const p2pCalls: unknown[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      timestamp: 2469,
      runtimeState: {
        directEntityInputDispatch: (() => true) as any,
      },
      warn: () => {},
      error: () => {},
    } as unknown as Env;
    const output: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: entityId('3e'),
      signerId: runtimeId('3f'),
      entityTxs: [],
    };

    expect(() => dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      getP2P: () => ({
        enqueueEntityInputDelivery: () => {
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

  test('falls back to P2P after typed direct dispatch defer', () => {
    const targetRuntimeId = runtimeId('25');
    const p2pCalls: Array<{ targetRuntimeId: string; input: DeliverableEntityInput; ingressTimestamp?: number }> = [];
    const env = {
      runtimeId: runtimeId('11'),
      timestamp: 1357,
      runtimeState: {
        directEntityInputDispatch: () => ({
          outcome: 'deferred',
          code: 'ROUTE_DIRECT_MISS_FALLBACK',
          retryable: true,
          fatal: false,
          terminal: false,
        }),
      },
      warn: () => {},
      error: () => {},
    } as unknown as Env;
    const output: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: entityId('3c'),
      signerId: runtimeId('3d'),
      entityTxs: [],
    };

    const deferred = dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      getP2P: () => ({
        enqueueEntityInputDelivery: (runtimeId, input, ingressTimestamp) => {
          p2pCalls.push({ targetRuntimeId: runtimeId, input, ingressTimestamp });
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
    const p2pCalls: Array<{ targetRuntimeId: string; input: DeliverableEntityInput; ingressTimestamp?: number }> = [];
    const env = {
      runtimeId: runtimeId('11'),
      timestamp: 2345,
      runtimeState: {
        directEntityInputDispatch: () => deliveryDeferred({ outcome: 'deferred', code: 'ROUTE_DIRECT_MISS_FALLBACK' }),
      },
      warn: () => {},
      error: () => {},
    } as unknown as Env;
    const input: RoutedEntityInput = {
      entityId: entityId('35'),
      signerId: runtimeId('36'),
      entityTxs: [{
        type: 'openAccount',
        data: { targetEntityId: entityId('37') },
      } as any],
    };

    const result = sendEntityInputWithRouting(env, input, {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      getP2P: () => ({
        enqueueEntityInputDelivery: (runtimeId, routedInput, ingressTimestamp) => {
          p2pCalls.push({ targetRuntimeId: runtimeId, input: routedInput, ingressTimestamp });
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
    expect(p2pCalls[0]?.input.runtimeId).toBe(targetRuntimeId);
  });

  test('sendEntityInputWithRouting exposes typed local queue result', () => {
    const queued: RoutedEntityInput[] = [];
    const localEntityId = entityId('38');
    const localSignerId = runtimeId('39');
    const env = {
      runtimeId: runtimeId('11'),
      timestamp: 3456,
      runtimeState: {},
      warn: () => {},
      error: () => {},
    } as unknown as Env;
    const input: RoutedEntityInput = {
      entityId: localEntityId,
      signerId: localSignerId,
      entityTxs: [],
    };

    const result = sendEntityInputWithRouting(env, input, {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
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
      timestamp: 9012,
      runtimeState: {
        directEntityInputDispatch: () => deliveryDeferred({ outcome: 'deferred', code: 'ROUTE_DIRECT_MISS_FALLBACK' }),
      },
      warn: (_scope: string, code: string) => warnings.push(code),
      info: (_scope: string, code: string) => infos.push(code),
      error: (_scope: string, code: string, payload: any) => {
        errors.push({ code, ...payload });
      },
    } as unknown as Env;

    const deferred = dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      getP2P: () => ({
        enqueueEntityInputDelivery: () => deliveryFailure({
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

    env.runtimeState!.deferredNetworkMeta = new Map([
      [buildRouteOutputKey(output), { attempts: 3, nextRetryAt: env.timestamp }],
    ]);
    dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      getP2P: () => ({
        enqueueEntityInputDelivery: () => deliveryFailure({
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
    expect(warnings).toEqual(['ROUTE_SEND_DEFERRED']);
  });

  test('defers when neither direct dispatch nor P2P is available', () => {
    const targetRuntimeId = runtimeId('44');
    const output: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: entityId('55'),
      signerId: runtimeId('56'),
      entityTxs: [],
    };
    const warnings: string[] = [];
    const infos: string[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      timestamp: 5678,
      runtimeState: {
        directEntityInputDispatch: () => deliveryDeferred({ outcome: 'deferred', code: 'ROUTE_DIRECT_MISS_FALLBACK' }),
      },
      warn: (_scope: string, code: string) => warnings.push(code),
      info: (_scope: string, code: string) => infos.push(code),
    } as unknown as Env;

    const deferred = dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
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

  test('keeps missing P2P loud for ordered consensus evidence', () => {
    const targetRuntimeId = runtimeId('45');
    const output = proposalOutput(
      targetRuntimeId,
      entityId('57'),
      runtimeId('58'),
      1,
      `0x${'59'.repeat(32)}`,
      '0xproposal-signature',
    );
    const warnings: string[] = [];
    const infos: string[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      timestamp: 5678,
      runtimeState: {
        directEntityInputDispatch: () => deliveryDeferred({ outcome: 'deferred', code: 'ROUTE_DIRECT_MISS_FALLBACK' }),
      },
      warn: (_scope: string, code: string) => warnings.push(code),
      info: (_scope: string, code: string) => infos.push(code),
    } as unknown as Env;

    const deferred = dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeState: target => target.runtimeState!,
      getP2P: () => null,
      enqueueRuntimeInputs: () => {},
      extractEntityId: key => String(key).split(':')[0] || '',
      hasLocalSignerForEntity: () => false,
      hasLocalSignerForEntitySigner: () => false,
      resolveSoleLocalSignerForEntity: () => null,
      resolveRuntimeIdForEntity: () => targetRuntimeId,
      resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
    });

    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.proposedFrame?.hash).toBe(output.proposedFrame?.hash);
    expect(warnings).toEqual(['ROUTE_RELIABLE_DEFERRED_NO_P2P']);
    expect(infos).toEqual([]);
  });

  test('fails fast when P2P reports a routing contradiction', () => {
    const targetRuntimeId = runtimeId('81');
    const output: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: entityId('82'),
      signerId: runtimeId('83'),
      entityTxs: [],
    };
    const env = {
      runtimeId: runtimeId('11'),
      timestamp: 5678,
      runtimeState: {},
      warn: () => {},
      error: () => {},
    } as unknown as Env;

    expect(() => dispatchEntityOutputs(env, [{ output, targetRuntimeId }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      getP2P: () => ({
        enqueueEntityInputDelivery: () => deliveryFailure({
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
      runtimeState: { entityRuntimeHints: new Map() },
    } as unknown as Env;

    const result = planEntityOutputs(env, [{
      entityId: localEntityId,
      signerId: staleSignerId,
      entityTxs: [],
    }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
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

  test('retargets trigger-only remote outputs to the target gossip board signer before delivery', () => {
    const targetRuntimeId = runtimeId('69');
    const targetEntityId = entityId('6a');
    const staleSenderSignerId = runtimeId('6b');
    const targetSignerId = runtimeId('6c');
    const warnings: string[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      warn: (_scope: string, code: string) => warnings.push(code),
      error: () => {},
      runtimeState: {},
      gossip: {
        getProfiles: () => [{
          entityId: targetEntityId,
          metadata: {
            board: {
              validators: [{ signerId: targetSignerId }],
            },
          },
        }],
      },
    } as unknown as Env;

    const result = planEntityOutputs(env, [{
      entityId: targetEntityId,
      signerId: staleSenderSignerId,
      entityTxs: [],
    }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
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
    const targetSignerId = runtimeId('6c');
    const errors: string[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      warn: () => {},
      error: (_scope: string, code: string) => errors.push(code),
      runtimeState: {},
      gossip: {
        getProfiles: () => [{
          entityId: targetEntityId,
          metadata: {
            board: {
              validators: [{ signerId: targetSignerId }],
            },
          },
        }],
      },
    } as unknown as Env;

    expect(() => planEntityOutputs(env, [{
      entityId: targetEntityId,
      signerId: staleSenderSignerId,
      entityTxs: [{ type: 'accountInput', data: { fromEntityId: entityId('6d'), toEntityId: targetEntityId } } as any],
    }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
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

  test('routes tx-bearing remote outputs when signer is a non-primary gossip board validator', () => {
    const targetRuntimeId = runtimeId('69');
    const targetEntityId = entityId('6a');
    const primarySignerId = runtimeId('6b');
    const secondarySignerId = runtimeId('6c');
    const errors: string[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      warn: () => {},
      error: (_scope: string, code: string) => errors.push(code),
      runtimeState: {},
      gossip: {
        getProfiles: () => [{
          entityId: targetEntityId,
          metadata: {
            board: {
              validators: [{ signerId: primarySignerId }, { signerId: secondarySignerId }],
            },
          },
        }],
      },
    } as unknown as Env;

    const result = planEntityOutputs(env, [{
      entityId: targetEntityId,
      signerId: secondarySignerId,
      entityTxs: [{ type: 'accountInput', data: { fromEntityId: entityId('6d'), toEntityId: targetEntityId } } as any],
    }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
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
    expect(result.remoteOutputs[0]?.output.signerId).toBe(secondarySignerId);
    expect(errors).not.toContain('ROUTE_REMOTE_SIGNER_MISMATCH');
  });

  test('routes consensus-only remote outputs without retargeting to primary gossip validator', () => {
    const targetRuntimeId = runtimeId('69');
    const targetEntityId = entityId('6a');
    const primarySignerId = runtimeId('6b');
    const secondarySignerId = runtimeId('6c');
    const warnings: string[] = [];
    const errors: string[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      warn: (_scope: string, code: string) => warnings.push(code),
      error: (_scope: string, code: string) => errors.push(code),
      runtimeState: {},
      gossip: {
        getProfiles: () => [{
          entityId: targetEntityId,
          metadata: {
            board: {
              validators: [{ signerId: primarySignerId }, { signerId: secondarySignerId }],
            },
          },
        }],
      },
    } as unknown as Env;

    const proposedFrameResult = planEntityOutputs(env, [{
      entityId: targetEntityId,
      signerId: secondarySignerId,
      proposedFrame: {
        height: 7,
        timestamp: 7,
        hash: '0xproposal',
        txs: [],
        leader: { proposerSignerId: primarySignerId, view: 0 },
        collectedSigs: new Map(),
      } as any,
    }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
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
      hashPrecommitFrame: { height: 7, frameHash: '0xproposal' },
      hashPrecommits: new Map([[primarySignerId, ['0xsig']]]),
    }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
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
      timestamp: 1234,
      runtimeState: {},
      gossip: {
        getProfiles: () => [{
          entityId: targetEntityId,
          runtimeId: targetRuntimeId,
          metadata: { board: { validators: [{ signerId: runtimeId('70') }] } },
        }],
      },
    } as unknown as Env;

    const resolved = resolveRuntimeIdForEntity(env, targetEntityId, {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
    });

    expect(resolved).toBe(targetRuntimeId);
    expect(env.runtimeState.entityRuntimeHints?.get(targetEntityId)?.seenAt).toBe(1234);
  });

  test('entity runtime hint ttl uses deterministic env timestamp', () => {
    const targetRuntimeId = runtimeId('71');
    const targetEntityId = entityId('72');
    const env = {
      timestamp: 10_000,
      runtimeState: { entityRuntimeHints: new Map() },
      gossip: {
        getProfiles: () => [{
          entityId: targetEntityId,
          runtimeId: targetRuntimeId,
          metadata: { board: { validators: [{ signerId: runtimeId('73') }] } },
        }],
      },
    } as unknown as Env;
    const deps = {
      ensureRuntimeState: (targetEnv: Env) => targetEnv.runtimeState!,
    };

    expect(resolveRuntimeIdForEntity(env, targetEntityId, deps)).toBe(targetRuntimeId);
    expect(env.runtimeState!.entityRuntimeHints!.get(targetEntityId)?.seenAt).toBe(10_000);

    env.timestamp = 70_001;
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
      runtimeState: {},
    } as unknown as Env;

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
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
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
      runtimeState: {},
    } as unknown as Env;

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
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
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
      runtimeState: {},
    } as unknown as Env;

    expect(() => planEntityOutputs(env, [{
      entityId: localEntityId,
      signerId: missingSignerId,
      proposedFrame: {
        height: 7,
        timestamp: 7,
        hash: '0xproposal',
        txs: [],
        leader: { proposerSignerId: actualSignerId, view: 0 },
        collectedSigs: new Map(),
      } as any,
    }], {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
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
      eReplicas: new Map([[`${localEntityId}:${actualSignerId}`, { entityId: localEntityId, signerId: actualSignerId }]]),
      runtimeState: { entityRuntimeHints: new Map() },
      warn: () => {},
      info: () => {},
      error: (_scope: string, code: string) => errors.push(code),
    } as unknown as Env;

    expect(() => handleInboundP2PEntityInput(env, runtimeId('12'), {
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
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
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

  test('fails fast on inbound tx-bearing P2P input for an unknown local entity', () => {
    const targetEntityId = entityId('7b');
    const signerId = runtimeId('7c');
    const errors: string[] = [];
    const enqueued: RoutedEntityInput[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      eReplicas: new Map(),
      runtimeState: { entityRuntimeHints: new Map() },
      warn: () => {},
      info: () => {},
      error: (_scope: string, code: string) => errors.push(code),
    } as unknown as Env;

    expect(() => handleInboundP2PEntityInput(env, runtimeId('12'), {
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
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
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
      eReplicas: new Map([[`${localEntityId}:${signerId}`, { entityId: localEntityId, signerId }]]),
      runtimeState: { entityRuntimeHints: new Map(), halted: true },
      warn: () => {},
      info: () => {},
      error: (_scope: string, code: string) => errors.push(code),
    } as unknown as Env;

    expect(() => handleInboundP2PEntityInput(env, runtimeId('12'), {
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
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
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
    expect(env.runtimeState.entityRuntimeHints.size).toBe(0);
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
      eReplicas: new Map([[`${localEntityId}:${signerId}`, { entityId: localEntityId, signerId }]]),
      runtimeState: { entityRuntimeHints: new Map(), loopActive: false, persistenceQuiescing: true },
      warn: () => {},
      info: (_scope: string, code: string) => infos.push(code),
      error: (_scope: string, code: string) => errors.push(code),
    } as unknown as Env;

    expect(() => handleInboundP2PEntityInput(env, runtimeId('12'), {
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
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
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
    expect(env.runtimeState.entityRuntimeHints.size).toBe(0);
  });

  test('drains exact ingress accepted before persistence quiesce began', () => {
    const localEntityId = entityId('84');
    const signerId = runtimeId('85');
    const sourceRuntimeId = runtimeId('86');
    const enqueued: RoutedEntityInput[] = [];
    const env = {
      runtimeId: runtimeId('11'),
      height: 9,
      eReplicas: new Map([[`${localEntityId}:${signerId}`, { entityId: localEntityId, signerId }]]),
      runtimeState: { entityRuntimeHints: new Map(), persistenceQuiescing: true },
      warn: () => {},
      info: () => {},
    } as unknown as Env;
    const input: RoutedEntityInput = {
      runtimeId: runtimeId('11'),
      entityId: localEntityId,
      signerId,
      hashPrecommitFrame: { height: 3, frameHash: `0x${'87'.repeat(32)}` },
      hashPrecommits: new Map([[runtimeId('88'), [`0x${'89'.repeat(65)}`]]]),
    };

    expect(handleInboundP2PEntityInput(env, sourceRuntimeId, input, {
      ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
      enqueueRuntimeInputs: (_targetEnv, inputs) => enqueued.push(...(inputs ?? [])),
      extractEntityId: (replicaKey) => String(replicaKey).split(':')[0] || '',
      hasLocalSignerForEntity: () => true,
      hasLocalSignerForEntitySigner: () => true,
      resolveSoleLocalSignerForEntity: () => signerId,
      getP2P: () => null,
    }, env.timestamp, { acceptedBeforeQuiesce: true })).toEqual({ kind: 'queued' });

    expect(enqueued).toEqual([{ ...input, from: sourceRuntimeId }]);
  });
});
