import type { BookState } from '../orderbook';
import type { AccountMachine, EntityReplica, EntityState, Env } from '../types';
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

const compareAscii = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareForDirection = (left: string, right: string, direction: 'asc' | 'desc'): number =>
  direction === 'desc' ? compareAscii(right, left) : compareAscii(left, right);

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

const pushBoundedItem = <T>(
  items: T[],
  item: T,
  sortId: (item: T) => string,
  limit: number,
  direction: 'asc' | 'desc',
): void => {
  let insertAt = items.length;
  while (insertAt > 0 && compareForDirection(sortId(item), sortId(items[insertAt - 1]!), direction) < 0) {
    insertAt -= 1;
  }
  items.splice(insertAt, 0, item);
  if (items.length > limit + 1) items.pop();
};

const isAfterCursor = (id: string, cursor: string, direction: 'asc' | 'desc'): boolean => {
  if (!cursor) return true;
  const order = compareAscii(id, cursor);
  return direction === 'desc' ? order < 0 : order > 0;
};

const projectLiveAccountsPage = (
  state: EntityState,
  query?: RuntimeAdapterReadQuery,
): RuntimeAdapterAccountPage => {
  const limit = readBoundedLimit(query?.accountsLimit ?? query?.limit, 10);
  const cursor = normalizeEntityId(String(query?.accountsCursor ?? query?.cursor ?? ''));
  const direction = query?.sortDir === 'desc' ? 'desc' : 'asc';
  const candidates: Array<{ id: string; account: AccountMachine }> = [];
  for (const [rawId, account] of state.accounts.entries()) {
    const id = normalizeEntityId(rawId);
    if (!isAfterCursor(id, cursor, direction)) continue;
    pushBoundedItem(candidates, { id, account }, entry => entry.id, limit, direction);
  }
  const visible = candidates.slice(0, limit);
  return {
    items: visible.map(({ account }) => projectAccountDoc(account)),
    nextCursor: candidates.length > limit ? visible[visible.length - 1]?.id ?? null : null,
  };
};

const projectLiveBooksPage = (
  state: EntityState,
  query?: RuntimeAdapterReadQuery,
): RuntimeAdapterBookPage => {
  const limit = readBoundedLimit(query?.booksLimit ?? query?.limit, 10);
  const cursor = String(query?.booksCursor ?? query?.cursor ?? '').trim();
  const direction = query?.sortDir === 'desc' ? 'desc' : 'asc';
  const candidates: Array<{ pairId: string; book: BookState }> = [];
  const books = state.orderbookExt?.books;
  for (const [rawPairId, book] of books?.entries?.() ?? []) {
    const pairId = String(rawPairId);
    if (!isAfterCursor(pairId, cursor, direction)) continue;
    pushBoundedItem(candidates, { pairId, book }, entry => entry.pairId, limit, direction);
  }
  const visible = candidates.slice(0, limit);
  return {
    items: visible.map(({ pairId, book }) => ({ pairId, book })),
    nextCursor: candidates.length > limit ? visible[visible.length - 1]?.pairId ?? null : null,
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
  const envHeight = Math.max(0, Math.floor(Number(ctx.env.height ?? 0)));
  const isCurrentHeight = requestedHeight === null || requestedHeight === envHeight;
  const persistedHead = !isCurrentHeight && ctx.readHead ? await ctx.readHead() : null;
  const head = persistedHead ?? headFromEnv(ctx.env);
  const height = requestedHeight ?? envHeight;
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
  if (accountQuery.limit !== undefined) storedQuery.limit = accountQuery.limit;
  if (accountQuery.limit !== undefined) storedQuery.accountsLimit = accountQuery.limit;
  if (accountQuery.cursor) storedQuery.accountsCursor = accountQuery.cursor;
  if (bookQuery.limit !== undefined) storedQuery.booksLimit = bookQuery.limit;
  if (bookQuery.cursor) storedQuery.booksCursor = bookQuery.cursor;
  const stored = isCurrentHeight
    ? projectLiveEntityViewPage(ctx, activeEntityId, storedQuery)
    : await loadRequiredEntityViewPage(ctx, activeEntityId, height, storedQuery);
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
};

export const resolveRuntimeAdapterRead = async <T = unknown>(
  ctx: RuntimeAdapterResolveContext,
  path: string,
  query?: RuntimeAdapterReadQuery,
): Promise<T> => {
  const parts = normalizePath(path);

  if (parts.length === 1 && parts[0] === 'head') {
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
      const targetHeight = height ?? Math.max(0, Math.floor(Number(ctx.env.height ?? 0)));
      if (targetHeight < 1) throw new RuntimeAdapterError('E_BAD_QUERY', 'paged entity reads require a persisted runtime height');
      const stored = height === null || targetHeight === Math.max(0, Math.floor(Number(ctx.env.height ?? 0)))
        ? projectLiveEntityViewPage(ctx, entityId, query)
        : await loadRequiredEntityViewPage(ctx, entityId, targetHeight, query);
      return (parts[2] === 'accounts' ? stored.accounts : stored.books) as T;
    }

    if (parts.length === 4 && parts[2] === 'account') {
      const counterpartyId = normalizeEntityId(parts[3] ?? '');
      const height = readAtHeight(query);
      if (height !== null && height !== ctx.env.height) {
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
