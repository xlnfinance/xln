import type {
  DeliverableEntityInput,
  RuntimeReplica,
  RoutedEntityInput,
  RuntimeEntityInputsEnvelope,
} from '../types';
import { createStructuredLogger, shortId } from '../../support/logger';
import { normalizeRuntimeId } from '../../network/p2p/auth/runtime-id';
import { getWallClockMs } from '../../support/time';
import { validateDeliverableEntityInput } from '../delivery/topology/routing-validation';
import {
  isDeliveryDelivered,
  requireDeliveryDelivered,
  requireDeliveryResult,
  type DeliveryResult,
} from '../../protocol/payments/delivery-result';
import { selectPotentialCrossJAccountInputPairs } from '../delivery/topology/entity-routing';
import { buildUnsignedRuntimeEntityInputsEnvelope } from '../admit/entity-input-envelope-auth.ts';
import {
  buildPendingNetworkOutputs,
  buildRoutingDeliveryResult,
  enqueueP2PEntityInputsDelivery,
  groupAtomicCrossJAdmissionOutputs,
  isCrossJAdmissionSourceProposal,
  mergeRoutedEntityOutput,
  pruneSettledOutputs,
  summarizeAccountEnvelopeOutputs,
  type PlannedRemoteOutput,
  type RuntimeEntityInputRoutingResult,
  type RuntimeOutputRoutingDeps,
} from './pending';
import { planEntityOutputs } from './plan';
import { recordRuntimeSecurityIncident } from '../observability/security-incidents';
import { createPreparedOutputGraph, type PreparedOutputGraph } from './prepared-output';
import { MAX_P2P_ENTITY_INPUTS } from '../../network/p2p/auth/entity-input-envelope';
import { traceAccountDeliveryHop } from '../../support/performance/account-delivery-trace';

const routeLog = createStructuredLogger('network.route');

const mergeRuntimeOutputEnvelopes = (
  existing: DeliverableEntityInput,
  incoming: DeliverableEntityInput,
): boolean => {
  const left = existing.entityTxs?.length === 1 && existing.entityTxs[0]?.type === 'runtimeOutput'
    ? existing.entityTxs[0]
    : null;
  const right = incoming.entityTxs?.length === 1 && incoming.entityTxs[0]?.type === 'runtimeOutput'
    ? incoming.entityTxs[0]
    : null;
  if (!left && !right) return false;
  if (!left || !right) throw new Error('ROUTE_RUNTIME_OUTPUT_MIXED_ENVELOPE');
  const leftData = left.data;
  const rightData = right.data;
  if (
    leftData.protocol !== rightData.protocol ||
    leftData.sourceEntityId !== rightData.sourceEntityId ||
    leftData.sourceSignerId !== rightData.sourceSignerId ||
    leftData.targetEntityId !== rightData.targetEntityId
  ) {
    throw new Error('ROUTE_RUNTIME_OUTPUT_AUTHORITY_MISMATCH');
  }
  existing.entityTxs = [{
    type: 'runtimeOutput',
    data: {
      ...leftData,
      entityTxs: [...leftData.entityTxs, ...rightData.entityTxs],
    },
  }];
  return true;
};

const batchOutputsByTarget = (
  outputs: DeliverableEntityInput[],
  graph: PreparedOutputGraph,
): DeliverableEntityInput[] => {
  const batched = new Map<string, DeliverableEntityInput>();

  for (const output of outputs.flatMap(candidate => graph.split(candidate))) {
    const runtimeId = output.runtimeId;
    if (!runtimeId) throw new Error('ROUTE_RUNTIME_OUTPUT_RUNTIME_ID_MISSING');
    const laneKey = `${runtimeId}:${output.entityId}:${output.signerId || ''}`;
    // Only tx-only outputs of one lane merge into a single input; every
    // consensus payload keeps its own input.
    const key = output.entityTxs?.length && !output.proposedFrame && !output.hashPrecommits
      && !output.leaderTimeoutVote && !output.jPrefixAttestations
      ? laneKey
      : `${laneKey}:${graph.prepare(output).routeKey}`;
    const existing = batched.get(key);

    if (existing) {
      if (!mergeRuntimeOutputEnvelopes(existing, { ...output, runtimeId })) {
        mergeRoutedEntityOutput(existing, output);
      }
      graph.invalidate(existing);
      routeLog.debug('batch.merge', { key, txs: existing.entityTxs?.length || 0 });
    } else {
      const target = validateDeliverableEntityInput({
        ...output,
        runtimeId,
        ...(output.entityTxs ? { entityTxs: [...output.entityTxs] } : {}),
      });
      graph.adopt(output, target);
      batched.set(key, target);
    }
  }

  return Array.from(batched.values());
};

const requireOutputRuntimeFrame = (
  output: RoutedEntityInput,
): NonNullable<RoutedEntityInput['sourceRuntimeFrame']> => {
  const frame = output.sourceRuntimeFrame;
  if (
    !frame ||
    !Number.isSafeInteger(frame.height) ||
    frame.height < 0 ||
    !Number.isSafeInteger(frame.timestamp) ||
    frame.timestamp < 0
  ) {
    throw new Error(
      `ROUTE_SOURCE_RUNTIME_FRAME_INVALID:entity=${output.entityId}:` +
      `height=${String(frame?.height)}:timestamp=${String(frame?.timestamp)}`,
    );
  }
  return frame;
};

const outputEnvelopeGroupKey = (output: DeliverableEntityInput): string =>
  normalizeRuntimeId(output.runtimeId);

const batchOrdinaryOutputsBySourceFrame = (
  outputs: DeliverableEntityInput[],
  graph: PreparedOutputGraph,
): DeliverableEntityInput[][] => {
  // One transport signature may authenticate many independent Entity lanes;
  // packetize exact same-frame inputs together. Cross-j cohorts were removed before this function and
  // retain their exact two-leg atomic envelopes.
  const byFrame = new Map<string, DeliverableEntityInput[]>();
  for (const output of batchOutputsByTarget(outputs, graph)) {
    const frame = requireOutputRuntimeFrame(output);
    const key = `${frame.height}:${frame.timestamp}`;
    const group = byFrame.get(key) ?? [];
    group.push(output);
    byFrame.set(key, group);
  }
  return [...byFrame.values()].flatMap(group => {
    const chunks: DeliverableEntityInput[][] = [];
    for (let offset = 0; offset < group.length; offset += MAX_P2P_ENTITY_INPUTS) {
      chunks.push(group.slice(offset, offset + MAX_P2P_ENTITY_INPUTS));
    }
    return chunks;
  });
};

const buildRuntimeEntityInputsEnvelope = (
  env: RuntimeReplica,
  _targetRuntimeId: string,
  outputs: readonly DeliverableEntityInput[],
): RuntimeEntityInputsEnvelope => {
  if (outputs.length === 0) throw new Error('ROUTE_ENTITY_INPUTS_ENVELOPE_EMPTY');
  const sourceRuntimeId = normalizeRuntimeId(String(env.runtimeId || ''));
  if (!sourceRuntimeId) throw new Error('ROUTE_SOURCE_RUNTIME_ID_INVALID');
  const firstFrame = requireOutputRuntimeFrame(outputs[0]!);
  const explicitPair = outputs[0]?.atomicCrossJurisdictionPair;
  if (explicitPair && !outputs.every(output =>
    output.atomicCrossJurisdictionPair?.phase === explicitPair.phase &&
    output.atomicCrossJurisdictionPair.pairKey === explicitPair.pairKey)) {
    throw new Error('ROUTE_CROSS_J_ATOMIC_COHORT_MISMATCH');
  }
  const structuralPairs = selectPotentialCrossJAccountInputPairs(outputs, {
    allowDifferentSourceRuntimeFrames: true,
  });
  const inferredProposalPair = !explicitPair && outputs.length === 2 && structuralPairs.length === 1;
  const atomicCrossJurisdictionPair = explicitPair ?? (inferredProposalPair
    ? {
        phase: 'proposal' as const,
        pairKey: structuralPairs[0]!.pairKey,
      }
    : undefined);
  const envelopeFrame = atomicCrossJurisdictionPair
    ? { height: env.state.height, timestamp: env.state.timestamp }
    : firstFrame;
  const entityInputs = outputs.map(output => {
    const frame = requireOutputRuntimeFrame(output);
    if (
      !atomicCrossJurisdictionPair &&
      (frame.height !== firstFrame.height || frame.timestamp !== firstFrame.timestamp)
    ) {
      throw new Error('ROUTE_ENTITY_INPUTS_ENVELOPE_FRAME_MISMATCH');
    }
    const {
      sourceRuntimeFrame: _sourceRuntimeFrame,
      atomicCrossJurisdictionPair: _atomicCrossJurisdictionPair,
      ...input
    } = output;
    return validateDeliverableEntityInput(input);
  });
  return buildUnsignedRuntimeEntityInputsEnvelope(env, {
    sourceRuntimeId,
    sourceRuntimeHeight: envelopeFrame.height,
    sourceRuntimeTimestamp: envelopeFrame.timestamp,
    entityInputs,
    ...(atomicCrossJurisdictionPair ? { atomicCrossJurisdictionPair } : {}),
  });
};

type OutputEnvelopeGroup = {
  targetRuntimeId: string;
  outputs: DeliverableEntityInput[];
  atomic: boolean;
  complete: boolean;
};

const buildOutputEnvelopeGroups = (
  outputs: PlannedRemoteOutput[],
  graph: PreparedOutputGraph,
): OutputEnvelopeGroup[] => {
  const structuralOutputs = outputs.map(({ output }) => ({ ...output, runtimeId: '' }));
  for (const pair of selectPotentialCrossJAccountInputPairs(structuralOutputs, {
    allowDifferentSourceRuntimeFrames: true,
  })) {
    const sourceRuntimeId = normalizeRuntimeId(outputs[pair.sourceInputIndex]!.targetRuntimeId);
    const targetRuntimeId = normalizeRuntimeId(outputs[pair.targetInputIndex]!.targetRuntimeId);
    if (sourceRuntimeId !== targetRuntimeId) {
      throw new Error(
        `CROSS_J_RUNTIME_TOPOLOGY_INVALID:${pair.pairKey}:SIBLING_RUNTIME_SPLIT:` +
        `${sourceRuntimeId}:${targetRuntimeId}`,
      );
    }
  }
  const byTarget = new Map<string, {
    targetRuntimeId: string;
    outputs: DeliverableEntityInput[];
  }>();
  for (const { output, targetRuntimeId } of outputs) {
    const key = outputEnvelopeGroupKey(output);
    const group = byTarget.get(key) ?? { targetRuntimeId, outputs: [] };
    if (group.targetRuntimeId !== targetRuntimeId) {
      throw new Error('ROUTE_ENTITY_INPUTS_ENVELOPE_TARGET_MISMATCH');
    }
    group.outputs.push(output);
    byTarget.set(key, group);
  }

  return [...byTarget.values()]
    .flatMap(group => {
      const units = groupAtomicCrossJAdmissionOutputs(group.outputs);
      const atomicUnits = units.filter(unit => unit.atomic);
      const ordinary = units.filter(unit => !unit.atomic).flatMap(unit => unit.outputs);
      const ordinaryUnits = batchOrdinaryOutputsBySourceFrame(ordinary, graph)
        .map(outputs => ({ outputs, atomic: false, complete: true }));
      return [...atomicUnits, ...ordinaryUnits]
        .map(unit => ({ targetRuntimeId: group.targetRuntimeId, ...unit }));
    });
};

/**
 * An unpaired cross-j Account leg must never be sent alone. It is a producer
 * invariant violation, not a transient transport condition: halt before any
 * member of the financial unit can escape.
 */
const failIncompleteCrossJCohort = (
  env: RuntimeReplica,
  group: OutputEnvelopeGroup,
  plannedOutputs: PlannedRemoteOutput[],
): never => {
  const detail = {
    targetRuntimeId: group.targetRuntimeId,
    outputs: summarizeAccountEnvelopeOutputs(group.outputs),
    atomicPairs: group.outputs.map(output => output.atomicCrossJurisdictionPair ?? null),
    plannedOutputs: plannedOutputs.map(({ output, targetRuntimeId }) => ({
      targetRuntimeId,
      ...summarizeAccountEnvelopeOutputs([output])[0],
    })),
  };
  recordRuntimeSecurityIncident(env, {
    domain: 'cross-j',
    code: 'CROSS_J_INCOMPLETE_COHORT_DROPPED',
    source: 'local-consensus',
    severity: 'critical',
    summary: 'Incomplete cross-j Account cohort reached transport dispatch',
    entityId: '',
  });
  env.error?.('network', 'CROSS_J_INCOMPLETE_COHORT_DROPPED', detail);
  throw new Error(`CROSS_J_INCOMPLETE_COHORT_DROPPED:${group.targetRuntimeId}`);
};

const dispatchDirectOutputEnvelope = (
  env: RuntimeReplica,
  group: OutputEnvelopeGroup,
  sendable: DeliverableEntityInput[],
  envelope: RuntimeEntityInputsEnvelope,
  directDispatch: NonNullable<ReturnType<RuntimeOutputRoutingDeps['ensureRuntimeInfrastructure']>['directEntityInputsDispatch']>,
): void => {
  const delivery = requireDeliveryResult(
    directDispatch(
      group.targetRuntimeId,
      envelope,
      envelope.sourceRuntimeTimestamp,
    ),
    'ROUTE_DIRECT_INVALID_DELIVERY_RESULT',
  );
  if (!isDeliveryDelivered(delivery)) {
    const detail = {
      targetRuntimeId: group.targetRuntimeId,
      sourceRuntimeHeight: envelope.sourceRuntimeHeight,
      delivery,
      outputs: summarizeAccountEnvelopeOutputs(sendable),
    };
    env.error?.('network', 'ROUTE_DIRECT_NOT_DELIVERED', detail);
    requireDeliveryDelivered(delivery, result =>
      `ROUTE_DIRECT_NOT_DELIVERED:runtime=${group.targetRuntimeId}:code=${result.code}:` +
      `sourceHeight=${envelope.sourceRuntimeHeight}:inputs=${sendable.length}`);
  }
  routeLog.debug('output.accepted', {
    atMs: getWallClockMs(),
    transport: 'direct',
    code: delivery.code,
    targetRuntimeId: group.targetRuntimeId,
    sourceRuntimeHeight: envelope.sourceRuntimeHeight,
    outputs: summarizeAccountEnvelopeOutputs(sendable),
  });
};

const dispatchP2POutputEnvelope = (
  env: RuntimeReplica,
  group: OutputEnvelopeGroup,
  sendable: DeliverableEntityInput[],
  envelope: RuntimeEntityInputsEnvelope,
  deps: RuntimeOutputRoutingDeps,
): void => {
  const p2p = deps.getP2P(env);
  if (!p2p) {
    const detail = {
      targetRuntimeId: group.targetRuntimeId,
      outputs: summarizeAccountEnvelopeOutputs(sendable),
    };
    env.error?.('network', 'ROUTE_P2P_UNAVAILABLE', detail);
    throw new Error(`ROUTE_P2P_UNAVAILABLE:${group.targetRuntimeId}`);
  }

  routeLog.debug('p2p.enqueue_envelope', {
    runtime: shortId(group.targetRuntimeId, 8),
    sourceHeight: envelope.sourceRuntimeHeight,
    inputs: envelope.entityInputs.length,
  });
  let delivery: DeliveryResult | null = null;
  try {
    delivery = enqueueP2PEntityInputsDelivery(
      p2p,
      group.targetRuntimeId,
      envelope,
      envelope.sourceRuntimeTimestamp,
    );
    if (isDeliveryDelivered(delivery)) {
      routeLog.debug('output.accepted', {
        atMs: getWallClockMs(),
        transport: 'p2p',
        code: delivery.code,
        targetRuntimeId: group.targetRuntimeId,
        sourceRuntimeHeight: envelope.sourceRuntimeHeight,
        outputs: summarizeAccountEnvelopeOutputs(sendable),
      });
      return;
    }
    requireDeliveryDelivered(delivery, result =>
      'ROUTE_SEND_NOT_DELIVERED: runtime=' + group.targetRuntimeId +
      ' code=' + result.code + ' inputs=' + sendable.length);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    env.error?.('network', 'ROUTE_SEND_FAILED', {
      runtimeId: group.targetRuntimeId,
      inputCount: sendable.length,
      error: message,
      ...(delivery ? { delivery } : {}),
    });
    throw error;
  }
};

const dispatchOutputEnvelope = (
  env: RuntimeReplica,
  group: OutputEnvelopeGroup,
  sendable: DeliverableEntityInput[],
  envelope: RuntimeEntityInputsEnvelope,
  deps: RuntimeOutputRoutingDeps,
): void => {
  const state = deps.ensureRuntimeInfrastructure(env);
  if (state.directEntityInputsDispatch) {
    // A Runtime that owns a duplex direct server has one authoritative peer
    // socket map. Falling through to relay after a direct miss forks transport
    // ordering and can erase Account ACKs after synchronous outbox retirement.
    dispatchDirectOutputEnvelope(env, group, sendable, envelope, state.directEntityInputsDispatch);
    return;
  }
  dispatchP2POutputEnvelope(env, group, sendable, envelope, deps);
};

export const dispatchEntityOutputs = (
  env: RuntimeReplica,
  outputs: PlannedRemoteOutput[],
  deps: RuntimeOutputRoutingDeps,
  graph: PreparedOutputGraph = createPreparedOutputGraph(),
): void => {
  for (const group of buildOutputEnvelopeGroups(outputs, graph)) {
    if (!group.complete) {
      failIncompleteCrossJCohort(env, group, outputs);
    }
    const sendable = group.outputs;
    const envelope = buildRuntimeEntityInputsEnvelope(env, group.targetRuntimeId, sendable);
    traceAccountDeliveryHop('committed-output', envelope, {
      runtimeId: env.runtimeId,
      targetRuntimeId: group.targetRuntimeId,
      transport: deps.ensureRuntimeInfrastructure(env).directEntityInputsDispatch ? 'direct-server' : 'p2p-client',
    });
    if (group.atomic || sendable.some(isCrossJAdmissionSourceProposal)) {
      routeLog.info('crossj.admission_envelope_dispatch', {
        atomic: group.atomic,
        targetRuntimeId: group.targetRuntimeId,
        sourceRuntimeHeight: envelope.sourceRuntimeHeight,
        inputCount: sendable.length,
        outputs: summarizeAccountEnvelopeOutputs(sendable),
      });
    }
    dispatchOutputEnvelope(env, group, sendable, envelope, deps);
  }
};

export const sendEntityInputWithRouting = (
  env: RuntimeReplica,
  input: RoutedEntityInput,
  deps: RuntimeOutputRoutingDeps,
): RuntimeEntityInputRoutingResult => {
  const state = deps.ensureRuntimeInfrastructure(env);
  const preparedOutputGraph = createPreparedOutputGraph();
  const originatedInput: RoutedEntityInput = input.sourceRuntimeFrame
    ? input
    : {
        ...input,
        sourceRuntimeFrame: {
          height: env.state.height,
          timestamp: env.state.timestamp,
        },
      };
  const pendingBeforePlan = buildPendingNetworkOutputs(pruneSettledOutputs(env, [
    ...(env.pendingNetworkOutputs ?? []),
    originatedInput,
  ]), preparedOutputGraph);
  const { localOutputs, remoteOutputs, deferredOutputs } = planEntityOutputs(
    env,
    pendingBeforePlan,
    deps,
    preparedOutputGraph,
  );
  if (remoteOutputs.length > 0 && state.recoveryBackupBarrier) {
    throw new Error('DIRECT_NETWORK_SEND_REQUIRES_COMMITTED_RECOVERY_BACKUP');
  }
  if (deferredOutputs.length > 0) throw new Error('ROUTE_DEFERRED_OUTPUTS_FORBIDDEN');
  dispatchEntityOutputs(env, remoteOutputs, deps, preparedOutputGraph);
  if (localOutputs.length > 0) {
    deps.enqueueRuntimeInputs(env, localOutputs, undefined, undefined, env.state.timestamp);
  }
  env.pendingNetworkOutputs = [];

  return {
    delivery: buildRoutingDeliveryResult({
      remoteCount: remoteOutputs.length,
      localCount: localOutputs.length,
      pendingCount: 0,
    }),
  };
};
