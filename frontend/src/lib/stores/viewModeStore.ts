import { writable } from 'svelte/store';

export type ViewMode = 'home' | 'settings' | 'docs' | 'brainvault' | 'panels' | 'graph3d' | 'terminal';

const STORAGE_KEY = 'xln-view-mode';

function createViewModeStore() {
  let initial: ViewMode = 'home';

  if (typeof window !== 'undefined') {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'home' || saved === 'settings' || saved === 'docs' || saved === 'brainvault' || saved === 'panels' || saved === 'graph3d' || saved === 'terminal') {
      initial = saved;
    }
  }

  const store = writable<ViewMode>(initial);

  if (typeof window !== 'undefined') {
    store.subscribe((value) => {
      try {
        window.localStorage.setItem(STORAGE_KEY, value);
      } catch (error) {
        console.warn('Failed to persist view mode:', error);
      }
    });
  }

  return store;
}

export const viewMode = createViewModeStore();

export const viewModeOperations = {
  set(mode: ViewMode) {
    viewMode.set(mode);
  }
};
