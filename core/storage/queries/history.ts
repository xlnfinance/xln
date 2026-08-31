import {
  buildRuntimeActivityEvents,
  dedupeRuntimeActivityEvents,
} from '../../api/public/activity-history';
import { findAccountByCounterparty } from '../../account/state/account-lookup';
import { getEntityReplicaById } from '../../entity/replica/replica-lookup';
import type { RuntimeReplica, RoutedEntityInput } from '../../runtime/types';
import type { AccountFrame, AccountInput, AccountTx } from '../../types/account';
import type { FrameLogEntry } from '../../types/logging';
import type {
  PersistedActivityJournal,
  RuntimeActivityEvent,
  RuntimeActivityFilters,
} from '../views/activity-types';
import type {
  PersistedFrameJournal,
  RuntimeFrame,
  RuntimeFramePayloads,
} from '../types';
import type { PersistenceQueryDeps } from './deps';

/**
 * Runtime WAL is the only timeline. Entity and Account histories are derived
 * from accepted Runtime inputs and the flat outbox on demand; they are never
 * written to a second database or retained in live machine state.
 */
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
  ...(payloads.runtimeOutputs?.length ? { runtimeOutputs: payloads.runtimeOutputs } : {}),
  ...(payloads.runtimeMachine ? { runtimeMachine: payloads.runtimeMachine } : {}),
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

type PersistedAccountFrameRecord = Readonly<{
  kind: 'accountFrame';
  entityId: string;
  counterpartyId: string;
  accountHeight: number;
  source: 'ackCommit' | 'counterpartyCommit';
  frame: AccountFrame;
  runtimeHeight: number;
  timestamp: number;
}>;

const normalize = (value: string): string => String(value || '').trim().toLowerCase();

const accountInputMatchesAccount = (
  input: AccountInput,
  entityId: string,
  counterpartyId: string,
): boolean => {
  const from = normalize(input.fromEntityId);
  const to = normalize(input.toEntityId);
  const owner = normalize(entityId);
  const peer = normalize(counterpartyId);
  return (from === owner && to === peer) || (from === peer && to === owner);
};

const proposalOf = (input: AccountInput): AccountFrame | null =>
  input.kind === 'ack_frame'
    ? input.proposal.frame
    : null;

const accountInputsOf = (envelopes: readonly RoutedEntityInput[]): AccountInput[] => {
  const inputs: AccountInput[] = [];
  for (const envelope of envelopes) {
    for (const tx of envelope.entityTxs ?? []) {
      if (tx.type === 'accountInput') inputs.push(tx.data);
    }
  }
  return inputs;
};

const readAccountFrameHistoryRecords = async (
  deps: PersistenceQueryDeps,
  env: RuntimeReplica,
  entityId: string,
  counterpartyId: string,
  limit = 50,
  opts?: { maxRuntimeHeight?: number; maxAccountHeight?: number },
): Promise<PersistedAccountFrameRecord[]> => {
  const latest = await deps.resolvePersistedLatestHeight(env);
  const maxRuntimeHeight = Math.min(
    latest,
    Number.isSafeInteger(opts?.maxRuntimeHeight)
      ? Math.max(0, Number(opts?.maxRuntimeHeight))
      : latest,
  );
  const maxAccountHeight = Number.isSafeInteger(opts?.maxAccountHeight)
    ? Math.max(0, Number(opts?.maxAccountHeight))
    : Number.MAX_SAFE_INTEGER;
  const boundedLimit = Math.max(1, Math.min(10_000, Math.floor(Number(limit || 50))));
  const records: PersistedAccountFrameRecord[] = [];
  const seen = new Set<string>();

  // One bounded sequential WAL scan. No per-Account queries and no eager fan-out.
  for (let runtimeHeight = 1; runtimeHeight <= maxRuntimeHeight; runtimeHeight += 1) {
    const runtimeFrame = await deps.readPersistedStorageFrameRecord(env, runtimeHeight);
    if (!runtimeFrame) continue;
    const payloads = await deps.readPersistedStorageFramePayloads(env, runtimeFrame);
    const inputs = [
      ...accountInputsOf(runtimeFrame.runtimeInput.entityInputs as RoutedEntityInput[]),
      ...accountInputsOf(payloads.runtimeOutputs ?? []),
    ];
    for (const input of inputs) {
      if (!accountInputMatchesAccount(input, entityId, counterpartyId)) continue;
      const frame = proposalOf(input);
      if (!frame || frame.height > maxAccountHeight) continue;
      const identity = `${frame.height}:${frame.stateHash}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      records.push({
        kind: 'accountFrame',
        entityId: normalize(entityId),
        counterpartyId: normalize(counterpartyId),
        accountHeight: frame.height,
        source: normalize(input.fromEntityId) === normalize(entityId) ? 'ackCommit' : 'counterpartyCommit',
        frame: structuredClone(frame),
        runtimeHeight,
        timestamp: runtimeFrame.timestamp,
      });
      if (records.length > boundedLimit) records.shift();
    }
  }
  return records;
};

export const readAccountFrameHistory = async (
  deps: PersistenceQueryDeps,
  env: RuntimeReplica,
  entityId: string,
  counterpartyId: string,
  limit = 50,
  opts?: { maxRuntimeHeight?: number; maxAccountHeight?: number },
): Promise<AccountFrame[]> => (await readAccountFrameHistoryRecords(
  deps,
  env,
  entityId,
  counterpartyId,
  limit,
  opts,
)).map(record => record.frame);

export type PersistedAccountSwapHistoryPage = Readonly<{
  entityId: string;
  accountId: string;
  latestHeight: number;
  items: readonly PersistedAccountSwapLifecycle[];
  nextCursor: Readonly<{ height: number; offerId: string }> | null;
}>;

type PersistedAccountSwapResolve = Readonly<{
  fillRatio: number;
  height: number;
  cancelRemainder: boolean;
}>;

type PersistedAccountSwapLifecycle = Readonly<{
  offerId: string;
  giveTokenId: number;
  wantTokenId: number;
  originalGiveAmount: bigint;
  originalWantAmount: bigint;
  priceTicks: bigint;
  createdHeight: number;
  lastUpdatedHeight: number;
  cancelRequested: boolean;
  closed: boolean;
  resolves: readonly PersistedAccountSwapResolve[];
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

const applySwapTx = (
  rows: Map<string, MutableSwapLifecycle>,
  tx: AccountTx,
  height: number,
): void => {
  if (tx.type === 'swap_offer') {
    if (tx.data.priceTicks === undefined) throw new Error(`ACCOUNT_SWAP_PRICE_TICKS_MISSING:${tx.data.offerId}`);
    rows.set(tx.data.offerId, {
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
  if (tx.type !== 'swap_cancel_request' && tx.type !== 'swap_resolve' && tx.type !== 'cross_swap_fill_ack') return;
  const row = rows.get(tx.data.offerId);
  if (!row) return;
  row.lastUpdatedHeight = height;
  if (tx.type === 'swap_cancel_request') {
    row.cancelRequested = true;
    return;
  }
  row.resolves.push({
    fillRatio: tx.type === 'swap_resolve' ? tx.data.fillRatio : tx.data.cumulativeFillRatio,
    height,
    cancelRemainder: tx.type === 'swap_resolve'
      ? tx.data.cancelRemainder
      : (tx.data.cancelRemainder ?? tx.data.ackKind === 'cancel'),
  });
};

const readAccountSwapHistoryPage = async (
  deps: PersistenceQueryDeps,
  env: RuntimeReplica,
  entityId: string,
  counterpartyId: string,
  options: Readonly<{
    limit?: number;
    cursor?: Readonly<{ height: number; offerId: string }>;
  }> = {},
): Promise<PersistedAccountSwapHistoryPage> => {
  const entity = getEntityReplicaById(env, entityId);
  const account = entity
    ? findAccountByCounterparty(entity.state.accounts, entityId, counterpartyId)
    : null;
  if (!account) throw new Error(`ACCOUNT_SWAP_ACCOUNT_NOT_FOUND:${entityId}:${counterpartyId}`);
  const frames = await readAccountFrameHistory(deps, env, entityId, counterpartyId, 10_000);
  const rows = new Map<string, MutableSwapLifecycle>();
  for (const frame of frames) {
    for (const tx of frame.accountTxs) applySwapTx(rows, tx, frame.height);
  }
  const cursor = options.cursor;
  const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit ?? 25))));
  const candidates = Array.from(rows.values()).filter(row => !cursor ||
    row.lastUpdatedHeight < cursor.height ||
    (row.lastUpdatedHeight === cursor.height && row.offerId < cursor.offerId));
  // Presentation order only; it never re-enters Runtime/Entity/Account state.
  candidates.sort((left, right) =>
    right.lastUpdatedHeight - left.lastUpdatedHeight || right.offerId.localeCompare(left.offerId));
  const selected = candidates.slice(0, limit);
  const items = selected.map(row => ({
    ...row,
    closed: !account.state.swapOffers.has(row.offerId) && row.resolves.length > 0,
    resolves: row.resolves.map(resolve => ({ ...resolve })),
  }));
  const last = selected.at(-1);
  return {
    entityId: normalize(entityId),
    accountId: normalize(counterpartyId),
    latestHeight: account.currentHeight,
    items,
    nextCursor: selected.length === limit && last
      ? { height: last.lastUpdatedHeight, offerId: last.offerId }
      : null,
  };
};

const readPersistedFrameJournals = async (
  deps: PersistenceQueryDeps,
  readOne: (env: RuntimeReplica, height: number, options?: { includeRuntimeMachine?: boolean }) => Promise<PersistedFrameJournal | null>,
  env: RuntimeReplica,
  opts?: { fromHeight?: number; toHeight?: number; limit?: number; includeRuntimeMachine?: boolean },
): Promise<PersistedFrameJournal[]> => {
  const latest = await deps.resolvePersistedLatestHeight(env);
  if (latest <= 0) return [];
  const from = Math.max(1, Math.floor(opts?.fromHeight ?? 1));
  const to = Math.min(latest, Math.max(from, Math.floor(opts?.toHeight ?? latest)));
  const end = Math.min(to, from + Math.max(1, Math.min(10_000, Math.floor(opts?.limit ?? 200))) - 1);
  const frames: PersistedFrameJournal[] = [];
  for (let height = from; height <= end; height += 1) {
    const frame = await readOne(env, height, { includeRuntimeMachine: opts?.includeRuntimeMachine !== false });
    if (frame) frames.push(frame);
  }
  return frames;
};

export const createPersistenceHistoryQueries = (deps: PersistenceQueryDeps) => {
  const readPersistedFrameJournal = async (
    env: RuntimeReplica,
    height: number,
    options?: { includeRuntimeMachine?: boolean },
  ): Promise<PersistedFrameJournal | null> => {
    const frame = await deps.readPersistedStorageFrameRecord(env, height);
    if (!frame) return null;
    const payloads = await deps.readPersistedStorageFramePayloads(env, frame, options);
    return buildRecoveryJournalFromStorageFrame(frame, payloads);
  };

  const readPersistedRuntimeActivityJournal = async (
    env: RuntimeReplica,
    height: number,
  ): Promise<(PersistedActivityJournal & { logs: FrameLogEntry[] }) | null> => {
    const frame = await deps.readPersistedStorageFrameRecord(env, height);
    return frame ? { height: frame.height, timestamp: frame.timestamp, runtimeInput: frame.runtimeInput, logs: [] } : null;
  };

  const readPersistedRuntimeActivityRecord = async (env: RuntimeReplica, height: number) => {
    const frame = await deps.readPersistedStorageFrameRecord(env, height);
    return frame ? {
      timestamp: frame.timestamp,
      logs: [] as FrameLogEntry[],
      touchedEntities: [...frame.touchedEntities],
      touchedAccounts: frame.touchedAccounts.map(account => ({ ...account })),
      touchedBookEntities: [...frame.touchedBookEntities],
    } : null;
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
    const start = latestHeight <= 0 ? 0 : Math.max(1, Math.min(latestHeight, Math.floor(Number(opts.beforeHeight ?? latestHeight))));
    const events: RuntimeActivityEvent[] = [];
    let scannedFrames = 0;
    let height = start;
    for (; height >= 1 && scannedFrames < scanLimit; height -= 1) {
      const activity = await readPersistedRuntimeActivityJournal(env, height);
      scannedFrames += 1;
      if (activity) events.push(...buildRuntimeActivityEvents(activity, opts));
      if (dedupeRuntimeActivityEvents(events).length >= limit) break;
    }
    const returned = dedupeRuntimeActivityEvents(events).slice(0, limit).map(event => ({
      ...event,
      ...(env.runtimeId ? { runtimeId: env.runtimeId, id: `${env.runtimeId}:${event.id}` } : {}),
    }));
    return {
      ok: true,
      runtimeId: env.runtimeId,
      latestHeight,
      fromHeight: start === 0 ? 0 : Math.max(1, height),
      toHeight: start,
      scannedFrames,
      returned: returned.length,
      limit,
      scanLimit,
      nextBeforeHeight: height > 1 ? height - 1 : null,
      filters: opts,
      events: returned,
    };
  };

  return {
    readPersistedFrameJournal,
    readPersistedRuntimeActivityJournal,
    readPersistedRuntimeActivityRecord,
    readPersistedAccountFrameHistory: (
      env: RuntimeReplica,
      entityId: string,
      counterpartyId: string,
      limit = 50,
      opts?: { maxRuntimeHeight?: number; maxAccountHeight?: number },
    ) => readAccountFrameHistory(deps, env, entityId, counterpartyId, limit, opts),
    readPersistedAccountFrameHistoryRecords: (
      env: RuntimeReplica,
      entityId: string,
      counterpartyId: string,
      limit = 50,
      opts?: { maxRuntimeHeight?: number; maxAccountHeight?: number },
    ) => readAccountFrameHistoryRecords(deps, env, entityId, counterpartyId, limit, opts),
    readPersistedAccountSwapHistoryPage: (
      env: RuntimeReplica,
      entityId: string,
      counterpartyId: string,
      options?: Readonly<{ limit?: number; cursor?: Readonly<{ height: number; offerId: string }> }>,
    ) => readAccountSwapHistoryPage(deps, env, entityId, counterpartyId, options),
    readPersistedFrameJournals: (
      env: RuntimeReplica,
      opts?: { fromHeight?: number; toHeight?: number; limit?: number; includeRuntimeMachine?: boolean },
    ) => readPersistedFrameJournals(deps, readPersistedFrameJournal, env, opts),
    readPersistedRuntimeActivityPage,
  };
};
