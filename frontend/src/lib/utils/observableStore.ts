/**
 * Minimal observable store with the svelte store contract — synchronous
 * current-value emission on subscribe, set/update/subscribe — and zero
 * framework imports, so the workspace data layer stays portable while the
 * React migration consumes the same stores.
 */

export type ObservableStore<T> = {
  get: () => T;
  set: (value: T) => void;
  update: (fn: (current: T) => T) => void;
  subscribe: (run: (value: T) => void) => () => void;
};

export const createObservableStore = <T>(initial: T): ObservableStore<T> => {
  const listeners = new Set<(value: T) => void>();
  let current = initial;
  return {
    get: () => current,
    set: value => {
      current = value;
      for (const listener of listeners) listener(value);
    },
    update: fn => {
      current = fn(current);
      for (const listener of listeners) listener(current);
    },
    subscribe: run => {
      listeners.add(run);
      run(current);
      return () => listeners.delete(run);
    },
  };
};

/**
 * One-shot read of any store-contract object (svelte writable or
 * ObservableStore): subscribe, capture, unsubscribe. This is exactly how
 * svelte's get() behaves, without importing the framework.
 */
export const readStoreValue = <T>(store: {
  subscribe: (run: (value: T) => void) => () => void;
}): T => {
  let value!: T;
  const unsubscribe = store.subscribe(next => { value = next; });
  unsubscribe();
  return value;
};
