/**
 * Unified App State Store
 * Consolidates: uiStore, viewModeStore, modeStore, navigationStore
 *
 * @license AGPL-3.0
 * Copyright (C) 2025 XLN Finance
 */

import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';
import { errorLog } from './errorLogStore';

export type AppMode = 'user' | 'dev';
export type ViewMode = 'home' | 'settings' | 'docs' | 'brainvault' | 'panels' | 'graph3d' | 'terminal';

export interface NavigationSelection {
  runtime: string | null;      // Runtime ID
  jurisdiction: string | null;  // Jurisdiction name
  signer: string | null;        // Signer address
  entity: string | null;        // Entity ID
  account: string | null;       // Account key (bilateral)
}

export interface AppState {
  // Mode toggles (from modeStore)
  mode: AppMode;

  // Landing page visibility (from uiStore)
  landingVisible: boolean;

  // View mode (from viewModeStore)
  viewMode: ViewMode;

  requestedDockPanel: string | null;

  // Hierarchical navigation (from navigationStore)
  navigation: NavigationSelection;
}

// Safe localStorage helpers (prevent throws in private/quota-restricted contexts)
function safeGetItem(key: string): string | null {
  if (!browser) return null;
  try {
    return localStorage.getItem(key);
  } catch (error) {
    errorLog.log('localStorage get failed', 'App State', { key, error });
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  if (!browser) return;
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    errorLog.log('localStorage set failed', 'App State', { key, error });
  }
}

// Load persisted state
function loadState(): AppState {
  const defaultState: AppState = {
    mode: 'user',
    landingVisible: true,
    viewMode: 'home',
    requestedDockPanel: null,
    navigation: {
      runtime: 'local',
      jurisdiction: null,
      signer: null,
      entity: null,
      account: null
    }
  };

  if (!browser) return defaultState;

  const savedMode = safeGetItem('xln-app-mode');
  const savedViewMode = safeGetItem('xln-view-mode');

  return {
    mode: (savedMode === 'dev' || savedMode === 'user') ? savedMode : 'user',
    landingVisible: true,
    viewMode: (savedViewMode === 'home' || savedViewMode === 'settings' || savedViewMode === 'docs' ||
               savedViewMode === 'brainvault' || savedViewMode === 'panels' || savedViewMode === 'graph3d' ||
               savedViewMode === 'terminal') ? savedViewMode : 'home',
    requestedDockPanel: null,
    navigation: {
      runtime: 'local',
      jurisdiction: null,
      signer: null,
      entity: null,
      account: null
    }
  };
}

// Save state to localStorage
function saveState(state: AppState) {
  safeSetItem('xln-app-mode', state.mode);
  safeSetItem('xln-view-mode', state.viewMode);
}

// Create store
export const appState = writable<AppState>(loadState());

// Auto-save on changes
appState.subscribe(state => saveState(state));

// Operations
export const appStateOperations = {
  // Mode toggle
  toggleMode() {
    appState.update(s => ({ ...s, mode: s.mode === 'user' ? 'dev' : 'user' }));
  },

  setMode(mode: AppMode) {
    appState.update(s => ({ ...s, mode }));
  },

  openDockPanel(panelId: string): void {
    appState.update(s => ({ ...s, mode: 'dev', requestedDockPanel: panelId }));
  },

  clearDockPanelRequest(panelId: string): void {
    appState.update(s => s.requestedDockPanel === panelId
      ? { ...s, requestedDockPanel: null }
      : s);
  },

  // Landing visibility
  setLandingVisible(visible: boolean) {
    appState.update(s => ({ ...s, landingVisible: visible }));
  },

  // View mode
  setViewMode(mode: ViewMode) {
    appState.update(s => ({ ...s, viewMode: mode }));
  },

  // Navigation
  navigate(level: keyof NavigationSelection, id: string | null) {
    appState.update(s => {
      const newNav = { ...s.navigation };
      newNav[level] = id;

      // Clear downstream selections when changing upstream
      const hierarchy: (keyof NavigationSelection)[] = ['runtime', 'jurisdiction', 'signer', 'entity', 'account'];
      const currentIndex = hierarchy.indexOf(level);
      for (let i = currentIndex + 1; i < hierarchy.length; i++) {
        newNav[hierarchy[i]!] = null;
      }

      return { ...s, navigation: newNav };
    });
  },

  resetNavigation() {
    appState.update(s => ({
      ...s,
      navigation: {
        runtime: 'local',
        jurisdiction: null,
        signer: null,
        entity: null,
        account: null
      }
    }));
  },

  getState(): AppState {
    return get(appState);
  }
};

// Backward compat exports (for gradual migration)
export const toggleMode = appStateOperations.toggleMode;
