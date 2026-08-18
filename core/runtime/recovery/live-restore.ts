import { createStructuredLogger } from '../../support/logger';
import type { TrustedJurisdictionRpcBinding } from './j-adapter-restore';
import type { RuntimeReplica } from '../types';
import { markRestoredOutputsDue } from '../delivery/pending';

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
};

export const loadLiveRuntimeFromDB = async (
  deps: RuntimeLiveRestoreDeps,
  runtimeId?: string | null,
  runtimeSeed?: string | null,
  options?: RuntimeLoadOptions,
): Promise<RuntimeReplica | null> => {
  try {
    const snapshotHeight = Number.isFinite(options?.fromSnapshotHeight)
      ? Math.floor(Number(options?.fromSnapshotHeight))
      : undefined;
    const restored = await deps.loadByReplay(runtimeId, runtimeSeed, snapshotHeight, {});
    const env = restored?.env ?? null;
    if (!env) return null;

    await deps.rehydrate(env, options?.trustedJurisdictionRpcBindings);
    deps.registerCommittedSingleSignerWallets(env);
    markRestoredOutputsDue(env);
    return env;
  } catch (error) {
    const message = error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
    runtimeLog.error('load_env_from_db.failed', { error: message });
    throw error;
  }
};
