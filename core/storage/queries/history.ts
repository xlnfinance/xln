import {
  readHistoryViewAccountFrames,
  readHistoryViewAccountSwapEvents,
  readHistoryViewAccountSwapRecency,
  readHistoryViewEntityFrames,
  readHistoryViewRuntimeActivity,
} from '..';
import {
  buildRuntimeActivityEvents,
  dedupeRuntimeActivityEvents,
} from '../../api/public/activity-history';
import type {
  PersistedActivityJournal,
  RuntimeActivityEvent,
  RuntimeActivityFilters,
} from '../views/activity-types';
import type { AccountFrame , AccountTx } from '../../types/account';
import type { CertifiedEntityFrameLink } from '../../entity/types';
import type { RuntimeReplica } from '../../runtime/types';
import { findAccountByCounterparty } from '../../account/state/account-lookup';
import { getEntityReplicaById } from '../../entity/replica/replica-lookup';
import type { FrameLogEntry } from '../../types/logging';
import type {
  PersistedFrameJournal,
  RuntimeFrame,
  RuntimeFramePayloads,
} from '../types';
import type { PersistenceQueryDeps } from './deps';
import { requireStorageDbOpen } from '../commit/availability';

export const buildRecoveryJournalFromStorageFrame = (
  frame: RuntimeFrame,
  payloads: RuntimeFramePayloads,
  logs: FrameLogEntry[] = [],
): PersistedFrameJournal => ({
  height: frame.height,
  timestamp: frame.timestamp,
  replicaMetaDigest: frame.replicaMetaDigest,
  postStateHash: frame.postStateHash,
  materializedState: frame.materializedState,
  runtimeInput: frame.runtimeInput,
  runtimeOutputCount: frame.runtimeOutputCount,
  runtimeOutputsDigest: frame.runtimeOutputsDigest,
  entityContexts: structuredClone(payloads.entityContexts),
  ...(frame.pendingRuntimeInput
    ? { pendingRuntimeInput: frame.pendingRuntimeInput }
    : {}),
  ...(payloads.runtimeOutputs?.length
    ? { runtimeOutputs: payloads.runtimeOutputs }
    : {}),
  ...(payloads.runtimeMachine
    ? { runtimeMachine: payloads.runtimeMachine }
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
    const frame = await deps.readPersistedStorageFrameRecord(env, targetHeight);
    if (!frame) throw new Error(`STORAGE_ACTIVITY_RUNTIME_FRAME_MISSING:height=${targetHeight}`);
    return {
      height: targetHeight,
      timestamp: activity.timestamp,
      runtimeInput: frame.runtimeInput,
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

const readRuntimeActivityRecord = async (
  deps: PersistenceQueryDeps,
  env: RuntimeReplica,
  height: number,
) => {
  const targetHeight = Number.isFinite(height) ? Math.floor(height) : 0;
  if (targetHeight <= 0) throw new Error(`STORAGE_ACTIVITY_RECORD_HEIGHT_INVALID:${String(height)}`);
  await requireStorageDbOpen(
    () => deps.tryOpenHistoryViewDb(env),
    `history-view:runtime-activity-record:${targetHeight}`,
  );
  const activity = await readHistoryViewRuntimeActivity(deps.getHistoryViewDb(env), targetHeight);
  return activity ? structuredClone(activity) : null;
};

type CertifiedHistoryReadDeps = Pick<
  PersistenceQueryDeps,
  'tryOpenRuntimeWalDb' | 'getRuntimeWalDb'
>;

/**
 * Rebuildable Account order lifecycle read-model. This value is derived only
 * from certified Account frames in the history LevelDB; it is never retained
 * by AccountState, AccountReplica, EntityState, or RuntimeReplica.
 */
export type PersistedAccountSwapHistoryPage = Readonly<{
  entityId: string;
  accountId: string;
  latestHeight: number;
  items: readonly PersistedAccountSwapLifecycle[];
  nextCursor: Readonly<{ height: number; offerId: string }> | null;
}>;

type PersistedAccountSwapLifecycle = Readonly<{
  offerId: string;
  giveTokenId: number;
  wantTokenId: number;
  originalGiveAmount: bigint;
  originalWantAmount: bigint;
  liveGiveAmount: bigint | null;
  liveWantAmount: bigint | null;
  priceTicks: bigint;
  createdHeight: number;
  lastUpdatedHeight: number;
  cancelRequested: boolean;
  closed: boolean;
  resolves: readonly PersistedAccountSwapResolve[];
}>;

type PersistedAccountSwapResolve = Readonly<{
  fillRatio: number;
  fillNumerator: bigint | null;
  fillDenominator: bigint | null;
  cancelRemainder: boolean;
  height: number;
  executionGiveAmount: bigint | null;
  executionWantAmount: bigint | null;
  feeTokenId: number | null;
  feeAmount: bigint | null;
  comment: string;
}>;

type SwapHistoryTx = Extract<AccountTx, {
  type: 'swap_offer' | 'swap_cancel_request' | 'swap_resolve' | 'cross_swap_fill_ack';
}>;

type MutableSwapLifecycle = {
  offerId: string;
  giveTokenId: number;
  wantTokenId: number;
  originalGiveAmount: bigint;
  originalWantAmount: bigint;
  priceTicks: bigint;
  createdHeight: number;
  lastUpdatedHeight: number;
  cancelRequested: boolean;
  resolves: PersistedAccountSwapResolve[];
};

const requireSwapLifecycle = (
  lifecycles: Map<string, MutableSwapLifecycle>,
  offerId: string,
  height: number,
): MutableSwapLifecycle => {
  const lifecycle = lifecycles.get(offerId);
  if (!lifecycle) {
    throw new Error(`ACCOUNT_SWAP_HISTORY_ORIGIN_MISSING:offer=${offerId}:height=${height}`);
  }
  return lifecycle;
};

const appendSwapHistoryTx = (
  lifecycles: Map<string, MutableSwapLifecycle>,
  tx: SwapHistoryTx,
  height: number,
): void => {
  if (tx.type === 'swap_offer') {
    if (lifecycles.has(tx.data.offerId)) {
      throw new Error(`ACCOUNT_SWAP_HISTORY_DUPLICATE_OFFER:${tx.data.offerId}:${height}`);
    }
    if (tx.data.priceTicks === undefined) {
      throw new Error(`ACCOUNT_SWAP_HISTORY_PRICE_TICKS_MISSING:${tx.data.offerId}:${height}`);
    }
    lifecycles.set(tx.data.offerId, {
      offerId: tx.data.offerId,
      giveTokenId: tx.data.giveTokenId,
      wantTokenId: tx.data.wantTokenId,
      originalGiveAmount: tx.data.giveAmount,
      originalWantAmount: tx.data.wantAmount,
      priceTicks: tx.data.priceTicks,
      createdHeight: height,
      lastUpdatedHeight: height,
      cancelRequested: false,
      resolves: [],
    });
    return;
  }

  const lifecycle = requireSwapLifecycle(lifecycles, tx.data.offerId, height);
  lifecycle.lastUpdatedHeight = height;
  if (tx.type === 'swap_cancel_request') {
    lifecycle.cancelRequested = true;
    return;
  }
  if (tx.type === 'swap_resolve') {
    lifecycle.priceTicks = tx.data.restingPriceTicks ?? lifecycle.priceTicks;
    lifecycle.resolves.push({
      fillRatio: tx.data.fillRatio,
      fillNumerator: tx.data.fillNumerator ?? null,
      fillDenominator: tx.data.fillDenominator ?? null,
      cancelRemainder: tx.data.cancelRemainder,
      height,
      executionGiveAmount: tx.data.executionGiveAmount ?? null,
      executionWantAmount: tx.data.executionWantAmount ?? null,
      feeTokenId: tx.data.feeTokenId ?? null,
      feeAmount: tx.data.feeAmount ?? null,
      comment: tx.data.comment ?? '',
    });
    return;
  }
  lifecycle.priceTicks = tx.data.priceTicks ?? lifecycle.priceTicks;
  lifecycle.resolves.push({
    fillRatio: tx.data.cumulativeFillRatio,
    fillNumerator: tx.data.fillNumerator ?? null,
    fillDenominator: tx.data.fillDenominator ?? null,
    cancelRemainder: tx.data.cancelRemainder ?? tx.data.ackKind === 'cancel',
    height,
    executionGiveAmount: tx.data.executionSourceAmount ?? null,
    executionWantAmount: tx.data.executionTargetAmount ?? null,
    feeTokenId: null,
    feeAmount: null,
    comment: tx.data.comment ?? '',
  });
};

const cursorAfter = (
  lifecycle: MutableSwapLifecycle,
  cursor: Readonly<{ height: number; offerId: string }> | undefined,
): boolean => {
  if (!cursor) return true;
  return lifecycle.lastUpdatedHeight < cursor.height
    || (lifecycle.lastUpdatedHeight === cursor.height && lifecycle.offerId < cursor.offerId);
};

const readAccountFrameHistoryRecords = async (
  deps: CertifiedHistoryReadDeps,
  env: RuntimeReplica,
  entityId: string,
  counterpartyId: string,
  limit = 50,
  opts?: { maxRuntimeHeight?: number; maxAccountHeight?: number },
) => {
  await requireStorageDbOpen(
    () => deps.tryOpenRuntimeWalDb(env),
    'runtime-wal:certified-account-frames',
  );
  const maxRuntimeHeight = Number.isFinite(Number(opts?.maxRuntimeHeight))
    ? Math.max(0, Math.floor(Number(opts?.maxRuntimeHeight)))
    : Number.POSITIVE_INFINITY;
  const maxAccountHeight = Number.isFinite(Number(opts?.maxAccountHeight))
    ? Math.max(0, Math.floor(Number(opts?.maxAccountHeight)))
    : Number.POSITIVE_INFINITY;
  const records = await readHistoryViewAccountFrames(
    deps.getRuntimeWalDb(env),
    entityId,
    counterpartyId,
    {
      limit: Math.max(1, Math.min(1000, Math.floor(Number(limit || 50)))),
      ...(Number.isSafeInteger(maxRuntimeHeight) ? { maxRuntimeHeight } : {}),
      ...(Number.isSafeInteger(maxAccountHeight) ? { maxAccountHeight } : {}),
    },
  );
  return records.map(record => structuredClone(record));
};

export const readAccountFrameHistory = async (
  deps: CertifiedHistoryReadDeps,
  env: RuntimeReplica,
  entityId: string,
  counterpartyId: string,
  limit = 50,
  opts?: { maxRuntimeHeight?: number; maxAccountHeight?: number },
): Promise<AccountFrame[]> => (await readAccountFrameHistoryRecords(
  deps, env, entityId, counterpartyId, limit, opts,
)).map(record => record.frame);

/**
 * Read a bounded, complete Account swap lifecycle projection from certified
 * frame history. The scan never falls back to a live or retained lifecycle
 * map: if the account history is larger than the safe inspection window, it
 * fails loudly until a caller uses an indexed archival reader.
 */
const readAccountSwapHistoryPage = async (
  deps: CertifiedHistoryReadDeps,
  env: RuntimeReplica,
  entityId: string,
  counterpartyId: string,
  options: Readonly<{
    limit?: number;
    cursor?: Readonly<{ height: number; offerId: string }>;
  }> = {},
): Promise<PersistedAccountSwapHistoryPage> => {
  const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit ?? 25))));
  if (!Number.isSafeInteger(limit)) throw new Error(`ACCOUNT_SWAP_HISTORY_LIMIT_INVALID:${String(options.limit)}`);
  await requireStorageDbOpen(
    () => deps.tryOpenRuntimeWalDb(env),
    'runtime-wal:account-swap-history',
  );
  const recency = await readHistoryViewAccountSwapRecency(
    deps.getRuntimeWalDb(env),
    entityId,
    counterpartyId,
  );
  const selectedOfferIds: Array<Readonly<{ offerId: string; height: number }>> = [];
  const seen = new Set<string>();
  for (const event of recency) {
    if (seen.has(event.offerId)) continue;
    seen.add(event.offerId);
    if (!cursorAfter({ lastUpdatedHeight: event.accountHeight, offerId: event.offerId } as MutableSwapLifecycle, options.cursor)) {
      continue;
    }
    selectedOfferIds.push({ offerId: event.offerId, height: event.accountHeight });
    if (selectedOfferIds.length === limit) break;
  }
  const replica = getEntityReplicaById(env, entityId);
  const account = replica
    ? findAccountByCounterparty(replica.state.accounts, entityId, counterpartyId)
    : null;
  if (!account) throw new Error(`ACCOUNT_SWAP_HISTORY_ACCOUNT_NOT_FOUND:${entityId}:${counterpartyId}`);
  const items = await Promise.all(selectedOfferIds.map(async ({ offerId }): Promise<PersistedAccountSwapLifecycle> => {
    const events = await readHistoryViewAccountSwapEvents(
      deps.getRuntimeWalDb(env),
      entityId,
      counterpartyId,
      offerId,
    );
    const lifecycles = new Map<string, MutableSwapLifecycle>();
    for (const event of events) appendSwapHistoryTx(lifecycles, event.tx, event.accountHeight);
    const lifecycle = lifecycles.get(offerId);
    if (!lifecycle) throw new Error(`ACCOUNT_SWAP_HISTORY_INDEX_ORIGIN_MISSING:${offerId}`);
    const liveOffer = account.state.swapOffers.get(lifecycle.offerId);
    return {
      offerId: lifecycle.offerId,
      giveTokenId: lifecycle.giveTokenId,
      wantTokenId: lifecycle.wantTokenId,
      originalGiveAmount: lifecycle.originalGiveAmount,
      originalWantAmount: lifecycle.originalWantAmount,
      liveGiveAmount: liveOffer?.giveAmount ?? null,
      liveWantAmount: liveOffer?.wantAmount ?? null,
      priceTicks: liveOffer?.priceTicks ?? lifecycle.priceTicks,
      createdHeight: lifecycle.createdHeight,
      lastUpdatedHeight: lifecycle.lastUpdatedHeight,
      cancelRequested: lifecycle.cancelRequested,
      closed: !liveOffer && lifecycle.resolves.length > 0,
      resolves: lifecycle.resolves.map(resolve => ({ ...resolve })),
    };
  }));
  const last = selectedOfferIds.at(-1);
  return {
    entityId,
    accountId: counterpartyId,
    latestHeight: account.currentHeight,
    items,
    nextCursor: selectedOfferIds.length === limit && last
      ? { height: last.height, offerId: last.offerId }
      : null,
  };
};

const createFrameHistoryQueries = (deps: PersistenceQueryDeps) => {
  const readPersistedFrameJournal = async (
    env: RuntimeReplica,
    height: number,
    options?: { includeRuntimeMachine?: boolean },
  ): Promise<PersistedFrameJournal | null> => {
    const frame = await deps.readPersistedStorageFrameRecord(env, height);
    if (!frame) return null;
    if (options?.includeRuntimeMachine === false && !frame.postStateHash) {
      throw new Error(`RUNTIME_JOURNAL_COMPACT_POST_STATE_HASH_MISSING:${frame.height}`);
    }
    const payloads = await deps.readPersistedStorageFramePayloads(env, frame, options);
    const activity = await readRuntimeActivityJournal(deps, env, height);
    return buildRecoveryJournalFromStorageFrame(frame, payloads, activity?.logs ?? []);
  };

  const readPersistedRuntimeActivityJournal = (
    env: RuntimeReplica,
    height: number,
  ) => readRuntimeActivityJournal(deps, env, height);

  const readPersistedRuntimeActivityRecord = (
    env: RuntimeReplica,
    height: number,
  ) => readRuntimeActivityRecord(deps, env, height);

  const readPersistedAccountFrameHistory = (
    env: RuntimeReplica,
    entityId: string,
    counterpartyId: string,
    limit = 50,
    opts?: { maxRuntimeHeight?: number; maxAccountHeight?: number },
  ) => readAccountFrameHistory(deps, env, entityId, counterpartyId, limit, opts);

  const readPersistedAccountFrameHistoryRecords = (
    env: RuntimeReplica,
    entityId: string,
    counterpartyId: string,
    limit = 50,
    opts?: { maxRuntimeHeight?: number; maxAccountHeight?: number },
  ) => readAccountFrameHistoryRecords(deps, env, entityId, counterpartyId, limit, opts);

  const readPersistedAccountSwapHistoryPage = (
    env: RuntimeReplica,
    entityId: string,
    counterpartyId: string,
    options?: Readonly<{
      limit?: number;
      cursor?: Readonly<{ height: number; offerId: string }>;
    }>,
  ) => readAccountSwapHistoryPage(deps, env, entityId, counterpartyId, options);

  return {
    readPersistedFrameJournal,
    readPersistedRuntimeActivityJournal,
    readPersistedRuntimeActivityRecord,
    readPersistedAccountFrameHistory,
    readPersistedAccountFrameHistoryRecords,
    readPersistedAccountSwapHistoryPage,
  };
};

const readPersistedEntityFrameHistoryRecords = async (
  deps: PersistenceQueryDeps,
  env: RuntimeReplica,
  entityId: string,
  limit = 50,
  opts?: { maxRuntimeHeight?: number; maxEntityHeight?: number },
) => {
  await requireStorageDbOpen(
    () => deps.tryOpenRuntimeWalDb(env),
    'runtime-wal:certified-entity-frames',
  );
  const maxRuntimeHeight = Number.isFinite(Number(opts?.maxRuntimeHeight))
    ? Math.max(0, Math.floor(Number(opts?.maxRuntimeHeight)))
    : Number.POSITIVE_INFINITY;
  const maxEntityHeight = Number.isFinite(Number(opts?.maxEntityHeight))
    ? Math.max(0, Math.floor(Number(opts?.maxEntityHeight)))
    : Number.POSITIVE_INFINITY;
  const records = await readHistoryViewEntityFrames(deps.getRuntimeWalDb(env), entityId, {
    limit: Math.max(1, Math.min(1000, Math.floor(Number(limit || 50)))),
    ...(Number.isSafeInteger(maxRuntimeHeight) ? { maxRuntimeHeight } : {}),
    ...(Number.isSafeInteger(maxEntityHeight) ? { maxEntityHeight } : {}),
  });
  return records.map(record => structuredClone(record));
};

const readPersistedEntityFrameHistory = async (
  deps: PersistenceQueryDeps,
  env: RuntimeReplica,
  entityId: string,
  limit = 50,
  opts?: { maxRuntimeHeight?: number; maxEntityHeight?: number },
): Promise<CertifiedEntityFrameLink[]> => (await readPersistedEntityFrameHistoryRecords(
  deps, env, entityId, limit, opts,
)).map(record => record.link);

const readPersistedFrameJournals = async (
  deps: PersistenceQueryDeps,
  readPersistedFrameJournal: (
    env: RuntimeReplica,
    height: number,
    options?: { includeRuntimeMachine?: boolean },
  ) => Promise<PersistedFrameJournal | null>,
  env: RuntimeReplica,
  opts?: { fromHeight?: number; toHeight?: number; limit?: number; includeRuntimeMachine?: boolean },
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
    const receipt = await readPersistedFrameJournal(env, height, {
      includeRuntimeMachine: opts?.includeRuntimeMachine !== false,
    });
    if (receipt) {
      if (opts?.includeRuntimeMachine === false && receipt.runtimeMachine) {
        if (!receipt.postStateHash) {
          throw new Error(`RUNTIME_JOURNAL_COMPACT_POST_STATE_HASH_MISSING:${receipt.height}`);
        }
        const { runtimeMachine: _runtimeMachine, ...compact } = receipt;
        receipts.push(compact);
      } else {
        receipts.push(receipt);
      }
    }
  }
  return receipts;
};

const readPersistedRuntimeActivityPage = async (
  deps: PersistenceQueryDeps,
  readPersistedRuntimeActivityJournal: (
    env: RuntimeReplica,
    height: number,
  ) => Promise<(PersistedActivityJournal & { logs: FrameLogEntry[] }) | null>,
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

export const createPersistenceHistoryQueries = (deps: PersistenceQueryDeps) => {
  const frameQueries = createFrameHistoryQueries(deps);

  return {
    ...frameQueries,
    readPersistedEntityFrameHistory: (
      env: RuntimeReplica,
      entityId: string,
      limit = 50,
      opts?: { maxRuntimeHeight?: number; maxEntityHeight?: number },
    ) => readPersistedEntityFrameHistory(deps, env, entityId, limit, opts),
    readPersistedEntityFrameHistoryRecords: (
      env: RuntimeReplica,
      entityId: string,
      limit = 50,
      opts?: { maxRuntimeHeight?: number; maxEntityHeight?: number },
    ) => readPersistedEntityFrameHistoryRecords(deps, env, entityId, limit, opts),
    readPersistedFrameJournals: (
      env: RuntimeReplica,
      opts?: { fromHeight?: number; toHeight?: number; limit?: number; includeRuntimeMachine?: boolean },
    ) => readPersistedFrameJournals(deps, frameQueries.readPersistedFrameJournal, env, opts),
    readPersistedRuntimeActivityPage: (
      env: RuntimeReplica,
      opts: RuntimeActivityFilters & {
        beforeHeight?: number | undefined;
        limit?: number | undefined;
        scanLimit?: number | undefined;
      } = {},
    ) => readPersistedRuntimeActivityPage(
      deps,
      frameQueries.readPersistedRuntimeActivityJournal,
      env,
      opts,
    ),
  };
};
