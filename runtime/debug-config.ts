/**
 * Simple debug toggle system
 * Set these to false to disable noisy logs
 */

export const DEBUG_LOGS = {
  // Core account flow (keep these)
  ACCOUNT_OPENING: true,
  ACCOUNT_FRAME: true,
  ENTITY_OUTPUT: true,

  // Noisy logs (disable these)
  ACCOUNT_DROPDOWN: false,
  REPLICA_LOOKUP: false,
  MERGE_INPUTS: false,
  CONSENSUS_CHECK: false,
  CLONE_TRACE: false,
  ENCODE_VALIDATION: false,

  // J-Watcher (keep minimal)
  J_WATCHER: false,
  J_EVENTS: false,
};

// Simple log wrapper
export const debugLog = (category: keyof typeof DEBUG_LOGS, ...args: any[]) => {
  if (DEBUG_LOGS[category]) {
    console.log(...args);
  }
};