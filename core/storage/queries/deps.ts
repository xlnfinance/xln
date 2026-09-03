import type { Level } from 'level';

import type { RuntimeRecoveryBundleV1 } from '../recovery/bundle/types';
import type { PersistedFrameJournal, RuntimeFrame, RuntimeFramePayloads } from '../types';
import type { StorageDbRole } from '../runtime-dbs';
import type { RuntimeReplica } from '../../runtime/types';
import type { RecoveryReplayOptions } from '../recovery/journal';

type RuntimeDb = Level<Buffer, Buffer>;

export type PersistenceQueryDeps = {
  tryOpenStorageDb(env: RuntimeReplica, role: StorageDbRole): Promise<boolean>;
  getStorageDb(env: RuntimeReplica, role: StorageDbRole): RuntimeDb;
  tryOpenRuntimeWalDb(env: RuntimeReplica): Promise<boolean>;
  getRuntimeWalDb(env: RuntimeReplica): RuntimeDb;
  resolvePersistedLatestHeight(env: RuntimeReplica): Promise<number>;
  resolvePersistedCheckpointHeights(env: RuntimeReplica): Promise<number[]>;
  readPersistedStorageFrameRecord(env: RuntimeReplica, height: number): Promise<RuntimeFrame | null>;
  readPersistedStorageFramePayloads(
    env: RuntimeReplica,
    frame: RuntimeFrame,
    options?: { includeRuntimeMachine?: boolean },
  ): Promise<RuntimeFramePayloads>;
  loadEnvFromStorageByReplay(
    runtimeId?: string | null,
    runtimeSeed?: string | null,
    targetHeightOverride?: number,
    options?: {
      prunedTargetReturnsNull?: boolean;
      borrowRuntimeWalFrom?: RuntimeReplica;
      readOnly?: boolean;
    },
  ): Promise<{ env: RuntimeReplica } | null>;
  replayRecoveryFrameJournals(
    env: RuntimeReplica,
    frames: PersistedFrameJournal[],
    options?: RecoveryReplayOptions,
  ): Promise<void>;
  closeRuntimeDb(env: RuntimeReplica): Promise<void>;
  closeInfraDb(env: RuntimeReplica): Promise<void>;
  restoreEnvFromRecoveryBundles(
    bundles: RuntimeRecoveryBundleV1[],
    options: {
      runtimeSeed: string;
      runtimeId: string;
      targetHeight: number;
      readOnly: true;
    },
  ): Promise<RuntimeReplica>;
  withStorageConsistentRead<T>(env: RuntimeReplica, operation: () => Promise<T>): Promise<T>;
};
