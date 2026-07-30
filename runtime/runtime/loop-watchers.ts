import type { Provider } from 'ethers';
import type { JAdapter } from '../jadapter/types';
import { createStructuredLogger } from '../infra/logger';
import type { RuntimeReplica } from './types';
import type { JReplica } from '../types/jurisdiction-runtime';

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
const getWatcherKey = (replica: JReplica): string | null => {
  const adapter = replica.jadapter;
  if (!adapter) return null;
  const depository = String(replica.depositoryAddress || replica.contracts?.depository || '')
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
  if (env.runtimeState?.persistenceQuiescing || !env.state.jReplicas?.size) return;
  const owners = new Map<string, JAdapter>();
  for (const [name, replica] of env.state.jReplicas) {
    const adapter = replica.jadapter;
    if (!adapter) continue;
    const watcherKey = getWatcherKey(replica);
    const owner = watcherKey ? owners.get(watcherKey) : undefined;
    if (owner) {
      if (owner !== adapter && adapter.isWatching()) {
        adapter.stopWatching();
        watcherLog.warn('duplicate_stopped', { jurisdictionName: name, watcherKey });
      }
      continue;
    }
    if (watcherKey) owners.set(watcherKey, adapter);
    if (adapter.isWatching()) continue;
    adapter.startWatching(env);
    watcherLog.debug('started', { jurisdictionName: name, watcherKey });
  }
};

export const stopJurisdictionWatchers = (env: RuntimeReplica): void => {
  if (!env.state.jReplicas?.size) return;
  for (const [name, replica] of env.state.jReplicas) {
    const adapter = replica.jadapter;
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
  for (const [name, replica] of env.state.jReplicas) {
    const adapter = replica.jadapter;
    if (!adapter) continue;
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
