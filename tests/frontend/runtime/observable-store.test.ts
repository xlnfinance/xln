import { describe, expect, test } from 'bun:test';

import { createObservableStore, readStoreValue } from '../../../frontend/src/lib/utils/observableStore';

describe('observable store', () => {
  test('emits the current value synchronously on subscribe and on every set/update', () => {
    const store = createObservableStore(1);
    const seen: number[] = [];
    const unsubscribe = store.subscribe(value => seen.push(value));
    expect(seen).toEqual([1]);
    store.set(2);
    store.update(current => current + 1);
    expect(seen).toEqual([1, 2, 3]);
    expect(store.get()).toBe(3);
    unsubscribe();
    store.set(4);
    expect(seen).toEqual([1, 2, 3]);
  });

  test('reads any store-contract object once, including svelte-style writables', () => {
    const listeners = new Set<(value: string) => void>();
    let current = 'a';
    const svelteShaped = {
      subscribe: (run: (value: string) => void): (() => void) => {
        listeners.add(run);
        run(current);
        return () => listeners.delete(run);
      },
    };
    expect(readStoreValue(svelteShaped)).toBe('a');
    current = 'b';
    for (const listener of listeners) listener(current);
    expect(readStoreValue(svelteShaped)).toBe('b');
    // A one-shot read must not leak a subscription behind it.
    expect(listeners.size).toBe(0);
    expect(readStoreValue(createObservableStore('z'))).toBe('z');
  });
});
