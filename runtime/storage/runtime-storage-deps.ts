import type { Level } from 'level';

import type { RuntimeState } from '../runtime/types';
import type { PersistedFrameJournal } from './types';
import type { StorageDbRole } from './runtime-dbs';

type RuntimeModule = typeof import('../runtime');

/**
 * Physical database ownership injected into Runtime storage.
 *
 * Keeping these handles explicit prevents restore/commit code from reaching
 * into process globals or silently opening a second writer.
 */
export type RuntimeStorageApiDeps =
  Pick<RuntimeModule, 'closeRuntimeDb' | 'closeInfraDb' | 'createEmptyEnv'> & {
    getStorageDb(env: RuntimeState, role?: StorageDbRole): Level<Buffer, Buffer>;
    getRuntimeWalDb(env: RuntimeState): Level<Buffer, Buffer>;
    getHistoryViewDb(env: RuntimeState): Level<Buffer, Buffer>;
    tryOpenStorageDb(env: RuntimeState, role?: StorageDbRole): Promise<boolean>;
    rotateStorageEpochDb(
      env: RuntimeState,
      snapshotHeight: number,
      timestamp?: number,
    ): Promise<boolean>;
    tryOpenRuntimeWalDb(env: RuntimeState): Promise<boolean>;
    tryOpenHistoryViewDb(env: RuntimeState): Promise<boolean>;
    waitForPromiseBeforeTimeout<T>(
      promise: Promise<T>,
      timeoutMs: number,
    ): Promise<boolean>;
    replayRecoveryFrameJournals(
      env: RuntimeState,
      frames: PersistedFrameJournal[],
    ): Promise<void>;
  };
