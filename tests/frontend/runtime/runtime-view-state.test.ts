import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  advanceRuntimeViewHeight,
  createDisconnectedRuntimeViewState,
  createEmptyRuntimeViewState,
  createErrorRuntimeViewState,
  createLoadingRuntimeViewState,
  createSuccessRuntimeViewState,
  runtimeViewErrorMessage,
  selectRuntimeViewHeight,
  type RuntimeViewHandleModel,
  type RuntimeViewState,
} from '../../../frontend/packages/runtime-client/src/runtime-view-state';

type TestHead = { latestHeight: number };
type TestEntity = { entityId: string };
type TestFrame = {
  height: number;
  entities: TestEntity[];
  activeEntityId: string | null;
  activeEntity: null;
};
type TestActiveFrame = Omit<TestFrame, 'activeEntity'> & {
  activeEntity: {
    summary: { entityId: string };
    accounts: { items: unknown[] };
    books: { items: unknown[] };
  };
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

const successView = (atHeight: number | null = null): TestView =>
  createSuccessRuntimeViewState<TestHead, TestEntity, TestFrame>(
    handle(),
    atHeight,
    { latestHeight: 10 },
    {
      height: 9,
      entities: [{ entityId: '0xentity-a' }],
      activeEntityId: '0xentity-a',
      activeEntity: null,
    },
  );

describe('runtime-client RuntimeView state boundary', () => {
  test('creates an empty live view from the active Runtime handle', () => {
    expect(createEmptyRuntimeViewState<TestHead, TestEntity, TestFrame>(handle(), null))
      .toEqual({
        runtimeId: 'runtime-a',
        mode: 'remote',
        authLevel: 'admin',
        status: 'connected',
        atHeight: null,
        height: 8,
        loading: false,
        error: null,
        head: null,
        frame: null,
        entities: [],
        activeEntityId: '',
      });
    expect(createEmptyRuntimeViewState<TestHead, TestEntity, TestFrame>(
      handle({ height: Number.NaN }),
      null,
    ).height).toBe(0);
  });

  test('pins an empty historical view to its selected height', () => {
    const view = createEmptyRuntimeViewState<TestHead, TestEntity, TestFrame>(
      handle({ height: 20 }),
      7,
    );

    expect(view).toMatchObject({ atHeight: 7, height: 7 });
  });

  test('starts loading on the current target without discarding its projection', () => {
    const current = { ...successView(), error: 'old failure' };
    const view = createLoadingRuntimeViewState(
      current,
      handle({ id: 'runtime-b', mode: 'embedded', authLevel: null, height: 12 }),
      null,
    );

    expect(view).toMatchObject({
      runtimeId: 'runtime-b',
      mode: 'embedded',
      authLevel: null,
      height: 12,
      loading: true,
      error: null,
      frame: current.frame,
      entities: current.entities,
    });
  });

  test('creates a disconnected empty view with a loud adapter error', () => {
    const view = createDisconnectedRuntimeViewState<TestHead, TestEntity, TestFrame>(
      handle({ status: 'disconnected' }),
      null,
    );

    expect(view).toMatchObject({
      status: 'disconnected',
      loading: false,
      error: 'Runtime adapter is not connected',
      frame: null,
    });
  });

  test('uses the greatest observed committed height for a live success', () => {
    const view = successView();

    expect(view.height).toBe(10);
    expect(view.head).toEqual({ latestHeight: 10 });
    expect(view.entities).toEqual([{ entityId: '0xentity-a' }]);
    expect(view.activeEntityId).toBe('0xentity-a');
    expect(view.loading).toBe(false);
  });

  test('keeps historical success pinned and normalizes fallback Entity identity', () => {
    const view = createSuccessRuntimeViewState<TestHead, TestEntity, TestActiveFrame>(
      handle({ height: 20 }),
      7,
      { latestHeight: 20 },
      {
        height: 7,
        entities: [],
        activeEntityId: null,
        activeEntity: {
          summary: { entityId: ' 0xENTITY-B ' },
          accounts: { items: [] },
          books: { items: [] },
        },
      },
    );

    expect(view.height).toBe(7);
    expect(view.activeEntityId).toBe('0xentity-b');
  });

  test('normalizes Error and non-Error refresh failures', () => {
    expect(runtimeViewErrorMessage(new Error('socket closed'))).toBe('socket closed');
    expect(runtimeViewErrorMessage('bad response')).toBe('bad response');
    expect(runtimeViewErrorMessage(null)).toBe('RuntimeView refresh failed');
    expect(createErrorRuntimeViewState<TestHead, TestEntity, TestFrame>(
      handle({ status: 'error' }),
      null,
      new Error('socket closed'),
    )).toMatchObject({ status: 'error', error: 'socket closed', frame: null });
  });

  test('selects a height while clearing stale projection data', () => {
    const current = { ...successView(), error: 'old failure' };
    const historical = selectRuntimeViewHeight(current, 7, 20);
    const live = selectRuntimeViewHeight(historical, null, 20);

    expect(historical).toMatchObject({
      atHeight: 7,
      height: 7,
      loading: true,
      error: null,
      frame: null,
      entities: [],
      activeEntityId: '0xentity-a',
    });
    expect(live).toMatchObject({ atHeight: null, height: 20 });
  });

  test('advances live height monotonically without moving historical views', () => {
    const live = successView();
    const advanced = advanceRuntimeViewHeight(live, 12);
    const unchanged = advanceRuntimeViewHeight(advanced, 11);
    const historical = advanceRuntimeViewHeight(successView(7), 20);

    expect(advanced.height).toBe(12);
    expect(unchanged.height).toBe(12);
    expect(historical.height).toBe(7);
  });

  test('keeps concrete reads and Svelte publication outside the state boundary', () => {
    const boundary = readFileSync(
      'frontend/packages/runtime-client/src/runtime-view-state.ts',
      'utf8',
    );
    const loader = readFileSync(
      'frontend/packages/runtime-client/src/runtime-view-loader.ts',
      'utf8',
    );
    const store = readFileSync('frontend/src/lib/stores/runtimeViewStore.ts', 'utf8');

    expect(boundary).not.toContain('svelte');
    expect(boundary).not.toContain('@xln/core');
    expect(boundary).not.toContain('runtimeQueryClient');
    expect(boundary).not.toContain('writable');
    expect(store).toContain('export type RuntimeView = RuntimeViewState<');
    expect(store).toContain('createLoadingRuntimeViewState(view, handle, expectedAtHeight)');
    expect(loader).toContain('createDisconnectedRuntimeViewState<');
    expect(loader).toContain('createSuccessRuntimeViewState<');
    expect(loader).toContain('createErrorRuntimeViewState<');
    expect(store).toContain('new RuntimeViewLoader<');
    expect(store).toContain('selectRuntimeViewHeight(view, atHeight');
    expect(store).toContain('advanceRuntimeViewHeight(view, nextHeight)');
    expect(store).not.toContain('next.runtimeId = current.id');
    expect(store).not.toContain('height: expectedAtHeight ?? Math.max(');
  });
});
