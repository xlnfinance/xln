/**
 * Replays committed WAL/history into a Runtime and reconstructs durable output delivery.
 * Key paths: restore one canonical head without executing pre-commit external effects.
 * Human-audit importance: 100/100 — this is the event-sourcing equivalence proof path.
 */
import { Level } from 'level';
import { type RuntimeOutputRoutingDeps } from '../../runtime/routing/output-routing';
import {
  applyCommittedLocalReliableReceipts,
  applyRecoveryRuntimeOutputPlan,
  hasPendingLocalReliableOutput,
} from '../../runtime/delivery/recovery-output';
import {
  assertPersistedContractConfigReady,
  reconcileRecoveryInfraEffects,
  registerCommittedSingleSignerWallets,
} from '../../runtime/recovery/recovery-infra';
import { rehydrateRestoredRuntimeInfra } from '../../runtime/infra';
import { runtimeIsBrowser } from '../../infra/process/runtime-process';
import { assertBrowserVMJurisdiction } from '../../jurisdiction/adapter/browservm/browservm-registry';
import { replayPersistedRuntimeJournals } from './journal';
import type { RuntimeReplica, ReliableDeliveryReceipt, RoutedEntityInput, RuntimeTx } from '../../runtime/types';
import type { PersistedFrameJournal } from '../types';
import type { RuntimeRecoveryBundleV1 } from './bundle/types';
import { loadGossipProfilesFromInfraDb } from '../../runtime/infrastructure/gossip-store';
import type { StorageDbRole } from '../runtime-dbs';
import {
  decodeCheckpointSnapshot,
  type CheckpointRestoreOptions,
} from './checkpoint';
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

  const restoreEnvFromCheckpointSnapshot = async (
    snapshot: Record<string, unknown>,
    options: CheckpointRestoreOptions = {},
  ): Promise<RuntimeReplica> => {
    const { env, gossipProfiles } = await decodeCheckpointSnapshot(
      { createEmptyEnv },
      snapshot,
      options,
    );
    if (!options.readOnly) {
      await rehydrateRestoredRuntimeInfra(env, {
        isBrowser: runtimeIsBrowser,
        loadGossipProfiles: target => loadGossipProfilesFromInfraDb(target, infraGossipDbAccess),
        assertPersistedContractConfigReady,
        assertBrowserVMJurisdiction,
      });
    }
    registerCommittedSingleSignerWallets(env);
    for (const profile of gossipProfiles) env.gossip?.announce?.(profile);
    return env;
  };

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
