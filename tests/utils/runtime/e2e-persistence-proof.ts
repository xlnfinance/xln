import type { Page } from '@playwright/test';
import type { RuntimeReplica, XLNModule } from '../../../core/api/public/runtime-module';

type RuntimeWindow = Window & {
  __xln?: { env(): RuntimeReplica | null; xln(): Promise<XLNModule> };
};

/** Configure the real checkpoint owner; never insert a checkpoint or alter accepted WAL. */
export const setCheckpointPeriod = (page: Page, frames: number) =>
  page.evaluate(async period => {
    const debug = (window as RuntimeWindow).__xln;
    const env = debug?.env();
    if (!debug || !env) throw new Error('PERSISTENCE_RUNTIME_UNAVAILABLE');
    if (!Number.isSafeInteger(period) || period < 1) throw new Error('PERSISTENCE_PERIOD_INVALID');
    const xln = await debug.xln();
    if (!(await xln.waitForRuntimeProcessingIdle(env, 5_000))) throw new Error('PERSISTENCE_DRAIN_TIMEOUT');
    const storage = { ...env.runtimeConfig.storage, snapshotPeriodFrames: period };
    env.runtimeConfig = { ...env.runtimeConfig, storage };
    return storage.snapshotPeriodFrames;
  }, frames);

export const readFinancialState = (page: Page, entityId: string, hubId: string) =>
  page.evaluate(
    async ({ entityId, hubId }) => {
      const debug = (window as RuntimeWindow).__xln;
      const env = debug?.env();
      if (!debug || !env) throw new Error('PERSISTENCE_RUNTIME_UNAVAILABLE');
      const replicas = [...env.state.eReplicas.values()].filter(replica => replica.entityId === entityId);
      const [replica] = replicas;
      if (replicas.length !== 1 || !replica) throw new Error('PERSISTENCE_ENTITY_NOT_UNIQUE');
      const account = replica.state.accounts.get(hubId);
      if (!account) throw new Error('PERSISTENCE_ACCOUNT_UNAVAILABLE');
      const delta = account.state.deltas.get(1);
      if (!delta) throw new Error('PERSISTENCE_USDC_UNAVAILABLE');
      const xln = await debug.xln();
      return {
        runtimeId: env.runtimeId,
        entityId: replica.entityId,
        signerId: replica.signerId,
        entityCount: env.state.eReplicas.size,
        // Historical Runtime frames are on disk, never an in-memory archive.
        historyPresent: Reflect.has(env, 'history'),
        out: xln.deriveDelta(delta, xln.isLeftEntity(entityId, hubId)).outCapacity.toString(),
        accountState: xln.safeStringify(account.state),
        accountRoot: account.currentFrame.accountStateRoot,
        offers: account.state.swapOffers.size,
        pending: Boolean(account.pendingFrame),
        mempool: account.mempool.length,
      };
    },
    { entityId, hubId },
  );

/** Exact historical commitments, including positional outbox digest, survive a fresh realm. */
export const readWalProof = (page: Page, checkpoint?: number, through?: number) =>
  page.evaluate(
    async ({ checkpoint, through }) => {
      const debug = (window as RuntimeWindow).__xln;
      const env = debug?.env();
      if (!debug || !env) throw new Error('PERSISTENCE_RUNTIME_UNAVAILABLE');
      const xln = await debug.xln();
      const latest = await xln.getPersistedLatestHeight(env);
      const checkpoints = await xln.listPersistedCheckpointHeights(env);
      const selected = checkpoint ?? checkpoints.at(-1);
      if (!selected) throw new Error('PERSISTENCE_CHECKPOINT_MISSING');
      const snapshot = await xln.readPersistedCheckpointSnapshot(env, selected);
      if (!snapshot) throw new Error(`PERSISTENCE_CHECKPOINT_UNREADABLE:${selected}`);
      const end = through ?? latest;
      const frames = [];
      for (let height = selected + 1; height <= end; height++) {
        const frame = await xln.readPersistedStorageFrameRecord(env, height);
        if (!frame?.frameHash) throw new Error(`PERSISTENCE_WAL_FRAME_MISSING:${height}`);
        frames.push({
          height,
          frameHash: frame.frameHash,
          postStateHash: frame.postStateHash,
          runtimeOutputCount: frame.runtimeOutputCount,
          runtimeOutputsDigest: frame.runtimeOutputsDigest,
        });
      }
      const raw: unknown = Reflect.get(env, '__replayMeta');
      let replay = null;
      if (raw !== undefined) {
        if (
          !raw ||
          typeof raw !== 'object' ||
          !('checkpointHeight' in raw) ||
          !('latestHeight' in raw) ||
          !('selectedSnapshotLabel' in raw) ||
          !('replayedFrameCount' in raw) ||
          typeof raw.checkpointHeight !== 'number' ||
          typeof raw.latestHeight !== 'number' ||
          typeof raw.selectedSnapshotLabel !== 'string' ||
          typeof raw.replayedFrameCount !== 'number'
        ) {
          throw new Error('PERSISTENCE_REPLAY_METADATA_INVALID');
        }
        replay = {
          checkpointHeight: raw.checkpointHeight,
          latestHeight: raw.latestHeight,
          label: raw.selectedSnapshotLabel,
          replayedFrames: raw.replayedFrameCount,
        };
      }
      return { latest, checkpoint: selected, checkpoints, frames, replay };
    },
    { checkpoint, through },
  );
