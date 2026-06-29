import type { BookState, BookOrderState, PriceBucketState, PriceLevelState } from '../orderbook';
import type { EntityReplica, EntityState, Env } from '../types';
import {
  DEFAULT_ACCOUNT_MERKLE_RADIX,
  DEFAULT_EPOCH_MAX_BYTES,
  DEFAULT_RETAIN_SNAPSHOTS,
  DEFAULT_SNAPSHOT_PERIOD_FRAMES,
  STORAGE_SCHEMA_VERSION,
  normalizeEntityId,
} from '../storage/keys';
import { projectAccountDoc, projectEntityCoreDoc } from '../storage/projections';
import type {
  StorageAccountDoc,
  StorageEntityCoreDoc,
  StorageFrameRecord,
  StorageHead,
} from '../storage/types';
import { compareAscii, sortedStringMapKeys, sortedStringMapStartIndex } from '../sorted-index';
import { RuntimeAdapterError } from './errors';
import type { RuntimeAdapterEntitySummary, RuntimeAdapterReadQuery } from './types';

export type RuntimeAdapterResolveContext = {
  env: Env;
  readHead?: () => Promise<StorageHead | null>;
  readFrame?: (height: number) => Promise<StorageFrameRecord | null>;
  listCheckpoints?: () => Promise<number[]>;
  loadEntityState?: (entityId: string, height: number) => Promise<EntityState | null>;
  loadEntityAccountDoc?: (entityId: string, counterpartyId: string, height: number) => Promise<StorageAccountDoc | null>;
  loadEntityViewPage?: (
    entityId: string,
    height: number,
    query?: RuntimeAdapterReadQuery,
  ) => Promise<{
    core: StorageEntityCoreDoc;
    accounts: RuntimeAdapterAccountPage;
    books: RuntimeAdapterBookPage;
  } | null>;
  listEntityIdsAtHeight?: (height: number) => Promise<string[]>;
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

export type RuntimeAdapterVisibleDeltaSummary = {
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

export type RuntimeAdapterViewEntityFrame = {
  summary: RuntimeAdapterEntitySummary;
  core: StorageEntityCoreDoc;
  accounts: RuntimeAdapterAccountPage;
  books: RuntimeAdapterBookPage;
};

export type RuntimeAdapterViewFrame = {
  head: StorageHead;
  height: number;
  entities: RuntimeAdapterEntitySummary[];
  activeEntityId: string | null;
  activeEntity: RuntimeAdapterViewEntityFrame | null;
};

const normalizePath = (path: string): string[] => {
  const parts = String(path || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
  if (parts.length === 0) throw new RuntimeAdapterError('E_BAD_PATH', 'empty adapter path');
  return parts;
};

const readBoundedLimit = (rawValue: unknown, fallback: number): number => {
  const raw = Number(rawValue ?? fallback);
  if (!Number.isFinite(raw)) throw new RuntimeAdapterError('E_BAD_QUERY', 'limit must be finite');
  return Math.max(1, Math.min(500, Math.floor(raw)));
};

const readAtHeight = (query?: RuntimeAdapterReadQuery): number | null => {
  if (query?.atHeight === undefined) return null;
  const raw = Number(query.atHeight);
  if (!Number.isFinite(raw) || raw < 1) throw new RuntimeAdapterError('E_BAD_QUERY', 'atHeight must be a positive integer');
  return Math.floor(raw);
};

const envHeight = (env: Env): number => Math.max(0, Math.floor(Number(env.height ?? 0)));

const latestHeadHeight = (head: StorageHead): number =>
  Math.max(0, Math.floor(Number(head.latestHeight ?? 0)));

const assertRequestedHeightAvailable = (
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

const findReplica = (env: Env, entityId: string): EntityReplica | null => {
  const normalized = normalizeEntityId(entityId);
  for (const replica of env.eReplicas?.values?.() ?? []) {
    if (normalizeEntityId(replica.entityId) === normalized) return replica;
  }
  return null;
};

const labelForState = (state: EntityState): string => {
  const name = String(state.profile?.name || '').trim();
  return name || state.entityId;
};

const isHubState = (state: EntityState): boolean =>
  state.profile?.isHub === true || Boolean(state.orderbookExt?.hubProfile);

const jurisdictionSummary = (jurisdiction: unknown): RuntimeAdapterEntitySummary['jurisdiction'] | undefined => {
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

const headFromEnv = (env: Env): StorageHead => {
  const storage = env.runtimeConfig?.storage;
  const height = envHeight(env);
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: height,
    latestMaterializedHeight: height,
    latestSnapshotHeight: 0,
    snapshotPeriodFrames: Math.max(
      1,
      Number(storage?.snapshotPeriodFrames ?? env.runtimeConfig?.snapshotIntervalFrames ?? DEFAULT_SNAPSHOT_PERIOD_FRAMES),
    ),
    retainSnapshots: Math.max(1, Number(storage?.retainSnapshots ?? DEFAULT_RETAIN_SNAPSHOTS)),
    epochMaxBytes: Math.max(1, Number(storage?.epochMaxBytes ?? DEFAULT_EPOCH_MAX_BYTES)),
    accountMerkleRadix: storage?.accountMerkleRadix === 256 ? 256 : DEFAULT_ACCOUNT_MERKLE_RADIX,
    retainedHistoryBytes: 0,
  };
};

const resolveEntityState = async (
  ctx: RuntimeAdapterResolveContext,
  entityId: string,
  query?: RuntimeAdapterReadQuery,
): Promise<{ state: EntityState; replica?: EntityReplica }> => {
  const normalized = normalizeEntityId(entityId);
  const height = readAtHeight(query);
  if (height !== null && height !== envHeight(ctx.env)) {
    if (!ctx.loadEntityState) {
      throw new RuntimeAdapterError('E_BAD_QUERY', 'historical reads are unavailable for this adapter');
    }
    const loaded = await ctx.loadEntityState(normalized, height);
    if (!loaded) throw new RuntimeAdapterError('E_NOT_FOUND', `entity not found at height ${height}: ${normalized}`);
    return { state: loaded };
  }

  const replica = findReplica(ctx.env, normalized);
  if (!replica) throw new RuntimeAdapterError('E_NOT_FOUND', `entity not found: ${normalized}`);
  return { state: replica.state, replica };
};

const listEntitySummaries = async (
  ctx: RuntimeAdapterResolveContext,
  query?: RuntimeAdapterReadQuery,
): Promise<RuntimeAdapterEntitySummary[]> => {
  const height = readAtHeight(query);
  if (height !== null && height !== envHeight(ctx.env)) {
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
    for (const id of ids) {
      const loadedView = ctx.loadEntityViewPage
        ? await ctx.loadEntityViewPage(id, height, { limit: 1, accountsLimit: 1, booksLimit: 1 })
        : null;
      const loaded = !loadedView && ctx.loadEntityState ? await ctx.loadEntityState(id, height) : null;
      if (!loadedView && !loaded) {
        throw new RuntimeAdapterError('E_NOT_FOUND', `entity summary not found at height ${height}: ${normalizeEntityId(id)}`);
      }
      const profileName = loadedView ? String(loadedView.core.profile?.name || '').trim() : '';
      const isHub = loadedView
        ? loadedView.core.profile?.isHub === true || Boolean(loadedView.core.orderbookHubProfile)
        : loaded ? isHubState(loaded) : false;
      const jurisdiction = jurisdictionSummary(loadedView?.core.config?.jurisdiction ?? loaded?.config?.jurisdiction);
      summaries.push({
        entityId: normalizeEntityId(id),
        label: profileName || (loaded ? labelForState(loaded) : normalizeEntityId(id)),
        height: loadedView?.core.height ?? loaded?.height ?? height,
        ...(isHub ? { isHub: true } : {}),
        ...(jurisdiction ? { jurisdiction } : {}),
      });
    }
    return summaries.sort((left, right) => compareAscii(left.entityId, right.entityId));
  }

  return Array.from(ctx.env.eReplicas?.values?.() ?? [])
    .map((replica) => {
      const isHub = isHubState(replica.state);
      const jurisdiction = jurisdictionSummary(replica.state.config?.jurisdiction);
      return {
        entityId: normalizeEntityId(replica.entityId),
        label: labelForState(replica.state),
        height: Math.max(0, Math.floor(Number(replica.state.height ?? 0))),
        ...(isHub ? { isHub: true } : {}),
        ...(jurisdiction ? { jurisdiction } : {}),
      };
    })
    .sort((left, right) => compareAscii(left.entityId, right.entityId));
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

const emptyPageMeta = (limit: number): Omit<RuntimeAdapterAccountPage, 'items'> => ({
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
    return singleAccountPage(accountId, account ? projectAccountDoc(account) : null, limit);
  }
  const cursor = normalizeEntityId(String(query?.accountsCursor ?? query?.cursor ?? ''));
  const pageIndex = readPageIndex(query?.accountsPage);
  const orderedKeys = sortedStringMapKeys(state.accounts as Map<string, unknown>);
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

const projectLiveEntityViewPage = (
  ctx: RuntimeAdapterResolveContext,
  entityId: string,
  query?: RuntimeAdapterReadQuery,
): {
  core: StorageEntityCoreDoc;
  accounts: RuntimeAdapterAccountPage;
  books: RuntimeAdapterBookPage;
} => {
  const replica = findReplica(ctx.env, entityId);
  if (!replica) throw new RuntimeAdapterError('E_NOT_FOUND', `entity not found: ${normalizeEntityId(entityId)}`);
  return {
    core: projectEntityCoreDoc(replica.state, replica),
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
  core: StorageEntityCoreDoc;
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

const compactAccountDocForView = (doc: StorageAccountDoc): StorageAccountDoc => ({
  ...doc,
  mempool: [],
  pendingSignatures: [],
  swapOffers: new Map(),
  swapOrderHistory: undefined,
  swapClosedOrders: undefined,
});

const compactMapTail = <K, V>(value: Map<K, V> | undefined, limit = 20): Map<K, V> | undefined =>
  value instanceof Map ? new Map(Array.from(value.entries()).slice(-limit)) : undefined;

const compactDebtLedgerForView = (
  value: StorageEntityCoreDoc['outDebtsByToken'] | StorageEntityCoreDoc['inDebtsByToken'],
  outerLimit = 20,
  innerLimit = 20,
): typeof value => {
  if (!(value instanceof Map)) return undefined;
  return new Map(Array.from(value.entries()).slice(0, outerLimit).map(([tokenId, bucket]) => [
    tokenId,
    bucket instanceof Map ? new Map(Array.from(bucket.entries()).slice(0, innerLimit)) : bucket,
  ]));
};

const compactEntityCoreForRemote = (core: StorageEntityCoreDoc): StorageEntityCoreDoc => {
  const compact: StorageEntityCoreDoc = {
    ...core,
    entityEncPrivKey: '',
    messages: core.messages.slice(-20),
    proposals: new Map(Array.from(core.proposals.entries()).slice(-20)),
    jBlockObservations: core.jBlockObservations.slice(-20),
    jBlockChain: core.jBlockChain.slice(-20),
    htlcRoutes: compactMapTail(core.htlcRoutes, 20) ?? new Map(),
    lockBook: new Map(Array.from(core.lockBook.entries()).slice(-20)),
  };

  const deferredAccountProposals = compactMapTail(core.deferredAccountProposals, 20);
  if (deferredAccountProposals) compact.deferredAccountProposals = deferredAccountProposals;
  if (core.batchHistory) compact.batchHistory = core.batchHistory.slice(-20);
  if (core.accountInputQueue) compact.accountInputQueue = core.accountInputQueue.slice(-20);
  const htlcNotes = compactMapTail(core.htlcNotes, 20);
  if (htlcNotes) compact.htlcNotes = htlcNotes;
  const outDebtsByToken = compactDebtLedgerForView(core.outDebtsByToken);
  if (outDebtsByToken) compact.outDebtsByToken = outDebtsByToken;
  const inDebtsByToken = compactDebtLedgerForView(core.inDebtsByToken);
  if (inDebtsByToken) compact.inDebtsByToken = inDebtsByToken;
  const pendingSwapFillRatios = compactMapTail(core.pendingSwapFillRatios, 20);
  if (pendingSwapFillRatios) compact.pendingSwapFillRatios = pendingSwapFillRatios;
  const crossJurisdictionSwaps = compactMapTail(core.crossJurisdictionSwaps, 20);
  if (crossJurisdictionSwaps) compact.crossJurisdictionSwaps = crossJurisdictionSwaps;
  const pendingCrossJurisdictionFillAcks = compactMapTail(core.pendingCrossJurisdictionFillAcks, 20);
  if (pendingCrossJurisdictionFillAcks) compact.pendingCrossJurisdictionFillAcks = pendingCrossJurisdictionFillAcks;
  const crossJurisdictionBookAdmissions = compactMapTail(core.crossJurisdictionBookAdmissions, 20);
  if (crossJurisdictionBookAdmissions) compact.crossJurisdictionBookAdmissions = crossJurisdictionBookAdmissions;
  const orderbookReferrals = compactMapTail(core.orderbookReferrals, 20);
  if (orderbookReferrals) compact.orderbookReferrals = orderbookReferrals;
  return compact;
};

const accountCounterpartyIdForView = (entityId: string, doc: StorageAccountDoc): string => {
  const normalized = normalizeEntityId(entityId);
  const left = normalizeEntityId(doc.leftEntity);
  const right = normalizeEntityId(doc.rightEntity);
  return left === normalized ? right : left;
};

const absoluteBigInt = (value: bigint): bigint => value < 0n ? -value : value;

const accountPageSummaryForView = (
  entityId: string,
  page: RuntimeAdapterAccountPage,
): RuntimeAdapterAccountPageSummary => {
  const limit = Math.max(1, Number(page.limit ?? (page.items.length || 1)));
  const totalItems = Number.isFinite(Number(page.totalItems)) ? Math.max(0, Math.floor(Number(page.totalItems))) : null;
  const pageIndex = Number.isFinite(Number(page.pageIndex)) ? Math.max(0, Math.floor(Number(page.pageIndex))) : null;
  const pageCount = Number.isFinite(Number(page.pageCount)) ? Math.max(0, Math.floor(Number(page.pageCount))) : null;
  const sampleIds = page.items.slice(0, 8).map((doc) => accountCounterpartyIdForView(entityId, doc));
  const pageStateHashes = Array.from(new Set(page.items
    .map((doc) => String(doc.currentFrame?.stateHash || doc.currentDisputeProofBodyHash || doc.counterpartyDisputeProofBodyHash || '').trim())
    .filter(Boolean)))
    .slice(0, 8);
  const visibleTopDeltas = page.items
    .flatMap((doc) => {
      const counterpartyId = accountCounterpartyIdForView(entityId, doc);
      return Array.from(doc.deltas.entries()).map(([tokenId, delta]) => {
        const netDelta = BigInt(delta.offdelta ?? 0n) + BigInt(delta.ondelta ?? 0n);
        return {
          counterpartyId,
          tokenId: Number(delta.tokenId ?? tokenId),
          delta: String(netDelta),
          magnitude: absoluteBigInt(netDelta),
        };
      });
    })
    .sort((left, right) => {
      if (left.magnitude === right.magnitude) return compareAscii(left.counterpartyId, right.counterpartyId);
      return left.magnitude > right.magnitude ? -1 : 1;
    })
    .slice(0, 8)
    .map(({ counterpartyId, tokenId, delta }) => ({ counterpartyId, tokenId, delta }));

  return {
    totalItems,
    visibleItems: page.items.length,
    limit,
    pageIndex,
    pageCount,
    hasMore: Boolean(page.nextCursor) || (totalItems !== null && pageIndex !== null && pageCount !== null && pageIndex + 1 < pageCount),
    sampleIds,
    pageStateHashes,
    visibleTopDeltas,
  };
};

const compactBookSideForView = (
  bucketIds: readonly bigint[],
  buckets: ReadonlyMap<string, PriceBucketState>,
  orderSource: ReadonlyMap<string, BookOrderState>,
  maxLevels: number,
  maxOrdersPerLevel: number,
): {
  bucketIds: bigint[];
  buckets: Map<string, PriceBucketState>;
  orders: Map<string, BookOrderState>;
  levels: number;
} => {
  const nextBucketIds: bigint[] = [];
  const nextBuckets = new Map<string, PriceBucketState>();
  const nextOrders = new Map<string, BookOrderState>();
  let levels = 0;

  for (const bucketId of bucketIds) {
    if (levels >= maxLevels) break;
    const sourceBucket = buckets.get(String(bucketId));
    if (!sourceBucket) continue;
    const nextPrices: bigint[] = [];
    const nextLevels = new Map<string, PriceLevelState>();
    for (const priceTicks of sourceBucket.pricesAsc) {
      if (levels >= maxLevels) break;
      const sourceLevel = sourceBucket.levels.get(String(priceTicks));
      if (!sourceLevel) continue;
      if (sourceLevel.totalQtyLots <= 0n) continue;
      const selectedOrderIds: string[] = [];
      for (const orderId of sourceLevel.orderIds) {
        if (selectedOrderIds.length >= maxOrdersPerLevel) break;
        const order = orderSource.get(orderId);
        if (!order || order.qtyLots <= 0n) continue;
        selectedOrderIds.push(orderId);
        nextOrders.set(orderId, order);
      }
      if (selectedOrderIds.length === 0) continue;
      nextPrices.push(priceTicks);
      nextLevels.set(String(priceTicks), {
        priceTicks: sourceLevel.priceTicks,
        orderIds: selectedOrderIds,
        totalQtyLots: sourceLevel.totalQtyLots,
      });
      levels += 1;
    }
    if (nextLevels.size > 0) {
      nextBucketIds.push(bucketId);
      nextBuckets.set(String(bucketId), {
        bucketId: sourceBucket.bucketId,
        pricesAsc: nextPrices,
        levels: nextLevels,
      });
    }
  }

  return { bucketIds: nextBucketIds, buckets: nextBuckets, orders: nextOrders, levels };
};

const compactBookStateForView = (book: BookState, maxLevelsPerSide = 5, maxOrdersPerLevel = 20): BookState => {
  const bids = compactBookSideForView(
    book.bidBucketIdsDesc,
    book.bidBuckets,
    book.orders,
    maxLevelsPerSide,
    maxOrdersPerLevel,
  );
  const asks = compactBookSideForView(
    book.askBucketIdsAsc,
    book.askBuckets,
    book.orders,
    maxLevelsPerSide,
    maxOrdersPerLevel,
  );
  return {
    params: book.params,
    orders: new Map([...bids.orders, ...asks.orders]),
    bidBuckets: bids.buckets,
    askBuckets: asks.buckets,
    bidBucketIdsDesc: bids.bucketIds,
    askBucketIdsAsc: asks.bucketIds,
    nextSeq: book.nextSeq,
    tradeCount: book.tradeCount,
    tradeQtySum: book.tradeQtySum,
    eventHash: book.eventHash,
  };
};

const compactViewPageForRemote = (entityId: string, view: {
  core: StorageEntityCoreDoc;
  accounts: RuntimeAdapterAccountPage;
  books: RuntimeAdapterBookPage;
}): {
  core: StorageEntityCoreDoc;
  accounts: RuntimeAdapterAccountPage;
  books: RuntimeAdapterBookPage;
} => ({
  core: compactEntityCoreForRemote(view.core),
  accounts: {
    ...view.accounts,
    items: view.accounts.items.map(compactAccountDocForView),
    summary: accountPageSummaryForView(entityId, view.accounts),
  },
  books: {
    ...view.books,
    items: view.books.items.map((item) => ({
      pairId: item.pairId,
      book: compactBookStateForView(item.book),
    })),
  },
});

const storageHeadCanServeHeight = async (
  ctx: RuntimeAdapterResolveContext,
  height: number,
): Promise<boolean> => {
  if (height < 1) return false;
  if (!ctx.readHead) return false;
  const head = await ctx.readHead();
  if (!head) return false;
  return latestHeadHeight(head) >= height;
};

const loadStorageViewPageIfAvailable = async (
  ctx: RuntimeAdapterResolveContext,
  entityId: string,
  height: number,
  query?: RuntimeAdapterReadQuery,
): Promise<{
  core: StorageEntityCoreDoc;
  accounts: RuntimeAdapterAccountPage;
  books: RuntimeAdapterBookPage;
} | null> => {
  if (!ctx.loadEntityViewPage) return null;
  if (!await storageHeadCanServeHeight(ctx, height)) return null;
  const stored = await ctx.loadEntityViewPage!(entityId, height, query);
  return stored ?? null;
};

const loadViewPageForHeight = async (
  ctx: RuntimeAdapterResolveContext,
  entityId: string,
  height: number,
  isCurrentHeight: boolean,
  query?: RuntimeAdapterReadQuery,
): Promise<{
  core: StorageEntityCoreDoc;
  accounts: RuntimeAdapterAccountPage;
  books: RuntimeAdapterBookPage;
}> => {
  if (isCurrentHeight) {
    const stored = await loadStorageViewPageIfAvailable(ctx, entityId, height, query);
    return stored ?? projectLiveEntityViewPage(ctx, entityId, query);
  }
  return await loadRequiredEntityViewPage(ctx, entityId, height, query);
};

const projectViewFrame = async (
  ctx: RuntimeAdapterResolveContext,
  query?: RuntimeAdapterReadQuery,
): Promise<RuntimeAdapterViewFrame> => {
  const requestedHeight = readAtHeight(query);
  const currentEnvHeight = envHeight(ctx.env);
  const isCurrentHeight = requestedHeight === null || requestedHeight === currentEnvHeight;
  if (!isCurrentHeight && !ctx.readHead) {
    throw new RuntimeAdapterError('E_INTERNAL', 'storage head reader is required for historical reads');
  }
  const persistedHead = !isCurrentHeight ? await ctx.readHead!() : null;
  if (!isCurrentHeight && !persistedHead) {
    throw new RuntimeAdapterError('E_NOT_FOUND', `storage head not found at height ${requestedHeight}`);
  }
  if (!isCurrentHeight) {
    assertRequestedHeightAvailable(requestedHeight!, persistedHead!, 'view-frame');
  }
  const head = persistedHead ?? headFromEnv(ctx.env);
  const height = requestedHeight ?? currentEnvHeight;
  const heightQuery = height > 0 ? { ...query, atHeight: height } : query;
  const entities = await listEntitySummaries(ctx, heightQuery);
  const requestedEntityId = normalizeEntityId(String(query?.entityId || ''));
  const activeEntityId = requestedEntityId || entities[0]?.entityId || null;
  if (!activeEntityId) {
    return { head, height, entities, activeEntityId: null, activeEntity: null };
  }

  const accountQuery: RuntimeAdapterReadQuery = {
    ...heightQuery,
    limit: readBoundedLimit(query?.accountsLimit, query?.limit ?? 10),
  };
  const accountsCursor = query?.accountsCursor ?? query?.cursor;
  if (accountsCursor) accountQuery.cursor = accountsCursor;
  const bookQuery: RuntimeAdapterReadQuery = {
    ...heightQuery,
    limit: readBoundedLimit(query?.booksLimit, query?.limit ?? 10),
  };
  if (query?.booksCursor) bookQuery.cursor = query.booksCursor;

  const storedQuery: RuntimeAdapterReadQuery = {
    ...heightQuery,
  };
  if (accountQuery.limit !== undefined) {
    storedQuery.limit = accountQuery.limit;
    storedQuery.accountsLimit = accountQuery.limit;
  }
  if (accountQuery.cursor) storedQuery.accountsCursor = accountQuery.cursor;
  if (query?.accountId) storedQuery.accountId = query.accountId;
  if (query?.accountsPage !== undefined) storedQuery.accountsPage = query.accountsPage;
  if (bookQuery.limit !== undefined) storedQuery.booksLimit = bookQuery.limit;
  if (bookQuery.cursor) storedQuery.booksCursor = bookQuery.cursor;
  if (query?.booksPage !== undefined) storedQuery.booksPage = query.booksPage;
  const stored = await loadViewPageForHeight(ctx, activeEntityId, height, isCurrentHeight, storedQuery);
  const compactStored = compactViewPageForRemote(activeEntityId, stored);
  const fallbackJurisdiction = jurisdictionSummary(compactStored.core.config?.jurisdiction);
  const summary = entities.find((entity) => normalizeEntityId(entity.entityId) === activeEntityId) ?? {
    entityId: activeEntityId,
    label: String(compactStored.core.profile?.name || '').trim() || activeEntityId,
    height: Math.max(0, Math.floor(Number(compactStored.core.height ?? height))),
    ...(compactStored.core.profile?.isHub === true || Boolean(compactStored.core.orderbookHubProfile) ? { isHub: true } : {}),
    ...(fallbackJurisdiction ? { jurisdiction: fallbackJurisdiction } : {}),
  };

  return {
    head,
    height,
    entities,
    activeEntityId,
    activeEntity: {
      summary,
      core: compactStored.core,
      accounts: compactStored.accounts,
      books: compactStored.books,
    },
  };
};

export const resolveRuntimeAdapterRead = async <T = unknown>(
  ctx: RuntimeAdapterResolveContext,
  path: string,
  query?: RuntimeAdapterReadQuery,
): Promise<T> => {
  const parts = normalizePath(path);

  if (parts.length === 1 && parts[0] === 'head') {
    const requestedHeight = readAtHeight(query);
    const currentEnvHeight = envHeight(ctx.env);
    if (requestedHeight !== null && requestedHeight !== currentEnvHeight) {
      if (!ctx.readHead) {
        throw new RuntimeAdapterError('E_INTERNAL', 'storage head reader is required for historical reads');
      }
      const head = await ctx.readHead();
      if (!head) throw new RuntimeAdapterError('E_NOT_FOUND', `storage head not found at height ${requestedHeight}`);
      assertRequestedHeightAvailable(requestedHeight, head, 'head');
      return head as T;
    }
    return headFromEnv(ctx.env) as T;
  }

  if (parts.length === 1 && parts[0] === 'entities') {
    return await listEntitySummaries(ctx, query) as T;
  }

  if (parts.length === 1 && parts[0] === 'view-frame') {
    return await projectViewFrame(ctx, query) as T;
  }

  if (parts[0] === 'entity' && parts.length >= 2) {
    const entityId = parts[1];
    if (!entityId) throw new RuntimeAdapterError('E_BAD_PATH', 'entity id is required');

    if (parts.length === 3 && (parts[2] === 'accounts' || parts[2] === 'books' || parts[2] === 'book-docs')) {
      const height = readAtHeight(query);
      const targetHeight = height ?? envHeight(ctx.env);
      if (targetHeight < 1) throw new RuntimeAdapterError('E_BAD_QUERY', 'paged entity reads require a persisted runtime height');
      const accountId = normalizeEntityId(String(query?.accountId || ''));
      if (parts[2] === 'accounts' && accountId) {
        const limit = readBoundedLimit(query?.accountsLimit ?? query?.limit, 10);
        const isCurrentHeight = height === null || targetHeight === envHeight(ctx.env);
        if (isCurrentHeight) {
          const stored = ctx.loadEntityAccountDoc && await storageHeadCanServeHeight(ctx, targetHeight)
            ? await ctx.loadEntityAccountDoc(entityId, accountId, targetHeight)
            : null;
          if (stored) {
            const page = singleAccountPage(accountId, compactAccountDocForView(stored), limit);
            return { ...page, summary: accountPageSummaryForView(entityId, page) } as T;
          }
          const replica = findReplica(ctx.env, entityId);
          if (!replica) throw new RuntimeAdapterError('E_NOT_FOUND', `entity not found: ${normalizeEntityId(entityId)}`);
          const account = replica.state.accounts.get(accountId);
          const page = singleAccountPage(accountId, account ? compactAccountDocForView(projectAccountDoc(account)) : null, limit);
          return { ...page, summary: accountPageSummaryForView(entityId, page) } as T;
        }
        if (!ctx.loadEntityAccountDoc) {
          throw new RuntimeAdapterError('E_BAD_QUERY', 'historical account reads are unavailable for this adapter');
        }
        const account = await ctx.loadEntityAccountDoc(entityId, accountId, targetHeight);
        const page = singleAccountPage(accountId, account ? compactAccountDocForView(account) : null, limit);
        return { ...page, summary: accountPageSummaryForView(entityId, page) } as T;
      }
      const isCurrentHeight = height === null || targetHeight === envHeight(ctx.env);
      const stored = await loadViewPageForHeight(ctx, entityId, targetHeight, isCurrentHeight, query);
      const compactStored = compactViewPageForRemote(entityId, stored);
      return (parts[2] === 'accounts' ? compactStored.accounts : compactStored.books) as T;
    }

    if (parts.length === 4 && parts[2] === 'account') {
      const counterpartyId = normalizeEntityId(parts[3] ?? '');
      const height = readAtHeight(query);
      if (height !== null && height !== envHeight(ctx.env)) {
        if (!ctx.loadEntityAccountDoc) {
          throw new RuntimeAdapterError('E_BAD_QUERY', 'historical account reads are unavailable for this adapter');
        }
        const loaded = await ctx.loadEntityAccountDoc(entityId, counterpartyId, height);
        if (!loaded) throw new RuntimeAdapterError('E_NOT_FOUND', `account not found at height ${height}: ${normalizeEntityId(entityId)}/${counterpartyId}`);
        return loaded as T;
      }
      const { state } = await resolveEntityState(ctx, entityId, query);
      const account = state.accounts.get(counterpartyId);
      if (!account) throw new RuntimeAdapterError('E_NOT_FOUND', `account not found: ${normalizeEntityId(entityId)}/${counterpartyId}`);
      return projectAccountDoc(account) as T;
    }

    const { state, replica } = await resolveEntityState(ctx, entityId, query);

    if (parts.length === 2) {
      return projectEntityCoreDoc(state, replica) as StorageEntityCoreDoc as T;
    }
  }

  if (parts[0] === 'frame' && parts.length === 2) {
    if (!ctx.readFrame) throw new RuntimeAdapterError('E_BAD_QUERY', 'frame reads are unavailable for this adapter');
    const height = parts[1] === 'latest' ? envHeight(ctx.env) : Number(parts[1]);
    if (!Number.isFinite(height) || height < 1) throw new RuntimeAdapterError('E_BAD_PATH', 'frame height must be a positive integer or latest');
    const frame = await ctx.readFrame(Math.floor(height));
    if (!frame) throw new RuntimeAdapterError('E_NOT_FOUND', `frame not found: ${Math.floor(height)}`);
    return frame as T;
  }

  if (parts.length === 1 && parts[0] === 'checkpoints') {
    const heights = ctx.listCheckpoints ? await ctx.listCheckpoints() : [];
    return heights.map((height) => ({ height, timestamp: null })) as T;
  }

  throw new RuntimeAdapterError('E_BAD_PATH', `unsupported adapter path: ${path}`);
};
