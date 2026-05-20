import type { Snapshot, EntityReplica, RuntimeFrame, RuntimeTx, EntityInput } from '$lib/types/ui';

export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString();
}

export function getRuntimeFrames(history: Snapshot[], replica: EntityReplica | null): RuntimeFrame[] {
  if (!history || history.length === 0) {
    return [];
  }

  if (!replica) {
    return [];
  }

  return history.map((snapshot, frameIndex) => {
    const entityInputs = snapshot.runtimeInput?.entityInputs || [];
    const runtimeOutputs = snapshot.runtimeOutputs || [];

    // Filter inputs TO this specific replica
    const replicaInputs = entityInputs.filter(
      (input: EntityInput) =>
        input.entityId === replica.entityId && input.signerId === replica.signerId,
    );

    // Filter outputs FROM this specific replica
    const replicaOutputs = runtimeOutputs.filter(
      (output: EntityInput) =>
        output.entityId === replica.entityId && output.signerId === replica.signerId,
    );

    // Filter runtimeTx imports related to this replica
    const runtimeTxs = snapshot.runtimeInput?.runtimeTxs || [];
    const replicaImports = runtimeTxs.filter((runtimeTx: RuntimeTx) => {
      if (runtimeTx.type === 'importReplica') {
        return runtimeTx.entityId === replica.entityId && runtimeTx.signerId === replica.signerId;
      }
      return false;
    });

    // Also check relevant runtimeTxs
    const relevantRuntimeTxs = runtimeTxs.filter((tx: RuntimeTx) => {
      if (tx.type === 'importReplica') {
        return tx.entityId === replica.entityId || tx.signerId === replica.signerId;
      }
      // For other types (importJ), they're not specific to any replica
      return false;
    });

    const hasActivity = replicaInputs.length > 0 || replicaOutputs.length > 0 || replicaImports.length > 0;

    return {
      frameIndex,
      snapshot,
      inputs: replicaInputs,
      outputs: replicaOutputs,
      imports: replicaImports,
      runtimeTxs: relevantRuntimeTxs,
      timestamp: snapshot.timestamp || Date.now() - (history.length - frameIndex) * 1000,
      hasActivity,
      logs: snapshot.logs || [], // Frame-specific structured logs
    };
  });
}
