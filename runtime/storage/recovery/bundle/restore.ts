import { markRestoredReliableOutputsDue } from '../../../runtime/output-routing';
import type { RuntimeReplica } from '../../../runtime/types';
import type { CheckpointRestoreOptions } from '../checkpoint';
import type { PersistedFrameJournal } from '../../types';
import { assertRuntimeRecoveryBundleAuthenticity } from './index';
import type { RuntimeRecoveryBundleV1 } from './types';
import { authorizeRestoredRuntimeInput } from '../../wal/snapshot';

export interface RuntimeBundleRestoreOptions extends CheckpointRestoreOptions {
  targetHeight?: number;
}

export interface RuntimeBundleRestoreDeps {
  restoreCheckpoint(snapshot: Record<string, unknown>, options: CheckpointRestoreOptions): Promise<RuntimeReplica>;
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
  readOnly: boolean,
): Promise<void> => {
  if (!candidate.tail || candidate.height <= candidate.snapshot.runtimeHeight) return;
  try {
    await deps.replayJournals(
      env,
      (candidate.tail.frames || []).filter(frame => frame.height <= candidate.height),
    );
  } catch (error) {
    if (readOnly) throw error;
    await deps.failAfterCleanup(env, error);
  }
};

// Bundle signatures establish provenance; the checkpoint hash and journal chain then
// establish one deterministic state at the requested height. Never "best effort"
// partial replay: a mismatch closes the opened databases and aborts the import.
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
  const env = await deps.restoreCheckpoint(candidate.snapshot.checkpoint!, options);
  env.runtimeMempool = authorizeRestoredRuntimeInput(env.runtimeMempool);
  await replayCandidateTail(deps, env, candidate, Boolean(options.readOnly));
  if (env.state.height !== candidate.height) {
    const mismatch = new Error(
      `RECOVERY_BUNDLE_TARGET_HEIGHT_MISMATCH:expected=${candidate.height}:actual=${env.state.height}`,
    );
    if (options.readOnly) throw mismatch;
    await deps.failAfterCleanup(env, mismatch);
  }
  if (!options.readOnly) markRestoredReliableOutputsDue(env);
  return env;
};
