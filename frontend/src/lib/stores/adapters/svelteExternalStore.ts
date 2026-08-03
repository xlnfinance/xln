import type {
  ExternalStore,
  ExternalStoreBinding,
} from '../../../../packages/client-core/external-store';

export type SvelteSubscriber<T> = (snapshot: T) => void;
export type SvelteUnsubscriber = () => void;

export interface SvelteReadable<T> {
  subscribe(subscriber: SvelteSubscriber<T>): SvelteUnsubscriber;
}

export interface SvelteWritable<T> extends SvelteReadable<T> {
  set(snapshot: T): void;
  update(transition: (snapshot: T) => T): void;
}

export const toSvelteReadable = <TSnapshot>(
  store: ExternalStore<TSnapshot>,
): SvelteReadable<TSnapshot> => Object.freeze({
  subscribe: (subscriber: SvelteSubscriber<TSnapshot>): SvelteUnsubscriber => {
    subscriber(store.getSnapshot());
    return store.subscribe(() => subscriber(store.getSnapshot()));
  },
});

export const toSvelteWritable = <TSnapshot>(
  binding: ExternalStoreBinding<TSnapshot>,
): SvelteWritable<TSnapshot> => Object.freeze({
  ...toSvelteReadable(binding.store),
  set: binding.controller.set,
  update: binding.controller.update,
});

export const getSvelteStoreValue = <TSnapshot>(
  store: SvelteReadable<TSnapshot>,
): TSnapshot => {
  let snapshot!: TSnapshot;
  const unsubscribe = store.subscribe((next) => {
    snapshot = next;
  });
  unsubscribe();
  return snapshot;
};

type StoreValues<TStores extends readonly SvelteReadable<unknown>[]> = {
  [TIndex in keyof TStores]: TStores[TIndex] extends SvelteReadable<infer TValue> ? TValue : never;
};

export function deriveSvelteStore<TSource, TSnapshot>(
  source: SvelteReadable<TSource>,
  project: (snapshot: TSource) => TSnapshot,
): SvelteReadable<TSnapshot>;
export function deriveSvelteStore<
  TFirst,
  TSecond,
  TSnapshot,
>(
  sources: readonly [SvelteReadable<TFirst>, SvelteReadable<TSecond>],
  project: (snapshots: [TFirst, TSecond]) => TSnapshot,
): SvelteReadable<TSnapshot>;
export function deriveSvelteStore<
  const TStores extends readonly SvelteReadable<unknown>[],
  TSnapshot,
>(
  sources: TStores,
  project: (snapshots: StoreValues<TStores>) => TSnapshot,
): SvelteReadable<TSnapshot>;
export function deriveSvelteStore<TSnapshot>(
  sourceOrSources: SvelteReadable<unknown> | readonly SvelteReadable<unknown>[],
  project: (snapshot: never) => TSnapshot,
): SvelteReadable<TSnapshot> {
  const sources = Array.isArray(sourceOrSources) ? sourceOrSources : [sourceOrSources];
  return Object.freeze({
    subscribe: (subscriber: SvelteSubscriber<TSnapshot>): SvelteUnsubscriber => {
      const snapshots: unknown[] = new Array(sources.length);
      const ready = new Array<boolean>(sources.length).fill(false);
      const emit = (): void => {
        if (!ready.every(Boolean)) return;
        const input = Array.isArray(sourceOrSources) ? snapshots : snapshots[0];
        subscriber(project(input as never));
      };
      const unsubscribers = sources.map((source: SvelteReadable<unknown>, index: number) => source.subscribe((snapshot: unknown) => {
        snapshots[index] = snapshot;
        ready[index] = true;
        emit();
      }));
      return () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
      };
    },
  });
}
