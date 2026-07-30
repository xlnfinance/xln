import type { RuntimeReplica, RuntimeInput } from '@xln/runtime/api/runtime-module';

export const runtimeInputWorkSummary = (input: RuntimeInput | undefined) => ({
  runtimeTxs: (input?.runtimeTxs ?? []).map(tx =>
    tx.type === 'importReplica'
      ? {
          type: tx.type,
          entityId: tx.entityId,
          signerId: tx.signerId,
          jurisdiction: tx.data.config.jurisdiction?.name ?? null,
          profileName: tx.data.profileName ?? null,
        }
      : { type: tx.type },
  ),
  entityInputs: (input?.entityInputs ?? []).map(entityInput => ({
    entityId: entityInput.entityId,
    signerId: entityInput.signerId,
    txs: (entityInput.entityTxs ?? []).map(tx => tx.type),
  })),
  jInputs: input?.jInputs?.length ?? 0,
  reliableReceipts: input?.reliableReceipts?.length ?? 0,
  queuedAt: input?.queuedAt ?? null,
});

export const runtimeQuiesceWorkSummary = (env: RuntimeReplica) => ({
  runtimeId: env.runtimeId ?? null,
  scenarioMode: Boolean(env.scenarioMode),
  height: env.height,
  timestamp: env.timestamp,
  lifecycle: env.runtimeState?.lifecyclePhase ?? null,
  persistencePaused: Boolean(env.runtimeState?.persistencePaused),
  persistenceQuiescing: Boolean(env.runtimeState?.persistenceQuiescing),
  processing: Boolean(env.runtimeState?.processingPromise),
  inFlightEntityInputs: env.runtimeState?.inFlightEntityInputs ?? 0,
  pendingCommittedJOutbox: env.runtimeState?.pendingCommittedJOutbox?.length ?? 0,
  pendingJurisdictionImports: env.runtimeState?.pendingJurisdictionImports?.size ?? 0,
  mempool: runtimeInputWorkSummary(env.runtimeMempool),
  pendingOutputs: env.pendingOutputs?.length ?? 0,
  networkInbox: env.networkInbox?.length ?? 0,
  pendingNetworkOutputs: env.pendingNetworkOutputs?.length ?? 0,
  jurisdictions: Array.from(env.jReplicas.entries(), ([name, replica]) => ({
    name,
    mode: replica.jadapter?.mode ?? null,
    watching: replica.jadapter?.isWatching?.() ?? false,
  })),
  replicas: Array.from(env.eReplicas.entries()).flatMap(([key, replica]) => {
    const accounts = Array.from(replica.state.accounts.entries()).flatMap(([counterpartyId, account]) =>
      account.mempool.length > 0 || account.pendingFrame
        ? [{ counterpartyId, mempool: account.mempool.length, pendingFrame: account.pendingFrame?.height ?? null }]
        : [],
    );
    if (replica.mempool.length === 0 && !replica.proposal && !replica.lockedFrame && accounts.length === 0) return [];
    return [
      {
        key,
        mempool: replica.mempool.map(tx => tx.type),
        proposal: replica.proposal?.height ?? null,
        lockedFrame: replica.lockedFrame?.height ?? null,
        accounts,
      },
    ];
  }),
});
