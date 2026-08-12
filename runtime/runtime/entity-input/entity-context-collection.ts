import { encodeCanonicalConsensusValue } from '../../protocol/serialization/canonical-consensus-value';
import type { EntityInfraContext } from '../../types/entity/infra-context';

/** Commit one proposer-observed slice under the exact local replica that applied it. */
export const collectRuntimeEntityContext = (
  contexts: Map<string, EntityInfraContext>,
  inputEntityId: string,
  appliedReplicaId: string,
  context: EntityInfraContext,
): void => {
  const entityId = context.entityId.toLowerCase();
  const proposerSignerId = context.proposerSignerId.toLowerCase();
  const proposerReplicaId = `${entityId}:${proposerSignerId}`;
  const appliedEntityId = appliedReplicaId.split(':')[0]?.toLowerCase();
  if (
    inputEntityId.toLowerCase() !== entityId ||
    appliedEntityId !== entityId ||
    context.entityId !== entityId ||
    context.proposerSignerId !== proposerSignerId ||
    context.proposerReplicaId !== proposerReplicaId
  ) {
    throw new Error(
      `RUNTIME_ENTITY_CONTEXT_REPLICA_BINDING_INVALID:expected=${proposerReplicaId}:received=${context.proposerReplicaId}`,
    );
  }
  const existing = contexts.get(appliedReplicaId);
  if (
    existing &&
    encodeCanonicalConsensusValue(existing) !== encodeCanonicalConsensusValue(context)
  ) {
    throw new Error(`RUNTIME_ENTITY_CONTEXT_COLLISION:${appliedReplicaId}`);
  }
  contexts.set(appliedReplicaId, structuredClone(context));
};
