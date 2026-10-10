import type { RuntimeReplica } from '../../../runtime/types';
import type { CheckpointRestoreOptions, DecodedCheckpointSnapshot } from '../checkpoint';
import type { Profile } from '../../../entity/profile';
import type { PersistedFrameJournal } from '../../types';
import { assertRuntimeRecoveryBundleAuthenticity } from './index';
import type { RuntimeRecoveryBundleV1 } from './types';
import { restoreRecoveryCheckpointOutbox } from './checkpoint-frame';

export interface RuntimeBundleRestoreOptions extends CheckpointRestoreOptions {
  targetHeight?: number;
}

export interface RuntimeBundleRestoreDeps {
  /** In-memory decode only: no database, adapter or announcement. */
  restoreCheckpoint(snapshot: Record<string, unknown>, options: CheckpointRestoreOptions): Promise<DecodedCheckpointSnapshot>;
  activateRestoredRuntime(env: RuntimeReplica, gossipProfiles: readonly Profile[]): Promise<void>;
  replayJournals(env: RuntimeReplica, frames: PersistedFrameJournal[]): Promise<void>;
  failAfterCleanup(env: RuntimeReplica, error: unknown): Promise<never>;
}

interface RecoveryCandidate {
  snapshot: RuntimeRecoveryBundleV1;
  tail?: RuntimeRecoveryBundleV1;
  height: number;
}

const selectRecoveryCandidate = (bundles: RuntimeRecoveryBundleV1[], targetHeight?: number): RecoveryCandidate => {
  const snapshots = bundles.filter(bundle => (bundle.kind ?? 'snapshot') === 'snapshot');
  if (snapshots.length === 0) throw new Error('RECOVERY_BUNDLE_SNAPSHOT_REQUIRED');
  if (targetHeight !== undefined && (!Number.isSafeInteger(targetHeight) || targetHeight < 0)) {
    throw new Error(`RECOVERY_BUNDLE_TARGET_HEIGHT_INVALID:${String(targetHeight)}`);
  }

  const candidates = snapshots
    .flatMap(snapshot => {
      if (targetHeight !== undefined && snapshot.runtimeHeight > targetHeight) return [];
      const snapshotHash = String(snapshot.checkpointHash || '').toLowerCase();
      const tail = bundles
        .filter(
          bundle =>
            bundle.kind === 'journal_tail' &&
            bundle.baseRuntimeHeight === snapshot.runtimeHeight &&
            String(bundle.baseCheckpointHash || '').toLowerCase() === snapshotHash &&
            bundle.runtimeHeight > snapshot.runtimeHeight,
        )
        .filter(bundle => targetHeight === undefined || bundle.runtimeHeight >= targetHeight)
        .sort((left, right) => right.runtimeHeight - left.runtimeHeight)[0];
      if (targetHeight !== undefined && snapshot.runtimeHeight < targetHeight && !tail) return [];
      return [
        {
          snapshot,
          ...(tail ? { tail } : {}),
          height: targetHeight ?? tail?.runtimeHeight ?? snapshot.runtimeHeight,
        },
      ];
    })
    .sort((left, right) =>
      right.height !== left.height
        ? right.height - left.height
        : right.snapshot.runtimeHeight - left.snapshot.runtimeHeight,
    );
  const candidate = candidates[0];
  if (!candidate) {
    throw new Error(`RECOVERY_BUNDLE_TARGET_HEIGHT_UNAVAILABLE:${String(targetHeight)}`);
  }
  return candidate;
};

const replayCandidateTail = async (
  deps: RuntimeBundleRestoreDeps,
  env: RuntimeReplica,
  candidate: RecoveryCandidate,
): Promise<void> => {
  if (!candidate.tail || candidate.height <= candidate.snapshot.runtimeHeight) return;
  await deps.replayJournals(
    env,
    (candidate.tail.frames || []).filter(frame => frame.height <= candidate.height),
  );
};

// Bundle signatures establish provenance; the checkpoint hash and journal chain then
// establish one deterministic state at the requested height. Never "best effort"
// partial replay: a mismatch closes the opened databases and aborts the import.
// A live restore starts infra (infra DB, J adapters, profiles) only after the
// tip outbox and the tail are verified, so a rejected bundle leaves nothing live.
export const restoreRuntimeFromBundles = async (
  deps: RuntimeBundleRestoreDeps,
  bundles: RuntimeRecoveryBundleV1[],
  options: RuntimeBundleRestoreOptions = {},
): Promise<RuntimeReplica> => {
  if (!options.runtimeSeed) throw new Error('RECOVERY_BUNDLE_TRUSTED_SEED_REQUIRED');
  const validated = bundles.map(bundle =>
    assertRuntimeRecoveryBundleAuthenticity(bundle, options.runtimeSeed!, options.runtimeId),
  );
  const candidate = selectRecoveryCandidate(validated, options.targetHeight);
  const { env, gossipProfiles } = await deps.restoreCheckpoint(candidate.snapshot.checkpoint!, options);
  try {
    restoreRecoveryCheckpointOutbox(env, candidate.snapshot);
    await replayCandidateTail(deps, env, candidate);
    if (env.state.height !== candidate.height) {
      throw new Error(
        `RECOVERY_BUNDLE_TARGET_HEIGHT_MISMATCH:expected=${candidate.height}:actual=${env.state.height}`,
      );
    }
    if (!options.readOnly) await deps.activateRestoredRuntime(env, gossipProfiles);
  } catch (error) {
    if (options.readOnly) throw error;
    await deps.failAfterCleanup(env, error);
  }
  // Both restore modes retain the verified tip outbox. A live Runtime retires
  // those exact units only after its normal transport accepts them.
  return env;
};
