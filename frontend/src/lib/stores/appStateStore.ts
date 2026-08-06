/**
 * Unified App State Store
 * Consolidates: uiStore, viewModeStore, modeStore, navigationStore
 *
 * @license AGPL-3.0
 * Copyright (C) 2025 XLN Finance
 */

import { createExternalStore } from '../../../packages/client-core/external-store';
import {
  appStateFromPersistence,
  reduceAppState,
  type AppMode,
  type AppState,
  type NavigationSelection,
  type ViewMode,
} from '../../../packages/client-core/app-state';
import { toReadableStore } from './storeBindings';
import { errorLog } from './errorLogStore';

export type { AppMode, AppState, NavigationSelection, ViewMode } from '../../../packages/client-core/app-state';

// Safe localStorage helpers (prevent throws in private/quota-restricted contexts)
function safeGetItem(key: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch (error) {
    errorLog.log('localStorage get failed', 'App State', { key, error });
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    errorLog.log('localStorage set failed', 'App State', { key, error });
  }
}

// Load persisted state
function loadState(): AppState {
  if (typeof localStorage === 'undefined') return appStateFromPersistence(null, null);

  const savedMode = safeGetItem('xln-app-mode');
  const savedViewMode = safeGetItem('xln-view-mode');
  return appStateFromPersistence(savedMode, savedViewMode);
}

// Save state to localStorage
function saveState(state: AppState) {
  safeSetItem('xln-app-mode', state.mode);
  safeSetItem('xln-view-mode', state.viewMode);
}

const appStateBinding = createExternalStore<AppState>(loadState());
export const appStateExternalStore = appStateBinding.store;
export const appState = toReadableStore(appStateBinding.store);

// Auto-save on changes
appState.subscribe(state => saveState(state));

// Operations
export const appStateOperations = {
  // Mode toggle
  toggleMode() {
    appStateBinding.controller.update(s => reduceAppState(s, { type: 'toggleMode' }));
  },

  setMode(mode: AppMode) {
    appStateBinding.controller.update(s => reduceAppState(s, { type: 'setMode', mode }));
  },

  openDockPanel(panelId: string): void {
    appStateBinding.controller.update(s => reduceAppState(s, { type: 'openDockPanel', panelId }));
  },

  clearDockPanelRequest(panelId: string): void {
    appStateBinding.controller.update(s => reduceAppState(s, { type: 'clearDockPanelRequest', panelId }));
  },

  // Landing visibility
  setLandingVisible(visible: boolean) {
    appStateBinding.controller.update(s => reduceAppState(s, { type: 'setLandingVisible', visible }));
  },

  // View mode
  setViewMode(mode: ViewMode) {
    appStateBinding.controller.update(s => reduceAppState(s, { type: 'setViewMode', mode }));
  },

  // Navigation
  navigate(level: keyof NavigationSelection, id: string | null) {
    appStateBinding.controller.update(s => reduceAppState(s, { type: 'navigate', level, id }));
  },

  resetNavigation() {
    appStateBinding.controller.update(s => reduceAppState(s, { type: 'resetNavigation' }));
  },

  getState(): AppState {
    return appStateExternalStore.getSnapshot();
  }
};
