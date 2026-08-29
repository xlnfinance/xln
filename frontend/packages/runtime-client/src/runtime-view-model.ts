import type { RuntimeAdapterStatus } from './runtime-handle';

type RuntimeViewPage = Readonly<{
  items: readonly unknown[];
  totalItems?: number;
  pageIndex?: number;
  pageCount?: number;
  prevCursor?: string | null;
  nextCursor?: string | null;
}>;

export type RuntimeViewFrameModel = Readonly<{
  height?: unknown;
  activeEntityId?: unknown;
  activeEntity?: Readonly<{
    summary?: Readonly<{ entityId?: unknown }>;
    core?: Readonly<{ entityId?: unknown }>;
    accounts: RuntimeViewPage;
    books: RuntimeViewPage;
  }> | null;
}>;

type RuntimeViewHeightModel = Readonly<{
  atHeight: number | null;
  frame?: Readonly<{ height?: unknown }> | null;
}>;

export type RuntimeViewHistoryScanState = {
  loading: boolean;
  error: string | null;
  requestedHeight: number | null;
  scannedHeight: number | null;
  latestHeight: number | null;
  framesCached: number;
  durationMs: number | null;
  accountsShown: number | null;
  accountsTotal: number | null;
  booksShown: number | null;
  booksTotal: number | null;
  endpoint: string;
};

export type RuntimeViewPageInfo = {
  entityId: string;
  accountsShown: number;
  accountsTotal: number;
  accountsPageIndex: number;
  accountsPageCount: number;
  accountsPrevCursor: string | null;
  accountsNextCursor: string | null;
  accountsHasMore: boolean;
  booksShown: number;
  booksTotal: number;
  booksPageIndex: number;
  booksPageCount: number;
  booksPrevCursor: string | null;
  booksNextCursor: string | null;
  booksHasMore: boolean;
};

export const normalizeEntityIdForRuntimeView = (value: unknown): string =>
  String(value || '').trim().toLowerCase();

export const runtimeViewPageInfoFromFrame = (
  frame: RuntimeViewFrameModel,
): RuntimeViewPageInfo | null => {
  const active = frame.activeEntity;
  const entityId = normalizeEntityIdForRuntimeView(
    frame.activeEntityId || active?.summary?.entityId || active?.core?.entityId,
  );
  if (!active || !entityId) return null;
  const accountsPageIndex = active.accounts.pageIndex ?? 0;
  const accountsPageCount = active.accounts.pageCount ?? 1;
  const booksPageIndex = active.books.pageIndex ?? 0;
  const booksPageCount = active.books.pageCount ?? 1;
  return {
    entityId,
    accountsShown: active.accounts.items.length,
    accountsTotal: active.accounts.totalItems ?? active.accounts.items.length,
    accountsPageIndex,
    accountsPageCount,
    accountsPrevCursor: active.accounts.prevCursor ?? null,
    accountsNextCursor: active.accounts.nextCursor ?? null,
    accountsHasMore: accountsPageIndex + 1 < accountsPageCount && !!active.accounts.nextCursor,
    booksShown: active.books.items.length,
    booksTotal: active.books.totalItems ?? active.books.items.length,
    booksPageIndex,
    booksPageCount,
    booksPrevCursor: active.books.prevCursor ?? null,
    booksNextCursor: active.books.nextCursor ?? null,
    booksHasMore: booksPageIndex + 1 < booksPageCount && !!active.books.nextCursor,
  };
};

export const runtimeViewPageNeedsNavigation = (
  pageInfo: RuntimeViewPageInfo,
  kind?: 'accounts' | 'books',
): boolean => {
  const accountsNeedNavigation = pageInfo.accountsPageIndex > 0 || pageInfo.accountsPageCount > 1;
  const booksNeedNavigation = pageInfo.booksPageIndex > 0 || pageInfo.booksPageCount > 1;
  if (kind === 'accounts') return accountsNeedNavigation;
  if (kind === 'books') return booksNeedNavigation;
  return accountsNeedNavigation || booksNeedNavigation;
};

export const normalizeRuntimeViewAtHeight = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const height = Math.floor(Number(value));
  if (!Number.isFinite(height) || height < 1) {
    throw new Error('RuntimeView historical height must be a positive integer');
  }
  return height;
};

export const runtimeViewQueryAtHeight = <Query extends object>(
  query: Query,
  atHeight: number | null,
): Query & { atHeight?: number } => {
  const next: Query & { atHeight?: number } = { ...query };
  if (atHeight === null) delete next.atHeight;
  else next.atHeight = atHeight;
  return next;
};

export const runtimeViewFrameMatchesAtHeight = (
  frame: Readonly<{ height?: unknown }> | null | undefined,
  atHeight: number | null,
): boolean => {
  if (!frame) return false;
  if (atHeight === null) return true;
  return Math.max(0, Math.floor(Number(frame.height || 0))) === atHeight;
};

export const runtimeViewTracksHeightAdvance = (
  view: RuntimeViewHeightModel,
  status: RuntimeAdapterStatus,
  nextHeight: number,
): boolean => {
  if (view.atHeight !== null || status !== 'connected' || nextHeight <= 0) return false;
  const frameHeight = Math.max(0, Math.floor(Number(view.frame?.height || 0)));
  return nextHeight > frameHeight;
};

export const runtimeViewNeedsHeightRefresh = (
  view: RuntimeViewHeightModel,
  status: RuntimeAdapterStatus,
  nextHeight: number,
): boolean => !!view.frame && runtimeViewTracksHeightAdvance(view, status, nextHeight);

export const assertRuntimeViewIsLive = (view: Readonly<{ atHeight: number | null }>): void => {
  if (view.atHeight === null) return;
  throw new Error(`RUNTIME_COMMAND_REQUIRES_LIVE_VIEW: selected=h${view.atHeight}`);
};

export const emptyRuntimeViewHistoryScan = (endpoint = ''): RuntimeViewHistoryScanState => ({
  loading: false,
  error: null,
  requestedHeight: null,
  scannedHeight: null,
  latestHeight: null,
  framesCached: 0,
  durationMs: null,
  accountsShown: null,
  accountsTotal: null,
  booksShown: null,
  booksTotal: null,
  endpoint,
});
