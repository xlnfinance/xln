import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  createRuntimeSelectionCoordinator,
  type RuntimeSelectionLease,
} from '../../../frontend/packages/runtime-client/src/runtime-selection';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

describe('runtime-client selection coordinator', () => {
  test('is one-writer and runs only the latest queued intent', async () => {
    const coordinator = createRuntimeSelectionCoordinator();
    const releaseFirst = deferred<void>();
    const firstStarted = deferred<void>();
    const events: string[] = [];

    const first = coordinator.runLatest(async () => {
      events.push('first:start');
      firstStarted.resolve();
      await releaseFirst.promise;
      events.push('first:end');
      return 'first';
    });
    await firstStarted.promise;

    const skippedMiddle = coordinator.runLatest(async () => {
      events.push('middle');
      return 'middle';
    });
    const latest = coordinator.runLatest(async () => {
      events.push('latest');
      return 'latest';
    });

    releaseFirst.resolve();
    expect(await first).toBeNull();
    expect(await skippedMiddle).toBeNull();
    expect(await latest).toBe('latest');
    expect(events).toEqual(['first:start', 'first:end', 'latest']);
  });

  test('invalidates an active lease as soon as a newer intent arrives', async () => {
    const coordinator = createRuntimeSelectionCoordinator();
    const firstStarted = deferred<RuntimeSelectionLease>();
    const releaseFirst = deferred<void>();
    const first = coordinator.runLatest(async (lease) => {
      firstStarted.resolve(lease);
      await releaseFirst.promise;
      return coordinator.isCurrent(lease);
    });
    const firstLease = await firstStarted.promise;
    expect(coordinator.isCurrent(firstLease)).toBe(true);
    coordinator.assertActive(firstLease);

    const latest = coordinator.runLatest(async () => 'latest');
    expect(coordinator.isCurrent(firstLease)).toBe(false);
    releaseFirst.resolve();
    expect(await first).toBeNull();
    expect(await latest).toBe('latest');
  });

  test('rejects leases outside their active operation', async () => {
    const coordinator = createRuntimeSelectionCoordinator();
    let completedLease!: RuntimeSelectionLease;
    expect(await coordinator.runLatest(async (lease) => {
      completedLease = lease;
      coordinator.assertActive(lease);
      return true;
    })).toBe(true);

    expect(coordinator.isCurrent(completedLease)).toBe(false);
    expect(() => coordinator.assertActive(completedLease)).toThrow('RUNTIME_SELECTION_LEASE_INVALID');
    expect(() => coordinator.assertActive({ revision: 1, token: Symbol('forged') }))
      .toThrow('RUNTIME_SELECTION_LEASE_INVALID');
  });

  test('releases the queue after an operation failure', async () => {
    const coordinator = createRuntimeSelectionCoordinator();
    const failureStarted = deferred<void>();
    const releaseFailure = deferred<void>();
    const failure = coordinator.runLatest(async () => {
      failureStarted.resolve();
      await releaseFailure.promise;
      throw new Error('SELECTION_FAILED');
    });
    await failureStarted.promise;
    const recovery = coordinator.runLatest(async () => 'recovered');
    releaseFailure.resolve();

    await expect(failure).rejects.toThrow('SELECTION_FAILED');
    expect(await recovery).toBe('recovered');
  });

  test('keeps the Svelte store as the activation adapter', () => {
    const boundary = readFileSync('frontend/packages/runtime-client/src/runtime-selection.ts', 'utf8');
    const store = readFileSync('frontend/src/lib/stores/runtimeStore.ts', 'utf8');

    expect(boundary).not.toContain('svelte');
    expect(boundary).not.toContain('localStorage');
    expect(boundary).not.toContain('switchToRuntimeAdapter');
    expect(store).toContain('createRuntimeSelectionCoordinator');
    expect(store).toContain('runtimeSelectionCoordinator.runLatest(operation)');
    expect(store).toContain('runtimeSelectionCoordinator.assertActive(lease)');
  });
});
