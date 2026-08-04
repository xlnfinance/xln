import type {
  ExternalStore,
  ExternalStoreBinding,
} from '../../../packages/client-core/external-store';
import type {
  ReadableStore,
  StoreSubscriber,
  StoreUnsubscriber,
  WritableStore,
} from '../../../packages/client-core/store';

export { derived, get } from '../../../packages/client-core/store';

export const toReadableStore = <TSnapshot>(
  store: ExternalStore<TSnapshot>,
): ReadableStore<TSnapshot> => Object.freeze({
  subscribe: (subscriber: StoreSubscriber<TSnapshot>): StoreUnsubscriber => {
    subscriber(store.getSnapshot());
    return store.subscribe(() => subscriber(store.getSnapshot()));
  },
});

export const toWritableStore = <TSnapshot>(
  binding: ExternalStoreBinding<TSnapshot>,
): WritableStore<TSnapshot> => Object.freeze({
  ...toReadableStore(binding.store),
  set: binding.controller.set,
  update: binding.controller.update,
});
