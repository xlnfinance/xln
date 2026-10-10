/**
 * Restores one checkpoint, replays the bounded Runtime WAL, and republishes its flat outbox.
 * Key paths: restore one canonical head without executing pre-commit external effects.
 * Human-audit importance: 100/100 — this is the event-sourcing equivalence proof path.
 */
import { Level } from 'level';
import { type RuntimeOutputRoutingDeps } from '../../runtime/delivery/topology/output-routing';
import { applyRecoveryRuntimeOutputPlan } from '../../runtime/delivery/recovery-output';
import {
  assertPersistedContractConfigReady,
  reconcileRecoveryInfraEffects,
  registerCommittedSingleSignerWallets,
} from '../../runtime/recovery/restore-adapters';
import { rehydrateRestoredRuntimeInfra } from '../../runtime/recovery/j-adapter-restore';
import { assertBrowserVMJurisdiction } from '../../jurisdiction/adapter/browservm/browservm-registry';
import { replayPersistedRuntimeJournals, type RecoveryReplayOptions } from './journal';
import { authorityReplayEnabled } from '../../rscore/authority-driver';
import type { RuntimeReplica, RoutedEntityInput, RuntimeTx } from '../../runtime/types';
import type { PersistedFrameJournal } from '../types';
import type { RuntimeRecoveryBundleV1 } from './bundle/types';
import { loadGossipProfilesFromInfraDb } from '../../runtime/envelope/gossip-store';
import type { StorageDbRole } from '../runtime-dbs';
import {
  decodeCheckpointSnapshot,
  type CheckpointRestoreOptions,
  type DecodedCheckpointSnapshot,
} from './checkpoint';
import type { Profile } from '../../entity/profile';
import { persistRestoredRuntimeState, type PersistRestoredRuntimeOptions } from './import';
import { restoreRuntimeFromBundles, type RuntimeBundleRestoreOptions } from './bundle/restore';

type RuntimeModule = typeof import('../../runtime');

export type RuntimeRecoveryDeps = Pick<
  RuntimeModule,
  'closeRuntimeDb' | 'closeInfraDb' | 'startJurisdictionWatchers'
> & {
  ensureRuntimeConfig(env: RuntimeReplica): NonNullable<RuntimeReplica['runtimeConfig']>;
  createEmptyEnv: RuntimeModule['createEmptyEnv'];
  getStorageDb(env: RuntimeReplica, role?: StorageDbRole): Level<Buffer, Buffer>;
  getRuntimeWalDb(env: RuntimeReplica): Level<Buffer, Buffer>;
  tryOpenStorageDb(env: RuntimeReplica, role?: StorageDbRole): Promise<boolean>;
  tryOpenRuntimeWalDb(env: RuntimeReplica): Promise<boolean>;
  enqueueRuntimeContinuation(
    env: RuntimeReplica,
    inputs?: import('../../entity/types').EntityInput[],
    runtimeTxs?: RuntimeTx[],
    jInputs?: import('../../jurisdiction/machine/input').JInput[],
    explicitTimestamp?: number,
  ): void;
  infraGossipDbAccess: Parameters<typeof loadGossipProfilesFromInfraDb>[1];
  getRuntimeOutputRoutingDeps(): RuntimeOutputRoutingDeps;
  applyRuntimeInput: RuntimeModule['applyRuntimeInput'];
  accountAuthorityConfigured(): boolean;
  setAccountAuthoritySuppressed(env: RuntimeReplica, suppressed: boolean): void;
};

export const createRuntimeRecoveryApi = (deps: RuntimeRecoveryDeps) => {
  const {
    ensureRuntimeConfig,
    createEmptyEnv,
    getStorageDb,
    getRuntimeWalDb,
    tryOpenStorageDb,
    tryOpenRuntimeWalDb,
    closeRuntimeDb,
    closeInfraDb,
    enqueueRuntimeContinuation,
    infraGossipDbAccess,
    startJurisdictionWatchers,
    getRuntimeOutputRoutingDeps,
    applyRuntimeInput,
    accountAuthorityConfigured,
    setAccountAuthoritySuppressed,
  } = deps;

  // Decodes and verifies the checkpoint in memory. It opens no database and
  // starts no adapter, so a later verification failure has nothing live to undo.
  const decodeRestoredCheckpoint = async (
    snapshot: Record<string, unknown>,
    options: CheckpointRestoreOptions,
  ): Promise<DecodedCheckpointSnapshot> => {
    if (accountAuthorityConfigured() && options.readOnly !== true) {
      throw new Error('RSCORE_PORTABLE_RESTORE_EXACT_CHECKPOINT_REQUIRED');
    }
    const decoded = await decodeCheckpointSnapshot(
      { createEmptyEnv },
      snapshot,
      options,
    );
    const { env, gossipProfiles } = decoded;
    env.persistenceLastMaterializedHeight = env.state.height;
    if (options.readOnly === true) {
      // A read-only restore never writes, so the engine it starts can never
      // become durable. That is why the benchmark replay may opt in explicitly;
      // silence stays the default.
      if (!authorityReplayEnabled()) setAccountAuthoritySuppressed(env, true);
      registerCommittedSingleSignerWallets(env);
      if (!env.gossip?.setProfiles) throw new Error('RECOVERY_GOSSIP_HYDRATION_UNAVAILABLE');
      env.gossip.setProfiles(gossipProfiles);
    }
    return decoded;
  };

  // Opens the infra DB, starts live J adapters, binds wallets and announces
  // profiles. Runs only on fully verified state, as loadEnvFromDB does.
  const activateRestoredRuntime = async (env: RuntimeReplica, gossipProfiles: readonly Profile[]): Promise<void> => {
    await rehydrateRestoredRuntimeInfra(env, {
      loadGossipProfiles: target => loadGossipProfilesFromInfraDb(target, infraGossipDbAccess),
      assertPersistedContractConfigReady,
      assertBrowserVMJurisdiction,
    });
    registerCommittedSingleSignerWallets(env);
    for (const profile of gossipProfiles) env.gossip?.announce?.(profile);
  };

  const restoreEnvFromCheckpointSnapshot = async (
    snapshot: Record<string, unknown>,
    options: CheckpointRestoreOptions = {},
  ): Promise<RuntimeReplica> => {
    const { env, gossipProfiles } = await decodeRestoredCheckpoint(snapshot, options);
    if (!options.readOnly) await activateRestoredRuntime(env, gossipProfiles);
    return env;
  };

  const replayRecoveryFrameJournals = (
    env: RuntimeReplica,
    frames: PersistedFrameJournal[],
    options?: RecoveryReplayOptions,
  ): Promise<void> =>
    replayPersistedRuntimeJournals(
      {
        ensureRuntimeConfig,
        applyRuntimeInput,
        applyRuntimeOutputPlan: applyDeterministicRuntimeOutputPlan,
        getRuntimeOutputRoutingDeps,
      },
      env,
      frames,
      options,
    );
  const failRecoveryRestoreAfterCleanup = async (env: RuntimeReplica, error: unknown): Promise<never> => {
    const originalError = error instanceof Error ? error : new Error(String(error));
    const cleanup = await Promise.allSettled([closeRuntimeDb(env), closeInfraDb(env)]);
    const cleanupErrors = cleanup
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => (result.reason instanceof Error ? result.reason : new Error(String(result.reason))));
    if (cleanupErrors.length > 0) {
      throw new AggregateError([originalError, ...cleanupErrors], 'RECOVERY_RESTORE_FAILED_WITH_CLEANUP_ERRORS');
    }
    throw originalError;
  };

  const restoreEnvFromRecoveryBundles = async (
    bundles: RuntimeRecoveryBundleV1[],
    options: RuntimeBundleRestoreOptions = {},
  ): Promise<RuntimeReplica> =>
    restoreRuntimeFromBundles(
      {
        restoreCheckpoint: decodeRestoredCheckpoint,
        activateRestoredRuntime,
        replayJournals: replayRecoveryFrameJournals,
        failAfterCleanup: failRecoveryRestoreAfterCleanup,
      },
      bundles,
      options,
    );

  const persistRestoredEnvToDB = async (
    env: RuntimeReplica,
    options: PersistRestoredRuntimeOptions = {},
  ): Promise<void> => {
    if (accountAuthorityConfigured()) {
      throw new Error('RSCORE_PORTABLE_PERSIST_EXACT_CHECKPOINT_REQUIRED');
    }
    return persistRestoredRuntimeState({
      getStorageDb,
      getRuntimeWalDb,
      tryOpenStorageDb,
      tryOpenRuntimeWalDb,
    }, env, options);
  };

  const reconcileCommittedRuntimeInfraEffects = (env: RuntimeReplica, runtimeTxs: readonly RuntimeTx[]) =>
    reconcileRecoveryInfraEffects(env, runtimeTxs, startJurisdictionWatchers);

  const applyDeterministicRuntimeOutputPlan = (
    env: RuntimeReplica,
    entityOutbox: readonly RoutedEntityInput[],
    outputRoutingDeps: RuntimeOutputRoutingDeps,
  ) => applyRecoveryRuntimeOutputPlan(env, entityOutbox, outputRoutingDeps, enqueueRuntimeContinuation);

  return {
    restoreEnvFromCheckpointSnapshot,
    restoreEnvFromRecoveryBundles,
    persistRestoredEnvToDB,
    replayRecoveryFrameJournals,
    assertPersistedContractConfigReady,
    registerCommittedSingleSignerWallets,
    reconcileCommittedRuntimeInfraEffects,
    applyDeterministicRuntimeOutputPlan,
  };
};
