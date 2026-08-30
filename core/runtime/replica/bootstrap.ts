import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
} from '../../account/crypto';
import { createStructuredLogger } from '../../support/logger';
import { attachEventEmitters } from '../observability/env-events';
import { nodeProcess, runtimeIsBrowser } from '../../support/process/runtime-process';
import type { RuntimeReplica } from '../types';
import type { TrustedJurisdictionRpcBinding } from '../recovery/j-adapter-restore';

const runtimeLog = createStructuredLogger('runtime');

export type RuntimeLocalSigner = Readonly<{
  label: string;
  seed?: Uint8Array | string;
}>;

export type RuntimeCreationOptions = Readonly<{
  trustedJurisdictionRpcBindings?: readonly TrustedJurisdictionRpcBinding[];
  localSigners?: readonly RuntimeLocalSigner[];
  /** Cache warmup only; omitted numeric signers remain available lazily. */
  numericSignerPrewarmCount?: number;
}>;

export type RuntimeBootstrapDeps = {
  createRuntime(seed: string | null, numericSignerPrewarmCount?: number): RuntimeReplica;
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

const runtimeRestoreDisabled = (): boolean =>
  !runtimeIsBrowser &&
  !!nodeProcess &&
  /^(1|true)$/i.test(String(nodeProcess.env['XLN_DISABLE_RUNTIME_RESTORE'] ?? ''));

const restoreRuntimeAtBootstrap = async (
  baseEnv: RuntimeReplica,
  options: RuntimeCreationOptions | undefined,
  deps: RuntimeBootstrapDeps,
): Promise<{ env: RuntimeReplica; restored: boolean }> => {
  if (runtimeRestoreDisabled()) return { env: baseEnv, restored: false };

  const env = await deps.loadRuntime(baseEnv.runtimeId, baseEnv.runtimeSeed, {
    ...(options?.trustedJurisdictionRpcBindings
      ? { trustedJurisdictionRpcBindings: options.trustedJurisdictionRpcBindings }
      : {}),
  });
  if (!env) return { env: baseEnv, restored: false };
  runtimeLog.info('main.restored', {
    runtime: String(env.runtimeId || '').slice(0, 12),
    height: env.state.height,
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
  const numericSignerPrewarmCount = options?.numericSignerPrewarmCount;
  if (
    numericSignerPrewarmCount !== undefined &&
    (!Number.isSafeInteger(numericSignerPrewarmCount) || numericSignerPrewarmCount < 1 || numericSignerPrewarmCount > 100)
  ) {
    throw new Error(`RUNTIME_SIGNER_PREWARM_COUNT_INVALID:${String(numericSignerPrewarmCount)}`);
  }
  registerLocalRuntimeSigners(runtimeSeed, options?.localSigners ?? []);
  const restored = await restoreRuntimeAtBootstrap(
    deps.createRuntime(runtimeSeed, numericSignerPrewarmCount),
    options,
    deps,
  );
  const env = restored.env;
  attachEventEmitters(env);
  if (!restored.restored && !runtimeRestoreDisabled()) {
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
