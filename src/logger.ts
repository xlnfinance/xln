// Log filtering system for debugging
export interface LogConfig {
  ENTITY_TX: boolean;
  ACCOUNT_OPEN: boolean;
  SIGNER_LOOKUP: boolean;
  PROCESS_CASCADE: boolean;
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

// Default log config - toggle these to debug specific flows
export const LOG_CONFIG: LogConfig = {
  ENTITY_TX: true,
  ACCOUNT_OPEN: true,
  SIGNER_LOOKUP: true,
  PROCESS_CASCADE: true,
  FRAME_CONSENSUS: false,
  ENTITY_OUTPUT: true,
  ENTITY_INPUT: true,
  SERVER_TICK: false,
  J_WATCHER: false,
  BLOCKCHAIN: false,
  GOSSIP: false,
  R2R_FLOW: true, // Enable to debug r2r receiver issues
  ACCOUNT_STATE: true,
};

// Helper to check if logging is enabled for a category
export function shouldLog(category: keyof LogConfig): boolean {
  return LOG_CONFIG[category] ?? false;
}

// Conditional logger
export function log(category: keyof LogConfig, ...args: any[]): void {
  if (shouldLog(category)) {
    console.log(...args);
  }
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

// Export to window for runtime debugging
if (typeof window !== 'undefined') {
  (window as any).logConfig = {
    show: showLogConfig,
    set: setLogConfig,
    enableAll: enableAllLogs,
    disableAll: disableAllLogs,
    config: LOG_CONFIG,
  };
  console.log('🔧 Log config available at window.logConfig');
}