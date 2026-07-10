import type { EntityReplica } from '@xln/runtime/xln-api';
import type { MergedRuntimeGraph, RuntimeGraphNodeState } from './runtimeGraphProjection';

const graphReplicaState = (node: RuntimeGraphNodeState): Record<string, unknown> => {
  const replicaState = node.replica?.state as unknown as Record<string, unknown> | undefined;
  const coreState = node.core as unknown as Record<string, unknown> | null;
  const source = replicaState ?? coreState ?? {};
  const profile = source['profile'] as Record<string, unknown> | undefined;
  return {
    ...source,
    entityId: node.entityId,
    height: node.height,
    timestamp: node.timestamp,
    profile: {
      ...(profile ?? {}),
      name: String(profile?.['name'] || node.label),
      isHub: node.isHub,
    },
    accounts: new Map<string, unknown>(),
  };
};

const graphReplica = (node: RuntimeGraphNodeState): EntityReplica => ({
  ...(node.replica ?? {} as EntityReplica),
  entityId: node.entityId,
  signerId: node.signerId || `graph:${node.runtimeId}`,
  state: graphReplicaState(node) as unknown as EntityReplica['state'],
  mempool: [...(node.replica?.mempool ?? [])],
  isProposer: node.replica?.isProposer ?? true,
  ...(node.position ? { position: { ...node.position } } : {}),
});

export const materializeRuntimeGraphReplicas = (graph: MergedRuntimeGraph): Map<string, EntityReplica> => {
  const replicas = new Map<string, EntityReplica>();
  const byEntityId = new Map<string, EntityReplica>();
  for (const node of graph.nodes) {
    const replica = graphReplica(node.selected);
    byEntityId.set(node.entityId, replica);
    replicas.set(`${node.entityId}:${replica.signerId}`, replica);
  }
  for (const account of graph.accounts) {
    const selected = account.selected;
    const observer = byEntityId.get(selected.observerEntityId);
    if (!observer) continue;
    const counterpartyId = selected.observerEntityId === selected.leftEntityId
      ? selected.rightEntityId
      : selected.leftEntityId;
    observer.state.accounts.set(counterpartyId, selected.account as EntityReplica['state']['accounts'] extends Map<string, infer A> ? A : never);
  }
  return replicas;
};
