import type { Level } from 'level';

import type { RuntimeReplica } from '../runtime/types';
import type { PersistedFrameJournal } from './types';
import type { StorageDbRole } from './runtime-dbs';
import type { RscoreExactCheckpoint } from '../rscore/checkpoint/checkpoint-wire';

type RuntimeModule = typeof import('../runtime');

/**
 * Physical database ownership injected into Runtime storage.
 *
 * Keeping these handles explicit prevents restore/commit code from reaching
 * into process globals or silently opening a second writer.
 */
export type RuntimeStorageApiDeps =
  Pick<RuntimeModule, 'closeRuntimeDb' | 'closeInfraDb' | 'createEmptyEnv'> & {
    ensureRuntimeInfrastructure(
      env: RuntimeReplica,
    ): NonNullable<RuntimeReplica['infrastructure']>;
    getStorageDb(env: RuntimeReplica, role?: StorageDbRole): Level<Buffer, Buffer>;
    getRuntimeWalDb(env: RuntimeReplica): Level<Buffer, Buffer>;
    tryOpenStorageDb(env: RuntimeReplica, role?: StorageDbRole): Promise<boolean>;
    rotateStorageEpochDb(
      env: RuntimeReplica,
      snapshotHeight: number,
      timestamp?: number,
    ): Promise<boolean>;
    tryOpenRuntimeWalDb(env: RuntimeReplica): Promise<boolean>;
    waitForPromiseBeforeTimeout<T>(
      promise: Promise<T>,
      timeoutMs: number,
    ): Promise<boolean>;
    replayRecoveryFrameJournals(
      env: RuntimeReplica,
      frames: PersistedFrameJournal[],
    ): Promise<void>;
    restoreAccountAuthorityExact(
      env: RuntimeReplica,
      checkpoints: readonly RscoreExactCheckpoint[],
    ): Promise<void>;
    discardAccountAuthority(env: RuntimeReplica): Promise<void>;
    setAccountAuthoritySuppressed(env: RuntimeReplica, suppressed: boolean): void;
    accountAuthorityConfigured(): boolean;
  };
