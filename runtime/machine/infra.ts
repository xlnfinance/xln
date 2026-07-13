import type { Env, JReplica } from '../types';
import type { JAdapter } from '../jadapter';
import type { BrowserVMProvider, JAdapterConfig } from '../jadapter/types';
import { createJAdapter } from '../jadapter';
import { createJAdapterWithRetry } from '../jadapter/retry';
import { createStructuredLogger } from '../infra/logger';
import { buildCanonicalJReplicaSnapshot } from '../wal/snapshot';

const infraLog = createStructuredLogger('runtime.infra');
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const hasLiveJAdapter = (value: unknown): value is JAdapter => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<JAdapter>;
  return (
    typeof candidate.startWatching === 'function' &&
    typeof candidate.stopWatching === 'function' &&
    typeof candidate.submitTx === 'function'
  );
};

export const normalizeRestoredJReplicas = (env: Env): void => {
  if (!env.jReplicas) env.jReplicas = new Map();
  for (const [name, replica] of env.jReplicas.entries()) {
    const jadapter = hasLiveJAdapter(replica.jadapter) ? replica.jadapter : undefined;
    env.jReplicas.set(name, {
      ...buildCanonicalJReplicaSnapshot(replica),
      ...(jadapter ? { jadapter } : {}),
    });
  }
};

export const ensureLiveJAdapterForReplica = async (
  env: Env,
  name: string,
  options: {
    allowBrowserVm?: boolean;
    context?: string;
    attempts?: number;
  } = {},
): Promise<JAdapter | null> => {
  const jReplica = env.jReplicas?.get(name);
  if (!jReplica) return null;

  if (jReplica.jadapter && !hasLiveJAdapter(jReplica.jadapter)) {
    delete (jReplica as JReplica & { jadapter?: unknown }).jadapter;
  }
  if (jReplica.jadapter) return jReplica.jadapter;

  const rpcUrl = jReplica.rpcs?.find((candidate) => {
    const normalized = String(candidate || '').trim().toLowerCase();
    return normalized.length > 0 && !normalized.startsWith('browservm:');
  });
  const hasRpcs = Boolean(rpcUrl);
  const chainId = jReplica.chainId ?? 31337;
  const context = options.context ?? `restore:${name}`;
  const attempts = options.attempts ?? (typeof window !== 'undefined' ? 5 : 3);

  if (!hasRpcs && !options.allowBrowserVm) return null;

  const adapterConfig: JAdapterConfig = {
    mode: hasRpcs ? 'rpc' : 'browservm',
    chainId,
  };

  if (hasRpcs) {
    if (!rpcUrl) return null;
    adapterConfig.rpcUrl = rpcUrl;
    adapterConfig.fromReplica = jReplica;
  } else if (env.browserVMState !== undefined) {
    adapterConfig.browserVMState = env.browserVMState;
  }

  const jadapter = await createJAdapterWithRetry(adapterConfig, {
    context,
    attempts,
    onRetry: (attempt, totalAttempts, error) => {
      infraLog.warn('jadapter.restore_retry', {
        name,
        attempt,
        attempts: totalAttempts,
        error: errorMessage(error),
      });
    },
  });

  if (hasRpcs && (!jadapter.addresses?.depository || !jadapter.addresses?.entityProvider)) {
    throw new Error(
      `RESTORE_JADAPTER_ADDRESSES_MISSING: name=${name} ` +
        `depository=${jadapter.addresses?.depository || 'none'} ` +
        `entityProvider=${jadapter.addresses?.entityProvider || 'none'}`,
    );
  }

  jReplica.jadapter = jadapter;
  infraLog.debug('jadapter.derived', { name, mode: hasRpcs ? 'rpc' : 'browservm' });
  return jadapter;
};

export const rehydrateRestoredRuntimeInfra = async (
  env: Env,
  options: {
    isBrowser: boolean;
    loadGossipProfiles: (env: Env) => Promise<void>;
    assertPersistedContractConfigReady: (env: Env, label: string) => void;
    setBrowserVMJurisdiction: (env: Env | null, depositoryAddress: string, browserVM?: BrowserVMProvider | null) => void;
  },
): Promise<void> => {
  normalizeRestoredJReplicas(env);
  try {
    await options.loadGossipProfiles(env);
  } catch (error) {
    infraLog.warn('gossip.restore_skipped', { error: errorMessage(error) });
  }

  options.assertPersistedContractConfigReady(env, 'loadEnvFromDB post-replay');

  let restoredBrowserVM: BrowserVMProvider | null = null;
  if (env.browserVMState && options.isBrowser) {
    try {
      const restoredAdapter = await createJAdapter({
        mode: 'browservm',
        chainId: 31337,
        browserVMState: env.browserVMState,
      });
      const browserVM = restoredAdapter.getBrowserVM();
      if (browserVM) {
        env.browserVM = browserVM;
        restoredBrowserVM = browserVM;
        options.setBrowserVMJurisdiction(env, browserVM.getDepositoryAddress(), browserVM);
      }
      if (typeof window !== 'undefined') {
        (window as Window & { __xlnBrowserVM?: BrowserVMProvider | null }).__xlnBrowserVM = browserVM;
      }
      infraLog.debug('browservm.restored');
    } catch (error) {
      infraLog.warn('browservm.restore_failed', { error: errorMessage(error) });
    }
  }

  if (!env.jReplicas || env.jReplicas.size === 0) return;

  for (const [name] of env.jReplicas.entries()) {
    try {
      await ensureLiveJAdapterForReplica(env, name, {
        allowBrowserVm: Boolean(restoredBrowserVM),
        context: `restore:${name}`,
        attempts: 5,
      });
    } catch (error) {
      throw new Error(
        `RESTORE_JADAPTER_FAILED: name=${name} cause=${errorMessage(error)}`,
      );
    }
  }
};
