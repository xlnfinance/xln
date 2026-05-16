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
  const stored = isCurrentHeight
    ? projectLiveEntityViewPage(ctx, activeEntityId, storedQuery)
    : await loadRequiredEntityViewPage(ctx, activeEntityId, height, storedQuery);
  const fallbackJurisdiction = jurisdictionSummary(stored.core.config?.jurisdiction);
  const summary = entities.find((entity) => normalizeEntityId(entity.entityId) === activeEntityId) ?? {
    entityId: activeEntityId,
    label: String(stored.core.profile?.name || '').trim() || activeEntityId,
    height: Math.max(0, Math.floor(Number(stored.core.height ?? height))),
    ...(stored.core.profile?.isHub === true || Boolean(stored.core.orderbookHubProfile) ? { isHub: true } : {}),
    ...(fallbackJurisdiction ? { jurisdiction: fallbackJurisdiction } : {}),
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
        if (height === null || targetHeight === envHeight(ctx.env)) {
          const replica = findReplica(ctx.env, entityId);
          if (!replica) throw new RuntimeAdapterError('E_NOT_FOUND', `entity not found: ${normalizeEntityId(entityId)}`);
          const account = replica.state.accounts.get(accountId);
          return singleAccountPage(accountId, account ? projectAccountDoc(account) : null, limit) as T;
        }
        if (!ctx.loadEntityAccountDoc) {
          throw new RuntimeAdapterError('E_BAD_QUERY', 'historical account reads are unavailable for this adapter');
        }
        const account = await ctx.loadEntityAccountDoc(entityId, accountId, targetHeight);
        return singleAccountPage(accountId, account, limit) as T;
      }
      const stored = height === null || targetHeight === envHeight(ctx.env)
        ? projectLiveEntityViewPage(ctx, entityId, query)
        : await loadRequiredEntityViewPage(ctx, entityId, targetHeight, query);
      return (parts[2] === 'accounts' ? stored.accounts : stored.books) as T;
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
