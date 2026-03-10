/**
 * Frontend Logging Control
 * Mirrors runtime/logger.ts pattern for UI code
 *
 * @license AGPL-3.0
 * Copyright (C) 2025 XLN Finance
 */

export interface FrontendLogConfig {
  GRAPH3D_RENDER: boolean;
  GRAPH3D_UPDATES: boolean;
  ARCHITECT_ACTIONS: boolean;
  PAYMENT_LOOP: boolean;
  ENTITY_CREATION: boolean;
  SETTINGS_CHANGES: boolean;
}

const LOG_CONFIG: FrontendLogConfig = {
  GRAPH3D_RENDER: false,    // animate() loop, mesh updates
  GRAPH3D_UPDATES: false,    // updateNetworkData() calls
  ARCHITECT_ACTIONS: true,   // User actions (create economy, etc)
  PAYMENT_LOOP: false,       // 5s payment cycle logs
  ENTITY_CREATION: true,     // Entity creation confirmations
  SETTINGS_CHANGES: false,   // Settings panel updates
};

export function shouldLog(category: keyof FrontendLogConfig): boolean {
  return LOG_CONFIG[category] ?? false;
}

export function logDebug(category: keyof FrontendLogConfig, ...args: unknown[]): void {
  if (shouldLog(category)) {
    console.log(`[${category}]`, ...args);
  }
}

// Global verbose logging toggle (controlled by Settings panel)
let VERBOSE_ENABLED = true; // DEFAULT ON for development

// Monkey-patch console for performance-aware logging
const originalLog = console.log;

export function enableFrontendLog(category: keyof FrontendLogConfig): void {
  LOG_CONFIG[category] = true;
  originalLog(`✅ ${category} enabled`);
}

export function disableFrontendLog(category: keyof FrontendLogConfig): void {
  LOG_CONFIG[category] = false;
  originalLog(`❌ ${category} disabled`);
}

export function setFrontendVerboseLogging(enabled: boolean): void {
  VERBOSE_ENABLED = enabled;
  for (const key of Object.keys(LOG_CONFIG) as Array<keyof FrontendLogConfig>) {
    LOG_CONFIG[key] = enabled;
  }
}
