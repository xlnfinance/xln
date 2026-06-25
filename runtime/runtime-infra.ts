import type { Env, JReplica } from './types';
import type { JAdapter } from './jadapter';
import type { BrowserVMProvider, JAdapterConfig } from './jadapter/types';
import { createJAdapter } from './jadapter';
import { createJAdapterWithRetry } from './jadapter/retry';

export const hasLiveJAdapter = (value: unknown): value is JAdapter => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<JAdapter>;
  return (
    typeof candidate.startWatching === 'function' &&
    typeof candidate.stopWatching === 'function' &&
    typeof candidate.submitTx === 'function'
  );
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

  const hasRpcs = jReplica.rpcs && jReplica.rpcs.length > 0 && jReplica.rpcs[0] !== '';
  const chainId = jReplica.chainId ?? 31337;
  const context = options.context ?? `restore:${name}`;
  const attempts = options.attempts ?? (typeof window !== 'undefined' ? 5 : 3);

  if (!hasRpcs && !options.allowBrowserVm) return null;

  const adapterConfig: JAdapterConfig = {
    mode: hasRpcs ? 'rpc' : 'browservm',
    chainId,
  };

  if (hasRpcs) {
    const rpcUrl = jReplica.rpcs?.[0];
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
      console.warn(
        `⚠️ Retrying JAdapter restore for "${name}" ` +
          `(${attempt}/${totalAttempts}): ${error instanceof Error ? error.message : String(error)}`,
      );
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
  console.log(`✅ JAdapter derived for jReplica "${name}" (${hasRpcs ? 'rpc' : 'browservm'})`);
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
  try {
    await options.loadGossipProfiles(env);
  } catch (error) {
    console.warn(
      '[loadEnvFromDB] skipped infra gossip restore:',
      error instanceof Error ? error.message : String(error),
    );
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
      console.log('✅ BrowserVM restored from loadEnvFromDB');
    } catch (error) {
      console.warn('⚠️ Failed to restore BrowserVM state (loadEnvFromDB):', error);
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
        `RESTORE_JADAPTER_FAILED: name=${name} cause=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
};
