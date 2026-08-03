import type {
  DeliverableEntityInput,
  RuntimeReplica,
  RoutedEntityInput,
  RuntimeEntityInputsEnvelope,
} from '../types';
import { createStructuredLogger, shortId } from '../../infra/logger';
import { normalizeRuntimeId } from '../../network/p2p/runtime-id';
import { compareStableText, safeStringify } from '../../protocol/serialization';
import { getWallClockMs } from '../../infra/time';
import { validateDeliverableEntityInput } from '../routing-validation';
import {
  isDeliveryDelivered,
  requireDeliveryDelivered,
  requireDeliveryResult,
  shouldRetryDelivery,
  type DeliveryResult,
} from '../../protocol/payments/delivery-result';
import { selectPotentialCrossJAccountInputPairs } from '../entity-routing';
import {
  buildRouteOutputKey,
  getReliableOutputIdentity,
  splitRoutedOutputByDeliveryLane,
  type ReliableOutputIdentity,
} from './identity';
import { signRuntimeEntityInputsEnvelope } from '../entity-input-envelope-auth';
import {
  buildPendingNetworkOutputs,
  buildRoutingDeliveryResult,
  compareOutputDelivery,
  enqueueP2PEntityInputsDelivery,
  groupAtomicCrossJAdmissionOutputs,
  isCrossJAdmissionSourceProposal,
  mergeRoutedEntityOutput,
  pruneReceiptedReliableOutputs,
  reportRetryableRouteDefer,
  rescheduleDeferredOutputs,
  splitPendingOutputsByRetryWindow,
  summarizeAccountEnvelopeOutputs,
  type PlannedRemoteOutput,
  type RuntimeEntityInputRoutingResult,
  type RuntimeOutputRoutingDeps,
} from './pending';
import { planEntityOutputs } from './plan';

const routeLog = createStructuredLogger('network.route');

const batchOutputsByTarget = (outputs: DeliverableEntityInput[]): DeliverableEntityInput[] => {
  const batched = new Map<string, DeliverableEntityInput>();

  for (const output of outputs.flatMap(candidate => splitRoutedOutputByDeliveryLane(candidate))) {
    const reliable = getReliableOutputIdentity(output);
    const laneKey = `${output.runtimeId}:${output.entityId}:${output.signerId || ''}`;
    const key = reliable
      ? `${laneKey}:${buildRouteOutputKey(output)}`
      : output.leaderTimeoutVote
        ? `${laneKey}:${buildRouteOutputKey(output)}`
        : laneKey;
    const existing = batched.get(key);

    if (existing) {
      mergeRoutedEntityOutput(existing, output);
      routeLog.debug('batch.merge', { key, txs: existing.entityTxs?.length || 0 });
    } else {
      batched.set(key, validateDeliverableEntityInput(structuredClone(output)));
    }
  }

  return Array.from(batched.values()).sort(compareOutputDelivery);
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

const outputEnvelopeGroupKey = (output: DeliverableEntityInput): string => {
  return safeStringify({
    runtimeId: normalizeRuntimeId(output.runtimeId),
  });
};

const buildRuntimeEntityInputsEnvelope = (
  env: RuntimeReplica,
  targetRuntimeId: string,
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
  return signRuntimeEntityInputsEnvelope(env, targetRuntimeId, {
    sourceRuntimeId,
    sourceRuntimeHeight: envelopeFrame.height,
    sourceRuntimeTimestamp: envelopeFrame.timestamp,
    entityInputs,
    ...(atomicCrossJurisdictionPair ? { atomicCrossJurisdictionPair } : {}),
  });
};

/**
 * Prior heights on this lane whose proposal the peer receipted but whose
 * certificate it never did. Non-empty means the lane must wait.
 */
const uncertifiedPriorHeights = (
  env: RuntimeReplica,
  targetRuntimeId: string,
  identity: ReliableOutputIdentity,
): number[] => {
  if (identity.kind !== 'entity-frame') return [];
  const normalizedTarget = normalizeRuntimeId(targetRuntimeId);
  if (!normalizedTarget) throw new Error('ROUTE_RELIABLE_TARGET_RUNTIME_INVALID');
  const priorReceipts = [
    ...(env.infrastructure?.receivedReliableReceiptLedger?.values() ?? []),
    ...(env.infrastructure?.receivedReliableTerminalWatermarks?.values() ?? []),
  ]
    .filter(receipt =>
      receipt.body.receiverRuntimeId === normalizedTarget &&
      receipt.body.identity.laneKey === identity.laneKey &&
      receipt.body.identity.height < identity.height);
  const proposals = new Set(
    priorReceipts
      .filter(receipt => receipt.body.identity.evidenceKind === 'entity-proposal')
      .map(receipt => receipt.body.identity.height),
  );
  const certificates = new Set(
    priorReceipts
      .filter(receipt => receipt.body.identity.evidenceKind === 'entity-certificate')
      .map(receipt => receipt.body.identity.height),
  );
  return [...proposals].filter(height => !certificates.has(height)).sort((left, right) => left - right);
};

const awaitsDurableEntityCertificate = (
  env: RuntimeReplica,
  targetRuntimeId: string,
  identity: ReliableOutputIdentity,
): boolean => uncertifiedPriorHeights(env, targetRuntimeId, identity).length > 0;

type OutputEnvelopeGroup = {
  targetRuntimeId: string;
  outputs: DeliverableEntityInput[];
  atomic: boolean;
  complete: boolean;
};

const buildOutputEnvelopeGroups = (
  outputs: PlannedRemoteOutput[],
): OutputEnvelopeGroup[] => {
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
      const ordinaryUnits = ordinary.length > 0
        ? groupAtomicCrossJAdmissionOutputs(batchOutputsByTarget(ordinary))
        : [];
      return [...atomicUnits, ...ordinaryUnits]
        .map(unit => ({ targetRuntimeId: group.targetRuntimeId, ...unit }));
    })
    .sort((left, right) =>
      compareStableText(left.targetRuntimeId, right.targetRuntimeId) ||
      compareOutputDelivery(left.outputs[0]!, right.outputs[0]!));
};

const assertCompleteOutputGroup = (
  group: OutputEnvelopeGroup,
  plannedOutputs: PlannedRemoteOutput[],
): void => {
  if (group.complete) return;
  throw new Error(
    'ROUTE_CROSS_J_INCOMPLETE_COHORT_MARKED_READY:' + safeStringify({
      targetRuntimeId: group.targetRuntimeId,
      outputs: summarizeAccountEnvelopeOutputs(group.outputs),
      atomicPairs: group.outputs.map(output => output.atomicCrossJurisdictionPair ?? null),
      plannedOutputs: plannedOutputs.map(({ output, targetRuntimeId }) => ({
        targetRuntimeId,
        ...summarizeAccountEnvelopeOutputs([output])[0],
      })),
    }),
  );
};

/**
 * A lane waiting on a prior height's certificate has no deadline: the wait ends
 * only when the peer's receipt arrives, and nothing guarantees it ever does. A
 * hub in that state stops sending on the lane, backs its Account mempool up
 * behind it, and reports healthy — the failure mode is silence. Count passes so
 * a wedged lane names itself instead.
 *
 * Passes rather than milliseconds: dispatch runs inside the Runtime frame path,
 * where a wall clock would be non-deterministic.
 */
const MAX_RELIABLE_LANE_CERTIFICATE_STALL_PASSES = 2_000;

const noteCertificateStall = (
  env: RuntimeReplica,
  targetRuntimeId: string,
  identity: ReliableOutputIdentity,
): void => {
  const infrastructure = env.infrastructure;
  if (!infrastructure) return;
  const stalls = infrastructure.reliableLaneCertificateStallPasses ??= new Map<string, number>();
  const passes = (stalls.get(identity.laneKey) ?? 0) + 1;
  stalls.set(identity.laneKey, passes);
  if (passes < MAX_RELIABLE_LANE_CERTIFICATE_STALL_PASSES) return;
  throw new Error(
    'ROUTE_RELIABLE_LANE_CERTIFICATE_STALLED:' + safeStringify({
      laneKey: identity.laneKey,
      entityId: identity.entityId,
      blockedHeight: identity.height,
      targetRuntimeId,
      passes,
      uncertifiedHeights: uncertifiedPriorHeights(env, targetRuntimeId, identity),
    }),
  );
};

const clearCertificateStall = (env: RuntimeReplica, identity: ReliableOutputIdentity | null): void => {
  if (identity) env.infrastructure?.reliableLaneCertificateStallPasses?.delete(identity.laneKey);
};

const selectSendableOutputs = (
  env: RuntimeReplica,
  group: OutputEnvelopeGroup,
  blockedReliableLanes: Set<string>,
  deferredOutputs: RoutedEntityInput[],
): DeliverableEntityInput[] => {
  const sendable: DeliverableEntityInput[] = [];
  for (const output of group.outputs) {
    const reliable = getReliableOutputIdentity(output);
    const blockedByLane =
      !group.atomic &&
      reliable &&
      reliable.kind !== 'account-ack' &&
      blockedReliableLanes.has(reliable.laneKey);
    if (blockedByLane) {
      deferredOutputs.push(output);
      continue;
    }
    if (reliable && awaitsDurableEntityCertificate(env, group.targetRuntimeId, reliable)) {
      deferredOutputs.push(output);
      blockedReliableLanes.add(reliable.laneKey);
      noteCertificateStall(env, group.targetRuntimeId, reliable);
      continue;
    }
    clearCertificateStall(env, reliable);
    sendable.push(output);
    // Except for Account ACKs, one reliable lane head remains pending until
    // its durable application receipt and therefore fences later entries.
    if (reliable && reliable.kind !== 'account-ack') {
      blockedReliableLanes.add(reliable.laneKey);
    }
  }
  return sendable;
};

const retainDeliveredReliableOutputs = (
  sendable: DeliverableEntityInput[],
  atomic: boolean,
  deferredOutputs: RoutedEntityInput[],
): void => {
  if (atomic) {
    deferredOutputs.push(...sendable);
    return;
  }
  deferredOutputs.push(...sendable.filter(output => getReliableOutputIdentity(output) !== null));
};

const deferOutputsAfterDeliveryFailure = (
  env: RuntimeReplica,
  deps: RuntimeOutputRoutingDeps,
  sendable: DeliverableEntityInput[],
  targetRuntimeId: string,
  details: Record<string, unknown>,
  deferredOutputs: RoutedEntityInput[],
): void => {
  for (const output of sendable) {
    reportRetryableRouteDefer(env, deps, output, {
      entityId: output.entityId,
      runtimeId: targetRuntimeId,
      ...details,
    });
  }
  deferredOutputs.push(...sendable);
};

const tryDirectOutputEnvelope = (
  env: RuntimeReplica,
  group: OutputEnvelopeGroup,
  sendable: DeliverableEntityInput[],
  envelope: RuntimeEntityInputsEnvelope,
  deps: RuntimeOutputRoutingDeps,
  deferredOutputs: RoutedEntityInput[],
): boolean => {
  const state = deps.ensureRuntimeInfrastructure(env);
  const directDispatch = state.directEntityInputsDispatch;
  if (!directDispatch) return false;
  const delivery = requireDeliveryResult(
    directDispatch(
      group.targetRuntimeId,
      envelope,
      envelope.sourceRuntimeTimestamp,
    ),
    'ROUTE_DIRECT_INVALID_DELIVERY_RESULT',
  );
  if (!isDeliveryDelivered(delivery)) return false;
  routeLog.info('output.accepted', {
    atMs: getWallClockMs(),
    transport: 'direct',
    code: delivery.code,
    targetRuntimeId: group.targetRuntimeId,
    sourceRuntimeHeight: envelope.sourceRuntimeHeight,
    outputs: summarizeAccountEnvelopeOutputs(sendable),
  });
  retainDeliveredReliableOutputs(sendable, group.atomic, deferredOutputs);
  return true;
};

const dispatchP2POutputEnvelope = (
  env: RuntimeReplica,
  group: OutputEnvelopeGroup,
  sendable: DeliverableEntityInput[],
  envelope: RuntimeEntityInputsEnvelope,
  deps: RuntimeOutputRoutingDeps,
  deferredOutputs: RoutedEntityInput[],
): void => {
  const p2p = deps.getP2P(env);
  if (!p2p) {
    for (const output of sendable) {
      const details = { entityId: output.entityId, runtimeId: group.targetRuntimeId };
      if (getReliableOutputIdentity(output)) {
        env.warn?.('network', 'ROUTE_RELIABLE_DEFERRED_NO_P2P', details);
      } else {
        env.info?.('network', 'ROUTE_DEFERRED_NO_P2P', details);
      }
    }
    deferredOutputs.push(...sendable);
    return;
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
      routeLog.info('output.accepted', {
        atMs: getWallClockMs(),
        transport: 'p2p',
        code: delivery.code,
        targetRuntimeId: group.targetRuntimeId,
        sourceRuntimeHeight: envelope.sourceRuntimeHeight,
        outputs: summarizeAccountEnvelopeOutputs(sendable),
      });
      retainDeliveredReliableOutputs(sendable, group.atomic, deferredOutputs);
      return;
    }
    if (shouldRetryDelivery(delivery)) {
      deferOutputsAfterDeliveryFailure(
        env,
        deps,
        sendable,
        group.targetRuntimeId,
        { delivery },
        deferredOutputs,
      );
      return;
    }
    requireDeliveryDelivered(delivery, result =>
      'ROUTE_SEND_NOT_DELIVERED: runtime=' + group.targetRuntimeId +
      ' code=' + result.code + ' inputs=' + sendable.length);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const transient = [
      'P2P_ENTITY_INPUTS_NOT_DELIVERED',
      'P2P_ENTITY_INPUTS_SEND_THROW',
      'P2P_TRANSPORT',
      'WebSocket',
    ].some(marker => message.includes(marker));
    if ((delivery !== null && shouldRetryDelivery(delivery)) || transient) {
      deferOutputsAfterDeliveryFailure(
        env,
        deps,
        sendable,
        group.targetRuntimeId,
        { error: message, ...(delivery ? { delivery } : {}) },
        deferredOutputs,
      );
      return;
    }
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
  deferredOutputs: RoutedEntityInput[],
): void => {
  if (
    tryDirectOutputEnvelope(
      env,
      group,
      sendable,
      envelope,
      deps,
      deferredOutputs,
    )
  ) {
    return;
  }
  dispatchP2POutputEnvelope(
    env,
    group,
    sendable,
    envelope,
    deps,
    deferredOutputs,
  );
};

export const dispatchEntityOutputs = (
  env: RuntimeReplica,
  outputs: PlannedRemoteOutput[],
  deps: RuntimeOutputRoutingDeps,
): RoutedEntityInput[] => {
  const deferredOutputs: RoutedEntityInput[] = [];
  const blockedReliableLanes = new Set<string>();
  for (const group of buildOutputEnvelopeGroups(outputs)) {
    assertCompleteOutputGroup(group, outputs);
    const sendable = selectSendableOutputs(
      env,
      group,
      blockedReliableLanes,
      deferredOutputs,
    );
    if (sendable.length === 0) continue;
    const envelope = buildRuntimeEntityInputsEnvelope(env, group.targetRuntimeId, sendable);
    if (group.atomic || sendable.some(isCrossJAdmissionSourceProposal)) {
      routeLog.info('crossj.admission_envelope_dispatch', {
        atomic: group.atomic,
        targetRuntimeId: group.targetRuntimeId,
        sourceRuntimeHeight: envelope.sourceRuntimeHeight,
        inputCount: sendable.length,
        outputs: summarizeAccountEnvelopeOutputs(sendable),
      });
    }
    dispatchOutputEnvelope(env, group, sendable, envelope, deps, deferredOutputs);
  }
  return deferredOutputs.sort(compareOutputDelivery);
};

export const sendEntityInputWithRouting = (
  env: RuntimeReplica,
  input: RoutedEntityInput,
  deps: RuntimeOutputRoutingDeps,
): RuntimeEntityInputRoutingResult => {
  const state = deps.ensureRuntimeInfrastructure(env);
  const originatedInput: RoutedEntityInput = input.sourceRuntimeFrame
    ? input
    : {
        ...input,
        sourceRuntimeFrame: {
          height: env.state.height,
          timestamp: env.state.timestamp,
        },
      };
  const pendingBeforePlan = buildPendingNetworkOutputs(pruneReceiptedReliableOutputs(env, [
    ...(env.pendingNetworkOutputs ?? []),
    originatedInput,
  ]));
  const { ready: readyPendingOutputs, waiting: waitingPendingOutputs } = splitPendingOutputsByRetryWindow(
    env,
    pendingBeforePlan,
    deps,
  );
  const { localOutputs, remoteOutputs, deferredOutputs } = planEntityOutputs(env, readyPendingOutputs, deps);
  if (remoteOutputs.length > 0 && state.recoveryBackupBarrier) {
    throw new Error('DIRECT_NETWORK_SEND_REQUIRES_COMMITTED_RECOVERY_BACKUP');
  }
  env.pendingNetworkOutputs = [];
  if (localOutputs.length > 0) {
    deps.enqueueRuntimeInputs(env, localOutputs, undefined, undefined, env.state.timestamp);
  }
  const deferred = dispatchEntityOutputs(env, remoteOutputs, deps);
  const remainingDeferred = [...deferredOutputs, ...deferred];
  env.pendingNetworkOutputs = rescheduleDeferredOutputs(
    env,
    readyPendingOutputs,
    remainingDeferred,
    waitingPendingOutputs,
    deps,
  );

  return {
    delivery: buildRoutingDeliveryResult({
      remoteCount: remoteOutputs.length,
      localCount: localOutputs.length,
      pendingCount: env.pendingNetworkOutputs.length,
    }),
  };
};
