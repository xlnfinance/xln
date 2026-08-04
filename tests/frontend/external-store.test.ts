import { expect, test } from 'bun:test';
import { createExternalStore, selectExternalStore } from '../../frontend/packages/client-core/external-store';
import { defaultAppState, reduceAppState } from '../../frontend/packages/client-core/app-state';
import {
  get,
  toWritableStore,
} from '../../frontend/src/lib/stores/storeBindings';
import { createErrorLogStore } from '../../frontend/src/lib/stores/errorLogStore';
import { createToastStore } from '../../frontend/src/lib/stores/toastStore';

test('external store keeps snapshots stable and skips no-op notifications', () => {
  const binding = createExternalStore(Object.freeze({ count: 0 }));
  const initial = binding.store.getSnapshot();
  let notifications = 0;
  const unsubscribe = binding.store.subscribe(() => {
    notifications += 1;
  });

  binding.controller.set(initial);
  expect(binding.store.getSnapshot()).toBe(initial);
  expect(notifications).toBe(0);

  binding.controller.update((snapshot) => Object.freeze({ count: snapshot.count + 1 }));
  expect(binding.store.getSnapshot()).toEqual({ count: 1 });
  expect(notifications).toBe(1);
  unsubscribe();
});

test('notification order is synchronous and removal suppresses a pending listener', () => {
  const binding = createExternalStore(0);
  const events: string[] = [];
  let removeSecond = (): void => undefined;
  binding.store.subscribe(() => {
    events.push(`first:${binding.store.getSnapshot()}`);
    removeSecond();
  });
  removeSecond = binding.store.subscribe(() => {
    events.push('second');
  });
  binding.store.subscribe(() => {
    events.push('third');
  });

  binding.controller.set(1);
  expect(events).toEqual(['first:1', 'third']);
});

test('listener failures stay loud after every remaining listener is notified', () => {
  const binding = createExternalStore(0);
  const events: string[] = [];
  binding.store.subscribe(() => {
    events.push('throw');
    throw new Error('listener failed');
  });
  binding.store.subscribe(() => {
    events.push('after');
  });

  expect(() => binding.controller.set(1)).toThrow('listener failed');
  expect(events).toEqual(['throw', 'after']);
  expect(binding.store.getSnapshot()).toBe(1);
});

test('nested transitions and use after teardown fail deterministically', () => {
  const binding = createExternalStore(0);
  binding.store.subscribe(() => binding.controller.set(2));
  expect(() => binding.controller.set(1)).toThrow('EXTERNAL_STORE_REENTRANT_TRANSITION');
  expect(binding.store.getSnapshot()).toBe(1);

  binding.controller.destroy();
  expect(() => binding.controller.set(3)).toThrow('EXTERNAL_STORE_DESTROYED');
  expect(() => binding.store.subscribe(() => undefined)).toThrow('EXTERNAL_STORE_DESTROYED');
});

test('selector stores notify only when the selected snapshot changes', () => {
  const binding = createExternalStore(Object.freeze({ count: 0, label: 'a' }));
  const count = selectExternalStore(binding.store, (snapshot) => snapshot.count);
  let notifications = 0;
  count.subscribe(() => {
    notifications += 1;
  });

  binding.controller.set(Object.freeze({ count: 0, label: 'b' }));
  binding.controller.set(Object.freeze({ count: 1, label: 'b' }));
  expect(count.getSnapshot()).toBe(1);
  expect(notifications).toBe(1);
});

test('store binding is a facade over the same external snapshot', () => {
  const binding = createExternalStore(0);
  const store = toWritableStore(binding);
  const snapshots: number[] = [];
  const unsubscribe = store.subscribe((snapshot) => snapshots.push(snapshot));

  binding.controller.set(1);
  store.update((snapshot) => snapshot + 1);
  unsubscribe();

  expect(snapshots).toEqual([0, 1, 2]);
  expect(get(store)).toBe(binding.store.getSnapshot());
});

test('pure app transitions replay identically and preserve no-op identity', () => {
  const inputs = [
    { type: 'setMode', mode: 'dev' },
    { type: 'navigate', level: 'jurisdiction', id: 'alpha' },
    { type: 'navigate', level: 'entity', id: 'entity-a' },
  ] as const;
  const replay = () => inputs.reduce(reduceAppState, defaultAppState());

  expect(replay()).toEqual(replay());
  const state = replay();
  expect(reduceAppState(state, { type: 'setMode', mode: 'dev' })).toBe(state);
});

test('error clock and toast scheduling are explicit deterministic ports', () => {
  const errorStore = createErrorLogStore({ now: () => 42 });
  errorStore.log('failed', 'test');
  expect(errorStore.externalStore.getSnapshot()).toEqual([{
    timestamp: 42,
    message: 'failed',
    source: 'test',
    details: undefined,
  }]);

  const scheduled: Array<() => void> = [];
  const toastStore = createToastStore({
    schedule: (_delayMs, task) => scheduled.push(task),
  });
  const id = toastStore.success('saved', 100);
  expect(toastStore.externalStore.getSnapshot()).toEqual([{
    id,
    type: 'success',
    message: 'saved',
    duration: 100,
  }]);
  scheduled[0]?.();
  expect(toastStore.externalStore.getSnapshot()).toEqual([]);
});
