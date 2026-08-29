import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  RuntimeQueryClient,
  clearRuntimeQueryCache,
  type RuntimeQueryResultSchema,
  type RuntimeReadAdapterModel,
  type RuntimeReadQueryModel,
} from '../../../frontend/packages/runtime-client/src/runtime-query-client';

type TestQuery = RuntimeReadQueryModel & Readonly<{
  entityId?: string;
  cursor?: string;
  marker?: number;
  unused?: undefined;
}>;

type TestResponse = Readonly<{
  path: string;
  query?: TestQuery;
  readNumber: number;
  height: number;
}>;

type TestResults = RuntimeQueryResultSchema & {
  head: TestResponse;
  frameSummary: TestResponse;
  entities: TestResponse;
  viewFrame: TestResponse;
  account: TestResponse;
  swapHistory: TestResponse;
  historyFrameBatch: TestResponse;
  timelineIndex: TestResponse;
  activity: TestResponse;
  solvencySummary: TestResponse;
  receiptStatus: TestResponse;
  recoveryBundles: TestResponse;
};

type HarnessOptions = Readonly<{
  cacheRuntimeId?: string;
  responseHeight?: (readNumber: number, currentHeight: number) => number;
}>;

const createHarness = (options: HarnessOptions = {}) => {
  let connected = true;
  let currentHeight = 10;
  let runtimeId = 'runtime-a';
  let readNumber = 0;
  const reads: Array<{ path: string; query?: TestQuery }> = [];
  const adapter: RuntimeReadAdapterModel<TestQuery> = {
    get currentHeight() { return currentHeight; },
    async read<T>(path: string, query?: TestQuery): Promise<T> {
      reads.push({ path, ...(query === undefined ? {} : { query }) });
      readNumber += 1;
      const height = options.responseHeight?.(readNumber, currentHeight) ?? currentHeight;
      return { path, query, readNumber, height } as T;
    },
  };
  const client = new RuntimeQueryClient<TestQuery, TestResults>({
    resolveAdapter: () => connected ? adapter : null,
    readRuntimeId: () => runtimeId,
    readCurrentHeight: () => currentHeight,
    createEmptyQuery: () => ({}),
  }, options.cacheRuntimeId);
  return {
    client,
    reads,
    setConnected: (value: boolean) => { connected = value; },
    setCurrentHeight: (value: number) => { currentHeight = value; },
    setRuntimeId: (value: string) => { runtimeId = value; },
  };
};

describe('runtime-client query boundary', () => {
  test('canonicalizes query keys and omitted values for cache identity', async () => {
    clearRuntimeQueryCache();
    const harness = createHarness();
    const first = await harness.client.readViewFrame({
      entityId: '0xentity-a', marker: 1, unused: undefined,
    });
    const second = await harness.client.readViewFrame({ marker: 1, entityId: '0xentity-a' });

    expect(second).toBe(first);
    expect(harness.reads).toHaveLength(1);
  });

  test('invalidates live cache entries when the adapter height advances', async () => {
    clearRuntimeQueryCache();
    const harness = createHarness();
    const first = await harness.client.readViewFrame();
    expect(await harness.client.readViewFrame()).toBe(first);
    harness.setCurrentHeight(11);

    expect(await harness.client.readViewFrame()).not.toBe(first);
    expect(harness.reads).toHaveLength(2);
  });

  test('does not pin a lagging live response to the newer adapter height', async () => {
    clearRuntimeQueryCache();
    const harness = createHarness({
      responseHeight: (readNumber) => readNumber === 1 ? 37 : 38,
    });
    harness.setCurrentHeight(38);

    expect((await harness.client.readViewFrame()).height).toBe(37);
    expect((await harness.client.readViewFrame()).height).toBe(38);
    expect((await harness.client.readViewFrame()).height).toBe(38);
    expect(harness.reads).toHaveLength(2);
  });

  test('pins historical reads independently of live height changes', async () => {
    clearRuntimeQueryCache();
    const harness = createHarness();
    const query = { atHeight: 7, heights: [7] } satisfies TestQuery;
    const first = await harness.client.readHistoryFrameBatch(query);
    harness.setCurrentHeight(14);

    expect(await harness.client.readHistoryFrameBatch(query)).toBe(first);
    expect(harness.reads).toHaveLength(1);
  });

  test('partitions cache entries by current Runtime identity', async () => {
    clearRuntimeQueryCache();
    const harness = createHarness();
    const first = await harness.client.readHead();
    harness.setRuntimeId('runtime-b');

    expect(await harness.client.readHead()).not.toBe(first);
    expect(harness.reads).toHaveLength(2);
  });

  test('validates and encodes frame, Account, and history paths', async () => {
    clearRuntimeQueryCache();
    const harness = createHarness();

    await harness.client.readFrameSummary(12);
    await harness.client.readAccount(' A/B ', ' C D ');
    await harness.client.readSwapHistory(' A/B ', ' C D ', { cursor: 'next' });
    await harness.client.readHistoryFrameBatch({ heights: [7] });

    expect(harness.reads.map(({ path }) => path)).toEqual([
      'frame/12',
      'entity/a%2Fb/account/c%20d',
      'entity/a%2Fb/account/c%20d/swap-history',
      'history-frame-batch',
    ]);
    await expect(harness.client.readFrameSummary(0)).rejects.toThrow(
      'RUNTIME_FRAME_HEIGHT_INVALID',
    );
    expect(() => harness.client.readAccount('', 'peer')).toThrow(
      'RUNTIME_ACCOUNT_PROJECTION_ID_MISSING',
    );
    expect(() => harness.client.readHistoryFrameBatch({})).toThrow(
      'history-frame-batch requires heights',
    );
  });

  test('never caches receipt or recovery reads', async () => {
    clearRuntimeQueryCache();
    const harness = createHarness();

    await harness.client.readReceiptStatus('receipt/id');
    await harness.client.readReceiptStatus('receipt/id');
    await harness.client.readRecoveryBundles('lookup/key');
    await harness.client.readRecoveryBundles('lookup/key');

    expect(harness.reads.map(({ path }) => path)).toEqual([
      'receipt/receipt%2Fid',
      'receipt/receipt%2Fid',
      'recovery/bundles/lookup%2Fkey',
      'recovery/bundles/lookup%2Fkey',
    ]);
    await expect(harness.client.readReceiptStatus('')).rejects.toThrow(
      'REMOTE_RUNTIME_RECEIPT_ID_MISSING',
    );
    await expect(harness.client.readRecoveryBundles('')).rejects.toThrow(
      'REMOTE_RUNTIME_RECOVERY_LOOKUP_KEY_MISSING',
    );
  });

  test('fails loudly when no Runtime adapter is connected', async () => {
    clearRuntimeQueryCache();
    const harness = createHarness();
    harness.setConnected(false);

    await expect(harness.client.readHead()).rejects.toThrow('Runtime adapter is not connected');
    await expect(harness.client.readReceiptStatus('receipt-a')).rejects.toThrow(
      'Runtime adapter is not connected',
    );
  });

  test('bounds the shared query cache and evicts the oldest entry', async () => {
    clearRuntimeQueryCache();
    const harness = createHarness();
    for (let marker = 0; marker <= 200; marker += 1) {
      await harness.client.readViewFrame({ marker });
    }
    await harness.client.readViewFrame({ marker: 0 });

    expect(harness.reads).toHaveLength(202);
  });

  test('keeps Svelte subscriptions and debug publication in the typed adapter', () => {
    const boundary = readFileSync(
      'frontend/packages/runtime-client/src/runtime-query-client.ts',
      'utf8',
    );
    const store = readFileSync('frontend/src/lib/stores/runtimeQueryClient.ts', 'utf8');

    expect(boundary).not.toContain('svelte');
    expect(boundary).not.toContain('@xln/core');
    expect(boundary).not.toContain('runtimeAdapter.subscribe');
    expect(boundary).not.toContain('registerDebugSurface');
    expect(store).toContain('extends RuntimeQueryClientBoundary<');
    expect(store).toContain('runtimeAdapter.subscribe(() => clearRuntimeQueryCache())');
    expect(store).toContain("registerDebugSurface('adapter'");
    expect(store).toContain('export const createRuntimeQueryStore');
  });
});
