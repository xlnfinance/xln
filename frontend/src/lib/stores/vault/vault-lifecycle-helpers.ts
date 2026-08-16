import type { RuntimeReplica, RuntimeInput } from '@xln/runtime/api/public/runtime-module';

import { hasConnectedJurisdictionAdapter, hasRuntimeJurisdictionAddresses } from './vault-helpers';

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
  height: env.state.height,
  timestamp: env.state.timestamp,
  lifecycle: env.infrastructure?.lifecyclePhase ?? null,
  persistencePaused: Boolean(env.infrastructure?.persistencePaused),
  persistenceQuiescing: Boolean(env.infrastructure?.persistenceQuiescing),
  processing: Boolean(env.infrastructure?.processingPromise),
  inFlightEntityInputs: env.infrastructure?.inFlightEntityInputs ?? 0,
  pendingCommittedJOutbox: env.infrastructure?.pendingCommittedJOutbox?.length ?? 0,
  pendingJurisdictionImports: env.infrastructure?.pendingJurisdictionImports?.size ?? 0,
  mempool: runtimeInputWorkSummary(env.runtimeMempool),
  pendingOutputs: env.pendingOutputs?.length ?? 0,
  networkInbox: env.networkInbox?.length ?? 0,
  pendingNetworkOutputs: env.pendingNetworkOutputs?.length ?? 0,
  jurisdictions: Array.from(env.state.jReplicas.keys(), (name) => ({
    name,
    mode: env.infrastructure?.liveJAdapters?.get(name)?.mode ?? null,
    watching: env.infrastructure?.liveJAdapters?.get(name)?.isWatching?.() ?? false,
  })),
  replicas: Array.from(env.state.eReplicas.entries()).flatMap(([key, replica]) => {
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

export const getRuntimeFatalDiagnostics = (env: RuntimeReplica, replicaName?: string): string => {
  const cleanLogs = Array.isArray(env.infrastructure?.cleanLogs) ? env.infrastructure.cleanLogs : [];
  // Live Runtime intentionally retains no event timeline. Persisted activity
  // belongs to the history reader; operator diagnostics use the bounded clean
  // operational log here.
  const recentErrors: never[] = [];
  const replica = replicaName ? env.state.jReplicas.get(replicaName) : env.state.jReplicas.values().next().value;
  const jState = replica
    ? {
        name: replica.name ?? null,
        chainId: replica.chainId ?? null,
        depositoryAddress: replica.contracts?.depository ?? null,
        entityProviderAddress: replica.contracts?.entityProvider ?? null,
        contracts: replica.contracts ?? null,
        rpcs: replica.rpcs ?? null,
        hasAdapter: hasConnectedJurisdictionAdapter(env, replica.name),
        hasAddresses: hasRuntimeJurisdictionAddresses(replica),
      }
    : null;
  return JSON.stringify(
    {
      runtimeId: env.runtimeId ?? null,
      height: env.state.height ?? null,
      latestHeight: env.state.height ?? null,
      loopActive: env.infrastructure?.loopActive ?? null,
      jState,
      recentErrors,
      recentLogs: cleanLogs.slice(-8),
    },
    null,
    2,
  );
};
