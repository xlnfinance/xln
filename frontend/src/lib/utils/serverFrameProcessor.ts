import type { Snapshot, EntityReplica, ServerFrame } from '../types';

export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString();
}

export function getServerFrames(history: Snapshot[], replica: EntityReplica | null): ServerFrame[] {
  console.log(`🔍 [ServerFrameProcessor] getServerFrames called:`, {
    historyLength: history?.length || 0,
    historyExists: !!history,
    replicaExists: !!replica,
    replicaId: replica?.signerId + ':' + replica?.entityId,
  });

  if (!history || history.length === 0) {
    console.log(`❌ [ServerFrameProcessor] No server history available:`, { 
      history, 
      historyLength: history?.length 
    });
    return [];
  }

  if (!replica) {
    console.log(`❌ [ServerFrameProcessor] No replica provided`);
    return [];
  }

  console.log(
    `🗂️ [ServerFrameProcessor] Processing history for replica ${replica.signerId}:${replica.entityId}, total frames: ${history.length}`,
  );
  
  console.log(
    `🗂️ [ServerFrameProcessor] First few snapshots:`,
    history.slice(0, 3).map((s, i) => ({
      frame: i,
      keys: Object.keys(s),
      serverInput: s.serverInput ? Object.keys(s.serverInput) : 'missing',
      entityInputsCount: s.serverInput?.entityInputs?.length || 0,
      serverOutputsCount: s.serverOutputs?.length || 0,
      timestamp: s.timestamp,
    })),
  );

  return history.map((snapshot, frameIndex) => {
    const entityInputs = snapshot.serverInput?.entityInputs || [];
    const serverOutputs = snapshot.serverOutputs || [];

    // Filter inputs TO this specific replica
    const replicaInputs = entityInputs.filter(
      (input) => input.entityId === replica.entityId && input.signerId === replica.signerId,
    );

    // Filter outputs FROM this specific replica
    const replicaOutputs = serverOutputs.filter(
      (output) => output.entityId === replica.entityId && output.signerId === replica.signerId,
    );

    // Filter serverTx imports related to this replica
    const serverTxs = snapshot.serverInput?.serverTxs || [];
    const replicaImports = serverTxs.filter((serverTx) => {
      if (serverTx.type === 'importReplica') {
        return serverTx.entityId === replica.entityId && serverTx.data?.signerId === replica.signerId;
      }
      return false;
    });

    // Also check relevant serverTxs
    const relevantServerTxs = serverTxs.filter(
      (tx) => tx.entityId === replica.entityId || tx.data?.from === replica.signerId,
    );

    const hasActivity = replicaInputs.length > 0 || replicaOutputs.length > 0 || replicaImports.length > 0;

    return {
      frameIndex,
      snapshot,
      inputs: replicaInputs,
      outputs: replicaOutputs,
      imports: replicaImports,
      serverTxs: relevantServerTxs,
      timestamp: snapshot.timestamp || Date.now() - (history.length - frameIndex) * 1000,
      hasActivity,
    };
  });
}
