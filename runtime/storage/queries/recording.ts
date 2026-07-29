import {
  buildRuntimeRecoveryBundle,
  buildRuntimeRecoveryCheckpointBundle,
} from '../../recovery/bundle';
import {
  buildRuntimeRecording,
  validateRuntimeRecording,
} from '../../recovery/recording';
import { buildRuntimeCheckpointSnapshot } from '../wal/snapshot';
import type {
  RuntimeRecording,
  RuntimeRecoveryMetaV1,
  RuntimeRecoverySignerV1,
} from '../../recovery/types';
import type { RuntimeState } from '../../runtime/types';
import type { PersistenceQueryDeps } from './deps';
import type { createPersistenceEntityQueries } from './entity';
import type { createPersistenceHistoryQueries } from './history';

type EntityQueries = ReturnType<typeof createPersistenceEntityQueries>;
type HistoryQueries = ReturnType<typeof createPersistenceHistoryQueries>;

export type DetachedRuntimeRecordingAdapter = {
  readonly runtimeId: string;
  readonly baseHeight: number;
  readonly targetHeight: number;
  readAtHeight(height: number): Promise<RuntimeState>;
  close(): Promise<void>;
};

const MAX_RUNTIME_RECORDING_JOURNAL_FRAMES = 10_000;

export const createPersistenceRecordingQueries = (
  deps: PersistenceQueryDeps,
  entityQueries: EntityQueries,
  historyQueries: HistoryQueries,
) => {
  const readPersistedCheckpointSnapshot = async (
    env: RuntimeState,
    height: number,
  ): Promise<Record<string, unknown> | null> => {
    const targetHeight = Number.isFinite(height) ? Math.floor(height) : 0;
    if (targetHeight <= 0) return null;
    return deps.withStorageConsistentRead(env, async () => {
      const restored = await deps.loadEnvFromStorageByReplay(
        env.runtimeId,
        env.runtimeSeed,
        targetHeight,
        { prunedTargetReturnsNull: true },
      );
      if (!restored || restored.env.height !== targetHeight) {
        if (restored?.env) await deps.closeRuntimeDb(restored.env);
        return null;
      }
      try {
        return buildRuntimeCheckpointSnapshot(restored.env);
      } finally {
        await deps.closeRuntimeDb(restored.env);
      }
    });
  };

  const buildPersistedRuntimeRecording = async (
    env: RuntimeState,
    options: {
      signers: RuntimeRecoverySignerV1[];
      meta?: RuntimeRecoveryMetaV1;
      createdAt?: number;
    },
  ): Promise<RuntimeRecording> => {
    const createdAt = Math.max(0, Math.floor(Number(options.createdAt ?? Date.now())));
    const latestHeight = await entityQueries.getPersistedLatestHeight(env);
    if (latestHeight !== env.height) {
      throw new Error(
        `RUNTIME_RECORDING_LIVE_HEAD_MISMATCH:persisted=${latestHeight}:env=${env.height}`,
      );
    }
    if (latestHeight <= 0) {
      return buildRuntimeRecording([
        buildRuntimeRecoveryBundle(env, { ...options, createdAt, kind: 'snapshot' }),
      ], createdAt);
    }

    const minimumBaseHeight = Math.max(1, latestHeight - MAX_RUNTIME_RECORDING_JOURNAL_FRAMES);
    const checkpointHeights = (await entityQueries.listPersistedCheckpointHeights(env))
      .filter(height => height >= minimumBaseHeight && height <= latestHeight)
      .sort((left, right) => left - right);
    let baseHeight = latestHeight;
    let checkpoint: Record<string, unknown> | null = null;
    for (const candidateHeight of checkpointHeights) {
      const candidate = await readPersistedCheckpointSnapshot(env, candidateHeight);
      if (!candidate) continue;
      baseHeight = candidateHeight;
      checkpoint = candidate;
      break;
    }
    if (!checkpoint) {
      return buildRuntimeRecording([
        buildRuntimeRecoveryBundle(env, { ...options, createdAt, kind: 'snapshot' }),
      ], createdAt);
    }
    const snapshotBundle = buildRuntimeRecoveryCheckpointBundle(env, {
      ...options,
      checkpoint,
      createdAt,
    });
    if (baseHeight === latestHeight) return buildRuntimeRecording([snapshotBundle], createdAt);

    const expectedFrameCount = latestHeight - baseHeight;
    const frames = await historyQueries.readPersistedFrameJournals(env, {
      fromHeight: baseHeight + 1,
      toHeight: latestHeight,
      limit: expectedFrameCount,
    });
    if (
      frames.length !== expectedFrameCount
      || frames[0]?.height !== baseHeight + 1
      || frames.at(-1)?.height !== latestHeight
    ) {
      throw new Error(
        `RUNTIME_RECORDING_JOURNAL_INCOMPLETE:base=${baseHeight}:target=${latestHeight}:` +
        `expected=${expectedFrameCount}:actual=${frames.length}`,
      );
    }
    const tailBundle = buildRuntimeRecoveryBundle(env, {
      ...options,
      createdAt,
      kind: 'journal_tail',
      baseCheckpoint: {
        height: baseHeight,
        hash: snapshotBundle.checkpointHash!,
      },
      frames,
    });
    return buildRuntimeRecording([snapshotBundle, tailBundle], createdAt);
  };

  const openDetachedRuntimeRecording = (
    recording: RuntimeRecording,
    runtimeSeed: string,
  ): DetachedRuntimeRecordingAdapter => {
    const validated = validateRuntimeRecording(recording);
    let closed = false;
    let activeProjection: RuntimeState | null = null;
    return {
      runtimeId: validated.runtimeId,
      baseHeight: validated.baseHeight,
      targetHeight: validated.targetHeight,
      async readAtHeight(height: number): Promise<RuntimeState> {
        if (closed) throw new Error('RUNTIME_RECORDING_ADAPTER_CLOSED');
        if (!Number.isSafeInteger(height) || height < validated.baseHeight || height > validated.targetHeight) {
          throw new Error(
            `RUNTIME_RECORDING_HEIGHT_UNAVAILABLE:height=${height}:` +
            `range=${validated.baseHeight}-${validated.targetHeight}`,
          );
        }
        activeProjection = await deps.restoreEnvFromRecoveryBundles(validated.bundles, {
          runtimeSeed,
          runtimeId: validated.runtimeId,
          targetHeight: height,
          readOnly: true,
        });
        return activeProjection;
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        activeProjection = null;
      },
    };
  };

  return {
    readPersistedCheckpointSnapshot,
    buildPersistedRuntimeRecording,
    openDetachedRuntimeRecording,
  };
};
