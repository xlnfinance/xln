import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runtimeAdapterHeight } from '../../frontend/src/lib/stores/runtimeControllerStore';
import {
  RuntimeQueryClient,
  clearRuntimeQueryCache,
} from '../../frontend/src/lib/stores/runtimeQueryClient';

test('runtime query client exposes typed projection reads and bounded cache', () => {
  const source = readFileSync('frontend/src/lib/stores/runtimeQueryClient.ts', 'utf8');

  expect(source).toContain('export class RuntimeQueryClient');
  expect(source).toContain('readHead()');
  expect(source).toContain('readEntities');
  expect(source).toContain('readViewFrame');
  expect(source).toContain('readHistoryFrameBatch');
  expect(source).toContain('readActivity');
  expect(source).toContain('readSolvencySummary');
  expect(source).toContain('readReceiptStatus');
  expect(source).toContain('readRecoveryBundles');
  expect(source).toContain("'solvency-summary'");
  expect(source).toContain("`receipt/${encodeURIComponent(id)}`");
  expect(source).toContain("`recovery/bundles/${encodeURIComponent(key)}`");
  expect(source).toContain('MAX_QUERY_CACHE_ENTRIES = 200');
  expect(source).toContain('clearRuntimeQueryCache');
  expect(source).toContain('runtimeAdapter.subscribe(() => clearRuntimeQueryCache())');
  expect(source).toContain('private readonly cacheRuntimeId?: string');
  expect(source).toContain('this.cacheRuntimeId || handle.id');
});

test('runtime view store owns the active projected RuntimeView without Env access', () => {
  const source = readFileSync('frontend/src/lib/stores/runtimeViewStore.ts', 'utf8');

  expect(source).toContain('export type RuntimeView');
  expect(source).toContain('export const runtimeView');
  expect(source).toContain('export const refreshRuntimeView');
  expect(source).toContain('runtimeQueryClient.readHead()');
  expect(source).toContain('runtimeQueryClient.readViewFrame(query)');
  expect(source).toContain('runtimeControllerHandle');
  expect(source).toContain('export const resetRuntimeView');
  expect(source).toContain('runtimeViewRefreshId += 1;');
  expect(source).toContain('const expectedRuntimeId = handle.id;');
  expect(source).toContain('const expectedRuntimeMode = handle.mode;');
  expect(source).toContain('const requestStillCurrent = (): boolean =>');
  expect(source).toContain('current.id === expectedRuntimeId');
  expect(source).toContain('current.mode === expectedRuntimeMode');
  expect(source).toContain('if (!requestStillCurrent()) return get(runtimeView);');
  expect(source).toContain('runtimeAdapter.subscribe');
  expect(source).toContain('resetRuntimeView();');
  expect(source).toContain('runtimeAdapterHeight.subscribe');
  expect(source).not.toContain('Env');
  expect(source).not.toContain('eReplicas');
  expect(source).not.toContain('jReplicas');
  expect(source).not.toContain('getEnv');
  expect(source).not.toContain('setXlnEnvironment');
  expect(source).not.toContain('runtimeAdapterStore');
});

test('activity history panel reads activity through RuntimeQueryClient only', () => {
  const panelSource = readFileSync('frontend/src/lib/components/Entity/ActivityHistoryPanel.svelte', 'utf8');
  const querySource = readFileSync('frontend/src/lib/components/Entity/activity-history-query.ts', 'utf8');
  const addressRouteSource = readFileSync('frontend/src/routes/address/[entityId]/+page.svelte', 'utf8');
  const paymentSmokeSource = readFileSync('tests/e2e-payment-smoke.spec.ts', 'utf8');
  const source = `${panelSource}\n${querySource}`;
  const activityE2EHelper = paymentSmokeSource.slice(
    paymentSmokeSource.indexOf('async function countRuntimeActivityEvents'),
    paymentSmokeSource.indexOf('async function openEntityHistoryPage'),
  );

  expect(panelSource).toContain('runtimeQueryClient.readActivity');
  expect(panelSource).toContain("from '$lib/stores/runtimeQueryClient'");
  expect(addressRouteSource).toContain("$page.url.searchParams.get('runtimeId')");
  expect(addressRouteSource).toContain("runtimeOperations.selectRuntime(targetRuntimeId)");
  expect(addressRouteSource).toContain('Runtime ${targetRuntimeId} is not imported');
  expect(paymentSmokeSource).toContain('__xln?.adapter?.query?.activity');
  expect(paymentSmokeSource).toContain('?runtimeId=${encodeURIComponent(runtimeId)}');
  expect(paymentSmokeSource).toContain('history page adapter must expose off-chain payment history');
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
  const appTypes = readFileSync('frontend/src/app.d.ts', 'utf8');
  const storeSource = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  const remoteE2ESource = readFileSync('tests/e2e-radapter-remote.spec.ts', 'utf8');

  expect(controllerSource).toContain('query: {');
  expect(controllerSource).toContain('readHead()');
  expect(controllerSource).toContain('readEntities(query)');
  expect(controllerSource).toContain('readViewFrame(query)');
  expect(controllerSource).toContain('readHistoryFrameBatch(query)');
  expect(controllerSource).toContain('readReceiptStatus(receiptId)');
  expect(controllerSource).not.toContain('runtimeAdapterRead');
  expect(controllerSource).not.toContain('createRuntimeReadStore');
  expect(controllerSource).not.toContain('runtimeQueryRead');
  expect(controllerSource).not.toContain('read:');
  expect(controllerSource).not.toContain('send: runtimeAdapterSend');
  expect(controllerSource).toContain("registerDebugSurface('adapter'");
  expect(appTypes).not.toContain('__xlnRuntimeAdapter');
  expect(appTypes).not.toContain('read: <T = unknown>');
  expect(storeSource).toContain('runtimeQueryClient.readReceiptStatus(id)');
  expect(storeSource).not.toContain("adapter.read<RuntimeReceiptStatus>(`receipt/");
  expect(storeSource).not.toContain("adapter.read<RemoteRuntimeReceiptStatus>(`receipt/");
  const queryClientSource = readFileSync('frontend/src/lib/stores/runtimeQueryClient.ts', 'utf8');
  expect(queryClientSource).not.toContain('export const runtimeQueryRead');
  expect(queryClientSource).toContain('private async read<T>');
  expect(queryClientSource).toContain('private async cachedRead<T>');
  expect(remoteE2ESource).toContain('RuntimeAdapterDebugSurface');
  expect(remoteE2ESource).toContain('adapter.query.viewFrame');
  expect(remoteE2ESource).not.toContain('adapter.read');
  expect(remoteE2ESource).not.toContain('read: <T = unknown>');
});

test('fast e2e target titles stay in sync with specs', () => {
  const fastRunnerSource = readFileSync('runtime/scripts/run-e2e-fast.ts', 'utf8');
  const targetMatches = [...fastRunnerSource.matchAll(/file: '([^']+)'[\s\S]*?title: '([^']+)'/g)];
  expect(targetMatches.length).toBeGreaterThan(0);

  for (const match of targetMatches) {
    const [, file, title] = match;
    const specSource = readFileSync(file, 'utf8');
    const testTitles = [...specSource.matchAll(/test\('([^']+)'/g)].map(([, testTitle]) => testTitle);
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

test('remote runtime refresh reads typed RuntimeView projections without Env bridge', () => {
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

  expect(route).toContain("new URL('/app', url.origin)");
  expect(route).toContain("target.searchParams.set('runtime', 'remote')");
  expect(route).toContain("target.hash = 'accounts'");
  expect(route).toContain('throw redirect(307');
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
  const runtimeConnection = readFileSync('frontend/src/lib/utils/runtimeConnection.ts', 'utf8');
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
  expect(runtimeConnection).toContain("from '$lib/stores/vaultStore'");
  expect(runtimeConnection).toContain('await vaultOperations.initialize()');
  expect(runtimeConnection).toContain('const runtime = get(activeRuntime)');
  expect(runtimeConnection).toContain('runtimeId: runtime.id');
  expect(runtimeConnection).toContain('seed: runtime.seed');
  expect(runtimeConnection).toContain('await initializeXLN()');
  expect(runtimeConnection).toContain('getRuntimeControllerAdapter');
  expect(appLayout).toContain("from '$lib/utils/runtimeConnection'");
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
  expect(source).not.toContain('/api/debug/events');
  expect(source).not.toContain('/api/debug/entities');
  expect(source).not.toContain('DebugResponse');
  expect(source).not.toContain('DebugEntitiesResponse');
  expect(source).not.toContain('Latest 1000 Debug Events');
  expect(source).not.toContain('Registered Gossip Entities');
});

test('remote runtime validation uses typed query client reads with runtime-scoped cache', () => {
  const source = readFileSync('frontend/src/lib/utils/remoteRuntimeValidation.ts', 'utf8');

  expect(source).toContain('new RuntimeQueryClient(() => adapter, runtimeId)');
  expect(source).toContain('queryClient.readHead()');
  expect(source).toContain('queryClient.readEntities()');
  expect(source).toContain('remoteHubSummaryFromEntity');
  expect(source).toContain('hubEntities');
  expect(source).not.toContain("adapter.read<StorageHead>('head'");
  expect(source).not.toContain("adapter.read<RuntimeAdapterEntitySummary[]>('entities'");
});
