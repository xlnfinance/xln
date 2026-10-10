import type { BookState } from '../../../orderbook';
import type { AccountFrame } from '../../../types/account';
import type { EntityReplica, EntityState } from '../../../entity/types';
import type { RuntimeEntityMetricStats, RuntimeReplica } from '../../../runtime/types';
import {
  DEFAULT_ACCOUNT_MERKLE_RADIX,
  DEFAULT_EPOCH_MAX_BYTES,
  DEFAULT_RETAIN_SNAPSHOTS,
  DEFAULT_SNAPSHOT_PERIOD_FRAMES,
  STORAGE_SCHEMA_VERSION,
  normalizeEntityId,
} from '../../../storage/keys';
import { projectAccountDoc, projectEntityReplicaCoreView } from '../../../storage/read/projections';
import type {
  StorageAccountDoc,
  StorageEntityCoreDoc,
  RuntimeFrame,
  StorageHead,
} from '../../../storage/types';
import { compareAscii, sortedStringMapKeys, sortedStringMapStartIndex } from '../../../support/collections/sorted-map-index';
import type { RuntimeActivityFilters } from '../../../storage/views/activity-types';
import type { Profile } from '../../../entity/profile';
import { RuntimeAdapterError } from '../errors';
import type {
  RuntimeAdapterActivityPage,
  RuntimeAdapterEntitySummary,
  RuntimeAdapterFrameReceiptResponse,
  RuntimeAdapterPaymentRoutesResponse,
  RuntimeAdapterReadQuery,
  RuntimeAdapterSwapHistoryPage,
} from '../types';

// The read context every runtime-adapter projection shares: storage/live
// readers, query bounds, the best known head, entity summaries and the live or
// stored Entity view page a projection starts from.

export type RuntimeAdapterEntityCoreDoc = StorageEntityCoreDoc & {
  signerId?: string;
  isProposer?: boolean;
  /** View-only: full active Paybook size. The compact map is a tail sample. */
  paybookOpen?: number;
  /** View-only counters derived after WAL commit; never part of EntityState. */
  metrics?: RuntimeEntityMetricStats;
};

export type RuntimeAdapterResolveContext = {
  env: RuntimeReplica;
  readHead?: () => Promise<StorageHead | null>;
  readFrame?: (height: number) => Promise<RuntimeFrame | null>;
  listCheckpoints?: () => Promise<number[]>;
  loadEntityState?: (entityId: string, height: number) => Promise<EntityState | null>;
  loadEntityAccountDoc?: (entityId: string, counterpartyId: string, height: number) => Promise<StorageAccountDoc | null>;
  loadEntityViewPage?: (
    entityId: string,
    height: number,
    query?: RuntimeAdapterReadQuery,
  ) => Promise<{
    core: RuntimeAdapterEntityCoreDoc;
    accounts: RuntimeAdapterAccountPage;
    books: RuntimeAdapterBookPage;
  } | null>;
  listEntityIdsAtHeight?: (height: number) => Promise<string[]>;
  readActivityPage?: (
    opts: RuntimeActivityFilters & {
      beforeHeight?: number | undefined;
      limit?: number | undefined;
      scanLimit?: number | undefined;
    },
  ) => Promise<RuntimeAdapterActivityPage>;
  readAccountSwapHistoryPage?: (
    entityId: string,
    counterpartyId: string,
    options: Readonly<{
      limit?: number;
      cursor?: Readonly<{ height: number; offerId: string }>;
    }>,
  ) => Promise<RuntimeAdapterSwapHistoryPage>;
  /** Certified Account frames, newest last. Point read: aggregate views omit them. */
  readAccountFrameHistory?: (
    entityId: string,
    counterpartyId: string,
    limit: number,
  ) => Promise<AccountFrame[]>;
  readFrameReceipts?: (query?: RuntimeAdapterReadQuery) => Promise<RuntimeAdapterFrameReceiptResponse>;
  findPaymentRoutes?: (query?: RuntimeAdapterReadQuery) => Promise<RuntimeAdapterPaymentRoutesResponse>;
};

export type RuntimeAdapterAccountPage = {
  items: StorageAccountDoc[];
  nextCursor: string | null;
  prevCursor?: string | null;
  firstCursor?: string | null;
  lastCursor?: string | null;
  pageIndex?: number;
  pageCount?: number;
  totalItems?: number;
  limit?: number;
  summary?: RuntimeAdapterAccountPageSummary;
};

export type NativeMapView<T> = T extends ReadonlyMap<infer K, infer V> ? Map<K, V> : never;

export type RuntimeAdapterBookPage = {
  items: Array<{ pairId: string; book: BookState }>;
  nextCursor: string | null;
  prevCursor?: string | null;
  firstCursor?: string | null;
  lastCursor?: string | null;
  pageIndex?: number;
  pageCount?: number;
  totalItems?: number;
  limit?: number;
};

type RuntimeAdapterVisibleDeltaSummary = {
  counterpartyId: string;
  tokenId: number;
  delta: string;
};

export type RuntimeAdapterAccountPageSummary = {
  totalItems: number | null;
  visibleItems: number;
  limit: number;
  pageIndex: number | null;
  pageCount: number | null;
  hasMore: boolean;
  sampleIds: string[];
  pageStateHashes: string[];
  visibleTopDeltas: RuntimeAdapterVisibleDeltaSummary[];
};

export const readBoundedLimit = (rawValue: unknown, defaultValue: number): number => {
  const raw = Number(rawValue ?? defaultValue);
  if (!Number.isFinite(raw)) throw new RuntimeAdapterError('E_BAD_QUERY', 'limit must be finite');
  return Math.max(1, Math.min(500, Math.floor(raw)));
};

export const readAtHeight = (query?: RuntimeAdapterReadQuery): number | null => {
  if (query?.atHeight === undefined) return null;
  const raw = Number(query.atHeight);
  if (!Number.isFinite(raw) || raw < 1) throw new RuntimeAdapterError('E_BAD_QUERY', 'atHeight must be a positive integer');
  return Math.floor(raw);
};

export const withDefinedProp = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

export const envHeight = (env: RuntimeReplica): number => Math.max(0, Math.floor(Number(env.state.height ?? 0)));

const latestHeadHeight = (head: StorageHead): number =>
  Math.max(0, Math.floor(Number(head.latestHeight ?? 0)));

const headMaterializedHeight = (head: StorageHead): number =>
  Math.max(0, Math.floor(Number(head.latestMaterializedHeight ?? head.latestSnapshotHeight ?? 0)));

const headSnapshotHeight = (head: StorageHead): number =>
  Math.max(0, Math.floor(Number(head.latestSnapshotHeight ?? 0)));

export const assertRequestedHeightAvailable = (
  requestedHeight: number,
  head: StorageHead,
  scope: string,
): void => {
  const latestHeight = latestHeadHeight(head);
  if (requestedHeight > latestHeight) {
    throw new RuntimeAdapterError(
      'E_NOT_FOUND',
      `${scope} height unavailable: requested=${requestedHeight} latest=${latestHeight}`,
    );
  }
};

export const findReplica = (env: RuntimeReplica, entityId: string): EntityReplica | null => {
  const normalized = normalizeEntityId(entityId);
  for (const replica of env.state.eReplicas?.values?.() ?? []) {
    if (normalizeEntityId(replica.entityId) === normalized) return replica;
  }
  return null;
};

const labelForState = (state: EntityState): string => {
  const name = String(state.profile?.name || '').trim();
  return name || state.entityId;
};

// Financial role is committed explicitly by the Entity profile. An orderbook
// is a capability, not authority to shorten the bilateral dispute window: a
// normal User may publish books without becoming a Hub.
export const isHubState = (state: EntityState): boolean => state.profile?.isHub === true;

export const jurisdictionSummary = (jurisdiction: unknown): RuntimeAdapterEntitySummary['jurisdiction'] | undefined => {
  if (!jurisdiction || typeof jurisdiction !== 'object') return undefined;
  const value = jurisdiction as {
    name?: unknown;
    address?: unknown;
    chainId?: unknown;
    depositoryAddress?: unknown;
    entityProviderAddress?: unknown;
  };
  const name = String(value.name ?? '').trim();
  const address = String(value.address ?? '').trim();
  const chainId = value.chainId as number | string | undefined;
  const depositoryAddress = String(value.depositoryAddress ?? '').trim();
  const entityProviderAddress = String(value.entityProviderAddress ?? '').trim();
  if (!name && !address && chainId === undefined && !depositoryAddress && !entityProviderAddress) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(address ? { address } : {}),
    ...(chainId !== undefined ? { chainId } : {}),
    ...(depositoryAddress ? { depositoryAddress } : {}),
    ...(entityProviderAddress ? { entityProviderAddress } : {}),
  };
};

const summaryFromProfile = (
  profile: Profile,
  defaultHeight: number,
): RuntimeAdapterEntitySummary | null => {
  const entityId = normalizeEntityId(profile.entityId);
  if (!entityId) return null;
  const profileName = String(profile.name || profile.metadata?.hubName || '').trim();
  const jurisdiction = jurisdictionSummary(profile.metadata?.jurisdiction);
  const runtimeId = normalizeEntityId(profile.runtimeId);
  return {
    entityId,
    ...(runtimeId ? { runtimeId } : {}),
    label: profileName || entityId,
    height: Math.max(0, Math.floor(Number(profile.lastUpdated || defaultHeight || 0))),
    isHub: profile.metadata?.isHub === true,
    ...(jurisdiction ? { jurisdiction } : {}),
  };
};

const mergeEntitySummaries = (
  summaries: RuntimeAdapterEntitySummary[],
  additions: RuntimeAdapterEntitySummary[],
): RuntimeAdapterEntitySummary[] => {
  const byEntityId = new Map<string, RuntimeAdapterEntitySummary>();
  const mergeSummary = (
    existing: RuntimeAdapterEntitySummary | undefined,
    summary: RuntimeAdapterEntitySummary,
    entityId: string,
  ): RuntimeAdapterEntitySummary => {
    const merged: RuntimeAdapterEntitySummary = {
      ...(existing ?? {}),
      ...summary,
      entityId,
    };
    if (!summary.jurisdiction && existing?.jurisdiction) merged.jurisdiction = existing.jurisdiction;
    if ((!summary.label || summary.label === entityId) && existing?.label) merged.label = existing.label;
    // The primary summary is committed local state and must win even when its
    // role is `false`. Letting a live gossip advertisement OR-in `true` would
    // change the response clocks signed by an Account-opening command.
    if (typeof summary.isHub === 'boolean') merged.isHub = summary.isHub;
    else if (typeof existing?.isHub === 'boolean') merged.isHub = existing.isHub;
    return merged;
  };
  for (const summary of additions) {
    const entityId = normalizeEntityId(summary.entityId);
    if (!entityId) continue;
    byEntityId.set(entityId, { ...summary, entityId });
  }
  for (const summary of summaries) {
    const entityId = normalizeEntityId(summary.entityId);
    if (!entityId) continue;
    byEntityId.set(entityId, mergeSummary(byEntityId.get(entityId), summary, entityId));
  }
  return Array.from(byEntityId.values()).sort((left, right) => compareAscii(left.entityId, right.entityId));
};

const listLiveGossipProfileSummaries = (ctx: RuntimeAdapterResolveContext): RuntimeAdapterEntitySummary[] => {
  const profiles = ctx.env.gossip?.getProfiles?.() ?? [];
  const height = envHeight(ctx.env);
  const summaries: RuntimeAdapterEntitySummary[] = [];
  for (const profile of profiles) {
    const summary = summaryFromProfile(profile, height);
    if (summary) summaries.push(summary);
  }
  return summaries;
};

const headFromEnv = (env: RuntimeReplica): StorageHead => {
  const storage = env.runtimeConfig?.storage;
  const height = envHeight(env);
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: height,
    latestMaterializedHeight: height,
    latestSnapshotHeight: 0,
    snapshotPeriodFrames: Math.max(
      1,
      Number(storage?.snapshotPeriodFrames ?? DEFAULT_SNAPSHOT_PERIOD_FRAMES),
    ),
    retainSnapshots: Math.max(1, Number(storage?.retainSnapshots ?? DEFAULT_RETAIN_SNAPSHOTS)),
    epochMaxBytes: Math.max(1, Number(storage?.epochMaxBytes ?? DEFAULT_EPOCH_MAX_BYTES)),
    accountMerkleRadix: storage?.accountMerkleRadix === 256 ? 256 : DEFAULT_ACCOUNT_MERKLE_RADIX,
    epochReplayBytes: 0,
    retainedWalBytes: 0,
  };
};

export const readBestHead = async (ctx: RuntimeAdapterResolveContext): Promise<StorageHead> => {
  const inMemoryHead = headFromEnv(ctx.env);
  if (!ctx.readHead) return inMemoryHead;
  const stored = await ctx.readHead();
  if (!stored) return inMemoryHead;
  const liveHeight = envHeight(ctx.env);
  if (latestHeadHeight(stored) >= liveHeight) return stored;
  const latestHeight = Math.max(liveHeight, latestHeadHeight(stored));
  return {
    ...stored,
    latestHeight,
    latestMaterializedHeight: Math.min(latestHeight, Math.max(headMaterializedHeight(stored), headMaterializedHeight(inMemoryHead))),
    latestSnapshotHeight: Math.min(latestHeight, Math.max(headSnapshotHeight(stored), headSnapshotHeight(inMemoryHead))),
    retainedWalBytes: Math.max(
      0,
      Math.floor(Number(stored.retainedWalBytes ?? inMemoryHead.retainedWalBytes ?? 0)),
    ),
  };
};

export const listLiveEntitySummaries = (
  ctx: RuntimeAdapterResolveContext,
): RuntimeAdapterEntitySummary[] => {
  const liveReplicas = Array.from(ctx.env.state.eReplicas?.values?.() ?? [])
    .map((replica) => {
      const isHub = isHubState(replica.state);
      const jurisdiction = jurisdictionSummary(replica.state.config?.jurisdiction);
      const runtimeId = normalizeEntityId(String(ctx.env.runtimeId || ''));
      return {
        entityId: normalizeEntityId(replica.entityId),
        ...(runtimeId ? { runtimeId } : {}),
        ...withDefinedProp('signerId', replica.signerId),
        label: labelForState(replica.state),
        height: Math.max(0, Math.floor(Number(replica.state.height ?? 0))),
        isHub,
        ...(jurisdiction ? { jurisdiction } : {}),
      };
    });
  return mergeEntitySummaries(liveReplicas, listLiveGossipProfileSummaries(ctx));
};

export const listEntitySummaries = async (
  ctx: RuntimeAdapterResolveContext,
  query?: RuntimeAdapterReadQuery,
  options: { allowPartial?: boolean; forceStorageAtHeight?: boolean } = {},
): Promise<RuntimeAdapterEntitySummary[]> => {
  const height = readAtHeight(query);
  const useStorage = height !== null
    && (options.forceStorageAtHeight === true || height !== envHeight(ctx.env));
  if (useStorage) {
    if (ctx.readHead) {
      const head = await ctx.readHead();
      if (!head) throw new RuntimeAdapterError('E_NOT_FOUND', `storage head not found at height ${height}`);
      assertRequestedHeightAvailable(height, head, 'entity summary');
    }
    if (!ctx.listEntityIdsAtHeight) {
      throw new RuntimeAdapterError('E_INTERNAL', 'storage entity listing is required for historical reads');
    }
    const ids = await ctx.listEntityIdsAtHeight(height);
    const summaries: RuntimeAdapterEntitySummary[] = [];
    const requestedEntityId = normalizeEntityId(String(query?.entityId || ''));
    const ctxRuntimeId = normalizeEntityId(String(ctx.env.runtimeId || ''));
    for (const id of ids) {
      const normalizedId = normalizeEntityId(id);
      const loadedView = ctx.loadEntityViewPage
        ? await ctx.loadEntityViewPage(id, height, { limit: 1, accountsLimit: 1, booksLimit: 1 })
        : null;
      const loaded = !loadedView && ctx.loadEntityState ? await ctx.loadEntityState(id, height) : null;
      if (!loadedView && !loaded) {
        if (options.allowPartial && (!requestedEntityId || normalizedId !== requestedEntityId)) continue;
        throw new RuntimeAdapterError('E_NOT_FOUND', `entity summary not found at height ${height}: ${normalizedId}`);
      }
      const profileName = loadedView ? String(loadedView.core.profile?.name || '').trim() : '';
      const isHub = loadedView
        ? loadedView.core.profile?.isHub === true
        : loaded ? isHubState(loaded) : false;
      const jurisdiction = jurisdictionSummary(loadedView?.core.config?.jurisdiction ?? loaded?.config?.jurisdiction);
      summaries.push({
        entityId: normalizedId,
        ...(ctxRuntimeId ? { runtimeId: ctxRuntimeId } : {}),
        ...withDefinedProp('signerId', loadedView?.core.signerId),
        label: profileName || (loaded ? labelForState(loaded) : normalizedId),
        height: loadedView?.core.height ?? loaded?.height ?? height,
        isHub,
        ...(jurisdiction ? { jurisdiction } : {}),
      });
    }
    if (summaries.length === 0 && ids.length > 0) {
      throw new RuntimeAdapterError('E_NOT_FOUND', `entity summary not found at height ${height}`);
    }
    return summaries.sort((left, right) => compareAscii(left.entityId, right.entityId));
  }

  return listLiveEntitySummaries(ctx);
};

const readPageIndex = (rawValue: unknown): number => {
  if (rawValue === undefined || rawValue === null || rawValue === '') return -1;
  const raw = Number(rawValue);
  if (!Number.isFinite(raw) || raw < 0) throw new RuntimeAdapterError('E_BAD_QUERY', 'page index must be a non-negative integer');
  return Math.floor(raw);
};

const buildPageMeta = (
  keys: readonly string[],
  start: number,
  limit: number,
  visibleKeys: readonly string[],
): Omit<RuntimeAdapterAccountPage, 'items'> => {
  const safeLimit = Math.max(1, limit);
  return {
    nextCursor: start + safeLimit < keys.length ? visibleKeys[visibleKeys.length - 1] ?? null : null,
    prevCursor: start > 0 ? keys[Math.max(0, start - safeLimit)] ?? null : null,
    firstCursor: visibleKeys[0] ?? null,
    lastCursor: visibleKeys[visibleKeys.length - 1] ?? null,
    pageIndex: Math.floor(start / safeLimit),
    pageCount: Math.ceil(keys.length / safeLimit),
    totalItems: keys.length,
    limit: safeLimit,
  };
};

export const emptyPageMeta = (limit: number): Omit<RuntimeAdapterAccountPage, 'items'> => ({
  nextCursor: null,
  prevCursor: null,
  firstCursor: null,
  lastCursor: null,
  pageIndex: 0,
  pageCount: 0,
  totalItems: 0,
  limit,
});

const singleAccountPage = (
  accountId: string,
  account: StorageAccountDoc | null,
  limit: number,
): RuntimeAdapterAccountPage => account
  ? {
      items: [account],
      nextCursor: null,
      prevCursor: null,
      firstCursor: accountId,
      lastCursor: accountId,
      pageIndex: 0,
      pageCount: 1,
      totalItems: 1,
      limit,
    }
  : { items: [], ...emptyPageMeta(limit) };

const projectLiveAccountsPage = (
  state: EntityState,
  query?: RuntimeAdapterReadQuery,
): RuntimeAdapterAccountPage => {
  const limit = readBoundedLimit(query?.accountsLimit ?? query?.limit, 10);
  const accountId = normalizeEntityId(String(query?.accountId || ''));
  if (accountId) {
    const account = state.accounts.get(accountId);
    return singleAccountPage(
      accountId,
      account ? projectAccountDoc(account) : null,
      limit,
    );
  }
  const cursor = normalizeEntityId(String(query?.accountsCursor ?? query?.cursor ?? ''));
  const pageIndex = readPageIndex(query?.accountsPage);
  const orderedKeys = sortedStringMapKeys(state.accounts);
  const keys = query?.sortDir === 'desc' ? [...orderedKeys].reverse() : orderedKeys;
  const start = sortedStringMapStartIndex(keys, cursor, pageIndex, limit);
  const visibleKeys = keys.slice(start, start + limit);
  return {
    items: visibleKeys.map((id) => {
      const account = state.accounts.get(id);
      if (!account) throw new RuntimeAdapterError('E_INTERNAL', `live account index is stale: ${id}`);
      return projectAccountDoc(account);
    }),
    ...buildPageMeta(keys, start, limit, visibleKeys),
  };
};

const projectLiveBooksPage = (
  state: EntityState,
  query?: RuntimeAdapterReadQuery,
): RuntimeAdapterBookPage => {
  const limit = readBoundedLimit(query?.booksLimit ?? query?.limit, 10);
  const cursor = String(query?.booksCursor ?? query?.cursor ?? '').trim();
  const books = state.orderbookExt?.books;
  if (!books) {
    return { items: [], ...emptyPageMeta(limit) };
  }
  const pageIndex = readPageIndex(query?.booksPage);
  const orderedKeys = sortedStringMapKeys(books as Map<string, unknown>);
  const keys = query?.sortDir === 'desc' ? [...orderedKeys].reverse() : orderedKeys;
  const start = sortedStringMapStartIndex(keys, cursor, pageIndex, limit);
  const visibleKeys = keys.slice(start, start + limit);
  return {
    items: visibleKeys.map((pairId) => {
      const book = books.get(pairId);
      if (!book) throw new RuntimeAdapterError('E_INTERNAL', `live book index is stale: ${pairId}`);
      return { pairId, book };
    }),
    ...buildPageMeta(keys, start, limit, visibleKeys),
  };
};

export const projectLiveEntityViewPage = (
  ctx: RuntimeAdapterResolveContext,
  entityId: string,
  query?: RuntimeAdapterReadQuery,
): {
  core: RuntimeAdapterEntityCoreDoc;
  accounts: RuntimeAdapterAccountPage;
  books: RuntimeAdapterBookPage;
} => {
  const replica = findReplica(ctx.env, entityId);
  if (!replica) throw new RuntimeAdapterError('E_NOT_FOUND', `entity not found: ${normalizeEntityId(entityId)}`);
  return {
    core: projectEntityReplicaCoreView(replica.state, replica),
    accounts: projectLiveAccountsPage(replica.state, query),
    books: projectLiveBooksPage(replica.state, query),
  };
};

const loadRequiredEntityViewPage = async (
  ctx: RuntimeAdapterResolveContext,
  entityId: string,
  height: number,
  query?: RuntimeAdapterReadQuery,
): Promise<{
  core: RuntimeAdapterEntityCoreDoc;
  accounts: RuntimeAdapterAccountPage;
  books: RuntimeAdapterBookPage;
}> => {
  if (!ctx.loadEntityViewPage) {
    throw new RuntimeAdapterError('E_INTERNAL', 'storage view page loader is required for paged entity reads');
  }
  const stored = await ctx.loadEntityViewPage(entityId, height, query);
  if (!stored) throw new RuntimeAdapterError('E_NOT_FOUND', `entity view not found at height ${height}: ${normalizeEntityId(entityId)}`);
  return stored;
};

export const loadViewPageForHeight = async (
  ctx: RuntimeAdapterResolveContext,
  entityId: string,
  height: number,
  isCurrentHeight: boolean,
  query?: RuntimeAdapterReadQuery,
): Promise<{
  core: RuntimeAdapterEntityCoreDoc;
  accounts: RuntimeAdapterAccountPage;
  books: RuntimeAdapterBookPage;
}> => {
  if (isCurrentHeight) return projectLiveEntityViewPage(ctx, entityId, query);
  return await loadRequiredEntityViewPage(ctx, entityId, height, query);
};
