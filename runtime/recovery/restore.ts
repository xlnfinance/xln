import { Level } from 'level';
import { type RuntimeOutputRoutingDeps } from '../runtime/output-routing';
import {
  applyCommittedLocalReliableReceipts,
  applyRecoveryRuntimeOutputPlan,
  hasPendingLocalReliableOutput,
} from '../runtime/recovery-output';
import {
  assertPersistedContractConfigReady,
  reconcileRecoveryInfraEffects,
  registerCommittedSingleSignerWallets,
} from '../runtime/recovery-infra';
import { replayPersistedRuntimeJournals } from '../storage/recovery/journal';
import type { RuntimeReplica, ReliableDeliveryReceipt, RoutedEntityInput, RuntimeTx } from '../runtime/types';
import type { PersistedFrameJournal } from './../storage/types';
import type { RuntimeRecoveryBundleV1 } from './../recovery/types';
import { loadGossipProfilesFromInfraDb } from '../runtime/infra-gossip-store';
import type { StorageDbRole } from './../storage/runtime-dbs';
import { restoreCheckpointSnapshot } from '../storage/recovery/checkpoint';
import { persistRestoredRuntimeState, type PersistRestoredRuntimeOptions } from '../storage/recovery/import';
import { restoreRuntimeFromBundles, type RuntimeBundleRestoreOptions } from './bundle-restore';

type RuntimeModule = typeof import('../runtime');

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
    inputs?: import('../entity/types').EntityInput[],
    runtimeTxs?: RuntimeTx[],
    jInputs?: import('../jurisdiction/input').JInput[],
    explicitTimestamp?: number,
    reliableReceipts?: ReliableDeliveryReceipt[],
  ): void;
  infraGossipDbAccess: Parameters<typeof loadGossipProfilesFromInfraDb>[1];
  generateHookPings(env: RuntimeReplica, nowMs?: number, queuedAt?: number): void;
  getRuntimeOutputRoutingDeps(): RuntimeOutputRoutingDeps;
  applyRuntimeInput: RuntimeModule['applyRuntimeInput'];
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
    generateHookPings,
    startJurisdictionWatchers,
    getRuntimeOutputRoutingDeps,
    applyRuntimeInput,
  } = deps;

  const restoreEnvFromCheckpointSnapshot = (
    snapshot: Record<string, unknown>,
    options?: Parameters<typeof restoreCheckpointSnapshot>[2],
  ) => restoreCheckpointSnapshot({ createEmptyEnv, infraGossipDbAccess }, snapshot, options);

  const replayRecoveryFrameJournals = (env: RuntimeReplica, frames: PersistedFrameJournal[]): Promise<void> =>
    replayPersistedRuntimeJournals(
      {
        ensureRuntimeConfig,
        applyRuntimeInput,
        applyRuntimeOutputPlan: applyDeterministicRuntimeOutputPlan,
        getRuntimeOutputRoutingDeps,
        generateHookPings,
      },
      env,
      frames,
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
        restoreCheckpoint: restoreEnvFromCheckpointSnapshot,
        replayJournals: replayRecoveryFrameJournals,
        failAfterCleanup: failRecoveryRestoreAfterCleanup,
      },
      bundles,
      options,
    );

  const persistRestoredEnvToDB = async (
    env: RuntimeReplica,
    options: PersistRestoredRuntimeOptions = {},
  ): Promise<void> =>
    persistRestoredRuntimeState({ getStorageDb, getRuntimeWalDb, tryOpenStorageDb, tryOpenRuntimeWalDb }, env, options);

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
    hasPendingLocalReliableOutput,
    applyDeterministicRuntimeOutputPlan,
    applyCommittedLocalReliableReceipts,
  };
};
