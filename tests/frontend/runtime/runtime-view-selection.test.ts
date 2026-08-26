import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  RuntimeViewSelectionCoordinator,
} from '../../../frontend/packages/runtime-client/src/runtime-view-selection';

describe('runtime-client RuntimeView selection coordinator', () => {
  test('starts with one stable empty selection snapshot', () => {
    const coordinator = new RuntimeViewSelectionCoordinator();
    const snapshot = coordinator.getSnapshot();

    expect(snapshot).toEqual({
      revision: 0,
      entityId: '',
      accountsPage: 0,
      booksPage: 0,
      atHeight: null,
    });
    expect(coordinator.getSnapshot()).toBe(snapshot);
    expect(coordinator.matches(snapshot)).toBe(true);
  });

  test('normalizes Entity identity and resets both page selections', () => {
    const coordinator = new RuntimeViewSelectionCoordinator();
    coordinator.setPage('accounts', 3);
    coordinator.setPage('books', 4);

    expect(coordinator.setActiveEntityId(' 0xENTITY-A ')).toBe(true);
    expect(coordinator.getSnapshot()).toEqual({
      revision: 3,
      entityId: '0xentity-a',
      accountsPage: 0,
      booksPage: 0,
      atHeight: null,
    });
  });

  test('reselecting the same Entity preserves pagination and snapshot identity', () => {
    const coordinator = new RuntimeViewSelectionCoordinator();
    coordinator.setActiveEntityId('0xentity-a');
    coordinator.setPage('accounts', 3);
    coordinator.setPage('books', 4);
    const before = coordinator.getSnapshot();

    expect(coordinator.setActiveEntityId(' 0xENTITY-A ')).toBe(false);
    expect(coordinator.getSnapshot()).toBe(before);
    expect(coordinator.getSnapshot()).toMatchObject({ accountsPage: 3, booksPage: 4 });
  });

  test('normalizes each page independently and ignores unchanged pages', () => {
    const coordinator = new RuntimeViewSelectionCoordinator();

    expect(coordinator.setPage('accounts', 3.9)).toBe(true);
    expect(coordinator.setPage('books', 2)).toBe(true);
    const selected = coordinator.getSnapshot();
    expect(selected).toMatchObject({ revision: 2, accountsPage: 3, booksPage: 2 });
    expect(coordinator.setPage('accounts', 3)).toBe(false);
    expect(coordinator.getSnapshot()).toBe(selected);
    expect(coordinator.setPage('books', -4)).toBe(true);
    expect(coordinator.getSnapshot().booksPage).toBe(0);
  });

  test('normalizes historical height without changing Entity or pages', () => {
    const coordinator = new RuntimeViewSelectionCoordinator();
    coordinator.setActiveEntityId('0xentity-a');
    coordinator.setPage('accounts', 2);

    expect(coordinator.setAtHeight(7.9)).toBe(true);
    expect(coordinator.getSnapshot()).toMatchObject({
      revision: 3,
      entityId: '0xentity-a',
      accountsPage: 2,
      atHeight: 7,
    });
    expect(coordinator.setAtHeight(7)).toBe(false);
    expect(() => coordinator.setAtHeight(0)).toThrow('positive integer');
    expect(coordinator.setAtHeight(null)).toBe(true);
  });

  test('navigation reset always invalidates readers while retaining selected height', () => {
    const coordinator = new RuntimeViewSelectionCoordinator();
    coordinator.setActiveEntityId('0xentity-a');
    coordinator.setPage('books', 2);
    coordinator.setAtHeight(8);
    const beforeReset = coordinator.getSnapshot();

    coordinator.resetNavigation();
    expect(coordinator.getSnapshot()).toEqual({
      revision: beforeReset.revision + 1,
      entityId: '',
      accountsPage: 0,
      booksPage: 0,
      atHeight: 8,
    });
    const firstReset = coordinator.getSnapshot();
    coordinator.resetNavigation();
    expect(coordinator.getSnapshot().revision).toBe(firstReset.revision + 1);
  });

  test('rejects an ABA publication even after returning to the same Entity', () => {
    const coordinator = new RuntimeViewSelectionCoordinator();
    coordinator.setActiveEntityId('0xentity-a');
    const firstA = coordinator.getSnapshot();
    coordinator.setActiveEntityId('0xentity-b');
    coordinator.setActiveEntityId('0xentity-a');

    expect(coordinator.getSnapshot().entityId).toBe(firstA.entityId);
    expect(coordinator.matches(firstA)).toBe(false);
  });

  test('requires both generation and complete selection identity for publication', () => {
    const coordinator = new RuntimeViewSelectionCoordinator();
    coordinator.setActiveEntityId('0xentity-a');
    const selection = coordinator.getSnapshot();

    expect(coordinator.publicationMatches(2, 2, selection)).toBe(true);
    expect(coordinator.publicationMatches(2, 3, selection)).toBe(false);
    coordinator.setPage('accounts', 1);
    expect(coordinator.publicationMatches(2, 2, selection)).toBe(false);
  });

  test('notifies active subscribers only when a selection publication occurs', () => {
    const coordinator = new RuntimeViewSelectionCoordinator();
    let first = 0;
    let second = 0;
    const unsubscribeFirst = coordinator.subscribe(() => { first += 1; });
    coordinator.subscribe(() => { second += 1; });

    coordinator.setActiveEntityId('0xentity-a');
    coordinator.setActiveEntityId('0xentity-a');
    expect([first, second]).toEqual([1, 1]);
    unsubscribeFirst();
    coordinator.setAtHeight(7);
    expect([first, second]).toEqual([1, 2]);
  });

  test('keeps Svelte readable stores outside the selection boundary', () => {
    const boundary = readFileSync(
      'frontend/packages/runtime-client/src/runtime-view-selection.ts',
      'utf8',
    );
    const store = readFileSync('frontend/src/lib/stores/runtimeViewStore.ts', 'utf8');

    expect(boundary).not.toContain('svelte');
    expect(boundary).not.toContain('@xln/core');
    expect(boundary).not.toContain('runtimeViewRefreshId');
    expect(store).toContain('new RuntimeViewSelectionCoordinator({');
    expect(store).toContain('beforePublish: runtimeViewRefreshCoordinator.invalidate');
    expect(store).toContain('const runtimeViewSelectionStore = readable(');
    expect(store).toContain('export const runtimeViewActiveEntityId = derived(');
    expect(store).toContain('runtimeViewSelectionCoordinator.setAtHeight(atHeight);');
    expect(store).not.toContain('let runtimeViewSelectionRevision');
    expect(store).not.toContain('let selectedRuntimeViewHeight');
    expect(store).not.toContain('runtimeViewActiveEntityId.set(');
  });
});
