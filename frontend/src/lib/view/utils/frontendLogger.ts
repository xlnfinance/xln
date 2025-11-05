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

if (typeof window !== 'undefined') {
  window.frontendLogs = {
    enable: (cat) => { LOG_CONFIG[cat] = true; console.log(`✅ ${cat} enabled`); },
    disable: (cat) => { LOG_CONFIG[cat] = false; console.log(`❌ ${cat} disabled`); },
    enableAll: () => { Object.keys(LOG_CONFIG).forEach(k => LOG_CONFIG[k as keyof FrontendLogConfig] = true); console.log('✅ All frontend logs enabled'); },
    disableAll: () => { Object.keys(LOG_CONFIG).forEach(k => LOG_CONFIG[k as keyof FrontendLogConfig] = false); console.log('❌ All frontend logs disabled'); },
    show: () => { console.table(LOG_CONFIG); }
  };
  console.log('🔧 Frontend log control: window.frontendLogs.show()');
}
