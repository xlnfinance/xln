import type { JAdapter } from '../../jurisdiction/adapter/types';
import type { RuntimeReplica } from '../types';
import { ensureRuntimeInfrastructure } from '../envelope/replica-envelope';

const requireJurisdiction = (replica: RuntimeReplica, name: string): void => {
  if (!replica.state.jReplicas.has(name)) {
    throw new Error(`LIVE_JADAPTER_JURISDICTION_NOT_FOUND:${name}`);
  }
};

/** Read a process-local chain capability without leaking it into Runtime State. */
export const getLiveJAdapter = (
  replica: RuntimeReplica,
  jurisdictionName: string,
): JAdapter | undefined =>
  replica.infrastructure?.liveJAdapters?.get(jurisdictionName);

/**
 * Attach exactly one live capability to an existing canonical J replica.
 *
 * Replacing a different adapter silently could leave a watcher or signer from
 * the old chain alive. Callers must detach it explicitly after closing it.
 */
export const attachLiveJAdapter = (
  replica: RuntimeReplica,
  jurisdictionName: string,
  adapter: JAdapter,
): void => {
  requireJurisdiction(replica, jurisdictionName);
  const adapters = ensureRuntimeInfrastructure(replica).liveJAdapters ??= new Map();
  const current = adapters.get(jurisdictionName);
  if (current && current !== adapter) {
    throw new Error(`LIVE_JADAPTER_CONFLICT:${jurisdictionName}`);
  }
  if (current === adapter) return;
  // EOA nonce ownership spans every contract stack on this chain; the sequencer
  // filters recovered payer signatures, never jurisdiction names or recipients.
  adapter.setPendingSignedTransactionSource(() => {
    const rows = (replica.infrastructure?.pendingCommittedJOutbox ?? [])
      .filter(input => replica.state.jReplicas.get(input.jurisdictionName)?.chainId === adapter.chainId).flatMap(input => input.jTxs);
    const raw = rows.flatMap(tx => tx.type === 'batch' && tx.data.runtimeSubmitAttempt?.rawTransaction
      ? [tx.data.runtimeSubmitAttempt.rawTransaction] : []);
    for (const intent of replica.infrastructure?.numberedRegistrationIntents?.values() ?? []) {
      if (intent.status !== 'pending') continue;
      const jurisdiction = intent.request.entities[0]?.config.jurisdiction;
      if (jurisdiction?.chainId === adapter.chainId) raw.push(intent.rawTransaction);
    }
    return raw;
  });
  adapters.set(jurisdictionName, adapter);
};

export const detachLiveJAdapter = (
  replica: RuntimeReplica,
  jurisdictionName: string,
  expectedAdapter?: JAdapter,
): void => {
  const adapters = replica.infrastructure?.liveJAdapters;
  const current = adapters?.get(jurisdictionName);
  if (expectedAdapter && current && current !== expectedAdapter) {
    throw new Error(`LIVE_JADAPTER_DETACH_CONFLICT:${jurisdictionName}`);
  }
  current?.setPendingSignedTransactionSource(null);
  adapters?.delete(jurisdictionName);
};

/** Canonical replicas paired with their process-local chain capabilities. */
export const getLiveJAdapterEntries = (
  replica: RuntimeReplica,
): Array<{ name: string; adapter: JAdapter }> => {
  const entries: Array<{ name: string; adapter: JAdapter }> = [];
  for (const [name, adapter] of replica.infrastructure?.liveJAdapters ?? []) {
    requireJurisdiction(replica, name);
    entries.push({ name, adapter });
  }
  return entries;
};
