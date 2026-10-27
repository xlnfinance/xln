import type { FrameLogEntry } from '../../types/logging';
import type { RuntimeReplica } from '../../runtime/types';
import type { PersistedFrameJournal, RuntimeFrame, RuntimeFramePayloads } from '../types';
import type { PersistenceQueryDeps } from '../queries/deps';
import { type RuntimeActivityViewAccess, withRuntimeActivityRepairFlight } from './runtime-activity-view';

type BuildJournal = (
  frame: RuntimeFrame,
  payloads: RuntimeFramePayloads,
  logs?: FrameLogEntry[],
) => PersistedFrameJournal;

const latestReplayableCheckpoint = async (
  deps: PersistenceQueryDeps,
  env: RuntimeReplica,
  latestHeight: number,
): Promise<number> => {
  const checkpoints = await deps.resolvePersistedCheckpointHeights(env);
  return checkpoints.reduce((latest, height) => (height > latest && height < latestHeight ? height : latest), 0);
};

const openPredecessor = (
  deps: PersistenceQueryDeps,
  env: RuntimeReplica,
  height: number,
): Promise<{ env: RuntimeReplica } | null> =>
  deps.loadEnvFromStorageByReplay(env.runtimeId, env.runtimeSeed, height, {
    prunedTargetReturnsNull: true,
    borrowRuntimeWalFrom: env,
    readOnly: true,
  });

const chooseReplayBase = async (
  view: RuntimeActivityViewAccess,
  deps: PersistenceQueryDeps,
  env: RuntimeReplica,
  latestHeight: number,
): Promise<Readonly<{ height: number; restored: { env: RuntimeReplica } | null }>> => {
  const status = await view.readStatus();
  if (status && status.latestHeight <= latestHeight) {
    const restored = status.latestHeight > 0 ? await openPredecessor(deps, env, status.latestHeight) : null;
    if (restored) return { height: status.latestHeight, restored };
  }
  const checkpoint = await latestReplayableCheckpoint(deps, env, latestHeight);
  await view.resetAtFloor(checkpoint || latestHeight);
  if (checkpoint === 0) return { height: latestHeight, restored: null };
  const restored = await openPredecessor(deps, env, checkpoint);
  if (!restored) {
    await view.resetAtFloor(latestHeight);
    return { height: latestHeight, restored: null };
  }
  return { height: checkpoint, restored };
};

const activityTipMatchesWal = async (
  view: RuntimeActivityViewAccess,
  deps: PersistenceQueryDeps,
  env: RuntimeReplica,
  latestHeight: number,
): Promise<boolean> => {
  const status = await view.readStatus();
  if (!status || status.latestHeight !== latestHeight) return false;
  if (latestHeight <= status.unavailableThroughHeight) return true;
  const [activity, frame] = await Promise.all([
    view.readFrame(latestHeight),
    deps.readPersistedStorageFrameRecord(env, latestHeight),
  ]);
  return Boolean(activity && frame?.frameHash === activity.marker.frameHash);
};

const resetInconsistentTip = async (
  view: RuntimeActivityViewAccess,
  deps: PersistenceQueryDeps,
  env: RuntimeReplica,
  latestHeight: number,
): Promise<void> => {
  const checkpoint = await latestReplayableCheckpoint(deps, env, latestHeight);
  await view.resetAtFloor(checkpoint || latestHeight);
};

const replayActivityTail = async (
  view: RuntimeActivityViewAccess,
  deps: PersistenceQueryDeps,
  source: RuntimeReplica,
  replay: RuntimeReplica,
  fromHeight: number,
  toHeight: number,
  buildJournal: BuildJournal,
): Promise<void> => {
  for (let height = fromHeight; height <= toHeight; height += 1) {
    const frame = await deps.readPersistedStorageFrameRecord(source, height);
    if (!frame) throw new Error(`RUNTIME_ACTIVITY_REPAIR_FRAME_MISSING:${height}`);
    const payloads = await deps.readPersistedStorageFramePayloads(source, frame);
    await deps.replayRecoveryFrameJournals(replay, [buildJournal(frame, payloads)], {
      verify: true,
      onVerifiedFrame: async (_journal, events) => {
        const result = await view.appendFrame(frame, events);
        if (result === 'gap') throw new Error(`RUNTIME_ACTIVITY_REPAIR_GAP:${height}`);
      },
    });
  }
};

const repairRuntimeActivityView = async (
  view: RuntimeActivityViewAccess,
  deps: PersistenceQueryDeps,
  env: RuntimeReplica,
  buildJournal: BuildJournal,
): Promise<void> => {
  const latestHeight = await deps.resolvePersistedLatestHeight(env);
  const status = await view.readStatus();
  if (latestHeight <= 0) return;
  if (status?.latestHeight === latestHeight && (await activityTipMatchesWal(view, deps, env, latestHeight))) {
    if (env.infrastructure) delete env.infrastructure.runtimeActivityViewFailure;
    return;
  }
  if (status && status.latestHeight >= latestHeight) {
    await resetInconsistentTip(view, deps, env, latestHeight);
  }
  const base = await chooseReplayBase(view, deps, env, latestHeight);
  if (!base.restored || base.height >= latestHeight) return;
  try {
    await replayActivityTail(view, deps, env, base.restored.env, base.height + 1, latestHeight, buildJournal);
  } finally {
    await deps.closeRuntimeDb(base.restored.env);
    await deps.closeInfraDb(base.restored.env);
  }
  const repaired = await view.readStatus();
  if (repaired?.latestHeight === latestHeight && env.infrastructure) {
    delete env.infrastructure.runtimeActivityViewFailure;
  }
};

export const ensureRuntimeActivityView = (
  deps: PersistenceQueryDeps,
  env: RuntimeReplica,
  buildJournal: BuildJournal,
): Promise<void> =>
  withRuntimeActivityRepairFlight(env, view => repairRuntimeActivityView(view, deps, env, buildJournal));
