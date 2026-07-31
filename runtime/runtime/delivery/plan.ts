import type { RuntimeReplica, RoutedEntityInput } from '../types';
import { entityInputHasCrossJurisdictionIntraRuntimeTx } from '../../extensions/cross-j/boundary';
import { createStructuredLogger, shortId } from '../../infra/logger';
import { normalizeRuntimeId } from '../../network/p2p/runtime-id';
import {
  buildRouteOutputKey,
  cloneRoutedOutputWithCachedIdentity,
  splitRoutedOutputByDeliveryLane,
} from './identity';
import {
  isTriggerOnlyOutput,
  isTxBearingOutput,
  mergeRoutedEntityOutput,
  reportRetryableRouteDefer,
  resolveGossipBoardSignerIds,
  toDeliverableEntityInput,
  type PlannedRemoteOutput,
  type RuntimeOutputRoutingDeps,
} from './pending';

const routeLog = createStructuredLogger('network.route');

type PlannedEntityOutput =
  | { kind: 'local'; output: RoutedEntityInput }
  | { kind: 'remote'; output: PlannedRemoteOutput }
  | { kind: 'deferred'; output: RoutedEntityInput };

const dedupeEntityOutputs = (outputs: RoutedEntityInput[]): RoutedEntityInput[] => {
  const deduped = new Map<string, RoutedEntityInput>();
  for (const output of outputs.flatMap(candidate => splitRoutedOutputByDeliveryLane(candidate))) {
    const key = buildRouteOutputKey(output);
    const existing = deduped.get(key);
    if (existing) mergeRoutedEntityOutput(existing, output);
    else deduped.set(key, cloneRoutedOutputWithCachedIdentity(output));
  }
  return [...deduped.values()];
};

const resolveLocalEntityOutput = (
  env: RuntimeReplica,
  output: RoutedEntityInput,
  deps: RuntimeOutputRoutingDeps,
): PlannedEntityOutput | null => {
  if (deps.hasLocalSignerForEntitySigner(env, output.entityId, output.signerId)) {
    return { kind: 'local', output };
  }
  if (!deps.hasLocalSignerForEntity(env, output.entityId)) return null;

  const resolvedSignerId = deps.resolveSoleLocalSignerForEntity(env, output.entityId);
  if (!resolvedSignerId) return null;
  if (isTriggerOnlyOutput(output)) {
    env.warn('network', 'ROUTE_RETARGET_LOCAL_TRIGGER_SIGNER', {
      entityId: output.entityId,
      inputSignerId: output.signerId,
      resolvedSignerId,
    }, output.entityId);
    return { kind: 'local', output: { ...output, signerId: resolvedSignerId } };
  }

  const txTypes = (output.entityTxs || []).map(tx => tx.type);
  if (!isTxBearingOutput(output)) {
    env.error?.('network', 'ROUTE_LOCAL_SIGNER_MISMATCH', {
      entityId: output.entityId,
      signerId: output.signerId,
      resolvedSignerId,
      hasProposedFrame: Boolean(output.proposedFrame),
      hasHashPrecommits: Boolean(output.hashPrecommits && output.hashPrecommits.size > 0),
    }, output.entityId);
    throw new Error(
      'ROUTE_LOCAL_SIGNER_MISMATCH: entity=' + output.entityId +
      ' signer=' + output.signerId + ' resolved=' + resolvedSignerId +
      ' consensusOnly=true',
    );
  }
  env.error?.('network', 'ROUTE_LOCAL_SIGNER_MISMATCH', {
    entityId: output.entityId,
    signerId: output.signerId,
    txTypes,
  }, output.entityId);
  throw new Error(
    'ROUTE_LOCAL_SIGNER_MISMATCH: entity=' + output.entityId +
    ' signer=' + output.signerId + ' txTypes=' + txTypes.join(','),
  );
};

const alignRemoteOutputSigner = (
  env: RuntimeReplica,
  output: RoutedEntityInput,
): RoutedEntityInput => {
  const gossipSignerIds = resolveGossipBoardSignerIds(env, output.entityId);
  const preferredSignerId = gossipSignerIds[0] || '';
  const outputSignerId = String(output.signerId || '').trim();
  if (!preferredSignerId || preferredSignerId.toLowerCase() === outputSignerId.toLowerCase()) {
    return output;
  }
  if (isTriggerOnlyOutput(output)) {
    env.warn?.('network', 'ROUTE_RETARGET_REMOTE_PROFILE_SIGNER', {
      entityId: output.entityId,
      inputSignerId: output.signerId,
      resolvedSignerId: preferredSignerId,
    }, output.entityId);
    return { ...output, signerId: preferredSignerId };
  }

  const signerKnown = gossipSignerIds.some(
    signerId => signerId.toLowerCase() === outputSignerId.toLowerCase(),
  );
  if (!isTxBearingOutput(output) || signerKnown) return output;
  const txTypes = (output.entityTxs || []).map(tx => tx.type);
  env.error?.('network', 'ROUTE_REMOTE_SIGNER_MISMATCH', {
    entityId: output.entityId,
    signerId: output.signerId,
    resolvedSignerId: preferredSignerId,
    boardSignerIds: gossipSignerIds,
    txTypes,
    hasProposedFrame: Boolean(output.proposedFrame),
    hasHashPrecommits: Boolean(output.hashPrecommits && output.hashPrecommits.size > 0),
  }, output.entityId);
  throw new Error(
    'ROUTE_REMOTE_SIGNER_MISMATCH: entity=' + output.entityId +
    ' signer=' + output.signerId + ' resolved=' + preferredSignerId +
    ' txTypes=' + txTypes.join(','),
  );
};

const bindVerifiedTargetRuntime = (
  env: RuntimeReplica,
  output: RoutedEntityInput,
  deps: RuntimeOutputRoutingDeps,
): { output: RoutedEntityInput; targetRuntimeId: string } => {
  const persisted = normalizeRuntimeId(String(output.runtimeId || ''));
  const resolved = deps.resolveRuntimeIdForEntity(env, output.entityId);
  const verified = normalizeRuntimeId(
    deps.getP2P(env)?.getVerifiedRuntimeRoute?.(output.entityId)?.runtimeId ?? '',
  );
  let routed = output;

  // A transport-authenticated profile supersedes durable destinations and
  // short-lived hints after a peer moves to a new Runtime.
  if (verified && persisted !== verified) {
    const routeBindingData = {
      entityId: output.entityId,
      persistedRuntimeId: persisted || null,
      resolvedRuntimeId: verified,
    };
    if (persisted) env.warn?.('network', 'ROUTE_TARGET_RUNTIME_REBOUND', routeBindingData);
    else env.info?.('network', 'ROUTE_TARGET_RUNTIME_BOUND', routeBindingData);
    routed = { ...output, runtimeId: verified };
  } else if (persisted && resolved && persisted !== resolved) {
    if (verified && verified === resolved) {
      env.warn?.('network', 'ROUTE_TARGET_RUNTIME_REBOUND', {
        entityId: output.entityId,
        persistedRuntimeId: persisted,
        resolvedRuntimeId: resolved,
      });
      routed = { ...output, runtimeId: resolved };
    } else {
      env.warn?.('network', 'ROUTE_TARGET_RUNTIME_CHANGE_UNVERIFIED', {
        entityId: output.entityId,
        persistedRuntimeId: persisted,
        resolvedRuntimeId: resolved,
      });
    }
  }
  return {
    output: routed,
    targetRuntimeId: normalizeRuntimeId(String(routed.runtimeId || '')) || verified || resolved || '',
  };
};

const planRemoteEntityOutput = (
  env: RuntimeReplica,
  initialOutput: RoutedEntityInput,
  deps: RuntimeOutputRoutingDeps,
): PlannedEntityOutput => {
  const signedOutput = alignRemoteOutputSigner(env, initialOutput);
  const { output, targetRuntimeId } = bindVerifiedTargetRuntime(env, signedOutput, deps);
  routeLog.debug('plan.output', {
    entity: shortId(output.entityId),
    runtime: targetRuntimeId ? shortId(targetRuntimeId, 8) : 'unknown',
  });
  if (!targetRuntimeId) {
    const txTypes = (output.entityTxs || []).map(tx => tx.type);
    if (entityInputHasCrossJurisdictionIntraRuntimeTx(output)) {
      env.error?.('network', 'ROUTE_TARGET_RUNTIME_UNKNOWN', {
        entityId: output.entityId,
        txTypes,
        protocol: 'cross-j',
      });
      throw new Error(
        'ROUTE_TARGET_RUNTIME_UNKNOWN: cross-j sibling entity=' + output.entityId +
        ' txTypes=' + txTypes.join(','),
      );
    }
    reportRetryableRouteDefer(env, deps, output, {
      entityId: output.entityId,
      reason: 'target-runtime-unknown',
      txTypes,
    });
    return { kind: 'deferred', output };
  }

  const localRuntimeId = normalizeRuntimeId(String(env.runtimeId || ''));
  if (localRuntimeId && targetRuntimeId === localRuntimeId) {
    env.error?.('network', 'ROUTE_STALE_SELF_HINT', {
      entityId: output.entityId,
      runtimeId: targetRuntimeId,
    });
    throw new Error(
      'ROUTE_STALE_SELF_HINT: entity=' + output.entityId + ' runtime=' + targetRuntimeId +
      ' txTypes=' + (output.entityTxs || []).map(tx => tx.type).join(','),
    );
  }
  if (entityInputHasCrossJurisdictionIntraRuntimeTx(output)) {
    throw new Error(
      'CROSS_J_REMOTE_OUTPUT_FORBIDDEN: entity=' +
      String(output.entityId || '').toLowerCase() + ' targetRuntime=' + targetRuntimeId +
      ' txTypes=' + (output.entityTxs || []).map(tx => tx.type).join(','),
    );
  }
  return {
    kind: 'remote',
    output: { output: toDeliverableEntityInput(output, targetRuntimeId), targetRuntimeId },
  };
};

export const planEntityOutputs = (
  env: RuntimeReplica,
  outputs: RoutedEntityInput[],
  deps: RuntimeOutputRoutingDeps,
): {
  localOutputs: RoutedEntityInput[];
  remoteOutputs: PlannedRemoteOutput[];
  deferredOutputs: RoutedEntityInput[];
} => {
  const localOutputs: RoutedEntityInput[] = [];
  const remoteOutputs: PlannedRemoteOutput[] = [];
  const deferredOutputs: RoutedEntityInput[] = [];
  for (const output of dedupeEntityOutputs(outputs)) {
    const decision = resolveLocalEntityOutput(env, output, deps) ??
      planRemoteEntityOutput(env, output, deps);
    if (decision.kind === 'local') localOutputs.push(decision.output);
    else if (decision.kind === 'remote') remoteOutputs.push(decision.output);
    else deferredOutputs.push(decision.output);
  }
  return { localOutputs, remoteOutputs, deferredOutputs };
};

