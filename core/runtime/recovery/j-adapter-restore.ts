import type { RuntimeReplica } from '../types';
import { ensureRuntimeInfrastructure } from '../envelope/replica-envelope';
import type { JReplica } from '../../types/jurisdiction-runtime';
import type { BrowserVMProvider, JAdapter, JAdapterConfig } from '../../jurisdiction/adapter/types';
import { createJAdapterWithRetry } from '../../jurisdiction/adapter/kernel/retry';
import { errorMessage } from '../../support/boundary-guards';
import { createStructuredLogger } from '../../support/logger';
import { getJurisdictionIdentityRef } from '../../jurisdiction/machine/jurisdiction-runtime';
import { buildCanonicalJReplicaSnapshot } from '../../storage/wal/snapshot';
import {
  attachLiveJAdapter,
  detachLiveJAdapter,
  getLiveJAdapter,
} from '../j-submit/live-jadapters';

const infraLog = createStructuredLogger('runtime.restore');

export type TrustedJurisdictionRpcBinding = {
  jurisdictionRef: string;
  rpcUrl: string;
};

export const applyTrustedJurisdictionRpcBindings = (
  env: RuntimeReplica,
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

  // RPC selection is a live capability. Changing JReplica.rpcs after replay
  // would commit an unlogged state change in the next frame and break restart.
  ensureRuntimeInfrastructure(env).trustedJurisdictionRpcUrls = rpcByJurisdictionRef;
};

export const normalizeRestoredJReplicas = (env: RuntimeReplica): void => {
  if (!env.state.jReplicas) env.state.jReplicas = new Map();
  for (const [name, replica] of env.state.jReplicas.entries()) {
    env.state.jReplicas.set(name, buildCanonicalJReplicaSnapshot(replica));
  }
};

/**
 * Close every adapter this restore created after `error`. Close failures are
 * aggregated into the thrown error, never dropped.
 */
const closeJAdaptersAfterFailure = async (adapters: readonly JAdapter[], error: unknown): Promise<never> => {
  const closing = await Promise.allSettled(adapters.map(adapter => adapter.close()));
  const closeFailures = closing.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (closeFailures.length === 0) throw error;
  throw new AggregateError([error, ...closeFailures], 'RESTORE_JADAPTER_FAILED_AND_CLOSE_FAILED');
};

const assertJAdapterMatchesReplica = async (
  name: string,
  jReplica: JReplica,
  jadapter: JAdapter,
): Promise<void> => {
  const expectedAddresses = {
    account: String(jReplica.contracts?.account || '').trim().toLowerCase(),
    depository: String(jReplica.contracts?.depository || '').trim().toLowerCase(),
    entityProvider: String(jReplica.contracts?.entityProvider || '').trim().toLowerCase(),
    deltaTransformer: String(jReplica.contracts?.deltaTransformer || '').trim().toLowerCase(),
  };
  for (const [contractName, expected] of Object.entries(expectedAddresses)) {
    const actual = String(
      jadapter.addresses[contractName as keyof typeof jadapter.addresses] || '',
    ).trim().toLowerCase();
    if (!expected || actual !== expected) {
      throw new Error(
        `RESTORE_JADAPTER_ADDRESS_MISMATCH:${name}:${contractName}:expected=${expected || 'missing'}:actual=${actual || 'missing'}`,
      );
    }
  }
  if (Number(jadapter.chainId) !== Number(jReplica.chainId)) {
    throw new Error(
      `RESTORE_JADAPTER_CHAIN_MISMATCH:${name}:expected=${String(jReplica.chainId)}:actual=${String(jadapter.chainId)}`,
    );
  }
  if ((jReplica.watcherReceiptCommitment === 'tron-rpc-attested') !== (jadapter.mode === 'tron')) {
    throw new Error(`RESTORE_JADAPTER_RECEIPT_COMMITMENT_MISMATCH:${name}`);
  }
  if (jadapter.mode !== 'browservm') return;
  const captureStateRoot = jadapter.captureStateRoot;
  if (!captureStateRoot) {
    throw new Error(`RESTORE_BROWSERVM_STATE_ROOT_READER_MISSING:${name}`);
  }
  const actualStateRoot = await captureStateRoot.call(jadapter);
  const expectedStateRoot = jReplica.stateRoot;
  const rootsMatch =
    actualStateRoot instanceof Uint8Array &&
    expectedStateRoot instanceof Uint8Array &&
    actualStateRoot.length === expectedStateRoot.length &&
    actualStateRoot.every((byte, index) => byte === expectedStateRoot[index]);
  if (!rootsMatch) {
    throw new Error(`RESTORE_BROWSERVM_STATE_ROOT_MISMATCH:${name}`);
  }
};

type LiveJAdapterOptions = {
  allowBrowserVm?: boolean;
  context?: string;
  attempts?: number;
};

/**
 * Connects and verifies one chain capability. A failed check closes the new
 * adapter; a verified one is returned unattached for its caller to own.
 */
const connectVerifiedJAdapter = async (
  env: RuntimeReplica,
  name: string,
  jReplica: JReplica,
  options: LiveJAdapterOptions,
): Promise<JAdapter | null> => {
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
    mode: hasRpcs ? (jReplica.watcherReceiptCommitment === 'tron-rpc-attested' ? 'tron' : 'rpc') : 'browservm',
    chainId,
    ...(hasRpcs ? { watchOnly: true } : {}),
  };

  if (hasRpcs) {
    if (!rpcUrl) return null;
    adapterConfig.rpcUrl = env.infrastructure?.trustedJurisdictionRpcUrls
      ?.get(getJurisdictionIdentityRef(jReplica).toLowerCase()) ?? rpcUrl;
    adapterConfig.fromReplica = jReplica;
    if (Number.isSafeInteger(jReplica.blockDelayMs) && jReplica.blockDelayMs > 0) {
      adapterConfig.watchPollMs = jReplica.blockDelayMs;
    }
  } else if (env.browserVMState !== undefined) {
    adapterConfig.browserVMState = env.browserVMState;
  }

  const jadapter = await createJAdapterWithRetry(adapterConfig, {
    context,
    attempts,
    onRetry: (attempt, totalAttempts, error) => {
      // A transient attempt that is still inside the bounded retry policy is
      // recovery telemetry, not a runtime warning. Exhaustion remains a loud
      // `jadapter.restore_failed` error in rehydrateRestoredRuntimeInfra.
      infraLog.info('jadapter.restore_retry', {
        name,
        attempt,
        attempts: totalAttempts,
        error: errorMessage(error),
      });
    },
  });

  try {
    if (hasRpcs && (!jadapter.addresses?.depository || !jadapter.addresses?.entityProvider)) {
      throw new Error(
        `RESTORE_JADAPTER_ADDRESSES_MISSING: name=${name} ` +
          `depository=${jadapter.addresses?.depository || 'none'} ` +
          `entityProvider=${jadapter.addresses?.entityProvider || 'none'}`,
      );
    }
    await assertJAdapterMatchesReplica(name, jReplica, jadapter);
  } catch (error) {
    return await closeJAdaptersAfterFailure([jadapter], error);
  }
  infraLog.debug('jadapter.derived', { name, mode: hasRpcs ? 'rpc' : 'browservm' });
  return jadapter;
};

export const ensureLiveJAdapterForReplica = async (
  env: RuntimeReplica,
  name: string,
  options: LiveJAdapterOptions = {},
): Promise<JAdapter | null> => {
  const jReplica = env.state.jReplicas?.get(name);
  if (!jReplica) return null;

  const liveAdapter = getLiveJAdapter(env, name);
  if (liveAdapter) {
    try {
      await assertJAdapterMatchesReplica(name, jReplica, liveAdapter);
    } catch (error) {
      detachLiveJAdapter(env, name, liveAdapter);
      return await closeJAdaptersAfterFailure([liveAdapter], error);
    }
    return liveAdapter;
  }

  const jadapter = await connectVerifiedJAdapter(env, name, jReplica, options);
  if (jadapter) attachLiveJAdapter(env, name, jadapter);
  return jadapter;
};

type RestoredJAdapter = { name: string; adapter: JAdapter };

/**
 * Restore connects every restored chain at once: each connection is an
 * independent RPC round trip, and connecting them in sequence added one full
 * chain handshake per jurisdiction to every unlock. Returns verified,
 * unattached adapters in jReplicas order; any failure closes every created one.
 */
const connectRestoredJAdapters = async (
  env: RuntimeReplica,
  options: LiveJAdapterOptions,
): Promise<RestoredJAdapter[]> => {
  const names = [...env.state.jReplicas.keys()];
  const settled = await Promise.allSettled(names.map(async name => {
    const jReplica = env.state.jReplicas.get(name);
    if (!jReplica) throw new Error(`RESTORE_JREPLICA_MISSING:${name}`);
    if (getLiveJAdapter(env, name)) throw new Error(`RESTORE_JADAPTER_ALREADY_LIVE:${name}`);
    return { name, adapter: await connectVerifiedJAdapter(env, name, jReplica, { ...options, context: `restore:${name}` }) };
  }));
  const restored = settled.flatMap((result): RestoredJAdapter[] =>
    result.status === 'fulfilled' && result.value.adapter ? [{ name: result.value.name, adapter: result.value.adapter }] : []);
  const failures = settled.flatMap((result, index) => result.status === 'rejected'
    ? [new Error(`RESTORE_JADAPTER_FAILED: name=${names[index]} cause=${errorMessage(result.reason)}`, { cause: result.reason })]
    : []);
  if (failures.length === 0) return restored;
  for (const [index, result] of settled.entries()) {
    if (result.status === 'rejected') infraLog.error('jadapter.restore_failed', { name: names[index], error: errorMessage(result.reason) });
  }
  return closeJAdaptersAfterFailure(
    restored.map(entry => entry.adapter),
    failures.length === 1 ? failures[0] : new AggregateError(failures, 'RESTORE_JADAPTERS_FAILED'),
  );
};

/** At most one BrowserVM provider, bound to its jurisdiction, before any adapter attaches. */
const validateRestoredBrowserVM = (
  restored: readonly RestoredJAdapter[],
  assertBrowserVMJurisdiction: (depositoryAddress: string, chainId: number, browserVM: BrowserVMProvider) => void,
): BrowserVMProvider | null => {
  let restoredBrowserVM: BrowserVMProvider | null = null;
  for (const { name, adapter } of restored) {
    if (adapter.mode !== 'browservm') continue;
    const browserVM = adapter.getBrowserVM();
    if (!browserVM) throw new Error(`RESTORE_JADAPTER_FAILED: name=${name} cause=RESTORE_BROWSERVM_PROVIDER_MISSING:${name}`);
    if (restoredBrowserVM && restoredBrowserVM !== browserVM) {
      throw new Error(`RESTORE_JADAPTER_FAILED: name=${name} cause=RESTORE_MULTIPLE_BROWSERVM_UNSUPPORTED`);
    }
    restoredBrowserVM = browserVM;
    assertBrowserVMJurisdiction(adapter.addresses.depository, adapter.chainId, browserVM);
  }
  return restoredBrowserVM;
};

export const rehydrateRestoredRuntimeInfra = async (
  env: RuntimeReplica,
  options: {
    loadGossipProfiles: (env: RuntimeReplica) => Promise<void>;
    assertPersistedContractConfigReady: (env: RuntimeReplica, label: string) => void;
    assertBrowserVMJurisdiction: (
      depositoryAddress: string,
      chainId: number,
      browserVM: BrowserVMProvider,
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

  if (!env.state.jReplicas || env.state.jReplicas.size === 0) return;

  const restored = await connectRestoredJAdapters(env, {
    allowBrowserVm: Boolean(env.browserVMState),
    attempts: 5,
  });
  const attached: RestoredJAdapter[] = [];
  try {
    const browserVM = validateRestoredBrowserVM(restored, options.assertBrowserVMJurisdiction);
    for (const entry of restored) {
      attachLiveJAdapter(env, entry.name, entry.adapter);
      attached.push(entry);
    }
    if (browserVM && typeof window !== 'undefined') {
      (window as Window & { __xlnBrowserVM?: BrowserVMProvider | null }).__xlnBrowserVM = browserVM;
    }
    if (browserVM) infraLog.debug('browservm.restored', { names: restored.filter(entry => entry.adapter.mode === 'browservm').map(entry => entry.name) });
  } catch (error) {
    for (const { name, adapter } of attached) detachLiveJAdapter(env, name, adapter);
    await closeJAdaptersAfterFailure(restored.map(entry => entry.adapter), error);
  }
};
