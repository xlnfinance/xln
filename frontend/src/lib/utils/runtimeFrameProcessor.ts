import type { Snapshot, EntityReplica, RuntimeFrame, RuntimeTx, EntityInput } from '$lib/types/ui';

export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString();
}

export function getRuntimeFrames(history: Snapshot[], replica: EntityReplica | null): RuntimeFrame[] {
  console.log(`🔍 [RuntimeFrameProcessor] getRuntimeFrames called:`, {
    historyLength: history?.length || 0,
    historyExists: !!history,
    replicaExists: !!replica,
    replicaId: replica?.signerId + ':' + replica?.entityId,
  });

  if (!history || history.length === 0) {
    console.log(`❌ [RuntimeFrameProcessor] No server history available:`, { 
      history, 
      historyLength: history?.length 
    });
    return [];
  }

  if (!replica) {
    console.log(`❌ [RuntimeFrameProcessor] No replica provided`);
    return [];
  }

  console.log(
    `🗂️ [RuntimeFrameProcessor] Processing history for replica ${replica.signerId}:${replica.entityId}, total frames: ${history.length}`,
  );
  
  console.log(
    `🗂️ [RuntimeFrameProcessor] First few snapshots:`,
    history.slice(0, 3).map((s, i) => ({
      frame: i,
      keys: Object.keys(s),
      runtimeInput: s.runtimeInput ? Object.keys(s.runtimeInput) : 'missing',
      entityInputsCount: s.runtimeInput?.entityInputs?.length || 0,
      runtimeOutputsCount: s.runtimeOutputs?.length || 0,
      timestamp: s.timestamp,
    })),
  );

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
    const relevantRuntimeTxs = runtimeTxs.filter(
      (tx: RuntimeTx) =>
        tx.entityId === replica.entityId || tx.signerId === replica.signerId,
    );

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
    };
  });
}
