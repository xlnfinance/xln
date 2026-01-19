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

// Extend window for console debugging
declare global {
  interface Window {
    frontendLogs: {
      enable: (category: keyof FrontendLogConfig) => void;
      disable: (category: keyof FrontendLogConfig) => void;
      enableAll: () => void;
      disableAll: () => void;
      show: () => void;
    };
  }
}

// Global verbose logging toggle (controlled by Settings panel)
let VERBOSE_ENABLED = true; // DEFAULT ON for development

// Monkey-patch console for performance-aware logging
const originalLog = console.log;
const originalInfo = console.info;
const originalDebug = console.debug;

// DISABLED monkey-patching for debugging - all logs show
// console.log = (...args: unknown[]) => {
//   if (VERBOSE_ENABLED || args[0]?.toString().includes('ERROR') || args[0]?.toString().includes('❌')) {
//     originalLog(...args);
//   }
// };

// console.info = (...args: unknown[]) => {
//   if (VERBOSE_ENABLED) originalInfo(...args);
// };

// console.debug = (...args: unknown[]) => {
//   if (VERBOSE_ENABLED) originalDebug(...args);
// };

// console.error and console.warn ALWAYS show (never silenced)

if (typeof window !== 'undefined') {
  window.frontendLogs = {
    enable: (cat) => { LOG_CONFIG[cat] = true; originalLog(`✅ ${cat} enabled`); },
    disable: (cat) => { LOG_CONFIG[cat] = false; originalLog(`❌ ${cat} disabled`); },
    enableAll: () => {
      VERBOSE_ENABLED = true;
      Object.keys(LOG_CONFIG).forEach(k => LOG_CONFIG[k as keyof FrontendLogConfig] = true);
      originalLog('✅ All frontend logs enabled');
    },
    disableAll: () => {
      VERBOSE_ENABLED = false;
      Object.keys(LOG_CONFIG).forEach(k => LOG_CONFIG[k as keyof FrontendLogConfig] = false);
      originalLog('❌ All frontend logs disabled (errors still show)');
    },
    show: () => { originalLog('Verbose:', VERBOSE_ENABLED); console.table(LOG_CONFIG); }
  };
  originalLog('🔧 Frontend log control: window.frontendLogs.show()');
}
