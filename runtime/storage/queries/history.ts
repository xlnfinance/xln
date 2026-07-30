import {
  readHistoryViewAccountFrames,
  readHistoryViewEntityFrames,
  readHistoryViewRuntimeActivity,
  type RuntimeFrame,
} from '..';
import {
  cloneIsolatedRoutedEntityInputs,
  cloneIsolatedRuntimeInput,
  cloneIsolatedRuntimeSnapshot,
} from '../../runtime/input-clone';
import { cloneIsolatedEntityInput } from '../../entity/input-clone';
import {
  buildRuntimeActivityEvents,
  dedupeRuntimeActivityEvents,
} from '../../api/activity-history';
import type {
  PersistedActivityJournal,
  RuntimeActivityEvent,
  RuntimeActivityFilters,
} from '../views/activity-types';
import type { AccountFrame } from '../../types/account';
import type { CertifiedEntityFrameLink, EntityInput } from '../../entity/types';
import type { RuntimeReplica } from '../../runtime/types';
import type { FrameLogEntry } from '../../types/logging';
import type { PersistedFrameJournal } from '../types';
import type { PersistenceQueryDeps } from './deps';
import { requireStorageDbOpen } from '../availability';

export const buildRecoveryJournalFromStorageFrame = (
  frame: RuntimeFrame,
  logs: FrameLogEntry[] = [],
): PersistedFrameJournal => ({
  height: frame.height,
  timestamp: frame.timestamp,
  replicaMetaDigest: frame.replicaMetaDigest,
  postStateHash: frame.postStateHash,
  replicaMetaCheckpoint: frame.replicaMetaCheckpoint,
  replicaMetaStateMode: frame.replicaMetaStateMode,
  runtimeInput: frame.runtimeInput,
  ...(frame.pendingRuntimeInput
    ? { pendingRuntimeInput: cloneIsolatedRuntimeInput(frame.pendingRuntimeInput) }
    : {}),
  ...(frame.runtimeOutputs?.length
    ? { runtimeOutputs: cloneIsolatedRoutedEntityInputs(frame.runtimeOutputs) }
    : {}),
  ...(frame.runtimeOutputRetryState?.length
    ? { runtimeOutputRetryState: structuredClone(frame.runtimeOutputRetryState) }
    : {}),
  ...(frame.runtimeMachine
    ? { runtimeMachine: cloneIsolatedRuntimeSnapshot(frame.runtimeMachine) }
    : {}),
  ...(frame.runtimeStateHash ? { runtimeStateHash: frame.runtimeStateHash } : {}),
  logs,
});

export type PersistedRuntimeActivityPage = {
  ok: true;
  runtimeId?: string | undefined;
  latestHeight: number;
  fromHeight: number;
  toHeight: number;
  scannedFrames: number;
  returned: number;
  limit: number;
  scanLimit: number;
  nextBeforeHeight: number | null;
  filters: RuntimeActivityFilters;
  events: RuntimeActivityEvent[];
};

const readRuntimeActivityJournal = async (
  deps: PersistenceQueryDeps,
  env: RuntimeReplica,
  height: number,
): Promise<(PersistedActivityJournal & { logs: FrameLogEntry[] }) | null> => {
  const targetHeight = Number.isFinite(height) ? Math.floor(height) : 0;
  if (targetHeight <= 0) {
    throw new Error(`STORAGE_ACTIVITY_JOURNAL_HEIGHT_INVALID:${String(height)}`);
  }
  await requireStorageDbOpen(
    () => deps.tryOpenHistoryViewDb(env),
    `history-view:runtime-activity:${targetHeight}`,
  );
  try {
    const activity = await readHistoryViewRuntimeActivity(deps.getHistoryViewDb(env), targetHeight);
    if (!activity) return null;
    return {
      height: targetHeight,
      timestamp: activity.timestamp,
      runtimeInput: {
        runtimeTxs: [],
        entityInputs: activity.runtimeInput.entityInputs.map(input =>
          cloneIsolatedEntityInput(input as EntityInput)),
        ...(activity.runtimeInput.jInputs
          ? { jInputs: activity.runtimeInput.jInputs.map(input => structuredClone(input)) }
          : {}),
      },
      logs: activity.logs.map((entry) => ({ ...entry })),
    };
  } catch (error) {
    throw new Error(
      `STORAGE_ACTIVITY_JOURNAL_READ_FAILED:height=${targetHeight}:` +
      `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
};

type HistoryViewReadDeps = Pick<
  PersistenceQueryDeps,
  'tryOpenHistoryViewDb' | 'getHistoryViewDb'
>;

export const readAccountFrameHistory = async (
  deps: HistoryViewReadDeps,
  env: RuntimeReplica,
  entityId: string,
  counterpartyId: string,
  limit = 50,
  opts?: { maxRuntimeHeight?: number; maxAccountHeight?: number },
): Promise<AccountFrame[]> => {
  await requireStorageDbOpen(
    () => deps.tryOpenHistoryViewDb(env),
    'history-view:account-frames',
  );
  const maxRuntimeHeight = Number.isFinite(Number(opts?.maxRuntimeHeight))
    ? Math.max(0, Math.floor(Number(opts?.maxRuntimeHeight)))
    : Number.POSITIVE_INFINITY;
  const maxAccountHeight = Number.isFinite(Number(opts?.maxAccountHeight))
    ? Math.max(0, Math.floor(Number(opts?.maxAccountHeight)))
    : Number.POSITIVE_INFINITY;
  const records = await readHistoryViewAccountFrames(
    deps.getHistoryViewDb(env),
    entityId,
    counterpartyId,
    {
      limit: Math.max(1, Math.min(1000, Math.floor(Number(limit || 50)))),
      ...(Number.isSafeInteger(maxRuntimeHeight) ? { maxRuntimeHeight } : {}),
      ...(Number.isSafeInteger(maxAccountHeight) ? { maxAccountHeight } : {}),
    },
  );
  return records.map((record) => structuredClone(record.frame));
};

export const createPersistenceHistoryQueries = (deps: PersistenceQueryDeps) => {
  const readPersistedFrameJournal = async (
    env: RuntimeReplica,
    height: number,
  ): Promise<PersistedFrameJournal | null> => {
    const frame = await deps.readPersistedStorageFrameRecord(env, height);
    if (!frame) return null;
    return buildRecoveryJournalFromStorageFrame(frame, frame.activityLogs);
  };

  const readPersistedRuntimeActivityJournal = (
    env: RuntimeReplica,
    height: number,
  ) => readRuntimeActivityJournal(deps, env, height);

  const readPersistedAccountFrameHistory = (
    env: RuntimeReplica,
    entityId: string,
    counterpartyId: string,
    limit = 50,
    opts?: { maxRuntimeHeight?: number; maxAccountHeight?: number },
  ) => readAccountFrameHistory(deps, env, entityId, counterpartyId, limit, opts);

  const readPersistedEntityFrameHistory = async (
    env: RuntimeReplica,
    entityId: string,
    limit = 50,
    opts?: { maxRuntimeHeight?: number; maxEntityHeight?: number },
  ): Promise<CertifiedEntityFrameLink[]> => {
    await requireStorageDbOpen(
      () => deps.tryOpenHistoryViewDb(env),
      'history-view:entity-frames',
    );
    const maxRuntimeHeight = Number.isFinite(Number(opts?.maxRuntimeHeight))
      ? Math.max(0, Math.floor(Number(opts?.maxRuntimeHeight)))
      : Number.POSITIVE_INFINITY;
    const maxEntityHeight = Number.isFinite(Number(opts?.maxEntityHeight))
      ? Math.max(0, Math.floor(Number(opts?.maxEntityHeight)))
      : Number.POSITIVE_INFINITY;
    const records = await readHistoryViewEntityFrames(deps.getHistoryViewDb(env), entityId, {
      limit: Math.max(1, Math.min(1000, Math.floor(Number(limit || 50)))),
      ...(Number.isSafeInteger(maxRuntimeHeight) ? { maxRuntimeHeight } : {}),
      ...(Number.isSafeInteger(maxEntityHeight) ? { maxEntityHeight } : {}),
    });
    return records.map((record) => structuredClone(record.link));
  };

  const readPersistedFrameJournals = async (
    env: RuntimeReplica,
    opts?: { fromHeight?: number; toHeight?: number; limit?: number },
  ): Promise<PersistedFrameJournal[]> => {
    const latestHeight = await deps.resolvePersistedLatestHeight(env);
    if (latestHeight <= 0) return [];
    const fromHeight = Math.max(1, Math.floor(opts?.fromHeight ?? 1));
    const toHeight = Math.min(
      latestHeight,
      Math.max(fromHeight, Math.floor(opts?.toHeight ?? latestHeight)),
    );
    const pageToHeight = Math.min(
      toHeight,
      fromHeight + Math.max(1, Math.min(10_000, Math.floor(opts?.limit ?? 200))) - 1,
    );
    const receipts: PersistedFrameJournal[] = [];
    for (let height = fromHeight; height <= pageToHeight; height += 1) {
      const receipt = await readPersistedFrameJournal(env, height);
      if (receipt) receipts.push(receipt);
    }
    return receipts;
  };

  const readPersistedRuntimeActivityPage = async (
    env: RuntimeReplica,
    opts: RuntimeActivityFilters & {
      beforeHeight?: number | undefined;
      limit?: number | undefined;
      scanLimit?: number | undefined;
    } = {},
  ): Promise<PersistedRuntimeActivityPage> => {
    const latestHeight = await deps.resolvePersistedLatestHeight(env);
    const limit = Math.max(1, Math.min(500, Math.floor(Number(opts.limit ?? 100))));
    const scanLimit = Math.max(1, Math.min(1000, Math.floor(Number(opts.scanLimit ?? 100))));
    if (latestHeight <= 0) {
      return {
        ok: true,
        runtimeId: env.runtimeId,
        latestHeight: 0,
        fromHeight: 0,
        toHeight: 0,
        scannedFrames: 0,
        returned: 0,
        limit,
        scanLimit,
        nextBeforeHeight: null,
        filters: opts,
        events: [],
      };
    }

    const startHeight = Math.max(
      1,
      Math.min(
        latestHeight,
        Number.isFinite(Number(opts.beforeHeight))
          ? Math.floor(Number(opts.beforeHeight))
          : latestHeight,
      ),
    );
    const events: RuntimeActivityEvent[] = [];
    let scannedFrames = 0;
    let height = startHeight;
    let uniqueEventCount = 0;
    for (; height >= 1 && scannedFrames < scanLimit && uniqueEventCount < limit; height -= 1) {
      const activity = await readPersistedRuntimeActivityJournal(env, height);
      scannedFrames += 1;
      if (!activity) continue;
      events.push(...buildRuntimeActivityEvents(activity, opts));
      uniqueEventCount = dedupeRuntimeActivityEvents(events).length;
    }

    const returned = dedupeRuntimeActivityEvents(events).slice(0, limit).map((event) => ({
      ...event,
      ...(env.runtimeId ? { runtimeId: env.runtimeId } : {}),
      id: env.runtimeId ? `${env.runtimeId}:${event.id}` : event.id,
    }));
    return {
      ok: true,
      runtimeId: env.runtimeId,
      latestHeight,
      fromHeight: Math.max(1, height + 1),
      toHeight: startHeight,
      scannedFrames,
      returned: returned.length,
      limit,
      scanLimit,
      nextBeforeHeight: height >= 1 ? height : null,
      filters: opts,
      events: returned,
    };
  };

  return {
    readPersistedFrameJournal,
    readPersistedRuntimeActivityJournal,
    readPersistedAccountFrameHistory,
    readPersistedEntityFrameHistory,
    readPersistedFrameJournals,
    readPersistedRuntimeActivityPage,
  };
};
