import { createObservableStore } from '$lib/utils/observableStore';

interface RoutePreview {
  path: string[];
  timestamp: number;
}

function createRoutePreviewStore() {
  const { subscribe, set } = createObservableStore<RoutePreview | null>(null);

  return {
    subscribe,
    showRoute(path: string[]) {
      set({ path, timestamp: Date.now() });
    },
    clear() {
      set(null);
    }
  };
}

export const routePreview = createRoutePreviewStore();
