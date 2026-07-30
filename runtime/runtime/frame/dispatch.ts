import { getSignerPrivateKeyIfAvailable } from '../../account/crypto';
import { extractEntityId, extractSignerId } from '../../protocol/identity';
import { createStructuredLogger } from '../../infra/logger';
import { announceCertifiedLocalProfiles } from '../../networking/local-profile-lifecycle';
import { isDeliveryDelivered } from '../../protocol/payments/delivery-result';
import type { RuntimeReplica, RoutedEntityInput } from '../types';
import {
  buildPendingNetworkOutputs,
  dispatchEntityOutputs,
  rescheduleDeferredOutputs,
  type PlannedRemoteOutput,
  type RuntimeOutputRoutingDeps,
} from '../output-routing';
import { ensureRuntimeState } from '../runtime-state';
import { finalizeReliableIngressCommit } from '../reliable-delivery';
import type { FrameExecutionState } from './execution-state';

const runtimeLog = createStructuredLogger('runtime');

const collectLocallySignableEntityIds = (env: RuntimeReplica): Set<string> => {
  const entityIds = new Set<string>();
  for (const replicaKey of env.state.eReplicas.keys()) {
    const signerId = extractSignerId(replicaKey);
    if (!signerId || getSignerPrivateKeyIfAvailable(env, signerId) === null) continue;
    entityIds.add(extractEntityId(replicaKey).toLowerCase());
  }
  return entityIds;
};

export type CommittedEntityOutputPlan = {
  remoteOutputs: PlannedRemoteOutput[];
  deferredOutputs: RoutedEntityInput[];
  readyPendingOutputs: RoutedEntityInput[];
  waitingPendingOutputs: RoutedEntityInput[];
  retainedLocalReliableOutputs: RoutedEntityInput[];
};

export const dispatchCommittedEntityOutputs = async (
  env: RuntimeReplica,
  changedEntityIds: ReadonlySet<string>,
  plan: CommittedEntityOutputPlan,
  routing: RuntimeOutputRoutingDeps,
): Promise<void> => {
  const p2p = ensureRuntimeState(env).p2p ?? null;
  const localIds = collectLocallySignableEntityIds(env);
  const changedLocalIds = [...changedEntityIds].filter(entityId => localIds.has(entityId));
  const knownIds = new Set(
    (env.gossip?.getProfiles?.() ?? []).map(profile => profile.entityId.toLowerCase()),
  );
  const newIds = changedLocalIds.filter(entityId => !knownIds.has(entityId));
  const refreshIds = changedLocalIds.filter(entityId => knownIds.has(entityId));

  if (p2p && plan.remoteOutputs.length > 0 && newIds.length > 0) {
    await p2p.announceProfilesForEntitiesNow(newIds, 'pre-output-profile-refresh', false);
  } else if (!p2p && changedLocalIds.length > 0) {
    await announceCertifiedLocalProfiles(env, changedLocalIds);
  }
  if (plan.remoteOutputs.length > 0 && env.quietRuntimeLogs !== true) {
    runtimeLog.debug('side_effect.remote_outputs.dispatch', {
      remoteOutputs: plan.remoteOutputs.length,
    });
  }
  const dispatchDeferred = dispatchEntityOutputs(env, plan.remoteOutputs, routing);
  if (refreshIds.length > 0) {
    p2p?.announceProfilesForEntities(refreshIds, 'routing-profile-refresh');
  }
  if (p2p && plan.remoteOutputs.length === 0 && newIds.length > 0) {
    p2p.announceProfilesForEntities(newIds, 'routing-profile-new');
  }

  const rescheduled = rescheduleDeferredOutputs(
    env,
    plan.readyPendingOutputs,
    [...plan.deferredOutputs, ...dispatchDeferred],
    plan.waitingPendingOutputs,
    routing,
  );
  env.pendingNetworkOutputs = buildPendingNetworkOutputs([
    ...rescheduled,
    ...plan.retainedLocalReliableOutputs,
  ]);
};

export const runCommittedRecoveryBarrier = async (
  env: RuntimeReplica,
  frame: FrameExecutionState,
  remoteOutputCount: number,
  jSideEffectCount: number,
  runtimeInfraEffectCount: number,
): Promise<void> => {
  const barrier = ensureRuntimeState(env).recoveryBackupBarrier;
  const receiptCount = frame.reliableIngressCommits.reduce(
    (count, commit) => count + commit.targetRuntimeIds.length,
    0,
  );
  const remoteCount = remoteOutputCount + receiptCount;
  const jInputCount = jSideEffectCount + runtimeInfraEffectCount;
  if (!barrier || (remoteCount === 0 && jInputCount === 0)) return;
  try {
    await barrier(env, { height: env.state.height, remoteOutputCount: remoteCount, jInputCount });
  } catch (error) {
    env.error('system', 'RECOVERY_BACKUP_BARRIER_FAILED', {
      height: env.state.height,
      remoteOutputCount: remoteCount,
      jInputCount,
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

export const finalizeCommittedReceiptDeliveries = (
  env: RuntimeReplica,
  frame: FrameExecutionState,
): void => {
  frame.reliableReceiptDeliveries = [
    ...frame.immediateReliableReceiptDeliveries,
    ...finalizeReliableIngressCommit(env, frame.reliableIngressCommits),
  ];
  const accountAcks = frame.reliableReceiptDeliveries
    .filter(delivery => delivery.receipt.body.identity.kind === 'account-ack')
    .map(delivery => ({
      targetRuntimeId: delivery.runtimeId,
      height: delivery.receipt.body.identity.height,
      coverage: delivery.receipt.body.coverage,
      entityId: delivery.receipt.body.identity.entityId,
    }));
  if (accountAcks.length > 0) {
    runtimeLog.info('reliable.account_receipts.finalized', { receipts: accountAcks });
  }
};

export const dispatchCommittedReceipts = (env: RuntimeReplica, frame: FrameExecutionState): void => {
  if (frame.reliableReceiptDeliveries.length === 0) return;
  const state = ensureRuntimeState(env);
  const p2p = state.p2p ?? null;
  for (const delivery of frame.reliableReceiptDeliveries) {
    const direct = state.directReliableReceiptDispatch?.(delivery.runtimeId, delivery.receipt);
    const usedDirect = Boolean(direct && isDeliveryDelivered(direct));
    const result = usedDirect
      ? direct
      : (p2p?.enqueueReliableReceiptDelivery(delivery.runtimeId, delivery.receipt) ?? direct);
    if (delivery.receipt.body.identity.kind === 'account-ack') {
      runtimeLog.info('reliable.account_receipt.dispatch', {
        targetRuntimeId: delivery.runtimeId,
        height: delivery.receipt.body.identity.height,
        coverage: delivery.receipt.body.coverage,
        transport: usedDirect ? 'direct' : 'p2p',
        delivered: Boolean(result && isDeliveryDelivered(result)),
        code: result?.code ?? null,
      });
    }
    if (!result || !isDeliveryDelivered(result)) {
      env.warn('network', 'RELIABLE_RECEIPT_SEND_DEFERRED', {
        targetRuntimeId: delivery.runtimeId,
        delivery: result ?? null,
      });
    }
  }
};
