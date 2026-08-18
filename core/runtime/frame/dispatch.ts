import { getSignerPrivateKeyIfAvailable } from '../../account/crypto';
import { extractEntityId, extractSignerId } from '../../protocol/identity';
import { createStructuredLogger } from '../../support/logger';
import { announceCertifiedLocalProfiles } from '../../network/p2p/gossip/local-profile-lifecycle';
import type { RuntimeReplica, RoutedEntityInput } from '../types';
import {
  buildPendingNetworkOutputs,
  dispatchEntityOutputs,
  rescheduleDeferredOutputs,
  type PlannedRemoteOutput,
  type RuntimeOutputRoutingDeps,
} from '../delivery/topology/output-routing';
import { ensureRuntimeInfrastructure } from '../envelope/replica-envelope';
import type { PreparedOutputGraph } from '../delivery/prepared-output';

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

const hasFreshProfileWitness = (env: RuntimeReplica, entityId: string): boolean => {
  for (const replica of env.state.eReplicas.values()) {
    if (replica.entityId.toLowerCase() !== entityId) continue;
    for (const entry of replica.hankoWitness?.values() ?? []) {
      if (entry.type === 'profile' && entry.entityHeight === replica.state.height) return true;
    }
  }
  return false;
};

export type CommittedEntityOutputPlan = {
  remoteOutputs: PlannedRemoteOutput[];
  deferredOutputs: RoutedEntityInput[];
  readyPendingOutputs: RoutedEntityInput[];
  waitingPendingOutputs: RoutedEntityInput[];
  preparedOutputGraph: PreparedOutputGraph;
};

export const dispatchCommittedEntityOutputs = async (
  env: RuntimeReplica,
  changedEntityIds: ReadonlySet<string>,
  plan: CommittedEntityOutputPlan,
  routing: RuntimeOutputRoutingDeps,
): Promise<void> => {
  const p2p = ensureRuntimeInfrastructure(env).p2p ?? null;
  const localIds = collectLocallySignableEntityIds(env);
  const changedLocalIds = [...changedEntityIds].filter(
    entityId => localIds.has(entityId) && hasFreshProfileWitness(env, entityId),
  );
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
  const dispatchDeferred = dispatchEntityOutputs(
    env,
    plan.remoteOutputs,
    routing,
    plan.preparedOutputGraph,
  );
  if (refreshIds.length > 0) {
    p2p?.announceProfilesForEntities(refreshIds, 'routing-profile-refresh');
  }
  if (p2p && plan.remoteOutputs.length === 0 && newIds.length > 0) {
    // First publication is not debounced: peers cannot route to an entity
    // whose profile they have never seen.
    p2p.announceProfilesForEntitiesNow(newIds, 'routing-profile-new', false).catch(error => {
      runtimeLog.warn('routing_profile_new.announce_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  const rescheduled = rescheduleDeferredOutputs(
    env,
    plan.readyPendingOutputs,
    [...plan.deferredOutputs, ...dispatchDeferred],
    plan.waitingPendingOutputs,
    routing,
    plan.preparedOutputGraph,
  );
  env.pendingNetworkOutputs = buildPendingNetworkOutputs(rescheduled, plan.preparedOutputGraph);
};

export const runCommittedRecoveryBarrier = async (
  env: RuntimeReplica,
  remoteCount: number,
  jSideEffectCount: number,
  runtimeInfraEffectCount: number,
): Promise<void> => {
  const barrier = ensureRuntimeInfrastructure(env).recoveryBackupBarrier;
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
