import type { EntityReplica } from '../../../entity/types';
import { normalizeEntityId } from '../../../storage/keys';
import type { StorageHead } from '../../../storage/types';
import { compareAscii } from '../../../support/collections/sorted-map-index';
import { RuntimeAdapterError } from '../errors';
import type { RuntimeAdapterEntitySummary, RuntimeAdapterReadQuery } from '../types';
import {
  assertRequestedHeightAvailable,
  envHeight,
  isHubState,
  jurisdictionSummary,
  listEntitySummaries,
  loadViewPageForHeight,
  readAtHeight,
  readBestHead,
  readBoundedLimit,
  type RuntimeAdapterEntityCoreDoc,
  type RuntimeAdapterResolveContext,
} from './context';
import {
  compactViewPageForRemote,
  type RuntimeAdapterAccountViewPage,
  type RuntimeAdapterPortableBookPage,
} from './compact-view';

// The view-frame projection (entity list plus one active Entity page) at the
// live or a stored height, and the history batch of view-frames over heights.

type RuntimeAdapterViewEntityFrame = {
  summary: RuntimeAdapterEntitySummary;
  core: RuntimeAdapterEntityCoreDoc;
  accounts: RuntimeAdapterAccountViewPage;
  books: RuntimeAdapterPortableBookPage;
};

export type RuntimeAdapterViewFrame = {
  head: StorageHead;
  height: number;
  entities: RuntimeAdapterEntitySummary[];
  activeEntityId: string | null;
  activeEntity: RuntimeAdapterViewEntityFrame | null;
};

export type RuntimeAdapterHistoryFrameBatch = {
  requestedHeights: number[];
  frames: RuntimeAdapterViewFrame[];
  unavailable: Array<{
    height: number;
    code: string;
    message: string;
  }>;
};

const readHeightBatch = (query?: RuntimeAdapterReadQuery): number[] => {
  const raw = query?.heights;
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',').map((part) => part.trim()).filter(Boolean)
      : [];
  if (values.length === 0) throw new RuntimeAdapterError('E_BAD_QUERY', 'heights must contain at least one height');
  if (values.length > 128) throw new RuntimeAdapterError('E_BAD_QUERY', 'heights batch is capped at 128');
  const heights: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    const height = Number(value);
    if (!Number.isFinite(height) || height < 1 || !Number.isInteger(height)) {
      throw new RuntimeAdapterError('E_BAD_QUERY', 'heights must be positive integers');
    }
    if (seen.has(height)) continue;
    seen.add(height);
    heights.push(height);
  }
  return heights;
};

const scoreDefaultLiveEntity = (replica: EntityReplica): number => {
  const accountCount = Math.max(0, Math.floor(Number(replica.state?.accounts?.size ?? 0)));
  const bookCount = Math.max(0, Math.floor(Number(replica.state?.orderbookExt?.books?.size ?? 0)));
  const hubScore = isHubState(replica.state) ? 1 : 0;
  const height = Math.max(0, Math.floor(Number(replica.state?.height ?? 0)));
  return accountCount * 1_000_000 + bookCount * 1_000 + hubScore * 100 + Math.min(height, 99);
};

const chooseDefaultActiveEntityId = (
  ctx: RuntimeAdapterResolveContext,
  entities: RuntimeAdapterEntitySummary[],
): string | null => {
  if (entities.length === 0) return null;

  const available = new Set(entities.map((entity) => normalizeEntityId(entity.entityId)).filter(Boolean));
  let best: { entityId: string; score: number } | null = null;
  for (const replica of ctx.env.state.eReplicas?.values?.() ?? []) {
    const entityId = normalizeEntityId(replica.entityId);
    if (!entityId || !available.has(entityId)) continue;
    const score = scoreDefaultLiveEntity(replica);
    if (
      !best ||
      score > best.score ||
      (score === best.score && compareAscii(entityId, best.entityId) < 0)
    ) {
      best = { entityId, score };
    }
  }
  return best?.entityId ?? entities[0]?.entityId ?? null;
};

export const projectViewFrame = async (
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
  const head = persistedHead ?? await readBestHead(ctx);
  const height = requestedHeight ?? currentEnvHeight;
  const heightQuery = requestedHeight !== null && height > 0 ? { ...query, atHeight: height } : query;
  const requestedEntityId = normalizeEntityId(String(query?.entityId || ''));
  const entities = await listEntitySummaries(ctx, heightQuery, {
    allowPartial: !isCurrentHeight || Boolean(requestedEntityId),
  });
  const activeEntityId = requestedEntityId || chooseDefaultActiveEntityId(ctx, entities);
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
  const storedJurisdiction = jurisdictionSummary(compactStored.core.config?.jurisdiction);
  const summary = entities.find((entity) => normalizeEntityId(entity.entityId) === activeEntityId) ?? {
    entityId: activeEntityId,
    label: String(compactStored.core.profile?.name || '').trim() || activeEntityId,
    height: Math.max(0, Math.floor(Number(compactStored.core.height ?? height))),
    ...(compactStored.core.profile?.isHub === true ? { isHub: true } : {}),
    ...(storedJurisdiction ? { jurisdiction: storedJurisdiction } : {}),
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

export const projectHistoryFrameBatch = async (
  ctx: RuntimeAdapterResolveContext,
  query?: RuntimeAdapterReadQuery,
): Promise<RuntimeAdapterHistoryFrameBatch> => {
  const requestedHeights = readHeightBatch(query);
  const frames: RuntimeAdapterViewFrame[] = [];
  const unavailable: RuntimeAdapterHistoryFrameBatch['unavailable'] = [];
  const baseQuery: RuntimeAdapterReadQuery = { ...(query ?? {}) };
  delete baseQuery.heights;
  for (const height of requestedHeights) {
    try {
      frames.push(await projectViewFrame(ctx, { ...baseQuery, atHeight: height }));
    } catch (error) {
      // Storage reports an unretained height as null, which the projection
      // types as E_NOT_FOUND. Any other failure is real and propagates; text
      // matching used to turn unrelated storage errors into "unavailable".
      if (error instanceof RuntimeAdapterError && error.code === 'E_NOT_FOUND') {
        unavailable.push({ height, code: error.code, message: error.message });
        continue;
      }
      throw error;
    }
  }

  return { requestedHeights, frames, unavailable };
};
