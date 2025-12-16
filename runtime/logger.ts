/**
 * XLN Logging System
 *
 * Feature-flagged logging controlled by runtime/constants.ts PERFORMANCE flags.
 * In production, set all DEBUG_* flags to false for 10x faster performance.
 *
 * @license AGPL-3.0
 * Copyright (C) 2025 XLN Finance
 */

import { PERFORMANCE } from './constants';

// Log filtering system for debugging
export interface LogConfig {
  ENTITY_TX: boolean;
  ACCOUNT_OPEN: boolean;
  SIGNER_LOOKUP: boolean;
  PROCESS_TICK: boolean;
  FRAME_CONSENSUS: boolean;
  ENTITY_OUTPUT: boolean;
  ENTITY_INPUT: boolean;
  SERVER_TICK: boolean;
  J_WATCHER: boolean;
  BLOCKCHAIN: boolean;
  GOSSIP: boolean;
  R2R_FLOW: boolean;
  ACCOUNT_STATE: boolean;
}

// Default log config - derived from constants.ts PERFORMANCE flags
// Individual categories can be toggled at runtime via window.logConfig.set()
export const LOG_CONFIG: LogConfig = {
  ENTITY_TX: PERFORMANCE.DEBUG_CONSENSUS,        // Entity-level consensus
  ACCOUNT_OPEN: PERFORMANCE.DEBUG_ACCOUNTS,      // Account creation
  SIGNER_LOOKUP: PERFORMANCE.DEBUG_CONSENSUS,    // Validator management
  PROCESS_TICK: PERFORMANCE.DEBUG_LOGGING,       // Tick processing
  FRAME_CONSENSUS: PERFORMANCE.DEBUG_CONSENSUS,  // BFT consensus
  ENTITY_OUTPUT: PERFORMANCE.DEBUG_LOGGING,      // Entity outputs
  ENTITY_INPUT: PERFORMANCE.DEBUG_LOGGING,       // Entity inputs
  SERVER_TICK: PERFORMANCE.DEBUG_LOGGING,        // Runtime tick processing
  J_WATCHER: PERFORMANCE.LOG_BLOCKCHAIN_ERRORS,  // Blockchain watcher
  BLOCKCHAIN: PERFORMANCE.LOG_BLOCKCHAIN_ERRORS, // Blockchain interactions
  GOSSIP: PERFORMANCE.DEBUG_LOGGING,             // Network gossip
  R2R_FLOW: PERFORMANCE.DEBUG_ACCOUNTS,          // Reserve-to-reserve transfers
  ACCOUNT_STATE: PERFORMANCE.DEBUG_ACCOUNTS,     // Account state changes
};

// Helper to check if logging is enabled for a category
export function shouldLog(category: keyof LogConfig): boolean {
  return LOG_CONFIG[category] ?? false;
}

// Log levels for structured logging
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Conditional logger with levels
export function log(category: keyof LogConfig, level: LogLevel, ...args: unknown[]): void {
  if (shouldLog(category)) {
    const prefix = `[${category}]`;
    switch (level) {
      case 'error':
        console.error(prefix, ...args);
        break;
      case 'warn':
        console.warn(prefix, ...args);
        break;
      case 'info':
        console.info(prefix, ...args);
        break;
      case 'debug':
      default:
        console.log(prefix, ...args);
        break;
    }
  }
}

// Convenience methods for common patterns
export function logDebug(category: keyof LogConfig, ...args: unknown[]): void {
  log(category, 'debug', ...args);
}

export function logInfo(category: keyof LogConfig, ...args: unknown[]): void {
  log(category, 'info', ...args);
}

export function logWarn(category: keyof LogConfig, ...args: unknown[]): void {
  log(category, 'warn', ...args);
}

export function logError(category: keyof LogConfig, ...args: unknown[]): void {
  log(category, 'error', ...args);
}

// Debug helper to show current config
export function showLogConfig(): void {
  console.log('📊 Current Log Configuration:');
  Object.entries(LOG_CONFIG).forEach(([key, enabled]) => {
    console.log(`  ${enabled ? '✅' : '❌'} ${key}`);
  });
}

// Runtime config setter (for debugging from console)
export function setLogConfig(category: keyof LogConfig, enabled: boolean): void {
  LOG_CONFIG[category] = enabled;
  console.log(`🔧 Log category "${category}" set to ${enabled ? 'ON' : 'OFF'}`);
}

// Enable all logs
export function enableAllLogs(): void {
  Object.keys(LOG_CONFIG).forEach(key => {
    LOG_CONFIG[key as keyof LogConfig] = true;
  });
  console.log('✅ All logs enabled');
}

// Disable all logs
export function disableAllLogs(): void {
  Object.keys(LOG_CONFIG).forEach(key => {
    LOG_CONFIG[key as keyof LogConfig] = false;
  });
  console.log('❌ All logs disabled');
}

// Extend Window interface for debugging
declare global {
  interface Window {
    logConfig: {
      show: typeof showLogConfig;
      set: typeof setLogConfig;
      enableAll: typeof enableAllLogs;
      disableAll: typeof disableAllLogs;
      config: typeof LOG_CONFIG;
    };
  }
}

// Export to window for runtime debugging
if (typeof window !== 'undefined') {
  window.logConfig = {
    show: showLogConfig,
    set: setLogConfig,
    enableAll: enableAllLogs,
    disableAll: disableAllLogs,
    config: LOG_CONFIG,
  };
  console.log('🔧 Log config available at window.logConfig');
}