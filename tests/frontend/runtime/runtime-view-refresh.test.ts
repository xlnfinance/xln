import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  RuntimeViewRefreshCoordinator,
  type RuntimeViewRefreshTarget,
} from '../../../frontend/packages/runtime-client/src/runtime-view-refresh';
import {
  RuntimeViewSelectionCoordinator,
  type RuntimeViewSelection,
} from '../../../frontend/packages/runtime-client/src/runtime-view-selection';

const emptySelection = (): RuntimeViewSelection => ({
  revision: 0,
  entityId: '',
  accountsPage: 0,
  booksPage: 0,
  atHeight: null,
});

const createHarness = () => {
  let target: RuntimeViewRefreshTarget = {
    runtimeId: 'runtime-a',
    mode: 'remote',
    selection: emptySelection(),
  };
  const coordinator = new RuntimeViewRefreshCoordinator({
    readTarget: () => target,
  });
  return {
    coordinator,
    readTarget: () => target,
    setTarget: (next: RuntimeViewRefreshTarget) => { target = next; },
  };
};

describe('runtime-client RuntimeView refresh coordinator', () => {
  test('captures the complete Runtime and selection target in a current lease', () => {
    const harness = createHarness();
    const lease = harness.coordinator.begin();

    expect(lease).toEqual({ generation: 1, ...harness.readTarget() });
    expect(harness.coordinator.isCurrent(lease)).toBe(true);
  });

  test('makes only the newest begun refresh current', () => {
    const harness = createHarness();
    const first = harness.coordinator.begin();
    const second = harness.coordinator.begin();

    expect(harness.coordinator.isCurrent(first)).toBe(false);
    expect(harness.coordinator.isCurrent(second)).toBe(true);
  });

  test('supports explicit invalidation without beginning another refresh', () => {
    const harness = createHarness();
    const lease = harness.coordinator.begin();

    harness.coordinator.invalidate();
    expect(harness.coordinator.isCurrent(lease)).toBe(false);
  });

  test('rejects a lease after Runtime identity changes', () => {
    const harness = createHarness();
    const lease = harness.coordinator.begin();

    harness.setTarget({ ...harness.readTarget(), runtimeId: 'runtime-b' });
    expect(harness.coordinator.isCurrent(lease)).toBe(false);
  });

  test('rejects a lease after Runtime adapter mode changes', () => {
    const harness = createHarness();
    const lease = harness.coordinator.begin();

    harness.setTarget({ ...harness.readTarget(), mode: 'embedded' });
    expect(harness.coordinator.isCurrent(lease)).toBe(false);
  });

  test('matches every field in the complete selection target', () => {
    const changes: RuntimeViewSelection[] = [
      { ...emptySelection(), revision: 1 },
      { ...emptySelection(), entityId: '0xentity-a' },
      { ...emptySelection(), accountsPage: 1 },
      { ...emptySelection(), booksPage: 1 },
      { ...emptySelection(), atHeight: 7 },
    ];

    for (const selection of changes) {
      const harness = createHarness();
      const lease = harness.coordinator.begin();
      harness.setTarget({ ...harness.readTarget(), selection });
      expect(harness.coordinator.isCurrent(lease)).toBe(false);
    }
  });

  test('rejects an ABA selection after returning to the same Entity', () => {
    const selection = new RuntimeViewSelectionCoordinator();
    let target: RuntimeViewRefreshTarget = {
      runtimeId: 'runtime-a',
      mode: 'remote',
      selection: selection.getSnapshot(),
    };
    const refresh = new RuntimeViewRefreshCoordinator({ readTarget: () => target });
    selection.setActiveEntityId('0xentity-a');
    target = { ...target, selection: selection.getSnapshot() };
    const firstA = refresh.begin();

    selection.setActiveEntityId('0xentity-b');
    selection.setActiveEntityId('0xentity-a');
    target = { ...target, selection: selection.getSnapshot() };
    expect(refresh.isCurrent(firstA)).toBe(false);
  });

  test('invalidates before selection subscribers can start stale work', () => {
    let selection!: RuntimeViewSelectionCoordinator;
    const refresh = new RuntimeViewRefreshCoordinator({
      readTarget: () => ({
        runtimeId: 'runtime-a',
        mode: 'remote',
        selection: selection.getSnapshot(),
      }),
    });
    selection = new RuntimeViewSelectionCoordinator({ beforePublish: refresh.invalidate });
    const lease = refresh.begin();
    let currentDuringNotification = true;
    selection.subscribe(() => {
      currentDuringNotification = refresh.isCurrent(lease);
    });

    expect(selection.setPage('accounts', 0)).toBe(false);
    expect(refresh.isCurrent(lease)).toBe(true);
    expect(selection.setPage('accounts', 1)).toBe(true);
    expect(currentDuringNotification).toBe(false);
  });

  test('keeps an invalidated lease stale after an ABA Runtime target restore', () => {
    const harness = createHarness();
    const original = harness.readTarget();
    const lease = harness.coordinator.begin();

    harness.coordinator.invalidate();
    harness.setTarget({ ...original, runtimeId: 'runtime-b' });
    harness.setTarget(original);
    expect(harness.coordinator.isCurrent(lease)).toBe(false);
  });

  test('keeps Svelte effects outside the refresh boundary', () => {
    const boundary = readFileSync(
      'frontend/packages/runtime-client/src/runtime-view-refresh.ts',
      'utf8',
    );
    const store = readFileSync('frontend/src/lib/stores/runtimeViewStore.ts', 'utf8');

    expect(boundary).not.toContain('svelte');
    expect(boundary).not.toContain('@xln/core');
    expect(boundary).not.toContain('writable');
    expect(store).toContain('new RuntimeViewRefreshCoordinator({');
    expect(store).toContain('beforePublish: runtimeViewRefreshCoordinator.invalidate');
    expect(store).toContain('const refreshLease = runtimeViewRefreshCoordinator.begin();');
    expect(store).toContain('runtimeViewRefreshCoordinator.isCurrent(refreshLease)');
    expect(store).not.toContain('let runtimeViewRefreshId');
    expect(store).not.toContain('const expectedRuntimeId');
    expect(store).not.toContain('const expectedRuntimeMode');
  });
});
