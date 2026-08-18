import type { Level } from 'level';

import type { RuntimeRecoveryBundleV1 } from '../recovery/bundle/types';
import type { RuntimeFrame, RuntimeFramePayloads } from '../types';
import type { StorageDbRole } from '../runtime-dbs';
import type { RuntimeReplica } from '../../runtime/types';

type RuntimeDb = Level<Buffer, Buffer>;

export type PersistenceQueryDeps = {
  tryOpenStorageDb(env: RuntimeReplica, role: StorageDbRole): Promise<boolean>;
  getStorageDb(env: RuntimeReplica, role: StorageDbRole): RuntimeDb;
  tryOpenRuntimeWalDb(env: RuntimeReplica): Promise<boolean>;
  getRuntimeWalDb(env: RuntimeReplica): RuntimeDb;
  tryOpenHistoryViewDb(env: RuntimeReplica): Promise<boolean>;
  getHistoryViewDb(env: RuntimeReplica): RuntimeDb;
  resolvePersistedLatestHeight(env: RuntimeReplica): Promise<number>;
  resolvePersistedCheckpointHeights(env: RuntimeReplica): Promise<number[]>;
  readPersistedStorageFrameRecord(env: RuntimeReplica, height: number): Promise<RuntimeFrame | null>;
  readPersistedStorageFramePayloads(
    env: RuntimeReplica,
    frame: RuntimeFrame,
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
  closeRuntimeDb(env: RuntimeReplica): Promise<void>;
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
