import type { RuntimeActivityEvent } from '@xln/runtime/api/public/runtime-module';

import { createExternalStore } from '../../../../../packages/client-core/external-store';
import { runtimeQueryClient } from '$lib/stores/runtimeQueryClient';
import {
  buildWalletActivityReadQuery,
  mergeWalletActivityEvents,
  parseWalletActivityPage,
  type WalletActivityQuery,
} from './activity-history-adapter';

export type WalletActivitySnapshot = Readonly<{
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  query: WalletActivityQuery | null;
  events: readonly RuntimeActivityEvent[];
  nextBeforeHeight: number | null;
  latestHeight: number;
  scannedFrames: number;
}>;

const emptySnapshot = (): WalletActivitySnapshot => Object.freeze({
  loading: false,
  loadingMore: false,
  error: null,
  query: null,
  events: Object.freeze([]),
  nextBeforeHeight: null,
  latestHeight: 0,
  scannedFrames: 0,
});
const binding = createExternalStore(emptySnapshot());
export const walletActivityExternalStore = binding.store;
let requestVersion = 0;

const message = (error: unknown): string => error instanceof Error ? error.message : String(error || 'Activity history failed');

const load = async (query: WalletActivityQuery, append: boolean): Promise<void> => {
  const version = ++requestVersion;
  binding.controller.update(snapshot => Object.freeze({
    ...snapshot,
    loading: !append,
    loadingMore: append,
    error: null,
    query,
    ...(!append ? { events: Object.freeze([]), nextBeforeHeight: null } : {}),
  }));
  try {
    const raw = await runtimeQueryClient.readActivity(buildWalletActivityReadQuery(query));
    const page = parseWalletActivityPage(raw);
    if (version !== requestVersion) return;
    binding.controller.update(snapshot => Object.freeze({
      ...snapshot,
      loading: false,
      loadingMore: false,
      events: append ? mergeWalletActivityEvents(snapshot.events, page.events) : page.events,
      nextBeforeHeight: page.nextBeforeHeight,
      latestHeight: page.latestHeight,
      scannedFrames: snapshot.scannedFrames + page.scannedFrames,
    }));
  } catch (error) {
    if (version !== requestVersion) return;
    binding.controller.update(snapshot => Object.freeze({
      ...snapshot,
      loading: false,
      loadingMore: false,
      error: message(error),
    }));
  }
};

export const walletActivityController = Object.freeze({
  load: (query: WalletActivityQuery): Promise<void> => load(Object.freeze({ ...query, beforeHeight: null }), false),
  loadMore: async (): Promise<void> => {
    const snapshot = binding.store.getSnapshot();
    if (!snapshot.query || snapshot.nextBeforeHeight === null || snapshot.loading || snapshot.loadingMore) return;
    await load(Object.freeze({ ...snapshot.query, beforeHeight: snapshot.nextBeforeHeight }), true);
  },
  retry: async (): Promise<void> => {
    const snapshot = binding.store.getSnapshot();
    if (!snapshot.query) throw new Error('WALLET_ACTIVITY_RETRY_QUERY_MISSING');
    await load(Object.freeze({ ...snapshot.query, beforeHeight: null }), false);
  },
  release: (): void => {
    requestVersion += 1;
    binding.controller.set(emptySnapshot());
  },
});
