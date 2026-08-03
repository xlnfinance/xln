import { useSyncExternalStore } from 'react';
import type { ExternalStore } from '../client-core/external-store';

export const useExternalStore = <TSnapshot>(
  store: ExternalStore<TSnapshot>,
): TSnapshot => useSyncExternalStore(store.subscribe, store.getSnapshot);
