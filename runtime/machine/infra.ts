import type { Env, JReplica } from '../types';
import type { JAdapter } from '../jadapter';
import type { BrowserVMProvider, JAdapterConfig } from '../jadapter/types';
import { createJAdapterWithRetry } from '../jadapter/retry';
import { createStructuredLogger } from '../infra/logger';
import { getJurisdictionIdentityRef } from '../jurisdiction/jurisdiction-runtime';
import { buildCanonicalJReplicaSnapshot } from '../wal/snapshot';

const infraLog = createStructuredLogger('runtime.infra');
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export type TrustedJurisdictionRpcBinding = {
  jurisdictionRef: string;
  rpcUrl: string;
};

export const applyTrustedJurisdictionRpcBindings = (
  env: Pick<Env, 'jReplicas'>,
  bindings: readonly TrustedJurisdictionRpcBinding[],
): void => {
  const rpcByJurisdictionRef = new Map<string, string>();
  for (const binding of bindings) {
    const jurisdictionRef = String(binding.jurisdictionRef || '').trim().toLowerCase();
    const rpcUrl = String(binding.rpcUrl || '').trim();
    if (!jurisdictionRef || !rpcUrl) {
      throw new Error('RESTORE_JURISDICTION_RPC_BINDING_INVALID');
    }
    const existing = rpcByJurisdictionRef.get(jurisdictionRef);
    if (existing && existing !== rpcUrl) {
      throw new Error(`RESTORE_JURISDICTION_RPC_BINDING_CONFLICT:${jurisdictionRef}`);
    }
    rpcByJurisdictionRef.set(jurisdictionRef, rpcUrl);
  }

  for (const replica of env.jReplicas.values()) {
    const hasExternalRpc = replica.rpcs?.some((rpc) => {
      const value = String(rpc || '').trim().toLowerCase();
      return value.length > 0 && !value.startsWith('browservm:');
    });
    if (!hasExternalRpc) continue;
    const rpcUrl = rpcByJurisdictionRef.get(getJurisdictionIdentityRef(replica).toLowerCase());
    if (rpcUrl) replica.rpcs = [rpcUrl];
  }
};

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

const rejectMismatchedJAdapter = async (
  jadapter: JAdapter,
  mismatch: Error,
): Promise<never> => {
  try {
    await jadapter.close();
  } catch (closeError) {
    throw new AggregateError([mismatch, closeError], 'RESTORE_JADAPTER_MISMATCH_AND_CLOSE_FAILED');
  }
  throw mismatch;
};

const assertJAdapterMatchesReplica = async (
  name: string,
  jReplica: JReplica,
  jadapter: JAdapter,
): Promise<void> => {
  const expectedAddresses = {
    account: String(jReplica.contracts?.account || '').trim().toLowerCase(),
    depository: String(jReplica.depositoryAddress || jReplica.contracts?.depository || '').trim().toLowerCase(),
    entityProvider: String(jReplica.entityProviderAddress || jReplica.contracts?.entityProvider || '').trim().toLowerCase(),
    deltaTransformer: String(jReplica.contracts?.deltaTransformer || '').trim().toLowerCase(),
  };
  for (const [contractName, expected] of Object.entries(expectedAddresses)) {
    const actual = String(
      jadapter.addresses[contractName as keyof typeof jadapter.addresses] || '',
    ).trim().toLowerCase();
    if (!expected || actual !== expected) {
      await rejectMismatchedJAdapter(
        jadapter,
        new Error(
          `RESTORE_JADAPTER_ADDRESS_MISMATCH:${name}:${contractName}:expected=${expected || 'missing'}:actual=${actual || 'missing'}`,
        ),
      );
    }
  }
  if (Number(jadapter.chainId) !== Number(jReplica.chainId)) {
    await rejectMismatchedJAdapter(
      jadapter,
      new Error(
        `RESTORE_JADAPTER_CHAIN_MISMATCH:${name}:expected=${String(jReplica.chainId)}:actual=${String(jadapter.chainId)}`,
      ),
    );
  }
  if (jadapter.mode !== 'browservm') return;
  const captureStateRoot = jadapter.captureStateRoot;
  if (!captureStateRoot) {
    return await rejectMismatchedJAdapter(
      jadapter,
      new Error(`RESTORE_BROWSERVM_STATE_ROOT_READER_MISSING:${name}`),
    );
  }
  const actualStateRoot = await captureStateRoot.call(jadapter);
  const expectedStateRoot = jReplica.stateRoot;
  const rootsMatch =
    actualStateRoot instanceof Uint8Array &&
    expectedStateRoot instanceof Uint8Array &&
    actualStateRoot.length === expectedStateRoot.length &&
    actualStateRoot.every((byte, index) => byte === expectedStateRoot[index]);
  if (!rootsMatch) {
    await rejectMismatchedJAdapter(
      jadapter,
      new Error(`RESTORE_BROWSERVM_STATE_ROOT_MISMATCH:${name}`),
    );
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
  if (jReplica.jadapter) {
    const attachedAdapter = jReplica.jadapter;
    try {
      await assertJAdapterMatchesReplica(name, jReplica, attachedAdapter);
    } catch (error) {
      delete jReplica.jadapter;
      throw error;
    }
    return attachedAdapter;
  }

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

  await assertJAdapterMatchesReplica(name, jReplica, jadapter);

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
    setBrowserVMJurisdiction: (
      env: Env | null,
      depositoryAddress: string,
      chainId: number,
      browserVM?: BrowserVMProvider | null,
    ) => void;
    trustedJurisdictionRpcBindings?: readonly TrustedJurisdictionRpcBinding[];
  },
): Promise<void> => {
  normalizeRestoredJReplicas(env);
  applyTrustedJurisdictionRpcBindings(env, options.trustedJurisdictionRpcBindings ?? []);
  try {
    await options.loadGossipProfiles(env);
  } catch (error) {
    infraLog.warn('gossip.restore_skipped', { error: errorMessage(error) });
  }

  options.assertPersistedContractConfigReady(env, 'loadEnvFromDB post-replay');

  if (!env.jReplicas || env.jReplicas.size === 0) return;

  let restoredBrowserVM: BrowserVMProvider | null = null;
  for (const [name] of env.jReplicas.entries()) {
    try {
      const adapter = await ensureLiveJAdapterForReplica(env, name, {
        allowBrowserVm: Boolean(env.browserVMState),
        context: `restore:${name}`,
        attempts: 5,
      });
      if (adapter?.mode === 'browservm') {
        const browserVM = adapter.getBrowserVM();
        if (!browserVM) throw new Error(`RESTORE_BROWSERVM_PROVIDER_MISSING:${name}`);
        if (restoredBrowserVM && restoredBrowserVM !== browserVM) {
          throw new Error('RESTORE_MULTIPLE_BROWSERVM_UNSUPPORTED');
        }
        restoredBrowserVM = browserVM;
        env.browserVM = browserVM;
        options.setBrowserVMJurisdiction(env, adapter.addresses.depository, adapter.chainId, browserVM);
        if (typeof window !== 'undefined') {
          (window as Window & { __xlnBrowserVM?: BrowserVMProvider | null }).__xlnBrowserVM = browserVM;
        }
        infraLog.debug('browservm.restored', { name });
      }
    } catch (error) {
      infraLog.error('jadapter.restore_failed', {
        name,
        error: errorMessage(error),
      });
      throw new Error(
        `RESTORE_JADAPTER_FAILED: name=${name} cause=${errorMessage(error)}`,
      );
    }
  }
};
