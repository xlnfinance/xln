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
  enqueueEntityInput(targetRuntimeId: string, input: DeliverableEntityInput, ingressTimestamp?: number): void;
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
  resolveRuntimeIdForEntity(env: Env, entityId: string): string | null;
  resolveRuntimeIdForCrossJurisdictionEntity(env: Env, entityId: string): string | null;
};

const DEFER_RETRY_DELAY_MS = 5_000;
const DEFER_MAX_ATTEMPTS = 3;

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
  const nowMs = getRuntimeNowMs(env);
  const meta = getDeferredNetworkMeta(env, deps);
  const next = new Map<string, RoutedEntityInput>();

  for (const output of waiting) {
    next.set(buildRouteOutputKey(output), output);
  }

  const failedKeys = new Set(failed.map(output => buildRouteOutputKey(output)));

  for (const output of attemptedPending) {
    const key = buildRouteOutputKey(output);
    if (!failedKeys.has(key)) {
      meta.delete(key);
    }
  }

  for (const output of failed) {
    const key = buildRouteOutputKey(output);
    const entry = meta.get(key);
    const attempts = (entry?.attempts ?? 0) + 1;
    if (attempts >= DEFER_MAX_ATTEMPTS) {
      meta.delete(key);
      env.warn('network', 'ROUTE_DROP_MAX_RETRIES', {
        entityId: output.entityId,
        attempts,
      });
      continue;
    }

    meta.set(key, {
      attempts,
      nextRetryAt: nowMs + DEFER_RETRY_DELAY_MS,
    });
    next.set(key, output);

    if (attempts === 1) {
      env.warn('network', 'ROUTE_DEFER_RETRY', {
        entityId: output.entityId,
        retryInMs: DEFER_RETRY_DELAY_MS,
        attemptsRemaining: DEFER_MAX_ATTEMPTS - attempts,
      });
    }
  }

  return [...next.values()];
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
  const localEntityIds = new Set<string>();
  for (const replicaKey of env.eReplicas.keys()) {
    try {
      localEntityIds.add(deps.extractEntityId(replicaKey));
    } catch {
      // Skip malformed replica keys
    }
  }

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
    if (localEntityIds.has(output.entityId)) {
      localOutputs.push(output);
      continue;
    }
    const targetRuntimeId = deps.resolveRuntimeIdForEntity(env, output.entityId);
    routeLog.debug('plan.output', {
      entity: shortId(output.entityId),
      runtime: targetRuntimeId ? shortId(targetRuntimeId, 8) : 'unknown',
    });
    if (!targetRuntimeId) {
      deferredOutputs.push(output);
      continue;
    }
    const localRuntimeId = normalizeRuntimeId(String(env.runtimeId || ''));
    if (localRuntimeId && targetRuntimeId === localRuntimeId) {
      env.warn('network', 'ROUTE_DEFER_STALE_SELF_HINT', {
        entityId: output.entityId,
        runtimeId: targetRuntimeId,
      });
      deferredOutputs.push(output);
      continue;
    }
    if (
      entityInputHasCrossJurisdictionIntraRuntimeTx(output) &&
      !isCrossJurisdictionEntityInputRemoteHopAllowed(
        output,
        env.runtimeId,
        targetRuntimeId,
        entityId => deps.resolveRuntimeIdForCrossJurisdictionEntity(env, entityId),
      )
    ) {
      throw new Error(
        `CROSS_J_REMOTE_TOPOLOGY_INVALID: entity=${String(output.entityId || '').toLowerCase()} ` +
        `targetRuntime=${targetRuntimeId} txTypes=${(output.entityTxs || []).map(tx => tx.type).join(',')}`,
      );
    }
    remoteOutputs.push({ output: toDeliverableEntityInput(output, targetRuntimeId), targetRuntimeId });
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
      env.warn('network', 'ROUTE_DROP_NO_P2P', {
        entityId: output.entityId,
        runtimeId: targetRuntimeId,
      });
      deferredOutputs.push(output);
      continue;
    }
    routeLog.debug('p2p.enqueue', {
      runtime: shortId(targetRuntimeId, 8),
      entity: shortId(output.entityId),
      txs: output.entityTxs?.length || 0,
    });
    try {
      p2p.enqueueEntityInput(targetRuntimeId, output, env.timestamp);
    } catch (error) {
      env.warn('network', 'ROUTE_DEFER_SEND_FAILED', {
        entityId: output.entityId,
        runtimeId: targetRuntimeId,
        error: (error as Error).message,
      });
      deferredOutputs.push(output);
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
