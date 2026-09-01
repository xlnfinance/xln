import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type {
  RuntimeAdapterHistoryFrameBatch,
  RuntimeAdapterViewFrame,
} from '@xln/core/api/public/runtime-module';

import {
  assertTimeMachineHistorySelection,
  createRuntimeHistoryContext,
  createTimeMachineHistoryBatchQuery,
  createTimeMachineScanFailureState,
  createTimeMachineScanLoadingState,
  createTimeMachineScanSuccessState,
  getTimeMachineTransportErrorMessage,
  mergeRuntimeHistoryFrame,
  normalizeTimeMachineRequestedHeight,
  requireTimeMachineHistoryFrame,
  runtimeHistoryContextKey,
  runtimeHistoryFrameFromViewFrame,
} from '../../../frontend/packages/runtime-client/src/time-machine-transport';

const frameAt = (
  height: number,
  entityId = '0xabc',
  accountsPage = 0,
  booksPage = 0,
): RuntimeAdapterViewFrame => ({
  runtimeId: 'runtime-a',
  height,
  head: { latestHeight: height + 4 } as RuntimeAdapterViewFrame['head'],
  entities: [],
  activeEntityId: entityId,
  activeEntity: {
    summary: { entityId, label: 'Entity', height },
    core: { entityId, signerId: entityId, timestamp: height * 1_000, profile: { name: 'Entity' } },
    accounts: {
      items: [{ leftEntity: entityId, rightEntity: '0xpeer' }],
      totalItems: 3,
      pageIndex: accountsPage,
      pageCount: 3,
      nextCursor: 'accounts-next',
      prevCursor: accountsPage > 0 ? 'accounts-prev' : null,
    },
    books: {
      items: [{ pairId: 'ETH/USDC', book: { bids: [], asks: [] } }],
      totalItems: 2,
      pageIndex: booksPage,
      pageCount: 2,
      nextCursor: 'books-next',
      prevCursor: booksPage > 0 ? 'books-prev' : null,
    },
  },
} as RuntimeAdapterViewFrame);

describe('Time Machine transport model', () => {
  test('normalizes positive heights and complete Runtime history context identity', () => {
    const context = createRuntimeHistoryContext({
      runtimeId: ' Runtime-A ', mode: 'remote', entityId: ' 0xABC ', accountsPage: 1.9, booksPage: -3,
    });

    expect(normalizeTimeMachineRequestedHeight(7.9)).toBe(7);
    expect(normalizeTimeMachineRequestedHeight(0)).toBe(1);
    expect(normalizeTimeMachineRequestedHeight(-4)).toBe(1);
    expect(() => normalizeTimeMachineRequestedHeight('not-a-height')).toThrow(
      'Remote Time Machine height must be a positive integer',
    );
    expect(context).toEqual({
      runtimeId: 'runtime-a', mode: 'remote', entityId: '0xabc', accountsPage: 1, booksPage: 0,
    });
    expect(runtimeHistoryContextKey(context)).toBe('runtime-a|remote|0xabc|1|0');
  });

  test('projects typed view frames and merges a bounded immutable height tail', () => {
    const one = runtimeHistoryFrameFromViewFrame({ runtimeId: ' Runtime-A ', mode: 'remote', frame: frameAt(1) });
    const two = runtimeHistoryFrameFromViewFrame({ runtimeId: 'runtime-a', mode: 'remote', frame: frameAt(2) });
    const replacement = runtimeHistoryFrameFromViewFrame({
      runtimeId: 'runtime-a', mode: 'remote', frame: frameAt(2, '0xreplacement'),
    });
    const source = [one, two];
    const merged = mergeRuntimeHistoryFrame(source, replacement, 1);

    expect(one).toMatchObject({ runtimeId: 'runtime-a', height: 1, timestamp: 1_000, activeEntityId: '0xabc' });
    expect(one.pageInfo).toMatchObject({ accountsShown: 1, accountsTotal: 3, booksShown: 1, booksTotal: 2 });
    expect(merged.map(({ height }) => height)).toEqual([2]);
    expect(merged[0]?.activeEntityId).toBe('0xreplacement');
    expect(source.map(({ activeEntityId }) => activeEntityId)).toEqual(['0xabc', '0xabc']);
  });

  test('builds the exact one-height batched transport query', () => {
    expect(createTimeMachineHistoryBatchQuery(
      { entityId: '0xabc', accountsPage: 2.8, booksPage: -1 },
      12,
      25.9,
    )).toEqual({
      entityId: '0xabc', accountsLimit: 25, booksLimit: 25,
      accountsPage: 2, booksPage: 0, heights: [12],
    });
  });

  test('selects only the requested frame and preserves unavailable evidence', () => {
    const batch: RuntimeAdapterHistoryFrameBatch = {
      requestedHeights: [7],
      frames: [frameAt(7)],
      unavailable: [],
    };
    expect(requireTimeMachineHistoryFrame(batch, 7).height).toBe(7);
    expect(() => requireTimeMachineHistoryFrame({
      requestedHeights: [8], frames: [], unavailable: [{ height: 8, code: 'E_GONE', message: 'pruned' }],
    }, 8)).toThrow('Remote Time Machine scan failed for height 8: E_GONE: pruned');
    expect(() => requireTimeMachineHistoryFrame({
      requestedHeights: [9], frames: [], unavailable: [],
    }, 9)).toThrow('Remote Time Machine scan failed for height 9: height unavailable');
  });

  test('rejects Entity or page drift before a history frame is cached', () => {
    const projected = runtimeHistoryFrameFromViewFrame({
      runtimeId: 'runtime-a', mode: 'remote', frame: frameAt(7, '0xabc', 1, 1),
    });
    expect(() => assertTimeMachineHistorySelection(
      projected,
      { entityId: '0xabc', accountsPage: 1, booksPage: 1 },
    )).not.toThrow();
    expect(() => assertTimeMachineHistorySelection(
      projected,
      { entityId: '0xdef', accountsPage: 1, booksPage: 1 },
    )).toThrow('Remote Time Machine entity mismatch: expected 0xdef, received 0xabc');
    expect(() => assertTimeMachineHistorySelection(
      projected,
      { entityId: '0xabc', accountsPage: 2, booksPage: 1 },
    )).toThrow('Remote Time Machine page mismatch: expected accounts=2, books=1');
  });

  test('projects loading, success, and failure evidence without owning a clock', () => {
    const frame = frameAt(7);
    expect(createTimeMachineScanLoadingState({
      requestedHeight: 7, framesCached: 2, endpoint: 'ws://runtime',
    })).toMatchObject({ loading: true, requestedHeight: 7, framesCached: 2, endpoint: 'ws://runtime' });
    expect(createTimeMachineScanSuccessState({
      requestedHeight: 7, frame, adapterHeight: 11, framesCached: 3, durationMs: 4.9, endpoint: 'ws://runtime',
    })).toMatchObject({
      loading: false, error: null, requestedHeight: 7, scannedHeight: 7, latestHeight: 11,
      framesCached: 3, durationMs: 4, accountsShown: 1, accountsTotal: 3, booksShown: 1, booksTotal: 2,
    });
    expect(createTimeMachineScanFailureState({
      error: 'offline', requestedHeight: 7, framesCached: 2, durationMs: 9, endpoint: 'ws://runtime',
    })).toMatchObject({ loading: false, error: 'offline', requestedHeight: 7, framesCached: 2, durationMs: 9 });
    expect(getTimeMachineTransportErrorMessage(new Error('offline'))).toBe('offline');
    expect(getTimeMachineTransportErrorMessage(null)).toBe('Remote Time Machine scan failed');
  });

  test('keeps query effects, stores, selection publication, and clocks in the Svelte facade', () => {
    const facade = readFileSync('frontend/src/lib/stores/runtimeHistoryStore.ts', 'utf8');
    const transport = readFileSync('frontend/packages/runtime-client/src/time-machine-transport.ts', 'utf8');

    expect(facade).toContain("from '../../../packages/runtime-client/src/time-machine-transport'");
    expect(facade).toContain('runtimeQueryClient.readHistoryFrameBatch');
    expect(facade).toContain('runtimeViewHistoryScan.set');
    expect(facade).toContain('setRuntimeViewActiveEntityId');
    expect(facade).toContain('Date.now()');
    expect(transport).not.toContain('svelte/store');
    expect(transport).not.toContain('runtimeQueryClient');
    expect(transport).not.toContain('Date.now()');
  });
});
