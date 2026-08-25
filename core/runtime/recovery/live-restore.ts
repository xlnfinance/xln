import { adoptShadowRuntimeState } from '../../rscore/shadow-hook';
import { createStructuredLogger } from '../../support/logger';
import type { TrustedJurisdictionRpcBinding } from './j-adapter-restore';
import type { RuntimeReplica } from '../types';

const runtimeLog = createStructuredLogger('runtime');

export type RuntimeLoadOptions = {
  fromSnapshotHeight?: number;
  trustedJurisdictionRpcBindings?: readonly TrustedJurisdictionRpcBinding[];
};

export type RuntimeLiveRestoreDeps = {
  loadByReplay(
    runtimeId?: string | null,
    runtimeSeed?: string | null,
    fromSnapshotHeight?: number,
    options?: Record<string, never>,
  ): Promise<{ env: RuntimeReplica } | null>;
  rehydrate(
    env: RuntimeReplica,
    trustedJurisdictionRpcBindings?: readonly TrustedJurisdictionRpcBinding[],
  ): Promise<void>;
  registerCommittedSingleSignerWallets(env: RuntimeReplica): void;
  discardAccountAuthority(env: RuntimeReplica): Promise<void>;
};

export const loadLiveRuntimeFromDB = async (
  deps: RuntimeLiveRestoreDeps,
  runtimeId?: string | null,
  runtimeSeed?: string | null,
  options?: RuntimeLoadOptions,
): Promise<RuntimeReplica | null> => {
  let env: RuntimeReplica | null = null;
  try {
    const snapshotHeight = Number.isFinite(options?.fromSnapshotHeight)
      ? Math.floor(Number(options?.fromSnapshotHeight))
      : undefined;
    const restored = await deps.loadByReplay(runtimeId, runtimeSeed, snapshotHeight, {});
    env = restored?.env ?? null;
    if (!env) return null;

    await deps.rehydrate(env, options?.trustedJurisdictionRpcBindings);
    deps.registerCommittedSingleSignerWallets(env);
    // Network outputs are one-shot post-commit effects, not a durable delivery
    // queue. Replay reconstructs them only to verify deterministic equivalence.
    // A live restore must neither resend nor block on the last replayed frame.
    env.pendingNetworkOutputs = [];
    // Canonical recovery boundary for the Rust shadow: the whole restored
    // account tree is the shared initial condition, and it must reach the
    // engine before the first live input. No-op when shadow is off.
    await adoptShadowRuntimeState(env.state);
    return env;
  } catch (error) {
    if (env) await deps.discardAccountAuthority(env);
    const message = error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
    runtimeLog.error('load_env_from_db.failed', { error: message });
    throw error;
  }
};
