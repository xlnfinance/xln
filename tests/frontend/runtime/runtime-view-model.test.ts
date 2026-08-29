import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  assertRuntimeViewIsLive,
  emptyRuntimeViewHistoryScan,
  normalizeEntityIdForRuntimeView,
  normalizeRuntimeViewAtHeight,
  runtimeViewFrameMatchesAtHeight,
  runtimeViewNeedsHeightRefresh,
  runtimeViewPageInfoFromFrame,
  runtimeViewPageNeedsNavigation,
  runtimeViewQueryAtHeight,
  runtimeViewTracksHeightAdvance,
  type RuntimeViewFrameModel,
} from '../../../frontend/packages/runtime-client/src/runtime-view-model';

const frame = {
  height: 7,
  activeEntityId: ' 0xENTITY-A ',
  activeEntity: {
    summary: { entityId: '0xentity-summary' },
    core: { entityId: '0xentity-core' },
    accounts: {
      items: [{ id: 'a1' }, { id: 'a2' }],
      totalItems: 5,
      pageIndex: 1,
      pageCount: 3,
      prevCursor: 'accounts-0',
      nextCursor: 'accounts-2',
    },
    books: {
      items: [{ id: 'b1' }],
      totalItems: 1,
      pageIndex: 0,
      pageCount: 1,
      prevCursor: null,
      nextCursor: null,
    },
  },
} satisfies RuntimeViewFrameModel;

describe('runtime-client RuntimeView model boundary', () => {
  test('normalizes Runtime Entity identities', () => {
    expect(normalizeEntityIdForRuntimeView(' 0xENTITY-A ')).toBe('0xentity-a');
    expect(normalizeEntityIdForRuntimeView(null)).toBe('');
  });

  test('derives bounded pagination metadata from a projected frame', () => {
    expect(runtimeViewPageInfoFromFrame(frame)).toEqual({
      entityId: '0xentity-a',
      accountsShown: 2,
      accountsTotal: 5,
      accountsPageIndex: 1,
      accountsPageCount: 3,
      accountsPrevCursor: 'accounts-0',
      accountsNextCursor: 'accounts-2',
      accountsHasMore: true,
      booksShown: 1,
      booksTotal: 1,
      booksPageIndex: 0,
      booksPageCount: 1,
      booksPrevCursor: null,
      booksNextCursor: null,
      booksHasMore: false,
    });
  });

  test('returns no pagination metadata without an active Entity projection', () => {
    expect(runtimeViewPageInfoFromFrame({ activeEntityId: '0xentity-a' })).toBeNull();
    expect(runtimeViewPageInfoFromFrame({
      activeEntity: { accounts: { items: [] }, books: { items: [] } },
    })).toBeNull();
  });

  test('defaults absent page metadata to the projected item counts', () => {
    const pageInfo = runtimeViewPageInfoFromFrame({
      activeEntity: {
        core: { entityId: '0xentity-a' },
        accounts: { items: [{}, {}] },
        books: { items: [{}] },
      },
    });

    expect(pageInfo).toMatchObject({
      accountsShown: 2,
      accountsTotal: 2,
      accountsPageIndex: 0,
      accountsPageCount: 1,
      accountsHasMore: false,
      booksShown: 1,
      booksTotal: 1,
      booksPageIndex: 0,
      booksPageCount: 1,
      booksHasMore: false,
    });
  });

  test('reports navigation requirements per projected collection', () => {
    const pageInfo = runtimeViewPageInfoFromFrame(frame);
    expect(pageInfo).not.toBeNull();
    expect(runtimeViewPageNeedsNavigation(pageInfo!)).toBe(true);
    expect(runtimeViewPageNeedsNavigation(pageInfo!, 'accounts')).toBe(true);
    expect(runtimeViewPageNeedsNavigation(pageInfo!, 'books')).toBe(false);
  });

  test('normalizes historical heights and rejects invalid selections', () => {
    expect(normalizeRuntimeViewAtHeight(null)).toBeNull();
    expect(normalizeRuntimeViewAtHeight(undefined)).toBeNull();
    expect(normalizeRuntimeViewAtHeight(7.9)).toBe(7);
    expect(() => normalizeRuntimeViewAtHeight(0)).toThrow(
      'RuntimeView historical height must be a positive integer',
    );
    expect(() => normalizeRuntimeViewAtHeight(Number.NaN)).toThrow(
      'RuntimeView historical height must be a positive integer',
    );
  });

  test('adds or removes the historical query without mutating its input', () => {
    const query = { entityId: '0xentity-a', atHeight: 4, accountsLimit: 10 };
    expect(runtimeViewQueryAtHeight(query, 7)).toEqual({ ...query, atHeight: 7 });
    expect(runtimeViewQueryAtHeight(query, null)).toEqual({
      entityId: '0xentity-a',
      accountsLimit: 10,
    });
    expect(query.atHeight).toBe(4);
  });

  test('matches live frames and exact historical heights', () => {
    expect(runtimeViewFrameMatchesAtHeight(frame, null)).toBe(true);
    expect(runtimeViewFrameMatchesAtHeight(frame, 7)).toBe(true);
    expect(runtimeViewFrameMatchesAtHeight(frame, 8)).toBe(false);
    expect(runtimeViewFrameMatchesAtHeight(null, null)).toBe(false);
  });

  test('tracks committed height advances before requiring a frame refresh', () => {
    const loadingLiveView = { atHeight: null, frame: null };
    const projectedLiveView = { atHeight: null, frame: { height: 10 } };

    expect(runtimeViewTracksHeightAdvance(loadingLiveView, 'connected', 11)).toBe(true);
    expect(runtimeViewNeedsHeightRefresh(loadingLiveView, 'connected', 11)).toBe(false);
    expect(runtimeViewNeedsHeightRefresh(projectedLiveView, 'connected', 11)).toBe(true);
    expect(runtimeViewTracksHeightAdvance(projectedLiveView, 'connecting', 11)).toBe(false);
    expect(runtimeViewTracksHeightAdvance({ ...projectedLiveView, atHeight: 10 }, 'connected', 11))
      .toBe(false);
  });

  test('rejects commands from historical views and initializes scan state', () => {
    expect(() => assertRuntimeViewIsLive({ atHeight: null })).not.toThrow();
    expect(() => assertRuntimeViewIsLive({ atHeight: 7 }))
      .toThrow('RUNTIME_COMMAND_REQUIRES_LIVE_VIEW: selected=h7');
    expect(emptyRuntimeViewHistoryScan('wss://runtime.example')).toEqual({
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
      endpoint: 'wss://runtime.example',
    });
  });

  test('keeps concrete Runtime reads and writable publication in the Svelte adapter', () => {
    const boundary = readFileSync(
      'frontend/packages/runtime-client/src/runtime-view-model.ts',
      'utf8',
    );
    const publication = readFileSync(
      'frontend/packages/runtime-client/src/runtime-view-publication.ts',
      'utf8',
    );
    const store = readFileSync('frontend/src/lib/stores/runtimeViewStore.ts', 'utf8');

    expect(boundary).not.toContain('svelte');
    expect(boundary).not.toContain('@xln/core');
    expect(boundary).not.toContain('runtimeQueryClient');
    expect(boundary).not.toContain('writable');
    expect(store).toContain("from '../../../packages/runtime-client/src/runtime-view-model'");
    expect(store).toContain('runtimeQueryClient.readViewFrame(query)');
    expect(publication).toContain('const requestStillCurrent = (): boolean =>');
    expect(store).toContain('export const runtimeView = writable<RuntimeView>');
  });
});
