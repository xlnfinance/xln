/**
 * App Mode Store - Toggle between user and dev modes
 * User mode: Simple consumer-focused single entity view
 * Dev mode: Full network graph + multi-panel inspection
 *
 * @license AGPL-3.0
 * Copyright (C) 2025 XLN Finance
 */

import { writable } from 'svelte/store';
import { browser } from '$app/environment';

export type AppMode = 'user' | 'dev';

// Persist mode in localStorage
function loadMode(): AppMode {
  if (!browser) return 'user';
  const saved = localStorage.getItem('xln-app-mode');
  return (saved === 'dev' || saved === 'user') ? saved : 'user';
}

function saveMode(mode: AppMode) {
  if (browser) {
    localStorage.setItem('xln-app-mode', mode);
  }
}

// Start in user mode by default (or restore from localStorage)
export const appMode = writable<AppMode>(loadMode());

// Subscribe to save changes
appMode.subscribe(mode => saveMode(mode));

export function toggleMode() {
  appMode.update(m => m === 'user' ? 'dev' : 'user');
}
