import type { JAdapter } from '../jurisdiction/adapter/types';
import type { RuntimeReplica } from './types';
import { ensureRuntimeInfrastructure } from './runtime-infrastructure';

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
