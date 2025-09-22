/**
 * XLN System-Wide Constants
 *
 * The Original demands no magic numbers.
 * Every constant has meaning. Every limit has purpose.
 */

// === Timing Constants (in milliseconds) ===
export const TIMING = {
  TICK_INTERVAL: 100,          // Server tick interval
  J_MACHINE_SYNC: 5000,        // J-Machine blockchain sync interval
  TIMEOUT_DEFAULT: 120000,     // Default operation timeout (2 minutes)
} as const;

// === Capacity Limits ===
export const LIMITS = {
  // Transaction limits
  MAX_SERVER_TXS: 1000,        // Max server transactions per tick
  MAX_ENTITY_INPUTS: 10000,    // Max entity inputs per tick
  MAX_ENTITY_TXS: 1000,        // Max transactions per entity input
  MAX_PRECOMMITS: 100,         // Max precommits per input
  MAX_ACCOUNT_TXS: 100,        // Max account transactions per frame

  // Mempool limits
  MEMPOOL_MAX: 10000,          // Max transactions in entity mempool
  ACCOUNT_MEMPOOL_MAX: 1000,   // Max transactions in account mempool

  // System limits
  MAX_ROLLBACKS: 3,            // Max frame rollbacks in account consensus
  MAX_MESSAGE_COUNTER: 1000000, // Max account message counter before reset
} as const;

// === Financial Constants ===
export const FINANCE = {
  CENTS_PER_DOLLAR: 100,       // Conversion factor
  PERCENTAGE_PRECISION: 100,   // Percentage calculation precision
  DEFAULT_CREDIT_LIMIT: 100000, // Default credit limit in cents ($1000)
} as const;

// === Network Constants ===
export const NETWORK = {
  DEFAULT_GOSSIP_CAPACITY: 1000, // Default gossip layer capacity
  DEFAULT_UPTIME: "99.9%",       // Default reported uptime
} as const;

// === Derived Constants ===
export const DERIVED = {
  TICKS_PER_SECOND: 1000 / TIMING.TICK_INTERVAL, // 10 ticks/second
  SYNC_TICKS: TIMING.J_MACHINE_SYNC / TIMING.TICK_INTERVAL, // 50 ticks between syncs
} as const;