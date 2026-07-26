import type { Level } from 'level';

import type { RuntimeRecoveryBundleV1 } from '../recovery/types';
import type { StorageFrameRecord } from '../storage';
import type { StorageDbRole } from '../storage/runtime-dbs';
import type { Env } from '../types';

type RuntimeDb = Level<Buffer, Buffer>;

export type PersistenceQueryDeps = {
  tryOpenStorageDb(env: Env, role: StorageDbRole): Promise<boolean>;
  getStorageDb(env: Env, role: StorageDbRole): RuntimeDb;
  tryOpenFrameDb(env: Env): Promise<boolean>;
  getFrameDb(env: Env): RuntimeDb;
  resolvePersistedLatestHeight(env: Env): Promise<number>;
  resolvePersistedCheckpointHeights(env: Env): Promise<number[]>;
  readPersistedStorageFrameRecord(env: Env, height: number): Promise<StorageFrameRecord | null>;
  loadEnvFromStorageByReplay(
    runtimeId?: string | null,
    runtimeSeed?: string | null,
    targetHeightOverride?: number,
    options?: { prunedTargetReturnsNull?: boolean },
  ): Promise<{ env: Env } | null>;
  closeRuntimeDb(env: Env): Promise<void>;
  restoreEnvFromRecoveryBundles(
    bundles: RuntimeRecoveryBundleV1[],
    options: {
      runtimeSeed: string;
      runtimeId: string;
      targetHeight: number;
      readOnly: true;
    },
  ): Promise<Env>;
  withStorageConsistentRead<T>(env: Env, operation: () => Promise<T>): Promise<T>;
};
