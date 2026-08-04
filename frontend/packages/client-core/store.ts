export type StoreSubscriber<T> = (snapshot: T) => void;
export type StoreUnsubscriber = () => void;

export interface ReadableStore<T> {
  subscribe(subscriber: StoreSubscriber<T>): StoreUnsubscriber;
}

export interface WritableStore<T> extends ReadableStore<T> {
  set(snapshot: T): void;
  update(transition: (snapshot: T) => T): void;
}

type StoreValues<TStores extends readonly ReadableStore<unknown>[]> = {
  [TIndex in keyof TStores]: TStores[TIndex] extends ReadableStore<infer TValue> ? TValue : never;
};

export const writable = <T>(initialSnapshot: T): WritableStore<T> => {
  let snapshot = initialSnapshot;
  const subscribers = new Set<StoreSubscriber<T>>();
  const set = (nextSnapshot: T): void => {
    if (Object.is(snapshot, nextSnapshot)) return;
    snapshot = nextSnapshot;
    for (const subscriber of [...subscribers]) {
      if (subscribers.has(subscriber)) subscriber(snapshot);
    }
  };
  return Object.freeze({
    subscribe: (subscriber: StoreSubscriber<T>): StoreUnsubscriber => {
      subscriber(snapshot);
      subscribers.add(subscriber);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(subscriber);
      };
    },
    set,
    update: (transition: (current: T) => T): void => set(transition(snapshot)),
  });
};

export const get = <T>(store: ReadableStore<T>): T => {
  let snapshot!: T;
  const unsubscribe = store.subscribe(next => { snapshot = next; });
  unsubscribe();
  return snapshot;
};

export function derived<TSource, TSnapshot>(
  source: ReadableStore<TSource>,
  project: (snapshot: TSource) => TSnapshot,
): ReadableStore<TSnapshot>;
export function derived<const TStores extends readonly ReadableStore<unknown>[], TSnapshot>(
  sources: TStores,
  project: (snapshots: StoreValues<TStores>) => TSnapshot,
): ReadableStore<TSnapshot>;
export function derived<TSnapshot>(
  sourceOrSources: ReadableStore<unknown> | readonly ReadableStore<unknown>[],
  project: (snapshot: never) => TSnapshot,
): ReadableStore<TSnapshot> {
  const sources: readonly ReadableStore<unknown>[] = Array.isArray(sourceOrSources)
    ? sourceOrSources
    : [sourceOrSources];
  return Object.freeze({
    subscribe: (subscriber: StoreSubscriber<TSnapshot>): StoreUnsubscriber => {
      const snapshots: unknown[] = new Array(sources.length);
      const ready = new Array<boolean>(sources.length).fill(false);
      const emit = (): void => {
        if (!ready.every(Boolean)) return;
        subscriber(project((Array.isArray(sourceOrSources) ? snapshots : snapshots[0]) as never));
      };
      const unsubscribers = sources.map((source, index) => source.subscribe((snapshot: unknown) => {
        snapshots[index] = snapshot;
        ready[index] = true;
        emit();
      }));
      return () => unsubscribers.forEach(unsubscribe => unsubscribe());
    },
  });
}
