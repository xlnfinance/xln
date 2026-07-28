import type { Level } from 'level';

import type { RuntimeRecoveryBundleV1 } from '../../recovery/types';
import type { StorageFrameRecord } from '..';
import type { StorageDbRole } from '../runtime-dbs';
import type { RuntimeState } from '../../types';

type RuntimeDb = Level<Buffer, Buffer>;

export type PersistenceQueryDeps = {
  tryOpenStorageDb(env: RuntimeState, role: StorageDbRole): Promise<boolean>;
  getStorageDb(env: RuntimeState, role: StorageDbRole): RuntimeDb;
  tryOpenRuntimeWalDb(env: RuntimeState): Promise<boolean>;
  getRuntimeWalDb(env: RuntimeState): RuntimeDb;
  tryOpenHistoryViewDb(env: RuntimeState): Promise<boolean>;
  getHistoryViewDb(env: RuntimeState): RuntimeDb;
  resolvePersistedLatestHeight(env: RuntimeState): Promise<number>;
  resolvePersistedCheckpointHeights(env: RuntimeState): Promise<number[]>;
  readPersistedStorageFrameRecord(env: RuntimeState, height: number): Promise<StorageFrameRecord | null>;
  loadEnvFromStorageByReplay(
    runtimeId?: string | null,
    runtimeSeed?: string | null,
    targetHeightOverride?: number,
    options?: { prunedTargetReturnsNull?: boolean },
  ): Promise<{ env: RuntimeState } | null>;
  closeRuntimeDb(env: RuntimeState): Promise<void>;
  restoreEnvFromRecoveryBundles(
    bundles: RuntimeRecoveryBundleV1[],
    options: {
      runtimeSeed: string;
      runtimeId: string;
      targetHeight: number;
      readOnly: true;
    },
  ): Promise<RuntimeState>;
  withStorageConsistentRead<T>(env: RuntimeState, operation: () => Promise<T>): Promise<T>;
};
