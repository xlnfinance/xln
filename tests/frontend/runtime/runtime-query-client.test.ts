import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runtimeAdapterHeight } from '../../../frontend/src/lib/stores/runtimeControllerStore';
import {
  RuntimeQueryClient,
  clearRuntimeQueryCache,
} from '../../../frontend/src/lib/stores/runtimeQueryClient';
import {
  runtimeViewHeightRetryDelayMs,
  runtimeViewNeedsHeightRefresh,
  runtimeViewTracksHeightAdvance,
  readRuntimeViewSelection,
  runtimeViewAccountsPage,
  runtimeViewActiveEntityId,
  runtimeViewBooksPage,
  runtimeViewHistoryScan,
  resetRuntimeViewSelection,
  runtimeViewPublicationMatches,
  runtimeViewSelectionMatches,
  setRuntimeViewActiveEntityId,
  setRuntimeViewPage,
} from '../../../frontend/src/lib/stores/runtimeViewStore';
import {
  ensureRuntimeHistoryContext,
  resetRuntimeHistoryFrames,
  runtimeHistoryFrames,
  upsertRuntimeHistoryFrame,
} from '../../../frontend/src/lib/stores/runtimeHistoryStore';

const readStore = <T>(store: { subscribe: (run: (value: T) => void) => () => void }): T => {
  let current!: T;
  const unsubscribe = store.subscribe((value) => { current = value; });
  unsubscribe();
  return current;
};

test('runtime query client exposes typed projection reads and bounded cache', () => {
  const source = readFileSync('frontend/src/lib/stores/runtimeQueryClient.ts', 'utf8');
  const boundary = readFileSync(
    'frontend/packages/runtime-client/src/runtime-query-client.ts',
    'utf8',
  );

  expect(source).toContain('export class RuntimeQueryClient');
  expect(source).toContain('extends RuntimeQueryClientBoundary<');
  expect(boundary).toContain('readHead()');
  expect(boundary).toContain('readFrameSummary');
  expect(boundary).toContain('readEntities');
  expect(boundary).toContain('readViewFrame');
  expect(boundary).toContain('readHistoryFrameBatch');
  expect(boundary).toContain('readActivity');
  expect(boundary).toContain('readSolvencySummary');
  expect(boundary).toContain('readSwapHistory');
  expect(boundary).toContain('/swap-history`');
  expect(boundary).toContain('readReceiptStatus');
  expect(boundary).toContain('readRecoveryBundles');
  expect(boundary).toContain("'solvency-summary'");
  expect(boundary).toContain("`receipt/${encodeURIComponent(id)}`");
  expect(boundary).toContain("`recovery/bundles/${encodeURIComponent(key)}`");
  expect(boundary).toContain('MAX_QUERY_CACHE_ENTRIES = 200');
  expect(source).toContain('clearRuntimeQueryCache');
  expect(source).toContain('runtimeAdapter.subscribe(() => clearRuntimeQueryCache())');
  expect(boundary).toContain('private readonly cacheRuntimeId?: string');
  expect(boundary).toContain('this.cacheRuntimeId || this.dependencies.readRuntimeId()');
  expect(boundary).not.toContain('svelte');
  expect(boundary).not.toContain('@xln/core');
});

test('remote history cache clears synchronously and rejects a superseded selection', () => {
  resetRuntimeHistoryFrames();
  const contextA = ensureRuntimeHistoryContext({
    runtimeId: 'runtime-a',
    mode: 'remote',
    entityId: '0xaaa',
    accountsPage: 0,
    booksPage: 0,
  }, 'ws://runtime-a');
  const frame = {
    height: 7,
    entities: [],
    activeEntityId: '0xaaa',
    activeEntity: {
      summary: { entityId: '0xaaa' },
      core: { entityId: '0xaaa', timestamp: 7 },
      accounts: { items: [], totalItems: 0, pageIndex: 0, pageCount: 1 },
      books: { items: [], totalItems: 0, pageIndex: 0, pageCount: 1 },
    },
  } as never;
  upsertRuntimeHistoryFrame({
    runtimeId: 'runtime-a',
    mode: 'remote',
    frame,
    context: contextA,
  }, 24);
  expect(readStore(runtimeHistoryFrames)).toHaveLength(1);
  runtimeViewHistoryScan.update((state) => ({ ...state, loading: true, requestedHeight: 7 }));

  ensureRuntimeHistoryContext({
    runtimeId: 'runtime-a',
    mode: 'remote',
    entityId: '0xbbb',
    accountsPage: 0,
    booksPage: 0,
  }, 'ws://runtime-a');
  expect(readStore(runtimeHistoryFrames)).toEqual([]);
  expect(readStore(runtimeViewHistoryScan).loading).toBe(false);
  expect(() => upsertRuntimeHistoryFrame({
    runtimeId: 'runtime-a',
    mode: 'remote',
    frame,
    context: contextA,
  }, 24)).toThrow('RUNTIME_HISTORY_CONTEXT_SUPERSEDED');
  resetRuntimeHistoryFrames();
});

test('runtime view store owns the active projected RuntimeView without RuntimeReplica access', () => {
  const source = readFileSync('frontend/src/lib/stores/runtimeViewStore.ts', 'utf8');
  const modelSource = readFileSync(
    'frontend/packages/runtime-client/src/runtime-view-model.ts',
    'utf8',
  );
  const publicationSource = readFileSync(
    'frontend/packages/runtime-client/src/runtime-view-publication.ts',
    'utf8',
  );

  expect(source).toContain('export type RuntimeView');
  expect(source).toContain("from '../../../packages/runtime-client/src/runtime-view-model'");
  expect(source).toContain('export const runtimeView');
  expect(source).toContain('export const refreshRuntimeView');
  expect(source).toContain('export const refreshSelectedRuntimeView');
  expect(source).toContain('refreshRuntimeView(currentRuntimeViewQuery())');
  expect(source).toContain('runtimeViewSelectionCoordinator.setActiveEntityId(entityId)');
  expect(source).toContain('runtimeQueryClient.readHead()');
  expect(source).toContain('runtimeQueryClient.readViewFrame(query)');
  expect(source).toContain('runtimeControllerHandle');
  expect(source).toContain('export const resetRuntimeView');
  expect(source).toContain('new RuntimeViewRefreshCoordinator({');
  expect(source).toContain('new RuntimeViewPublicationCoordinator<');
  expect(publicationSource).toContain('const refreshLease = this.dependencies.refresh.begin();');
  expect(publicationSource).toContain('const requestStillCurrent = (): boolean =>');
  expect(publicationSource).toContain('this.dependencies.refresh.isCurrent(refreshLease)');
  expect(source).not.toContain('let runtimeViewRefreshId');
  expect(source).toContain('runtimeViewPageInfo.set(runtimeViewPageInfoFromFrame(frame));');
  expect(publicationSource).toContain('if (!requestStillCurrent()) return next;');
  expect(publicationSource).not.toContain('if (!requestStillCurrent()) throw error;');
  expect(source).toContain('runtimeAdapter.subscribe');
  expect(source).toContain('resetRuntimeView();');
  expect(source).toContain('runtimeAdapterHeight.subscribe');
  expect(source).not.toContain('RuntimeReplica');
  expect(source).not.toContain('eReplicas');
  expect(source).not.toContain('jReplicas');
  expect(source).not.toContain('getEnv');
  expect(source).not.toContain('setXlnEnvironment');
  expect(source).not.toContain('runtimeAdapterStore');
  expect(modelSource).toContain('export type RuntimeViewPageInfo');
  expect(modelSource).not.toContain('svelte');
  expect(modelSource).not.toContain('@xln/core');
  expect(modelSource).not.toContain('runtimeQueryClient');
});

test('re-pinning the same wallet Entity preserves account pagination', () => {
  resetRuntimeViewSelection();
  try {
    setRuntimeViewActiveEntityId('0xentity-a');
    setRuntimeViewPage('accounts', 3);
    setRuntimeViewPage('books', 4);

    setRuntimeViewActiveEntityId(' 0xENTITY-A ');

    expect(readStore(runtimeViewActiveEntityId)).toBe('0xentity-a');
    expect(readStore(runtimeViewAccountsPage)).toBe(3);
    expect(readStore(runtimeViewBooksPage)).toBe(4);
  } finally {
    resetRuntimeViewSelection();
  }
});

test('an ABA remote Entity refresh cannot publish after the newer selection revision', async () => {
  resetRuntimeViewSelection();
  try {
    setRuntimeViewActiveEntityId('0xentity-a');
    const selectionA = readRuntimeViewSelection();
    let resolveA!: (value: string) => void;
    const delayedA = new Promise<string>((resolve) => { resolveA = resolve; });
    const published: string[] = [];
    let currentGeneration = 0;
    const publishIfCurrent = async (
      generation: number,
      selection: typeof selectionA,
      value: Promise<string>,
    ): Promise<void> => {
      const resolved = await value;
      if (runtimeViewPublicationMatches(generation, currentGeneration, selection)) published.push(resolved);
    };
    const refreshA = publishIfCurrent(++currentGeneration, selectionA, delayedA);

    setRuntimeViewActiveEntityId('0xentity-b');
    const selectionB = readRuntimeViewSelection();
    await publishIfCurrent(++currentGeneration, selectionB, Promise.resolve('B'));

    setRuntimeViewActiveEntityId('0xentity-a');
    const selectionA2 = readRuntimeViewSelection();
    await publishIfCurrent(++currentGeneration, selectionA2, Promise.resolve('A2'));
    expect(runtimeViewSelectionMatches(selectionA)).toBe(false);
    resolveA('A');
    await refreshA;

    expect(published).toEqual(['B', 'A2']);
  } finally {
    resetRuntimeViewSelection();
  }
});

test('automatic root refresh preserves the pinned RuntimeView Entity', () => {
  const source = readFileSync('frontend/src/lib/view/View.svelte', 'utf8');

  expect(source).toContain('refreshSelectedRuntimeView()');
  expect(source).not.toContain('refreshRuntimeView()');
});

test('payment terminal observation follows the synchronous Entity selection', () => {
  const viewSource = readFileSync('frontend/src/lib/view/View.svelte', 'utf8');
  const userModeSource = readFileSync('frontend/src/lib/view/UserModePanel.svelte', 'utf8');

  expect(viewSource).toContain('const entityId = String(get(runtimeViewActiveEntityId)');
  expect(viewSource).toContain('runtimeViewActiveEntityId.subscribe(');
  expect(viewSource).not.toContain('const entityId = String(get(runtimeView).activeEntityId');
  expect(userModeSource).toContain('if ($runtimeViewActiveEntityId !== selectedEntityId)');
  expect(userModeSource).toContain('setRuntimeViewActiveEntityId(selectedEntityId);');
});

test('runtime view height pushes cannot race the initial remote projection', () => {
  const liveView = {
    atHeight: null,
    frame: { height: 10 },
  };

  expect(runtimeViewNeedsHeightRefresh({ atHeight: null, frame: null }, 'connected', 11)).toBe(false);
  expect(runtimeViewNeedsHeightRefresh(liveView, 'connecting', 11)).toBe(false);
  expect(runtimeViewNeedsHeightRefresh({ ...liveView, atHeight: 10 }, 'connected', 11)).toBe(false);
  expect(runtimeViewNeedsHeightRefresh(liveView, 'connected', 10)).toBe(false);
  expect(runtimeViewNeedsHeightRefresh(liveView, 'connected', 11)).toBe(true);
});

test('runtime view queues committed heights that arrive during the initial projection', () => {
  const loadingLiveView = { atHeight: null, frame: null };

  expect(runtimeViewTracksHeightAdvance(loadingLiveView, 'connected', 11)).toBe(true);
  expect(runtimeViewTracksHeightAdvance(loadingLiveView, 'connecting', 11)).toBe(false);
  expect(runtimeViewTracksHeightAdvance({ ...loadingLiveView, atHeight: 10 }, 'connected', 11)).toBe(false);
  expect(runtimeViewTracksHeightAdvance(loadingLiveView, 'connected', 0)).toBe(false);

  const source = readFileSync('frontend/src/lib/stores/runtimeViewStore.ts', 'utf8');
  const boundary = readFileSync(
    'frontend/packages/runtime-client/src/runtime-view-catchup.ts',
    'utf8',
  );
  expect(boundary).toContain('this.pendingHeight = Math.max(this.pendingHeight, nextHeight);');
  expect(boundary).toContain('if (!state.hasFrame) return;');
  expect(source).toContain('runtimeViewCatchup.observeHeight(nextHeight);');
  expect(source).toContain('continueRuntimeViewCatchup();');
});

test('runtime view catch-up retries back off instead of spinning', () => {
  expect([0, 1, 2, 3, 20].map(runtimeViewHeightRetryDelayMs)).toEqual([50, 100, 200, 250, 250]);
  const source = readFileSync('frontend/src/lib/stores/runtimeViewStore.ts', 'utf8');
  const boundary = readFileSync(
    'frontend/packages/runtime-client/src/runtime-view-catchup.ts',
    'utf8',
  );
  expect(boundary).not.toContain('while (this.pendingHeight');
  expect(boundary).toContain('RUNTIME_VIEW_CATCHUP_TIMEOUT');
  expect(source).not.toContain('RUNTIME_VIEW_CATCHUP_TIMEOUT');
});

test('persisted receipt probes reuse the live Runtime module singleton', () => {
  const source = readFileSync('tests/utils/e2e-runtime-receipts.ts', 'utf8');

  expect(source).toContain('const XLN = view.__xln?.instance;');
  expect(source).not.toContain('runtime.js');
  expect(source).not.toContain('await import(');
  expect(source).not.toContain('window.XLN');
});

test('wallet UI and wallet-backed E2E helpers never import a second Runtime module', () => {
  const guardedFiles = [
    'frontend/src/lib/view/panels/ArchitectPanel.svelte',
    'frontend/src/lib/view/panels/graph3d/Graph3DPanel.svelte',
    'tests/e2e/product/e2e-debt-ledger.spec.ts',
    'tests/e2e/runtime/e2e-runtime-persistence.spec.ts',
  ];

  for (const file of guardedFiles) {
    const source = readFileSync(file, 'utf8');
    expect(source).not.toContain("new URL('/runtime.js'");
    expect(source).not.toContain('new URL(`/runtime.js');
    expect(source).not.toContain('await import(/* @vite-ignore */ runtimeUrl)');
  }
});

test('activity history panel reads activity through RuntimeQueryClient only', () => {
  const panelSource = readFileSync('frontend/src/lib/components/Entity/payments/ActivityHistoryPanel.svelte', 'utf8');
  const querySource = readFileSync('frontend/src/lib/components/Entity/account/activity-history-query.ts', 'utf8');
  const addressRouteSource = readFileSync('frontend/src/routes/address/[entityId]/+page.svelte', 'utf8');
  const paymentSmokeSource = readFileSync('tests/e2e/payments/e2e-payment-smoke.spec.ts', 'utf8');
  const source = `${panelSource}\n${querySource}`;
  const activityE2EHelper = paymentSmokeSource.slice(
    paymentSmokeSource.indexOf('async function countRuntimeActivityEvents'),
    paymentSmokeSource.indexOf('test.describe'),
  );
  expect(panelSource).toContain('runtimeQueryClient.readActivity');
  expect(panelSource).toContain("from '$lib/stores/runtimeQueryClient'");
  expect(addressRouteSource).toContain("$page.url.searchParams.get('runtimeId')");
  expect(addressRouteSource).toContain("runtimeOperations.selectRuntime(targetRuntimeId)");
  expect(addressRouteSource).toContain('Runtime ${targetRuntimeId} is not imported');
  expect(paymentSmokeSource).toContain('__xln?.adapter?.query?.activity');
  expect(paymentSmokeSource).toContain("getByRole('button', { name: 'History', exact: true }).click()");
  expect(paymentSmokeSource).toContain('history panel adapter must expose off-chain payment history');
  expect(paymentSmokeSource).not.toContain('/api/debug/activity');
  expect(paymentSmokeSource).not.toContain('readPersistedRuntimeActivityPage');
  expect(source).not.toContain('readPersistedRuntimeActivityPage');
  expect(source).not.toContain('runtimeFrameEnv');
  expect(source).not.toContain('window.XLN');
  expect(source).not.toContain('view.XLN');
  expect(source).not.toContain('runtime.js');
  expect(source).not.toContain('/api/debug/activity');
  expect(source).not.toContain('readDebugActivitySource');
  expect(source).not.toContain("from '$lib/stores/runtimeStore'");
  expect(activityE2EHelper).not.toContain('isolatedEnv');
  expect(activityE2EHelper).not.toContain('window.XLN');
  expect(activityE2EHelper).not.toContain('view.XLN');
  expect(activityE2EHelper).not.toContain('runtime.js');
});

test('runtime query cache is live-height aware but keeps historical reads pinned', async () => {
  clearRuntimeQueryCache();
  runtimeAdapterHeight.set(10);
  const reads: Array<{ path: string; query?: unknown }> = [];
  const adapter = {
    read: async (path: string, query?: unknown) => {
      reads.push({ path, query });
      return [{ path, query, readNumber: reads.length }];
    },
  };
  const queryClient = new RuntimeQueryClient(() => adapter as never, 'runtime-query-cache-test');

  const firstLive = await queryClient.readEntities();
  const secondLive = await queryClient.readEntities();
  expect(firstLive).toBe(secondLive);
  expect(reads).toHaveLength(1);

  runtimeAdapterHeight.set(11);
  const nextLive = await queryClient.readEntities();
  expect(nextLive).not.toBe(firstLive);
  expect(reads).toHaveLength(2);

  const historicalQuery = { atHeight: 7, heights: [7] };
  const firstHistorical = await queryClient.readHistoryFrameBatch(historicalQuery);
  runtimeAdapterHeight.set(12);
  const secondHistorical = await queryClient.readHistoryFrameBatch(historicalQuery);
  expect(firstHistorical).toBe(secondHistorical);
  expect(reads).toHaveLength(3);
});

test('runtime query client reads one exact committed frame summary', async () => {
  const reads: string[] = [];
  const adapter = {
    read: async (path: string) => {
      reads.push(path);
      return { height: 12, stateHash: '0x12' };
    },
  };
  const queryClient = new RuntimeQueryClient(() => adapter as never, 'runtime-frame-summary-test');

  expect(await queryClient.readFrameSummary(12)).toEqual({ height: 12, stateHash: '0x12' });
  expect(reads).toEqual(['frame/12']);
  await expect(queryClient.readFrameSummary(0)).rejects.toThrow('RUNTIME_FRAME_HEIGHT_INVALID');
  await expect(queryClient.readFrameSummary(Number.NaN)).rejects.toThrow('RUNTIME_FRAME_HEIGHT_INVALID');
});

test('runtime query cache never pins a lagging live projection to a newer adapter height', async () => {
  clearRuntimeQueryCache();
  let readNumber = 0;
  const adapter = {
    currentHeight: 38,
    read: async (path: string) => {
      readNumber += 1;
      const height = readNumber === 1 ? 37 : 38;
      return path === 'head'
        ? { latestHeight: height }
        : { height, head: { latestHeight: height }, entities: [], activeEntityId: null, activeEntity: null };
    },
  };
  const queryClient = new RuntimeQueryClient(() => adapter as never, 'runtime-query-lag-test');

  expect((await queryClient.readViewFrame()).height).toBe(37);
  expect((await queryClient.readViewFrame()).height).toBe(38);
  expect((await queryClient.readViewFrame()).height).toBe(38);
  expect(readNumber).toBe(2);
});

test('runtime query cache follows custom adapter height during remote validation', async () => {
  clearRuntimeQueryCache();
  runtimeAdapterHeight.set(0);
  const reads: Array<{ path: string; query?: unknown }> = [];
  const adapter = {
    currentHeight: 3,
    read: async (path: string, query?: unknown) => {
      reads.push({ path, query });
      return [{ path, query, readNumber: reads.length }];
    },
  };
  const queryClient = new RuntimeQueryClient(() => adapter as never, 'remote-validation-runtime');

  const first = await queryClient.readEntities();
  const second = await queryClient.readEntities();
  expect(first).toBe(second);
  expect(reads).toHaveLength(1);

  adapter.currentHeight = 4;
  const afterRemoteTick = await queryClient.readEntities();
  expect(afterRemoteTick).not.toBe(first);
  expect(reads).toHaveLength(2);
});

test('runtime receipt status reads through typed query client without cache reuse', async () => {
  const reads: Array<{ path: string; query?: unknown }> = [];
  const adapter = {
    read: async (path: string, query?: unknown) => {
      reads.push({ path, query });
      return { status: reads.length === 1 ? 'accepted' : 'observed', observedHeight: reads.length };
    },
  };
  const queryClient = new RuntimeQueryClient(() => adapter as never, 'receipt-runtime');

  const first = await queryClient.readReceiptStatus('receipt id/1');
  const second = await queryClient.readReceiptStatus('receipt id/1');

  expect(first.status).toBe('accepted');
  expect(second.status).toBe('observed');
  expect(reads).toEqual([
    { path: 'receipt/receipt%20id%2F1', query: undefined },
    { path: 'receipt/receipt%20id%2F1', query: undefined },
  ]);
  await expect(queryClient.readReceiptStatus('')).rejects.toThrow('REMOTE_RUNTIME_RECEIPT_ID_MISSING');
});

test('runtime recovery bundles read through typed query client without cache reuse', async () => {
  const reads: Array<{ path: string; query?: unknown }> = [];
  const adapter = {
    read: async (path: string, query?: unknown) => {
      reads.push({ path, query });
      return {
        ok: true,
        runtimeId: 'runtime-a',
        lookupKey: 'lookup/key',
        bundle: {
          version: 1,
          runtimeId: 'runtime-a',
          lookupKey: 'lookup/key',
          cipher: 'aes-256-gcm',
          kdf: 'hkdf-sha256',
          iv: '0x01',
          tag: '0x02',
          ciphertext: '0x03',
          createdAt: 1,
          runtimeHeight: 2,
          snapshotHeight: 2,
          journalFromHeight: 3,
          signerCount: 1,
        },
        bundles: [],
      };
    },
  };
  const queryClient = new RuntimeQueryClient(() => adapter as never, 'peer-recovery-runtime');

  const first = await queryClient.readRecoveryBundles('lookup/key');
  const second = await queryClient.readRecoveryBundles('lookup/key');

  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  expect(reads).toEqual([
    { path: 'recovery/bundles/lookup%2Fkey', query: undefined },
    { path: 'recovery/bundles/lookup%2Fkey', query: undefined },
  ]);
  await expect(queryClient.readRecoveryBundles('')).rejects.toThrow('REMOTE_RUNTIME_RECOVERY_LOOKUP_KEY_MISSING');
});

test('runtime controller exposes only typed debug projection queries', () => {
  const controllerSource = readFileSync('frontend/src/lib/stores/runtimeControllerStore.ts', 'utf8');
  const queryClientSource = readFileSync('frontend/src/lib/stores/runtimeQueryClient.ts', 'utf8');
  const queryBoundarySource = readFileSync(
    'frontend/packages/runtime-client/src/runtime-query-client.ts',
    'utf8',
  );
  const appTypes = readFileSync('frontend/src/app.d.ts', 'utf8');
  const storeSource = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  const remoteE2ESource = [
    'tests/e2e/runtime/e2e-radapter-remote-part-1.spec.ts',
    'tests/e2e/runtime/e2e-radapter-remote-part-2.spec.ts',
  ].map(file => readFileSync(file, 'utf8')).join('\n');

  expect(queryClientSource).toContain('query: {');
  expect(queryClientSource).toContain('runtimeQueryClient.readHead()');
  expect(queryClientSource).toContain('runtimeQueryClient.readFrameSummary(height)');
  expect(queryClientSource).toContain('runtimeQueryClient.readEntities(query)');
  expect(queryClientSource).toContain('runtimeQueryClient.readViewFrame(query)');
  expect(queryClientSource).toContain('runtimeQueryClient.readHistoryFrameBatch(query)');
  expect(queryClientSource).toContain('runtimeQueryClient.readReceiptStatus(receiptId)');
  expect(queryClientSource).toContain("registerDebugSurface('adapter'");
  expect(controllerSource).not.toContain("import('./runtimeQueryClient')");
  expect(controllerSource).not.toContain("registerDebugSurface('adapter'");
  expect(controllerSource).not.toContain('runtimeAdapterRead');
  expect(controllerSource).not.toContain('createRuntimeReadStore');
  expect(controllerSource).not.toContain('runtimeQueryRead');
  expect(controllerSource).not.toContain('read:');
  expect(controllerSource).not.toContain('send: runtimeAdapterSend');
  expect(appTypes).not.toContain('__xlnRuntimeAdapter');
  expect(appTypes).not.toContain('read: <T = unknown>');
  expect(storeSource).toContain('runtimeQueryClient.readReceiptStatus(id)');
  expect(storeSource).not.toContain("adapter.read<RuntimeReceiptStatus>(`receipt/");
  expect(storeSource).not.toContain("adapter.read<RemoteRuntimeReceiptStatus>(`receipt/");
  expect(queryClientSource).not.toContain('export const runtimeQueryRead');
  expect(queryClientSource).toContain('extends RuntimeQueryClientBoundary<');
  expect(queryBoundarySource).toContain('private async read<T>');
  expect(queryBoundarySource).toContain('private async cachedRead<T>');
  expect(remoteE2ESource).toContain('RuntimeAdapterDebugSurface');
  expect(remoteE2ESource).toContain('adapter.query.viewFrame');
  expect(remoteE2ESource).not.toContain('adapter.read');
  expect(remoteE2ESource).not.toContain('read: <T = unknown>');
});

test('fast e2e target titles stay in sync with specs', () => {
  const fastRunnerSource = readFileSync('core/scripts/e2e/runners/run-e2e-fast.ts', 'utf8');
  const targetMatches = [...fastRunnerSource.matchAll(/file: '([^']+)'[\s\S]*?title: '([^']+)'/g)];
  expect(targetMatches.length).toBeGreaterThan(0);

  for (const match of targetMatches) {
    const [, file, title] = match;
    const specSource = readFileSync(file, 'utf8');
    const testTitles = [...specSource.matchAll(/test\s*\(\s*'([^']+)'/g)]
      .map(([, testTitle]) => testTitle);
    expect(
      testTitles.some((testTitle) => testTitle.includes(title)),
      `${file} must contain fast e2e target "${title}"`,
    ).toBe(true);
  }
});

test('runtime view-frame live reads do not force historical atHeight queries', async () => {
  clearRuntimeQueryCache();
  runtimeAdapterHeight.set(16);
  const reads: Array<{ path: string; query?: Record<string, unknown> }> = [];
  const adapter = {
    read: async (path: string, query?: Record<string, unknown>) => {
      reads.push({ path, query });
      return { path, query, height: 17, entities: [], activeEntityId: null, activeEntity: null };
    },
  };
  const queryClient = new RuntimeQueryClient(() => adapter as never, 'runtime-view-frame-live-test');

  await queryClient.readViewFrame({ entityId: '0xabc' });
  expect(reads[0]?.query).toEqual({ entityId: '0xabc' });

  await queryClient.readViewFrame({ entityId: '0xabc', atHeight: 7 });
  expect(reads[1]?.query).toEqual({ entityId: '0xabc', atHeight: 7 });
});

test('remote runtime refresh reads typed RuntimeView projections without RuntimeReplica bridge', () => {
  const source = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  const historySource = readFileSync('frontend/src/lib/stores/runtimeHistoryStore.ts', 'utf8');
  const refreshIndex = source.indexOf('const refreshRemoteRuntimeProjection = async');
  expect(refreshIndex).toBeGreaterThan(0);
  const refreshSource = source.slice(refreshIndex, source.indexOf('const createEmbeddedRuntimeAdapter', refreshIndex));
  const scanIndex = historySource.indexOf('export const scanRuntimeAdapterHistoryAtHeight');
  expect(scanIndex).toBeGreaterThan(0);
  const scanSource = historySource.slice(scanIndex);

  expect(refreshSource).toContain('refreshRuntimeView');
  expect(refreshSource).toContain('runtimeHistoryFrameFromViewFrame');
  expect(refreshSource).not.toContain('atHeight');
  expect(refreshSource).not.toContain("adapter.read<RuntimeAdapterViewFrame>('view-frame'");
  expect(source).not.toContain('export const scanRuntimeAdapterHistoryAtHeight');
  expect(scanSource).toContain('runtimeQueryClient.readHistoryFrameBatch');
  expect(scanSource).toContain('heights: [requestedHeight]');
  expect(scanSource).not.toContain('heights: missingHeights');
  expect(scanSource).not.toContain("adapter.read<RuntimeAdapterHistoryFrameBatch>('history-frame-batch'");
  expect(source).not.toContain("$lib/utils/runtimeViewEnv");
  expect(source).not.toContain('runtimeViewFrameToEnv');
  expect(source).not.toContain('buildRemoteAdapterHistory');
  expect(source).not.toContain('buildRemoteAdapterEnvSnapshot');
  expect(source).not.toContain('isRemoteHistoryBoundaryError');
  expect(source).not.toContain('unsupported adapter path: history-frame-batch');
});

test('runtime adapter health panel uses shared RuntimeView store instead of owning projection state', () => {
  const source = readFileSync('frontend/src/lib/components/Health/RuntimeAdapterPanel.svelte', 'utf8');

  expect(source).toContain("from '$lib/stores/runtimeViewStore'");
  expect(source).toContain('runtimeControllerHandle');
  expect(source).toContain('$runtimeControllerHandle.status');
  expect(source).toContain('$runtimeControllerHandle.height');
  expect(source).toContain('$runtimeControllerHandle.authLevel');
  expect(source).toContain('refreshRuntimeView({');
  expect(source).toContain('const head = $derived($runtimeView.head)');
  expect(source).toContain('const viewFrame = $derived($runtimeView.frame)');
  expect(source).toContain("authKey.trim() && $runtimeControllerHandle.authLevel === 'admin'");
  expect(source).toContain('persistRuntimeAdapterSession(wsUrl, authKey.trim())');
  expect(source).not.toContain('runtimeQueryClient.readHead');
  expect(source).not.toContain('runtimeQueryClient.readViewFrame');
  expect(source).not.toContain('let head = $state');
  expect(source).not.toContain('let viewFrame = $state');
  expect(source).not.toContain('runtimeAdapterRead');
  expect(source).not.toContain('runtimeAdapterAuthLevel');
  expect(source).not.toContain('runtimeAdapterStatus');
  expect(source).not.toContain('runtimeAdapterHeight');
});

test('radapter page redirects remote users into the canonical app workspace', () => {
  const route = readFileSync('frontend/src/routes/radapter/+page.ts', 'utf8');
  const panel = readFileSync('frontend/src/lib/components/Health/RuntimeAdapterPanel.svelte', 'utf8');

  expect(route).toContain("throw error(400, 'REMOTE_RUNTIME_QUERY_BOOTSTRAP_FORBIDDEN')");
  expect(route).toContain("throw redirect(307, '/app')");
  expect(route).not.toContain("searchParams.get('token'");
  expect(panel).toContain('href="/app"');
  expect(panel).not.toContain('Runtime Adapter Inspector');
  expect(panel).not.toContain('autoConnect');
});

test('remote Time Machine scan reads historical frames through history-frame-batch only', () => {
  const source = readFileSync('frontend/src/lib/stores/runtimeHistoryStore.ts', 'utf8');
  const scanStart = source.indexOf('export const scanRuntimeAdapterHistoryAtHeight');
  expect(scanStart).toBeGreaterThan(0);
  const scanSource = source.slice(scanStart);

  expect(scanSource).toContain('runtimeQueryClient.readHistoryFrameBatch');
  expect(scanSource).toContain('heights: [requestedHeight]');
  expect(scanSource).toContain('upsertRuntimeHistoryFrame');
  expect(scanSource).toContain('ensureRuntimeHistoryContext');
  expect(scanSource).toContain('setRuntimeViewActiveEntityId(projected.activeEntityId)');
  expect(scanSource).toContain('snapshot: { height: scannedHeight }');
  expect(scanSource).not.toContain('remoteViewFrameToEnv');
  expect(scanSource).not.toContain('setXlnEnvironment');
  expect(scanSource).not.toContain('history.set');
  expect(scanSource).not.toContain('buildRemoteAdapterEnvSnapshot');
  expect(scanSource).not.toContain("adapter.read<RuntimeAdapterHistoryFrameBatch>('history-frame-batch'");
});

test('address explorer routes read runtime projections instead of debug entity APIs', () => {
  const directory = readFileSync('frontend/src/routes/address/+page.svelte', 'utf8');
  const detail = readFileSync('frontend/src/routes/address/[entityId]/+page.svelte', 'utf8');
  const runtimeConnection = readFileSync('frontend/src/lib/utils/runtime/runtimeConnection.ts', 'utf8');
  const appLayout = readFileSync('frontend/src/routes/app/+layout.svelte', 'utf8');

  expect(directory).toContain('ensureProjectionRuntimeConnected');
  expect(directory).toContain('runtimeQueryClient.readEntities');
  expect(directory).toContain('runtimeAdapterHeight.subscribe');
  expect(directory).not.toContain('/api/debug/entities');
  expect(directory).not.toContain('fetch(');
  expect(directory).not.toContain('setInterval');
  expect(detail).toContain('ensureProjectionRuntimeConnected');
  expect(detail).toContain("from '$lib/stores/runtimeViewStore'");
  expect(detail).toContain("from '$lib/stores/runtimeQueryClient'");
  expect(detail).toContain('refreshRuntimeView({');
  expect(detail).toContain('selectEntityRuntimeFromDirectory');
  expect(detail).toContain('runtimeOperations.selectRuntime(targetRuntimeId)');
  expect(detail).toContain('summaryRuntimeId(summary)');
  expect(detail).toContain('canReadEntityRuntime(entity.runtimeId)');
  expect(detail).toContain('entity-history-runtime-mismatch');
  expect(detail).toContain('fetchSummaryExplorerEntity');
  expect(detail).toContain('runtimeQueryClient.readEntities({ limit: 5000 })');
  expect(detail).toContain('buildExplorerEntityFromSummary');
  expect(detail).not.toContain('runtimeQueryClient.readViewFrame');
  expect(detail).toContain('runtimeAdapterHeight.subscribe');
  expect(detail).toContain('accountsLimit: 8');
  expect(detail).toContain('booksLimit: 8');
  expect(detail).not.toContain('vaultOperations.initialize');
  expect(detail).not.toContain('/api/debug/entities');
  expect(detail).not.toContain('fetch(');
  expect(detail).not.toContain('setInterval');
  expect(runtimeConnection).toContain('export async function ensureProjectionRuntimeConnected');
  expect(runtimeConnection).toContain('readRemoteRuntimeRequestFromUrl');
  expect(runtimeConnection).toContain('persistRemoteRuntimeRequest');
  expect(runtimeConnection).toContain('stripRemoteRuntimeParamsFromHistory');
  expect(runtimeConnection).toContain("from '$lib/stores/vault/vaultStore'");
  expect(runtimeConnection).toContain('await vaultOperations.initialize()');
  expect(runtimeConnection).toContain('const runtime = get(activeRuntime)');
  expect(runtimeConnection).toContain('runtimeId: runtime.id');
  expect(runtimeConnection).toContain('seed: runtime.seed');
  expect(runtimeConnection).toContain('await initializeXLN()');
  expect(runtimeConnection).toContain('getRuntimeControllerAdapter');
  expect(appLayout).toContain("from '$lib/utils/runtime/runtimeConnection'");
  expect(appLayout).not.toContain('function readRemoteRuntimeRequestFromUrl');
  expect(appLayout).not.toContain('function persistRemoteRuntimeRequest');
  expect(appLayout).not.toContain('function remoteAccessFromAuthKey');
});

test('health admin reads active runtime projections instead of debug event/entity APIs', () => {
  const source = readFileSync('frontend/src/routes/health/+page.svelte', 'utf8');

  expect(source).toContain('ensureProjectionRuntimeConnected');
  expect(source).toContain('runtimeQueryClient.readActivity');
  expect(source).toContain('runtimeQueryClient.readEntities');
  expect(source).toContain('RuntimeActivityEvent');
  expect(source).toContain('RuntimeAdapterEntitySummary');
  expect(source).toContain("fetch('/api/health')");
  expect(source).toContain("import { errorLog } from '$lib/stores/errorLogStore';");
  expect(source).toContain("errorLog.log(message, 'Health Admin', details)");
  expect(source).toContain("'RPC health check failed after retries'");
  expect(source).toContain("'Runtime projection health read failed'");
  expect(source).not.toContain('console.error');
  expect(source).not.toContain('console.warn');
  expect(source).not.toContain('console.info');
  expect(source).not.toContain('alert(');
  expect(source).not.toContain('/api/debug/events');
  expect(source).not.toContain('/api/debug/entities');
  expect(source).not.toContain('DebugResponse');
  expect(source).not.toContain('DebugEntitiesResponse');
  expect(source).not.toContain('Latest 1000 Debug Events');
  expect(source).not.toContain('Registered Gossip Entities');
});

test('remote runtime validation uses typed query client reads with runtime-scoped cache', () => {
  const source = readFileSync('frontend/src/lib/utils/onboarding/remoteRuntimeValidation.ts', 'utf8');

  expect(source).toContain('new RuntimeQueryClient(() => adapter, runtimeId)');
  expect(source).toContain('queryClient.readHead()');
  expect(source).toContain('queryClient.readEntities()');
  expect(source).toContain('remoteHubSummaryFromEntity');
  expect(source).toContain('hubEntities');
  expect(source).not.toContain("adapter.read<StorageHead>('head'");
  expect(source).not.toContain("adapter.read<RuntimeAdapterEntitySummary[]>('entities'");
});
