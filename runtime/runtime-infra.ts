import { ethers } from 'ethers';
import type { Env, JReplica } from './types';
import type { JAdapter } from './jadapter';
import { createJAdapter } from './jadapter';
import { createBrowserVMAdapter } from './jadapter/browservm';
import { BrowserVMEthersProvider } from './jadapter/browservm-ethers-provider';
import { DEFAULT_PRIVATE_KEY } from './jadapter/helpers';

const hasLiveJAdapter = (value: unknown): value is JAdapter => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<JAdapter>;
  return (
    typeof candidate.startWatching === 'function' &&
    typeof candidate.stopWatching === 'function' &&
    typeof candidate.submitTx === 'function'
  );
};

export const rehydrateRestoredRuntimeInfra = async (
  env: Env,
  options: {
    isBrowser: boolean;
    loadGossipProfiles: (env: Env) => Promise<void>;
    assertPersistedContractConfigReady: (env: Env, label: string) => void;
    setBrowserVMJurisdiction: (env: Env, depositoryAddress: string, browserVM: unknown) => void;
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

  let restoredBrowserVM: any = null;
  if (env.browserVMState && options.isBrowser) {
    try {
      const { BrowserVMProvider } = await import('./jadapter');
      const browserVM = new BrowserVMProvider();
      await browserVM.init();
      await browserVM.restoreState(env.browserVMState);
      env.browserVM = browserVM;
      restoredBrowserVM = browserVM;
      options.setBrowserVMJurisdiction(env, browserVM.getDepositoryAddress(), browserVM);
      if (typeof window !== 'undefined') {
        (window as any).__xlnBrowserVM = browserVM;
      }
      console.log('✅ BrowserVM restored from loadEnvFromDB');
    } catch (error) {
      console.warn('⚠️ Failed to restore BrowserVM state (loadEnvFromDB):', error);
    }
  }

  if (!env.jReplicas || env.jReplicas.size === 0) return;

  for (const [name, jReplica] of env.jReplicas.entries()) {
    if (jReplica.jadapter && !hasLiveJAdapter(jReplica.jadapter)) {
      delete (jReplica as JReplica & { jadapter?: unknown }).jadapter;
    }
    if (jReplica.jadapter) continue;

    try {
      const hasRpcs = jReplica.rpcs && jReplica.rpcs.length > 0 && jReplica.rpcs[0] !== '';
      const chainId = jReplica.chainId ?? 31337;

      if (!hasRpcs && restoredBrowserVM) {
        const jadapter = await createJAdapter({
          mode: 'browservm',
          chainId,
          browserVMState: undefined,
        });
        const inner = jadapter.getBrowserVM();
        if (inner && restoredBrowserVM) {
          const provider = new BrowserVMEthersProvider(restoredBrowserVM);
          const signer = new ethers.Wallet(DEFAULT_PRIVATE_KEY, provider);
          jReplica.jadapter = await createBrowserVMAdapter(
            { mode: 'browservm', chainId },
            provider,
            signer,
            restoredBrowserVM,
          );
        } else {
          jReplica.jadapter = jadapter;
        }
      } else if (hasRpcs) {
        const jadapter = await createJAdapter({
          mode: 'rpc',
          chainId,
          rpcUrl: jReplica.rpcs![0],
          fromReplica: jReplica as any,
        });
        if (!jadapter.addresses?.depository || !jadapter.addresses?.entityProvider) {
          throw new Error(
            `RESTORE_JADAPTER_ADDRESSES_MISSING: name=${name} ` +
              `depository=${jadapter.addresses?.depository || 'none'} ` +
              `entityProvider=${jadapter.addresses?.entityProvider || 'none'}`,
          );
        }
        jReplica.jadapter = jadapter;
      }

      if (jReplica.jadapter) {
        console.log(`✅ JAdapter derived for jReplica "${name}" (${hasRpcs ? 'rpc' : 'browservm'})`);
      }
    } catch (error) {
      console.warn(`⚠️ Failed to derive JAdapter for jReplica "${name}":`, error);
    }
  }
};
