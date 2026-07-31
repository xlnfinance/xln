import type {
  MergedRuntimeGraph,
  RuntimeGraphAccountView,
  RuntimeGraphNodeState,
} from './runtimeGraphProjection';

export type RuntimeGraphReplicaView = {
  entityId: string;
  signerId: string;
  state: Record<string, unknown> & {
    accounts: Map<string, RuntimeGraphAccountView>;
  };
  mempool: unknown[];
  isProposer: boolean;
  position?: RuntimeGraphNodeState['position'];
};

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

const graphReplica = (node: RuntimeGraphNodeState): RuntimeGraphReplicaView => ({
  ...(node.replica ?? {}),
  entityId: node.entityId,
  signerId: node.signerId || `graph:${node.runtimeId}`,
  state: graphReplicaState(node) as RuntimeGraphReplicaView['state'],
  mempool: [...(node.replica?.mempool ?? [])],
  isProposer: node.replica?.isProposer ?? true,
  ...(node.position ? { position: { ...node.position } } : {}),
});

export const materializeRuntimeGraphReplicas = (graph: MergedRuntimeGraph): Map<string, RuntimeGraphReplicaView> => {
  const replicas = new Map<string, RuntimeGraphReplicaView>();
  const byEntityId = new Map<string, RuntimeGraphReplicaView>();
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
    observer.state.accounts.set(counterpartyId, selected.account);
  }
  return replicas;
};
