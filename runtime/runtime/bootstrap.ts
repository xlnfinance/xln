import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
} from '../account/crypto';
import { createStructuredLogger } from '../infra/logger';
import { attachEventEmitters } from './env-events';
import { nodeProcess, runtimeIsBrowser } from '../infra/runtime-process';
import type { EntityTx } from '../types/entity-tx';
import type { RuntimeReplica } from './types';
import type { TrustedJurisdictionRpcBinding } from './infra';

const runtimeLog = createStructuredLogger('runtime');

export type RuntimeLocalSigner = Readonly<{
  label: string;
  seed?: Uint8Array | string;
}>;

export type RuntimeCreationOptions = Readonly<{
  trustedJurisdictionRpcBindings?: readonly TrustedJurisdictionRpcBinding[];
  localSigners?: readonly RuntimeLocalSigner[];
}>;

export type RuntimeBootstrapDeps = {
  createRuntime(seed: string | null): RuntimeReplica;
  loadRuntime(
    runtimeId?: string | null,
    runtimeSeed?: string | null,
    options?: Pick<RuntimeCreationOptions, 'trustedJurisdictionRpcBindings'>,
  ): Promise<RuntimeReplica | null>;
  loadGossipProfiles(env: RuntimeReplica): Promise<void>;
  startRuntimeLoop(env: RuntimeReplica): unknown;
};

const registerLocalRuntimeSigners = (
  runtimeSeed: string | null,
  signers: readonly RuntimeLocalSigner[],
): void => {
  if (signers.length > 0 && runtimeSeed === null) {
    throw new Error('RUNTIME_LOCAL_SIGNERS_REQUIRE_SEED');
  }
  if (runtimeSeed === null) return;
  for (const signer of signers) {
    const label = String(signer.label || '').trim();
    if (!label) throw new Error('RUNTIME_LOCAL_SIGNER_LABEL_REQUIRED');
    const signerSeed = signer.seed ?? runtimeSeed;
    const signerId = deriveSignerAddressSync(signerSeed, label).toLowerCase();
    registerSignerKey(runtimeSeed, signerId, deriveSignerKeySync(signerSeed, label));
  }
};

const restoreRuntimeAtBootstrap = async (
  baseEnv: RuntimeReplica,
  options: RuntimeCreationOptions | undefined,
  deps: RuntimeBootstrapDeps,
): Promise<{ env: RuntimeReplica; restored: boolean }> => {
  const restoreDisabled =
    !runtimeIsBrowser &&
    !!nodeProcess &&
    /^(1|true)$/i.test(String(nodeProcess.env['XLN_DISABLE_RUNTIME_RESTORE'] ?? ''));
  if (restoreDisabled) return { env: baseEnv, restored: false };

  const env = await deps.loadRuntime(baseEnv.runtimeId, baseEnv.runtimeSeed, {
    ...(options?.trustedJurisdictionRpcBindings
      ? { trustedJurisdictionRpcBindings: options.trustedJurisdictionRpcBindings }
      : {}),
  });
  if (!env) return { env: baseEnv, restored: false };
  runtimeLog.info('main.restored', {
    runtime: String(env.runtimeId || '').slice(0, 12),
    height: env.height,
  });
  return { env, restored: true };
};

const ensureBootstrapRuntimeId = (env: RuntimeReplica): void => {
  if (env.runtimeId || !env.runtimeSeed) return;
  try {
    env.runtimeId = deriveSignerAddressSync(env.runtimeSeed, '1');
    runtimeLog.debug('main.runtime_id_derived', { runtime: env.runtimeId.slice(0, 12) });
  } catch (error) {
    runtimeLog.warn('main.runtime_id_derive_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export const bootstrapRuntime = async (
  deps: RuntimeBootstrapDeps,
  runtimeSeedOverride?: string | null,
  options?: RuntimeCreationOptions,
): Promise<RuntimeReplica> => {
  const runtimeSeed = runtimeSeedOverride ?? null;
  registerLocalRuntimeSigners(runtimeSeed, options?.localSigners ?? []);
  const restored = await restoreRuntimeAtBootstrap(
    deps.createRuntime(runtimeSeed),
    options,
    deps,
  );
  const env = restored.env;
  attachEventEmitters(env);
  if (!restored.restored) {
    try {
      await deps.loadGossipProfiles(env);
    } catch (error) {
      runtimeLog.warn('main.infra_gossip_restore_skipped', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  ensureBootstrapRuntimeId(env);
  if (runtimeIsBrowser) {
    runtimeLog.info('main.loop_start_browser');
    deps.startRuntimeLoop(env);
  }
  return env;
};

export const queueEntityTransaction = (
  enqueue: (
    env: RuntimeReplica,
    entityId: string,
    signerId: string,
    tx: EntityTx,
  ) => void,
  env: RuntimeReplica,
  entityId: string,
  signerId: string,
  txData: { type: EntityTx['type'] } & Record<string, unknown>,
): void => {
  enqueue(env, entityId, signerId, { type: txData.type, data: txData } as EntityTx);
};

export const getHistory = (env: RuntimeReplica) => env.history || [];

export const getSnapshot = (env: RuntimeReplica, index: number) => {
  const history = getHistory(env);
  return index >= 0 && index < history.length ? history[index] : null;
};

export const getCurrentHistoryIndex = (env: RuntimeReplica): number =>
  getHistory(env).length - 1;
