import type { Provider } from 'ethers';
import type { JAdapter } from '../../jurisdiction/adapter/types.ts';
import { createStructuredLogger } from '../../infra/logger.ts';
import type { RuntimeReplica } from '../types.ts';
import type { JReplica } from '../../types/jurisdiction-runtime.ts';
import { getLiveJAdapter, getLiveJAdapterEntries } from '../jurisdiction/live-jadapters.ts';

const watcherLog = createStructuredLogger('runtime.jadapter-watcher');

const getProviderUrl = (adapter: JAdapter, replica: JReplica): string => {
  const configured = replica.rpcs?.find(rpc => typeof rpc === 'string' && rpc.trim().length > 0);
  if (configured) return configured.trim();
  const provider = adapter.provider as Provider & {
    _getConnection?: () => { url?: string };
  };
  return String(provider._getConnection?.()?.url || '').trim();
};

/**
 * Watchers are de-duplicated by their external observation source. Two
 * jurisdiction aliases backed by one RPC/depository must never create two
 * producers for the same J event stream.
 */
const getWatcherKey = (replica: JReplica, adapter: JAdapter): string => {
  const depository = String(replica.contracts?.depository || '')
    .trim()
    .toLowerCase();
  const chainId = String(replica.chainId ?? adapter.chainId ?? '');
  if (adapter.mode === 'browservm') {
    return `browservm:${chainId}:${depository || replica.name}`;
  }
  return `rpc:${chainId}:${getProviderUrl(adapter, replica).toLowerCase()}:${depository || replica.name}`;
};

export const startJurisdictionWatchers = (env: RuntimeReplica): void => {
  // Quiesce closes ingress before draining accepted work. Never resurrect a
  // producer after that fence has been raised.
  if (env.infrastructure?.persistenceQuiescing || !env.state.jReplicas?.size) return;
  const owners = new Map<string, JAdapter>();
  for (const { name, adapter } of getLiveJAdapterEntries(env)) {
    const replica = env.state.jReplicas.get(name)!;
    const watcherKey = getWatcherKey(replica, adapter);
    const owner = owners.get(watcherKey);
    if (owner) {
      if (owner !== adapter && adapter.isWatching()) {
        adapter.stopWatching();
        watcherLog.warn('duplicate_stopped', { jurisdictionName: name, watcherKey });
      }
      continue;
    }
    owners.set(watcherKey, adapter);
    if (adapter.isWatching()) continue;
    adapter.startWatching(env);
    watcherLog.debug('started', { jurisdictionName: name, watcherKey });
  }
};

export const stopJurisdictionWatchers = (env: RuntimeReplica): void => {
  if (!env.state.jReplicas?.size) return;
  for (const [name] of env.state.jReplicas) {
    const adapter = getLiveJAdapter(env, name);
    if (!adapter?.isWatching()) continue;
    try {
      adapter.stopWatching();
    } catch (error) {
      watcherLog.warn('stop_failed', {
        jurisdictionName: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
};

const wrapDrainFailure = (names: string[], error: unknown): Error =>
  new Error(
    `JADAPTER_WATCHER_DRAIN_FAILED:${names.join(',')}:${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );

const stopAdapterAndWait = (adapter: JAdapter, names: string[]): Promise<void> => {
  try {
    return adapter.stopWatchingAndWait().catch(error => {
      throw wrapDrainFailure(names, error);
    });
  } catch (error) {
    return Promise.reject(wrapDrainFailure(names, error));
  }
};

export const stopJurisdictionWatchersAndWait = async (env: RuntimeReplica): Promise<void> => {
  if (!env.state.jReplicas?.size) return;
  const adapters = new Map<JAdapter, string[]>();
  for (const { name, adapter } of getLiveJAdapterEntries(env)) {
    const names = adapters.get(adapter) ?? [];
    names.push(name);
    adapters.set(adapter, names);
  }
  const settled = await Promise.allSettled(
    Array.from(adapters, ([adapter, names]) => stopAdapterAndWait(adapter, names)),
  );
  const errors = settled
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => (result.reason instanceof Error ? result.reason : new Error(String(result.reason))));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'JADAPTER_WATCHER_DRAIN_FAILED');
};
