import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { RuntimeViewLoader } from '../../../frontend/packages/runtime-client/src/runtime-view-loader';
import type { RuntimeViewHandleModel } from '../../../frontend/packages/runtime-client/src/runtime-view-state';

type TestQuery = { entityId?: string; atHeight?: number };
type TestHead = { latestHeight: number };
type TestEntity = { entityId: string };
type TestFrame = {
  height: number;
  entities: TestEntity[];
  activeEntityId: string | null;
  activeEntity: null;
};

const handle = (
  overrides: Partial<RuntimeViewHandleModel> = {},
): RuntimeViewHandleModel => ({
  id: 'runtime-a',
  mode: 'remote',
  authLevel: 'admin',
  status: 'connected',
  height: 8,
  ...overrides,
});

const frame = (height = 9): TestFrame => ({
  height,
  entities: [{ entityId: '0xentity-a' }],
  activeEntityId: '0xentity-a',
  activeEntity: null,
});

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const createHarness = () => {
  let currentHandle = handle();
  let headReads = 0;
  let frameReads = 0;
  const queries: TestQuery[] = [];
  let readHead: () => Promise<TestHead> = async () => ({ latestHeight: 10 });
  let readFrame: (query: TestQuery) => Promise<TestFrame> = async () => frame();
  const loader = new RuntimeViewLoader<TestQuery, TestHead, TestEntity, TestFrame>({
    readCurrentHandle: () => currentHandle,
    readHead: () => {
      headReads += 1;
      return readHead();
    },
    readFrame: (query) => {
      frameReads += 1;
      queries.push(query);
      return readFrame(query);
    },
  });
  return {
    loader,
    queries,
    readCounts: () => ({ head: headReads, frame: frameReads }),
    setCurrentHandle: (next: RuntimeViewHandleModel) => { currentHandle = next; },
    setReadHead: (next: () => Promise<TestHead>) => { readHead = next; },
    setReadFrame: (next: (query: TestQuery) => Promise<TestFrame>) => { readFrame = next; },
  };
};

describe('runtime-client RuntimeView loader', () => {
  test('returns a disconnected outcome without issuing reads', async () => {
    const harness = createHarness();
    const outcome = await harness.loader.load(
      handle({ status: 'disconnected' }),
      null,
      { entityId: '0xentity-a' },
    );

    expect(outcome.kind).toBe('disconnected');
    expect(outcome.frame).toBeNull();
    expect(outcome.view).toMatchObject({
      runtimeId: 'runtime-a',
      status: 'disconnected',
      error: 'Runtime adapter is not connected',
    });
    expect(harness.readCounts()).toEqual({ head: 0, frame: 0 });
  });

  test('starts head and frame reads concurrently', async () => {
    const harness = createHarness();
    const headRead = deferred<TestHead>();
    const frameRead = deferred<TestFrame>();
    harness.setReadHead(() => headRead.promise);
    harness.setReadFrame(() => frameRead.promise);

    const loading = harness.loader.load(handle(), null, {});
    expect(harness.readCounts()).toEqual({ head: 1, frame: 1 });
    headRead.resolve({ latestHeight: 10 });
    frameRead.resolve(frame());
    expect((await loading).kind).toBe('success');
  });

  test('builds a live success from the greatest observed height', async () => {
    const harness = createHarness();
    const outcome = await harness.loader.load(handle(), null, { entityId: '0xentity-a' });

    expect(outcome.kind).toBe('success');
    expect(outcome.frame).toEqual(frame());
    expect(outcome.view).toMatchObject({
      runtimeId: 'runtime-a',
      atHeight: null,
      height: 10,
      head: { latestHeight: 10 },
      entities: [{ entityId: '0xentity-a' }],
      activeEntityId: '0xentity-a',
      error: null,
    });
  });

  test('pins a historical success and forwards its exact query', async () => {
    const harness = createHarness();
    harness.setReadFrame(async () => frame(7));
    const query = { entityId: '0xentity-a', atHeight: 7 };

    const outcome = await harness.loader.load(handle({ height: 20 }), 7, query);

    expect(outcome.kind).toBe('success');
    expect(outcome.view.height).toBe(7);
    expect(outcome.view.atHeight).toBe(7);
    expect(harness.queries).toEqual([query]);
  });

  test('returns a loud error when a historical frame has the wrong height', async () => {
    const harness = createHarness();

    const outcome = await harness.loader.load(handle(), 7, { atHeight: 7 });

    expect(outcome.kind).toBe('error');
    expect(outcome.frame).toBeNull();
    expect(outcome.view.error).toBe('RuntimeView returned h9 for selected h7');
  });

  test('normalizes a head-read rejection into an error outcome', async () => {
    const harness = createHarness();
    harness.setReadHead(async () => { throw new Error('head unavailable'); });

    const outcome = await harness.loader.load(handle(), null, {});

    expect(outcome.kind).toBe('error');
    expect(outcome.view.error).toBe('head unavailable');
    expect(harness.readCounts()).toEqual({ head: 1, frame: 1 });
  });

  test('normalizes a frame-read rejection into an error outcome', async () => {
    const harness = createHarness();
    harness.setReadFrame(async () => { throw new Error('frame unavailable'); });

    const outcome = await harness.loader.load(handle(), null, {});

    expect(outcome.kind).toBe('error');
    expect(outcome.view.error).toBe('frame unavailable');
    expect(harness.readCounts()).toEqual({ head: 1, frame: 1 });
  });

  test('uses the latest Runtime handle when an in-flight read fails', async () => {
    const harness = createHarness();
    const frameRead = deferred<TestFrame>();
    harness.setReadFrame(() => frameRead.promise);
    const loading = harness.loader.load(handle(), null, {});
    harness.setCurrentHandle(handle({ id: 'runtime-b', mode: 'embedded', authLevel: null }));
    frameRead.reject(new Error('runtime-a socket closed'));

    const outcome = await loading;

    expect(outcome.kind).toBe('error');
    expect(outcome.view).toMatchObject({
      runtimeId: 'runtime-b',
      mode: 'embedded',
      authLevel: null,
      error: 'runtime-a socket closed',
    });
  });

  test('keeps the captured Runtime handle when an in-flight read succeeds', async () => {
    const harness = createHarness();
    const frameRead = deferred<TestFrame>();
    harness.setReadFrame(() => frameRead.promise);
    const loading = harness.loader.load(handle(), null, {});
    harness.setCurrentHandle(handle({ id: 'runtime-b', mode: 'embedded', authLevel: null }));
    frameRead.resolve(frame());

    const outcome = await loading;

    expect(outcome.kind).toBe('success');
    expect(outcome.view).toMatchObject({
      runtimeId: 'runtime-a',
      mode: 'remote',
      authLevel: 'admin',
    });
  });

  test('keeps concrete reads, refresh leases, and publication in the Svelte adapter', () => {
    const boundary = readFileSync(
      'frontend/packages/runtime-client/src/runtime-view-loader.ts',
      'utf8',
    );
    const store = readFileSync('frontend/src/lib/stores/runtimeViewStore.ts', 'utf8');

    expect(boundary).not.toContain('svelte');
    expect(boundary).not.toContain('@xln/core');
    expect(boundary).not.toContain('runtimeQueryClient');
    expect(boundary).not.toContain('writable');
    expect(boundary).toContain('Promise.all([');
    expect(boundary).toContain('runtimeViewFrameMatchesAtHeight(frame, atHeight)');
    expect(boundary).toContain('createDisconnectedRuntimeViewState<');
    expect(boundary).toContain('createSuccessRuntimeViewState<');
    expect(boundary).toContain('createErrorRuntimeViewState<');
    expect(store).toContain('new RuntimeViewLoader<');
    expect(store).toContain('readHead: () => runtimeQueryClient.readHead()');
    expect(store).toContain('readFrame: (query) => runtimeQueryClient.readViewFrame(query)');
    expect(store).toContain('runtimeViewLoader.load(handle, expectedAtHeight, query)');
    expect(store).toContain('const requestStillCurrent = (): boolean =>');
    expect(store).toContain("if (outcome.kind === 'success')");
    expect(store).toContain('runtimeViewPageInfo.set(runtimeViewPageInfoFromFrame(frame));');
    expect(store).toContain('export const runtimeView = writable<RuntimeView>');
  });
});
