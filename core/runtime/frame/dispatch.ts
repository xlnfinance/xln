import { getSignerPrivateKeyIfAvailable } from '../../account/crypto';
import { extractEntityId, extractSignerId } from '../../protocol/identity';
import { createStructuredLogger } from '../../support/logger';
import { announceCertifiedLocalProfiles } from '../../network/p2p/gossip/local-profile-lifecycle';
import { computeEntityProfileHash } from '../../entity/profile/profile-descriptor';
import type { EntityReplica } from '../../entity/types';
import type { RuntimeReplica, RoutedEntityInput } from '../types';
import {
  dispatchEntityOutputs,
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

export const hasCertifiedCurrentProfileWitness = (replica: EntityReplica): boolean => {
  const currentHash = computeEntityProfileHash(replica.state);
  return replica.hankoWitness?.get(currentHash)?.type === 'profile';
};

const hasCurrentProfileWitness = (env: RuntimeReplica, entityId: string): boolean => {
  for (const replica of env.state.eReplicas.values()) {
    if (replica.entityId.toLowerCase() !== entityId) continue;
    if (hasCertifiedCurrentProfileWitness(replica)) return true;
  }
  return false;
};

export type CommittedEntityOutputPlan = {
  remoteOutputs: PlannedRemoteOutput[];
  deferredOutputs: RoutedEntityInput[];
  preparedOutputGraph: PreparedOutputGraph;
};

const DIRECT_OUTPUT_CONNECT_TIMEOUT_MS = 10_000;

export const dispatchCommittedEntityOutputs = async (
  env: RuntimeReplica,
  changedEntityIds: ReadonlySet<string>,
  plan: CommittedEntityOutputPlan,
  routing: RuntimeOutputRoutingDeps,
): Promise<void> => {
  const p2p = ensureRuntimeInfrastructure(env).p2p ?? null;
  const localIds = collectLocallySignableEntityIds(env);
  const changedLocalIds = [...changedEntityIds].filter(
    entityId => localIds.has(entityId) && hasCurrentProfileWitness(env, entityId),
  );
  const getProfile = env.gossip?.getProfile;
  const newIds = changedLocalIds.filter(entityId => getProfile?.(entityId) === undefined);
  const refreshIds = changedLocalIds.filter(entityId => getProfile?.(entityId) !== undefined);

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
  if (plan.deferredOutputs.length > 0) {
    throw new Error(`ROUTE_DEFERRED_OUTPUTS_FORBIDDEN:${plan.deferredOutputs.length}`);
  }
  // Sovereign clients open only the routes used by this committed frame. A
  // Profile supplies the endpoint; the actual socket is established lazily at
  // the send boundary. Hub servers already own inbound user sessions and must
  // not dial every user back.
  let transportReady = true;
  if (p2p && !env.infrastructure?.directEntityInputsDispatch && plan.remoteOutputs.length > 0) {
    const targetEntityIds = Array.from(new Set(
      plan.remoteOutputs.map(({ output }) => output.entityId.toLowerCase()),
    ));
    try {
      transportReady = await p2p.bootstrapDirectEntityRoutes(targetEntityIds, DIRECT_OUTPUT_CONNECT_TIMEOUT_MS);
    } catch (error) {
      transportReady = false;
      env.warn('network', 'DIRECT_OUTPUT_CONNECT_FAILED', {
        targetEntityIds,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!transportReady) {
      env.warn('network', 'DIRECT_OUTPUT_NOT_SENT', {
        targetEntityIds,
        remoteOutputs: plan.remoteOutputs.length,
      });
    }
  }
  if (transportReady) {
    dispatchEntityOutputs(env, plan.remoteOutputs, routing, plan.preparedOutputGraph);
  }
  // The outbox is retained across every failure path. Clear it only after the
  // transport synchronously accepts every envelope; there is no timer retry.
  env.pendingNetworkOutputs = [];
  if (p2p && refreshIds.length > 0) {
    await p2p.announceProfilesForEntitiesNow(refreshIds, 'routing-profile-refresh', false);
  }
  if (p2p && plan.remoteOutputs.length === 0 && newIds.length > 0) {
    // First publication is not debounced: peers cannot route to an entity
    // whose profile they have never seen. Awaiting also keeps publication
    // failure attached to the exact committed side-effect instead of hiding it
    // in a timer callback with no causal owner.
    await p2p.announceProfilesForEntitiesNow(newIds, 'routing-profile-new', false);
  }

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
