import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { RuntimeViewLoader } from '../../../frontend/packages/runtime-client/src/runtime-view-loader';
import { RuntimeViewPublicationCoordinator } from '../../../frontend/packages/runtime-client/src/runtime-view-publication';
import { RuntimeViewRefreshCoordinator } from '../../../frontend/packages/runtime-client/src/runtime-view-refresh';
import {
  createEmptyRuntimeViewState,
  type RuntimeViewHandleModel,
  type RuntimeViewState,
} from '../../../frontend/packages/runtime-client/src/runtime-view-state';
import type { RuntimeViewSelection } from '../../../frontend/packages/runtime-client/src/runtime-view-selection';

type TestQuery = { entityId?: string; atHeight?: number };
type TestHead = { latestHeight: number };
type TestEntity = { entityId: string };
type TestFrame = {
  height: number;
  entities: TestEntity[];
  activeEntityId: string | null;
  activeEntity: null;
};
type TestView = RuntimeViewState<TestHead, TestEntity, TestFrame>;

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

const selection = (
  overrides: Partial<RuntimeViewSelection> = {},
): RuntimeViewSelection => ({
  revision: 0,
  entityId: '0xentity-a',
  accountsPage: 0,
  booksPage: 0,
  atHeight: null,
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
  let currentSelection = selection();
  let currentView: TestView = createEmptyRuntimeViewState(currentHandle, null);
  let readHead: () => Promise<TestHead> = async () => ({ latestHeight: 10 });
  let readFrame: (query: TestQuery) => Promise<TestFrame> = async () => frame();
  let headReads = 0;
  let frameReads = 0;
  const events: string[] = [];
  const queries: TestQuery[] = [];
  const successfulFrames: TestFrame[] = [];
  const refresh = new RuntimeViewRefreshCoordinator({
    readTarget: () => ({
      runtimeId: currentHandle.id,
      mode: currentHandle.mode,
      selection: currentSelection,
    }),
  });
  const loader = new RuntimeViewLoader<TestQuery, TestHead, TestEntity, TestFrame>({
    readCurrentHandle: () => currentHandle,
    readHead: () => {
      headReads += 1;
      events.push('read-head');
      return readHead();
    },
    readFrame: (query) => {
      frameReads += 1;
      events.push('read-frame');
      queries.push(query);
      return readFrame(query);
    },
  });
  const publication = new RuntimeViewPublicationCoordinator<
    TestQuery,
    TestHead,
    TestEntity,
    TestFrame
  >({
    refresh,
    loader,
    readHandle: () => currentHandle,
    readView: () => currentView,
    publishLoading: (view) => {
      events.push('loading');
      currentView = view;
    },
    publishSuccess: (view, nextFrame) => {
      events.push('success');
      currentView = view;
      successfulFrames.push(nextFrame);
    },
    publishUnavailable: (view) => {
      events.push('unavailable');
      currentView = view;
    },
  });
  return {
    publication,
    refresh,
    events,
    queries,
    successfulFrames,
    readCounts: () => ({ head: headReads, frame: frameReads }),
    readView: () => currentView,
    setHandle: (next: RuntimeViewHandleModel) => { currentHandle = next; },
    setSelection: (next: RuntimeViewSelection) => { currentSelection = next; },
    setReadHead: (next: () => Promise<TestHead>) => { readHead = next; },
    setReadFrame: (next: (query: TestQuery) => Promise<TestFrame>) => { readFrame = next; },
  };
};

describe('runtime-client RuntimeView publication coordinator', () => {
  test('publishes loading before live reads and routes a current success', async () => {
    const harness = createHarness();

    const result = await harness.publication.refresh({ entityId: '0xentity-a' });

    expect(harness.events).toEqual(['loading', 'read-head', 'read-frame', 'success']);
    expect(harness.queries).toEqual([{ entityId: '0xentity-a' }]);
    expect(harness.successfulFrames).toEqual([frame()]);
    expect(result).toBe(harness.readView());
    expect(result).toMatchObject({ loading: false, error: null, height: 10 });
  });

  test('pins historical queries without mutating the caller input', async () => {
    const harness = createHarness();
    harness.setSelection(selection({ revision: 1, atHeight: 7 }));
    harness.setReadFrame(async () => frame(7));
    const query = { entityId: '0xentity-a', atHeight: 99 };

    const result = await harness.publication.refresh(query);

    expect(harness.queries).toEqual([{ entityId: '0xentity-a', atHeight: 7 }]);
    expect(query).toEqual({ entityId: '0xentity-a', atHeight: 99 });
    expect(result).toMatchObject({ atHeight: 7, height: 7 });
  });

  test('routes disconnected views without issuing reads', async () => {
    const harness = createHarness();
    harness.setHandle(handle({ status: 'disconnected' }));

    const result = await harness.publication.refresh({});

    expect(harness.events).toEqual(['loading', 'unavailable']);
    expect(harness.readCounts()).toEqual({ head: 0, frame: 0 });
    expect(result).toBe(harness.readView());
    expect(result.error).toBe('Runtime adapter is not connected');
  });

  test('routes current read failures as non-rejecting unavailable views', async () => {
    const harness = createHarness();
    harness.setReadFrame(async () => { throw new Error('frame unavailable'); });

    const result = await harness.publication.refresh({});

    expect(harness.events).toEqual(['loading', 'read-head', 'read-frame', 'unavailable']);
    expect(result).toBe(harness.readView());
    expect(result.error).toBe('frame unavailable');
  });

  test('explicit invalidation suppresses an in-flight success publication', async () => {
    const harness = createHarness();
    const frameRead = deferred<TestFrame>();
    harness.setReadFrame(() => frameRead.promise);
    const loading = harness.publication.refresh({});
    harness.refresh.invalidate();
    frameRead.resolve(frame());

    const result = await loading;

    expect(result.frame).toEqual(frame());
    expect(harness.events).toEqual(['loading', 'read-head', 'read-frame']);
    expect(harness.readView()).toMatchObject({ loading: true, frame: null });
  });

  test('a changed Runtime target suppresses an in-flight success publication', async () => {
    const harness = createHarness();
    const frameRead = deferred<TestFrame>();
    harness.setReadFrame(() => frameRead.promise);
    const loading = harness.publication.refresh({});
    harness.setHandle(handle({ id: 'runtime-b', mode: 'embedded', authLevel: null }));
    frameRead.resolve(frame());

    const result = await loading;

    expect(result.runtimeId).toBe('runtime-a');
    expect(harness.events).toEqual(['loading', 'read-head', 'read-frame']);
  });

  test('a changed selection suppresses an in-flight success publication', async () => {
    const harness = createHarness();
    const frameRead = deferred<TestFrame>();
    harness.setReadFrame(() => frameRead.promise);
    const loading = harness.publication.refresh({});
    harness.setSelection(selection({ revision: 1, entityId: '0xentity-b' }));
    frameRead.resolve(frame());

    await loading;

    expect(harness.events).toEqual(['loading', 'read-head', 'read-frame']);
    expect(harness.successfulFrames).toEqual([]);
  });

  test('only the newest overlapping refresh publishes while each caller keeps its result', async () => {
    const harness = createHarness();
    const firstFrame = deferred<TestFrame>();
    let frameRequest = 0;
    harness.setReadFrame(async () => {
      frameRequest += 1;
      return frameRequest === 1 ? firstFrame.promise : frame(12);
    });

    const first = harness.publication.refresh({ entityId: '0xentity-a' });
    const second = harness.publication.refresh({ entityId: '0xentity-b' });
    const secondResult = await second;
    firstFrame.resolve(frame(9));
    const firstResult = await first;

    expect(secondResult.frame?.height).toBe(12);
    expect(firstResult.frame?.height).toBe(9);
    expect(harness.readView().frame?.height).toBe(12);
    expect(harness.successfulFrames.map(({ height }) => height)).toEqual([12]);
  });

  test('returns a stale failure with the latest handle without publishing it', async () => {
    const harness = createHarness();
    const frameRead = deferred<TestFrame>();
    harness.setReadFrame(() => frameRead.promise);
    const loading = harness.publication.refresh({});
    harness.setHandle(handle({ id: 'runtime-b', mode: 'embedded', authLevel: null }));
    frameRead.reject(new Error('runtime-a socket closed'));

    const result = await loading;

    expect(result).toMatchObject({ runtimeId: 'runtime-b', error: 'runtime-a socket closed' });
    expect(harness.events).toEqual(['loading', 'read-head', 'read-frame']);
  });

  test('keeps concrete reads and Svelte effects in the canonical adapter', () => {
    const boundary = readFileSync(
      'frontend/packages/runtime-client/src/runtime-view-publication.ts',
      'utf8',
    );
    const store = readFileSync('frontend/src/lib/stores/runtimeViewStore.ts', 'utf8');

    expect(boundary).not.toContain('svelte');
    expect(boundary).not.toContain('@xln/core');
    expect(boundary).not.toContain('runtimeQueryClient');
    expect(boundary).not.toContain('writable');
    expect(boundary).not.toContain('setTimeout');
    expect(boundary).toContain('this.dependencies.refresh.begin()');
    expect(boundary).toContain('this.dependencies.refresh.isCurrent(refreshLease)');
    expect(boundary).toContain('this.dependencies.loader.load(handle, expectedAtHeight, query)');
    expect(store).toContain('new RuntimeViewPublicationCoordinator<');
    expect(store).toContain('publishLoading: (view) => runtimeView.set(view)');
    expect(store).toContain('publishSuccess: (view, frame) =>');
    expect(store).toContain('runtimeViewPageInfo.set(runtimeViewPageInfoFromFrame(frame))');
    expect(store).toContain('continueRuntimeViewCatchup()');
    expect(store).toContain('publishUnavailable: (view) =>');
    expect(store).toContain('runtimeViewPublicationCoordinator.refresh(inputQuery)');
    expect(store).not.toContain('const refreshLease = runtimeViewRefreshCoordinator.begin()');
  });
});
