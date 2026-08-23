import type { EntityReplica } from '../../entity/types';
import { compareAscii, sortedStringMapKeys, sortedStringMapStartIndex } from '../../support/collections/sorted-map-index';
import { normalizeEntityId } from '../keys';
import { projectAccountDoc, projectEntityCoreDoc } from '../read/projections';
import type { StorageEntityViewPage } from '../read/read';

export type StorageEntityViewQuery = {
  cursor?: string;
  limit?: number;
  accountsCursor?: string;
  booksCursor?: string;
  accountsLimit?: number;
  booksLimit?: number;
  sortDir?: 'asc' | 'desc';
};

const EMPTY_BOOKS_MAP: ReadonlyMap<string, unknown> = new Map();

const pageLimit = (value: number | undefined): number => {
  const raw = Number(value ?? 10);
  return Number.isFinite(raw) ? Math.max(1, Math.min(500, Math.floor(raw))) : 10;
};

/**
 * Cursor pagination over a hub-scale map (hundreds to thousands of accounts)
 * used to resort the full key set from scratch on every single page — an
 * O(N log N) sort plus an O(N) cursor scan per page, so draining one full
 * listing at the default page size cost O(N^2 log N). sortedStringMapKeys
 * caches the ascending key order on the map itself (invalidated only when a
 * key is added/removed), and the ascending path uses a binary-search cursor
 * seek — turning a full drain from O(N^2 log N) into O(N log N) total.
 */
const pageKeys = (
  map: ReadonlyMap<string, unknown>,
  cursor: string,
  limit: number,
  sortDir: 'asc' | 'desc',
): { visible: string[]; nextCursor: string | null } => {
  const ascending = sortedStringMapKeys(map);
  if (sortDir === 'asc') {
    const start = sortedStringMapStartIndex(ascending, cursor, -1, limit);
    const visible = ascending.slice(start, start + limit);
    return {
      visible,
      nextCursor: start + limit < ascending.length ? visible[visible.length - 1] ?? null : null,
    };
  }
  const ordered = [...ascending].reverse();
  const start = cursor ? ordered.findIndex(key => compareAscii(key, cursor) < 0) : 0;
  const from = start < 0 ? ordered.length : start;
  const visible = ordered.slice(from, from + limit);
  return {
    visible,
    nextCursor: from + limit < ordered.length ? visible[visible.length - 1] ?? null : null,
  };
};

export const findReplicaForEntityId = (
  replicas: Iterable<EntityReplica>,
  entityId: string,
): EntityReplica | undefined => {
  const normalized = normalizeEntityId(entityId);
  for (const replica of replicas) {
    if (normalizeEntityId(replica.entityId) === normalized) return replica;
  }
  return undefined;
};

const pageAccounts = (
  replica: EntityReplica,
  query: StorageEntityViewQuery | undefined,
): StorageEntityViewPage['accounts'] => {
  const accounts = replica.state.accounts;
  const page = pageKeys(
    accounts,
    normalizeEntityId(String(query?.accountsCursor ?? query?.cursor ?? '')),
    pageLimit(query?.accountsLimit ?? query?.limit),
    query?.sortDir === 'desc' ? 'desc' : 'asc',
  );
  return {
    items: page.visible.map(id => {
      const account = accounts.get(id);
      if (!account) throw new Error(`STORAGE_REPLAY_ACCOUNT_MISSING:${id}`);
      return projectAccountDoc(account);
    }),
    nextCursor: page.nextCursor,
  };
};

const pageBooks = (
  replica: EntityReplica,
  query: StorageEntityViewQuery | undefined,
): StorageEntityViewPage['books'] => {
  const books = replica.state.orderbookExt?.books;
  const page = pageKeys(
    books ?? EMPTY_BOOKS_MAP,
    String(query?.booksCursor ?? (query?.accountsCursor ? '' : query?.cursor ?? '')).trim(),
    pageLimit(query?.booksLimit ?? query?.limit),
    'asc',
  );
  return {
    items: page.visible.map(pairId => {
      const book = books?.get(pairId);
      if (!book) throw new Error(`STORAGE_REPLAY_BOOK_MISSING:${pairId}`);
      return { pairId, book };
    }),
    nextCursor: page.nextCursor,
  };
};

export const projectEntityViewPageFromReplica = (
  replica: EntityReplica,
  query?: StorageEntityViewQuery,
): StorageEntityViewPage => ({
  core: projectEntityCoreDoc(replica.state),
  accounts: pageAccounts(replica, query),
  books: pageBooks(replica, query),
});
