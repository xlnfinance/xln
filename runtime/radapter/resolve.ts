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
  listEntityIdsAtHeight?: (height: number) => Promise<string[]>;
};

export type RuntimeAdapterAccountPage = {
  items: StorageAccountDoc[];
  nextCursor: string | null;
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
  const raw = Number(query?.limit ?? 50);
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
      const loaded = ctx.loadEntityState ? await ctx.loadEntityState(id, height) : null;
      summaries.push({
        entityId: normalizeEntityId(id),
        label: loaded ? labelForState(loaded) : normalizeEntityId(id),
        height: loaded?.height ?? height,
      });
    }
    return summaries.sort((left, right) => left.entityId.localeCompare(right.entityId));
  }

  return Array.from(ctx.env.eReplicas?.values?.() ?? [])
    .map((replica) => ({
      entityId: normalizeEntityId(replica.entityId),
      label: labelForState(replica.state),
      height: Math.max(0, Math.floor(Number(replica.state.height ?? 0))),
    }))
    .sort((left, right) => left.entityId.localeCompare(right.entityId));
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
  const keys = Array.from(state.accounts?.keys?.() ?? [])
    .map((key) => normalizeEntityId(String(key)))
    .sort((left, right) => direction === 'desc' ? right.localeCompare(left) : left.localeCompare(right));

  const filtered = cursor
    ? keys.filter((key) => direction === 'desc' ? key < cursor : key > cursor)
    : keys;
  const pageKeys = filtered.slice(0, limit + 1);
  const visibleKeys = pageKeys.slice(0, limit);
  const items = visibleKeys.map((counterpartyId) => {
    const account = state.accounts.get(counterpartyId);
    if (!account) throw new RuntimeAdapterError('E_INTERNAL', `account index drift: ${normalized}/${counterpartyId}`);
    return projectAccountDoc(account);
  });
  return {
    items,
    nextCursor: pageKeys.length > limit ? visibleKeys[visibleKeys.length - 1] ?? null : null,
  };
};

const projectBooks = (state: EntityState): BookState[] => {
  const books = Array.from(state.orderbookExt?.books?.entries?.() ?? []);
  return books
    .sort(([left], [right]) => String(left).localeCompare(String(right)))
    .map(([, value]) => value);
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

  if (parts[0] === 'entity' && parts.length >= 2) {
    const entityId = parts[1];
    if (!entityId) throw new RuntimeAdapterError('E_BAD_PATH', 'entity id is required');
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
      return projectBooks(state) as T;
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
