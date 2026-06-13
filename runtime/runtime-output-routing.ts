import type { DeliverableEntityInput, Env, RoutedEntityInput } from './types';
import { signatureMapSize } from './consensus-signatures';
import {
  entityInputHasCrossJurisdictionIntraRuntimeTx,
  isCrossJurisdictionEntityInputRemoteHopAllowed,
} from './cross-jurisdiction-boundary';
import { createStructuredLogger, shortId } from './logger';
import { normalizeRuntimeId } from './networking/runtime-id';
import { txFingerprint } from './state-helpers';
import { validateDeliverableEntityInput } from './validation-utils';

const routeLog = createStructuredLogger('network.route');

export const buildRouteOutputKey = (output: RoutedEntityInput): string => {
  const txPart = (output.entityTxs || [])
    .map(tx => txFingerprint(tx))
    .join('|');
  return `${output.entityId}:${output.signerId || ''}:${txPart}`;
};

export const carriesEntityCommitNotification = (output: RoutedEntityInput): boolean =>
  signatureMapSize(output.proposedFrame?.collectedSigs) > 0;

export const mergeRoutedEntityOutput = <T extends RoutedEntityInput>(existing: T, incoming: T): T => {
  if (incoming.entityTxs?.length) {
    existing.entityTxs = [...(existing.entityTxs || []), ...incoming.entityTxs];
  }
  if (incoming.hashPrecommits) {
    const mergedPrecommits = existing.hashPrecommits || new Map<string, string[]>();
    incoming.hashPrecommits.forEach((sigs, signerId) => {
      mergedPrecommits.set(signerId, sigs);
    });
    existing.hashPrecommits = mergedPrecommits;
  }
  if (incoming.proposedFrame) {
    const existingIsCommit = carriesEntityCommitNotification(existing);
    const incomingIsCommit = carriesEntityCommitNotification(incoming);
    if (!existing.proposedFrame || incomingIsCommit || !existingIsCommit) {
      existing.proposedFrame = incoming.proposedFrame;
    }
  }
  return existing;
};

export type PlannedRemoteOutput = {
  output: DeliverableEntityInput;
  targetRuntimeId: string;
};

type RuntimeP2PDispatch = {
  enqueueEntityInput(targetRuntimeId: string, input: DeliverableEntityInput, ingressTimestamp?: number): boolean;
};

export type RuntimeOutputRoutingDeps = {
  ensureRuntimeState(env: Env): NonNullable<Env['runtimeState']>;
  getP2P(env: Env): RuntimeP2PDispatch | null;
  enqueueRuntimeInputs(
    env: Env,
    entityInputs: RoutedEntityInput[],
    runtimeTxs?: never,
    jInputs?: never,
    ingressTimestamp?: number,
  ): void;
  extractEntityId(replicaKey: string): string;
  hasLocalSignerForEntity(env: Env, entityId: string): boolean;
  hasLocalSignerForEntitySigner(env: Env, entityId: string, signerId: string): boolean;
  resolveSoleLocalSignerForEntity(env: Env, entityId: string): string | null;
  resolveRuntimeIdForEntity(env: Env, entityId: string): string | null;
  resolveRuntimeIdForCrossJurisdictionEntity(env: Env, entityId: string): string | null;
};

const getDeferredNetworkMeta = (
  env: Env,
  deps: RuntimeOutputRoutingDeps,
): Map<string, { attempts: number; nextRetryAt: number }> => {
  const state = deps.ensureRuntimeState(env);
  if (!state.deferredNetworkMeta) {
    state.deferredNetworkMeta = new Map();
  }
  return state.deferredNetworkMeta;
};

const getRuntimeNowMs = (env: Env): number => env.timestamp ?? 0;

const toDeliverableEntityInput = (
  output: RoutedEntityInput,
  targetRuntimeId: string,
): DeliverableEntityInput => {
  const deliverable: DeliverableEntityInput = {
    ...output,
    runtimeId: targetRuntimeId,
  };
  return validateDeliverableEntityInput(deliverable);
};

const isTriggerOnlyOutput = (output: RoutedEntityInput): boolean =>
  (output.entityTxs?.length ?? 0) === 0 &&
  !output.proposedFrame &&
  (!output.hashPrecommits || output.hashPrecommits.size === 0);

const isTxBearingOutput = (output: RoutedEntityInput): boolean =>
  (output.entityTxs?.length ?? 0) > 0;

const readBoardValidatorSignerId = (validator: unknown): string => {
  if (typeof validator === 'string') return validator.trim();
  if (!validator || typeof validator !== 'object') return '';
  const raw = validator as { signerId?: unknown; signer?: unknown };
  return String(raw.signerId || raw.signer || '').trim();
};

const resolveGossipBoardSignerId = (env: Env, entityId: string): string => {
  const targetEntityId = String(entityId || '').trim().toLowerCase();
  if (!targetEntityId || !env.gossip?.getProfiles) return '';
  const profile = env.gossip.getProfiles().find(candidate =>
    String(candidate?.entityId || '').trim().toLowerCase() === targetEntityId,
  );
  const validators = profile?.metadata?.board?.validators;
  if (!Array.isArray(validators) || validators.length === 0) return '';
  return readBoardValidatorSignerId(validators[0]);
};

export const splitPendingOutputsByRetryWindow = (
  env: Env,
  pending: RoutedEntityInput[],
  deps: RuntimeOutputRoutingDeps,
): { ready: RoutedEntityInput[]; waiting: RoutedEntityInput[] } => {
  if (pending.length === 0) return { ready: [], waiting: [] };
  const nowMs = getRuntimeNowMs(env);
  const meta = getDeferredNetworkMeta(env, deps);
  const ready: RoutedEntityInput[] = [];
  const waiting: RoutedEntityInput[] = [];

  for (const output of pending) {
    const key = buildRouteOutputKey(output);
    const entry = meta.get(key);
    if (!entry || entry.nextRetryAt <= nowMs) {
      ready.push(output);
      continue;
    }
    waiting.push(output);
  }
  return { ready, waiting };
};

export const rescheduleDeferredOutputs = (
  env: Env,
  attemptedPending: RoutedEntityInput[],
  failed: RoutedEntityInput[],
  waiting: RoutedEntityInput[],
  deps: RuntimeOutputRoutingDeps,
): RoutedEntityInput[] => {
  const meta = getDeferredNetworkMeta(env, deps);
  const failedKeys = new Set(failed.map(output => buildRouteOutputKey(output)));

  for (const output of attemptedPending) {
    const key = buildRouteOutputKey(output);
    if (!failedKeys.has(key)) {
      meta.delete(key);
    }
  }

  if (failed.length > 0 || waiting.length > 0) {
    const sample = [...failed, ...waiting][0];
    throw new Error(
      `DEFERRED_NETWORK_OUTPUTS_FATAL: failed=${failed.length} waiting=${waiting.length} ` +
      `sampleEntity=${sample?.entityId ?? ''}`,
    );
  }

  return [];
};

export const planEntityOutputs = (
  env: Env,
  outputs: RoutedEntityInput[],
  deps: RuntimeOutputRoutingDeps,
): {
  localOutputs: RoutedEntityInput[];
  remoteOutputs: PlannedRemoteOutput[];
  deferredOutputs: RoutedEntityInput[];
} => {
  const localOutputs: RoutedEntityInput[] = [];
  const remoteOutputs: PlannedRemoteOutput[] = [];
  const deduped = new Map<string, RoutedEntityInput>();
  for (const output of outputs) {
    const key = buildRouteOutputKey(output);
    const existing = deduped.get(key);
    if (existing) {
      mergeRoutedEntityOutput(existing, output);
    } else {
      deduped.set(key, { ...output });
    }
  }
  const allOutputs = [...deduped.values()];
  const deferredOutputs: RoutedEntityInput[] = [];

  for (const output of allOutputs) {
    if (deps.hasLocalSignerForEntitySigner(env, output.entityId, output.signerId)) {
      localOutputs.push(output);
      continue;
    }
    if (deps.hasLocalSignerForEntity(env, output.entityId)) {
      const resolvedSignerId = deps.resolveSoleLocalSignerForEntity(env, output.entityId);
      if (resolvedSignerId && isTriggerOnlyOutput(output)) {
        env.warn('network', 'ROUTE_RETARGET_LOCAL_TRIGGER_SIGNER', {
          entityId: output.entityId,
          inputSignerId: output.signerId,
          resolvedSignerId,
        }, output.entityId);
        localOutputs.push({ ...output, signerId: resolvedSignerId });
        continue;
      }
      if (resolvedSignerId) {
        if (!isTxBearingOutput(output)) {
          env.warn('network', 'ROUTE_CONSENSUS_SIGNER_UNAVAILABLE', {
            entityId: output.entityId,
            signerId: output.signerId,
            resolvedSignerId,
            hasProposedFrame: Boolean(output.proposedFrame),
            hasHashPrecommits: Boolean(output.hashPrecommits && output.hashPrecommits.size > 0),
          }, output.entityId);
          continue;
        }
        env.error?.('network', 'ROUTE_LOCAL_SIGNER_MISMATCH', {
          entityId: output.entityId,
          signerId: output.signerId,
          txTypes: (output.entityTxs || []).map(tx => tx.type),
        }, output.entityId);
        throw new Error(
          `ROUTE_LOCAL_SIGNER_MISMATCH: entity=${output.entityId} signer=${output.signerId} ` +
          `txTypes=${(output.entityTxs || []).map(tx => tx.type).join(',')}`,
        );
      }
    }
    let outputToRoute = output;
    const gossipSignerId = resolveGossipBoardSignerId(env, output.entityId);
    if (gossipSignerId && gossipSignerId.toLowerCase() !== String(output.signerId || '').toLowerCase()) {
      env.warn?.('network', 'ROUTE_RETARGET_REMOTE_PROFILE_SIGNER', {
        entityId: output.entityId,
        inputSignerId: output.signerId,
        resolvedSignerId: gossipSignerId,
        txTypes: (output.entityTxs || []).map(tx => tx.type),
      }, output.entityId);
      outputToRoute = { ...output, signerId: gossipSignerId };
    }

    const targetRuntimeId = deps.resolveRuntimeIdForEntity(env, outputToRoute.entityId);
    routeLog.debug('plan.output', {
      entity: shortId(outputToRoute.entityId),
      runtime: targetRuntimeId ? shortId(targetRuntimeId, 8) : 'unknown',
    });
    if (!targetRuntimeId) {
      throw new Error(
        `ROUTE_TARGET_RUNTIME_UNKNOWN: entity=${outputToRoute.entityId} ` +
        `txTypes=${(outputToRoute.entityTxs || []).map(tx => tx.type).join(',')}`,
      );
    }
    const localRuntimeId = normalizeRuntimeId(String(env.runtimeId || ''));
    if (localRuntimeId && targetRuntimeId === localRuntimeId) {
      env.error?.('network', 'ROUTE_STALE_SELF_HINT', {
        entityId: outputToRoute.entityId,
        runtimeId: targetRuntimeId,
      });
      throw new Error(
        `ROUTE_STALE_SELF_HINT: entity=${outputToRoute.entityId} runtime=${targetRuntimeId} ` +
        `txTypes=${(outputToRoute.entityTxs || []).map(tx => tx.type).join(',')}`,
      );
    }
    if (
      entityInputHasCrossJurisdictionIntraRuntimeTx(outputToRoute) &&
      !isCrossJurisdictionEntityInputRemoteHopAllowed(
        outputToRoute,
        env.runtimeId,
        targetRuntimeId,
        entityId => deps.resolveRuntimeIdForCrossJurisdictionEntity(env, entityId),
      )
    ) {
      throw new Error(
        `CROSS_J_REMOTE_TOPOLOGY_INVALID: entity=${String(outputToRoute.entityId || '').toLowerCase()} ` +
        `targetRuntime=${targetRuntimeId} txTypes=${(outputToRoute.entityTxs || []).map(tx => tx.type).join(',')}`,
      );
    }
    remoteOutputs.push({ output: toDeliverableEntityInput(outputToRoute, targetRuntimeId), targetRuntimeId });
  }

  return { localOutputs, remoteOutputs, deferredOutputs };
};

const batchOutputsByTarget = (outputs: DeliverableEntityInput[]): DeliverableEntityInput[] => {
  const batched = new Map<string, DeliverableEntityInput>();

  for (const output of outputs) {
    const key = `${output.runtimeId}:${output.entityId}:${output.signerId || ''}`;
    const existing = batched.get(key);

    if (existing) {
      mergeRoutedEntityOutput(existing, output);
      routeLog.debug('batch.merge', { key, txs: existing.entityTxs?.length || 0 });
    } else {
      batched.set(key, validateDeliverableEntityInput({ ...output }));
    }
  }

  return Array.from(batched.values());
};

export const dispatchEntityOutputs = (
  env: Env,
  outputs: PlannedRemoteOutput[],
  deps: RuntimeOutputRoutingDeps,
): RoutedEntityInput[] => {
  const state = deps.ensureRuntimeState(env);
  const directDispatch = state.directEntityInputDispatch;
  const p2p = deps.getP2P(env);

  const groupedByRuntime = new Map<string, DeliverableEntityInput[]>();
  for (const { output, targetRuntimeId } of outputs) {
    const list = groupedByRuntime.get(targetRuntimeId) || [];
    list.push(output);
    groupedByRuntime.set(targetRuntimeId, list);
  }

  const batchedOutputs: PlannedRemoteOutput[] = [];
  for (const [targetRuntimeId, grouped] of groupedByRuntime.entries()) {
    const batchedGrouped = batchOutputsByTarget(grouped);
    for (const output of batchedGrouped) {
      batchedOutputs.push({ output, targetRuntimeId });
    }
  }
  if (batchedOutputs.length < outputs.length) {
    routeLog.debug('batch.reduced', { before: outputs.length, after: batchedOutputs.length });
  }

  const deferredOutputs: RoutedEntityInput[] = [];
  for (const { output, targetRuntimeId } of batchedOutputs) {
    if (directDispatch) {
      const deliveredDirect = directDispatch(targetRuntimeId, output, env.timestamp);
      if (deliveredDirect) {
        continue;
      }
      // Direct dispatch is only an optimization for runtimes connected to this
      // process. A miss must still fall through to RuntimeP2P, which encrypts the
      // entity_input and delivers it over relay/direct transport. Cross-j system
      // txs are safe here because planEntityOutputs already validated that the
      // hop is exactly between the two runtimes bound by the route topology.
    }
    if (!p2p) {
      env.error?.('network', 'ROUTE_NO_P2P', {
        entityId: output.entityId,
        runtimeId: targetRuntimeId,
      });
      throw new Error(`ROUTE_NO_P2P: entity=${output.entityId} runtime=${targetRuntimeId}`);
    }
    routeLog.debug('p2p.enqueue', {
      runtime: shortId(targetRuntimeId, 8),
      entity: shortId(output.entityId),
      txs: output.entityTxs?.length || 0,
    });
    try {
      const delivered = p2p.enqueueEntityInput(targetRuntimeId, output, env.timestamp);
      if (delivered !== true) {
        throw new Error(
          `ROUTE_SEND_NOT_DELIVERED: entity=${output.entityId} runtime=${targetRuntimeId} ` +
          `txTypes=${(output.entityTxs || []).map(tx => tx.type).join(',')}`,
        );
      }
    } catch (error) {
      env.error?.('network', 'ROUTE_SEND_FAILED', {
        entityId: output.entityId,
        runtimeId: targetRuntimeId,
        error: (error as Error).message,
      });
      throw error;
    }
  }
  return deferredOutputs;
};

export const sendEntityInputWithRouting = (
  env: Env,
  input: RoutedEntityInput,
  deps: RuntimeOutputRoutingDeps,
): { sent: boolean; deferred: boolean; queuedLocal: boolean } => {
  const state = deps.ensureRuntimeState(env);
  const pendingBeforePlan = env.pendingNetworkOutputs ?? [];
  if (pendingBeforePlan.length > 0) {
    throw new Error(`PENDING_NETWORK_OUTPUTS_FATAL: count=${pendingBeforePlan.length}`);
  }
  const { ready: readyPendingOutputs, waiting: waitingPendingOutputs } = splitPendingOutputsByRetryWindow(
    env,
    pendingBeforePlan,
    deps,
  );
  const outputsToPlan = [...readyPendingOutputs, input];
  const { localOutputs, remoteOutputs, deferredOutputs } = planEntityOutputs(env, outputsToPlan, deps);
  if (remoteOutputs.length > 0 && state.recoveryBackupBarrier) {
    throw new Error('DIRECT_NETWORK_SEND_REQUIRES_COMMITTED_RECOVERY_BACKUP');
  }
  env.pendingNetworkOutputs = [];
  if (localOutputs.length > 0) {
    deps.enqueueRuntimeInputs(env, localOutputs, undefined, undefined, env.timestamp);
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
    sent: remoteOutputs.length > 0 && deferred.length === 0,
    deferred: env.pendingNetworkOutputs.length > 0,
    queuedLocal: localOutputs.length > 0,
  };
};
