export type ExternalStoreListener = () => void;

export interface ExternalStore<TSnapshot> {
  getSnapshot(): TSnapshot;
  subscribe(listener: ExternalStoreListener): () => void;
}

export interface ExternalStoreController<TSnapshot> {
  set(snapshot: TSnapshot): void;
  update(transition: (snapshot: TSnapshot) => TSnapshot): void;
  destroy(): void;
}

export type ExternalStoreBinding<TSnapshot> = Readonly<{
  store: ExternalStore<TSnapshot>;
  controller: ExternalStoreController<TSnapshot>;
}>;

const destroyedError = (): Error => new Error('EXTERNAL_STORE_DESTROYED');
const reentrantError = (): Error => new Error('EXTERNAL_STORE_REENTRANT_TRANSITION');

export const createExternalStore = <TSnapshot>(
  initialSnapshot: TSnapshot,
): ExternalStoreBinding<TSnapshot> => {
  let snapshot = initialSnapshot;
  let destroyed = false;
  let notifying = false;
  const listeners = new Set<ExternalStoreListener>();

  const assertActive = (): void => {
    if (destroyed) throw destroyedError();
  };

  const notify = (): void => {
    notifying = true;
    const errors: unknown[] = [];
    try {
      for (const listener of Array.from(listeners)) {
        if (!listeners.has(listener)) continue;
        try {
          listener();
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      notifying = false;
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'EXTERNAL_STORE_LISTENER_FAILURE');
  };

  const set = (nextSnapshot: TSnapshot): void => {
    assertActive();
    if (notifying) throw reentrantError();
    if (Object.is(snapshot, nextSnapshot)) return;
    snapshot = nextSnapshot;
    notify();
  };

  const store: ExternalStore<TSnapshot> = Object.freeze({
    getSnapshot: (): TSnapshot => snapshot,
    subscribe: (listener: ExternalStoreListener): (() => void) => {
      assertActive();
      listeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
      };
    },
  });

  const controller: ExternalStoreController<TSnapshot> = Object.freeze({
    set,
    update: (transition: (current: TSnapshot) => TSnapshot): void => {
      assertActive();
      if (notifying) throw reentrantError();
      set(transition(snapshot));
    },
    destroy: (): void => {
      assertActive();
      if (notifying) throw reentrantError();
      destroyed = true;
      listeners.clear();
    },
  });

  return Object.freeze({ store, controller });
};

export const selectExternalStore = <TSource, TSnapshot>(
  source: ExternalStore<TSource>,
  select: (snapshot: TSource) => TSnapshot,
  equal: (left: TSnapshot, right: TSnapshot) => boolean = Object.is,
): ExternalStore<TSnapshot> => Object.freeze({
  getSnapshot: (): TSnapshot => select(source.getSnapshot()),
  subscribe: (listener: ExternalStoreListener): (() => void) => {
    let selected = select(source.getSnapshot());
    return source.subscribe(() => {
      const next = select(source.getSnapshot());
      if (equal(selected, next)) return;
      selected = next;
      listener();
    });
  },
});
