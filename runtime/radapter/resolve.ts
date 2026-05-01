import type { BookState } from '../orderbook';
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
import { RuntimeAdapterError } from './errors';
import type { RuntimeAdapterEntitySummary, RuntimeAdapterReadQuery } from './types';

export type RuntimeAdapterResolveContext = {
  env: Env;
  readHead?: () => Promise<StorageHead | null>;
  readFrame?: (height: number) => Promise<StorageFrameRecord | null>;
  listCheckpoints?: () => Promise<number[]>;
  loadEntityState?: (entityId: string, height: number) => Promise<EntityState | null>;
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
};

export type RuntimeAdapterBookPage = {
  items: Array<{ pairId: string; book: BookState }>;
  nextCursor: string | null;
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

const readLimit = (query?: RuntimeAdapterReadQuery): number => {
  const raw = Number(query?.limit ?? 10);
  if (!Number.isFinite(raw)) throw new RuntimeAdapterError('E_BAD_QUERY', 'limit must be finite');
  return Math.max(1, Math.min(500, Math.floor(raw)));
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

const assertSupportedSort = (query?: RuntimeAdapterReadQuery): void => {
  const sortBy = String(query?.sortBy || '').trim();
  if (sortBy && sortBy !== 'counterparty') {
    throw new RuntimeAdapterError('E_BAD_QUERY', `unsupported sortBy: ${sortBy}`);
  }
};

const compareAscii = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

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

const headFromEnv = (env: Env): StorageHead => {
  const storage = env.runtimeConfig?.storage;
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: Math.max(0, Math.floor(Number(env.height ?? 0))),
    latestMaterializedHeight: Math.max(0, Math.floor(Number(env.height ?? 0))),
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
  if (height !== null && height !== ctx.env.height) {
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
  if (height !== null && height !== ctx.env.height && ctx.listEntityIdsAtHeight) {
    const ids = await ctx.listEntityIdsAtHeight(height);
    const summaries: RuntimeAdapterEntitySummary[] = [];
    for (const id of ids) {
      const loadedView = ctx.loadEntityViewPage
        ? await ctx.loadEntityViewPage(id, height, { limit: 1, accountsLimit: 1, booksLimit: 1 })
        : null;
      const loaded = !loadedView && ctx.loadEntityState ? await ctx.loadEntityState(id, height) : null;
      const profileName = loadedView ? String(loadedView.core.profile?.name || '').trim() : '';
      summaries.push({
        entityId: normalizeEntityId(id),
        label: profileName || (loaded ? labelForState(loaded) : normalizeEntityId(id)),
        height: loadedView?.core.height ?? loaded?.height ?? height,
      });
    }
    return summaries.sort((left, right) => compareAscii(left.entityId, right.entityId));
  }

  return Array.from(ctx.env.eReplicas?.values?.() ?? [])
    .map((replica) => ({
      entityId: normalizeEntityId(replica.entityId),
      label: labelForState(replica.state),
      height: Math.max(0, Math.floor(Number(replica.state.height ?? 0))),
    }))
    .sort((left, right) => compareAscii(left.entityId, right.entityId));
};

const projectAccountsPage = (
  entityId: string,
  state: EntityState,
  query?: RuntimeAdapterReadQuery,
): RuntimeAdapterAccountPage => {
  assertSupportedSort(query);
  const normalized = normalizeEntityId(entityId);
  const cursor = query?.cursor ? normalizeEntityId(query.cursor) : '';
  const limit = readLimit(query);
  const direction = query?.sortDir === 'desc' ? 'desc' : 'asc';
  const compare = (left: string, right: string): number =>
    direction === 'desc' ? compareAscii(right, left) : compareAscii(left, right);
  const isAfterCursor = (key: string): boolean =>
    !cursor || (direction === 'desc' ? key < cursor : key > cursor);
  const pageKeys: Array<{ raw: string; normalized: string }> = [];

  for (const rawKey of state.accounts?.keys?.() ?? []) {
    const raw = String(rawKey);
    const normalizedKey = normalizeEntityId(raw);
    if (!isAfterCursor(normalizedKey)) continue;
    let insertAt = pageKeys.length;
    while (insertAt > 0 && compare(normalizedKey, pageKeys[insertAt - 1]!.normalized) < 0) {
      insertAt -= 1;
    }
    pageKeys.splice(insertAt, 0, { raw, normalized: normalizedKey });
    if (pageKeys.length > limit + 1) pageKeys.pop();
  }

  const visibleKeys = pageKeys.slice(0, limit);
  const items = visibleKeys.map(({ raw, normalized: counterpartyId }) => {
    const account = state.accounts.get(raw);
    if (!account) throw new RuntimeAdapterError('E_INTERNAL', `account index drift: ${normalized}/${counterpartyId}`);
    return projectAccountDoc(account);
  });
  return {
    items,
    nextCursor: pageKeys.length > limit ? visibleKeys[visibleKeys.length - 1]?.normalized ?? null : null,
  };
};

const bestBidTicks = (book: BookState): bigint | null => {
  const bucketId = book.bidBucketIdsDesc[0];
  if (bucketId === undefined) return null;
  const bucket = book.bidBuckets.get(bucketId.toString());
  const price = bucket?.pricesAsc.at(-1);
  return price ?? null;
};

const bestAskTicks = (book: BookState): bigint | null => {
  const bucketId = book.askBucketIdsAsc[0];
  if (bucketId === undefined) return null;
  const bucket = book.askBuckets.get(bucketId.toString());
  const price = bucket?.pricesAsc[0];
  return price ?? null;
};

const bookSpreadSortKey = (book: BookState): bigint | null => {
  const bid = bestBidTicks(book);
  const ask = bestAskTicks(book);
  if (bid === null || ask === null) return null;
  return ask >= bid ? ask - bid : 0n;
};

const compareBooksNearSpread = (
  left: [string, BookState],
  right: [string, BookState],
): number => {
  const leftSpread = bookSpreadSortKey(left[1]);
  const rightSpread = bookSpreadSortKey(right[1]);
  if (leftSpread !== null && rightSpread !== null && leftSpread !== rightSpread) {
    return leftSpread < rightSpread ? -1 : 1;
  }
  if (leftSpread !== null && rightSpread === null) return -1;
  if (leftSpread === null && rightSpread !== null) return 1;
  return compareAscii(String(left[0]), String(right[0]));
};

const projectBookPage = (
  state: EntityState,
  limit = 10,
  query?: RuntimeAdapterReadQuery,
): RuntimeAdapterBookPage => {
  const cursor = String(query?.cursor || '').trim();
  const ordered = Array.from(state.orderbookExt?.books?.entries?.() ?? [])
    .map(([pairId, book]) => [String(pairId), book] as [string, BookState])
    .sort(compareBooksNearSpread);
  const startIndex = cursor ? ordered.findIndex(([pairId]) => pairId === cursor) + 1 : 0;
  const offset = Math.max(0, startIndex);
  const visible = ordered.slice(offset, offset + limit);
  return {
    items: visible.map(([pairId, book]) => ({ pairId, book })),
    nextCursor: offset + limit < ordered.length ? visible[visible.length - 1]?.[0] ?? null : null,
  };
};

const projectViewFrame = async (
  ctx: RuntimeAdapterResolveContext,
  query?: RuntimeAdapterReadQuery,
): Promise<RuntimeAdapterViewFrame> => {
  const persistedHead = ctx.readHead ? await ctx.readHead() : null;
  const head = persistedHead ?? headFromEnv(ctx.env);
  const requestedHeight = readAtHeight(query);
  const height = requestedHeight ?? Math.max(0, Math.floor(Number(head.latestHeight ?? ctx.env.height ?? 0)));
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

  if (height !== ctx.env.height && ctx.loadEntityViewPage) {
    const storedQuery: RuntimeAdapterReadQuery = {
      ...heightQuery,
    };
    if (accountQuery.limit !== undefined) storedQuery.limit = accountQuery.limit;
    if (accountQuery.limit !== undefined) storedQuery.accountsLimit = accountQuery.limit;
    if (accountQuery.cursor) storedQuery.accountsCursor = accountQuery.cursor;
    if (bookQuery.limit !== undefined) storedQuery.booksLimit = bookQuery.limit;
    if (bookQuery.cursor) storedQuery.booksCursor = bookQuery.cursor;
    const stored = await ctx.loadEntityViewPage(activeEntityId, height, storedQuery);
    if (stored) {
      const summary = entities.find((entity) => normalizeEntityId(entity.entityId) === activeEntityId) ?? {
        entityId: activeEntityId,
        label: String(stored.core.profile?.name || '').trim() || activeEntityId,
        height: Math.max(0, Math.floor(Number(stored.core.height ?? height))),
      };
      return {
        head,
        height,
        entities,
        activeEntityId,
        activeEntity: {
          summary,
          core: stored.core,
          accounts: stored.accounts,
          books: stored.books,
        },
      };
    }
  }

  const { state, replica } = await resolveEntityState(ctx, activeEntityId, heightQuery);
  const summary = entities.find((entity) => normalizeEntityId(entity.entityId) === activeEntityId) ?? {
    entityId: activeEntityId,
    label: labelForState(state),
    height: Math.max(0, Math.floor(Number(state.height ?? height))),
  };
  const accounts = projectAccountsPage(activeEntityId, state, accountQuery);
  const books = projectBookPage(state, bookQuery.limit, bookQuery);

  return {
    head,
    height,
    entities,
    activeEntityId,
    activeEntity: {
      summary,
      core: projectEntityCoreDoc(state, replica),
      accounts,
      books,
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
    const persisted = ctx.readHead ? await ctx.readHead() : null;
    return (persisted ?? headFromEnv(ctx.env)) as T;
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
      if (height !== null && height !== ctx.env.height && ctx.loadEntityViewPage) {
        const stored = await ctx.loadEntityViewPage(entityId, height, query);
        if (stored) return (parts[2] === 'accounts' ? stored.accounts : stored.books) as T;
      }
    }

    const { state, replica } = await resolveEntityState(ctx, entityId, query);

    if (parts.length === 2) {
      return projectEntityCoreDoc(state, replica) as StorageEntityCoreDoc as T;
    }

    if (parts.length === 3 && parts[2] === 'accounts') {
      return projectAccountsPage(entityId, state, query) as T;
    }

    if (parts.length === 4 && parts[2] === 'account') {
      const counterpartyId = normalizeEntityId(parts[3] ?? '');
      const account = state.accounts.get(counterpartyId);
      if (!account) throw new RuntimeAdapterError('E_NOT_FOUND', `account not found: ${normalizeEntityId(entityId)}/${counterpartyId}`);
      return projectAccountDoc(account) as T;
    }

    if (parts.length === 3 && parts[2] === 'books') {
      return projectBookPage(state, readBoundedLimit(query?.booksLimit, query?.limit ?? 10), query) as T;
    }

    if (parts.length === 3 && parts[2] === 'book-docs') {
      return projectBookPage(state, readBoundedLimit(query?.booksLimit, query?.limit ?? 10), query) as T;
    }
  }

  if (parts[0] === 'frame' && parts.length === 2) {
    if (!ctx.readFrame) throw new RuntimeAdapterError('E_BAD_QUERY', 'frame reads are unavailable for this adapter');
    const height = parts[1] === 'latest' ? Math.max(0, Math.floor(Number(ctx.env.height ?? 0))) : Number(parts[1]);
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
