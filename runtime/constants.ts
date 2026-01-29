/**
 * XLN System Constants
 *
 * All magic numbers, limits, and tuneable parameters in one place.
 * These values are chosen for production safety - adjust for testnets.
 *
 * @license AGPL-3.0
 * Copyright (C) 2025 XLN Finance
 */

// ═══════════════════════════════════════════════════════════════
// SYSTEM LIMITS
// ═══════════════════════════════════════════════════════════════

export const LIMITS = {
  /** Maximum messages stored per entity (memory limit) */
  MESSAGE_HISTORY: 100,

  /** Maximum transactions in entity mempool before rejection */
  MEMPOOL_SIZE: 1000,

  /** Maximum size of a single frame in bytes (like Bitcoin block limit) */
  MAX_FRAME_SIZE_BYTES: 1_048_576, // 1MB

  /** Maximum number of accounts per entity (prevents state bloat) */
  MAX_ACCOUNTS_PER_ENTITY: 1000,

  /** Maximum proposals per entity (prevents governance spam) */
  MAX_PROPOSALS_PER_ENTITY: 100,

  /** Maximum validators per entity (BFT performance limit) */
  MAX_VALIDATORS: 100,
} as const;

// ═══════════════════════════════════════════════════════════════
// FINANCIAL LIMITS (Safety against bugs and attacks)
// ═══════════════════════════════════════════════════════════════

export const FINANCIAL = {
  /** Maximum payment amount in smallest unit (prevents overflow) */
  MAX_PAYMENT_AMOUNT: 2n ** 128n - 1n, // U128 max

  /** Minimum payment amount (prevents dust spam) */
  MIN_PAYMENT_AMOUNT: 1n, // Smallest unit - actual dust prevention is per-token

  /** Maximum credit limit in USDC (prevents unbounded credit) */
  MAX_CREDIT_LIMIT: 1_000_000_000n * 10n ** 6n, // 1 billion USDC

  /** Maximum collateral per account (sanity check) */
  MAX_COLLATERAL: 2n ** 64n - 1n, // U64 max

  /** Maximum route length for multi-hop payments */
  MAX_ROUTE_HOPS: 10,
} as const;

// ═══════════════════════════════════════════════════════════════
// HTLC (Hash Time-Locked Contracts)
// ═══════════════════════════════════════════════════════════════

export const HTLC = {
  /** Minimum timelock delta per hop (simnet-optimized for speed) */
  MIN_TIMELOCK_DELTA_MS: 10_000, // 10 seconds per hop

  /** Minimum time remaining for the first forward (prevents TIMELOCK_TOO_TIGHT) */
  MIN_FORWARD_TIMELOCK_MS: 20_000, // 20 seconds minimum at first hop

  /** Maximum hops for HTLC routing (prevents loops) */
  MAX_HOPS: 20,

  /** Default HTLC expiry (baseline, may be raised per-route) */
  DEFAULT_EXPIRY_MS: 30_000,

  /** Base fee in USD (micro basis points) */
  BASE_FEE_USD: 0n, // No base fee

  /** Fee rate in micro basis points (μbp) */
  // 1 μbp = 0.0001 bp = 0.00001% = 1/10,000,000
  // 100 μbp = 0.01 bp = 0.001% = 1 bp for hubs
  FEE_RATE_UBP: 100n, // 1 basis point for hubs to see profits

  /** Fee denominator for μbp calculation */
  FEE_DENOMINATOR: 10_000_000n, // Fee = (amount × FEE_RATE_UBP) / FEE_DENOMINATOR
} as const;

// ═══════════════════════════════════════════════════════════════
// TIMING & SYNCHRONIZATION
// ═══════════════════════════════════════════════════════════════

export const TIMING = {
  /** Runtime tick interval (how often runtime.ts processes inputs) */
  TICK_INTERVAL_MS: 100,

  /** Maximum allowed clock drift between entities (30 seconds) */
  TIMESTAMP_DRIFT_MS: 30_000,

  /** Proposal timeout before new proposer elected (10 seconds) */
  PROPOSAL_TIMEOUT_MS: 10_000,

  /** Account frame acknowledgment timeout (5 seconds) */
  ACCOUNT_ACK_TIMEOUT_MS: 5_000,

  /** Withdrawal request timeout before auto-reject */
  WITHDRAWAL_TIMEOUT_MS: 60_000, // 1 minute

  /** Dispute period on-chain (blocks) */
  DISPUTE_PERIOD_BLOCKS: 100, // ~20 minutes on Ethereum

  /** Crontab execution interval */
  CRONTAB_INTERVAL_MS: 1000, // 1 second
} as const;

// ═══════════════════════════════════════════════════════════════
// CONSENSUS PARAMETERS
// ═══════════════════════════════════════════════════════════════

export const CONSENSUS = {
  /** Default BFT threshold (2/3 + 1 for safety) */
  DEFAULT_THRESHOLD_NUMERATOR: 2n,
  DEFAULT_THRESHOLD_DENOMINATOR: 3n,

  /** Maximum precommit locks before forcing progress */
  MAX_PRECOMMIT_LOCKS: 10,

  /** Frame retention for state proofs (how many old frames to keep) */
  FRAME_RETENTION_COUNT: 1000,
} as const;

// ═══════════════════════════════════════════════════════════════
// BLOCKCHAIN INTEGRATION (J-Machine)
// ═══════════════════════════════════════════════════════════════

export const BLOCKCHAIN = {
  /** Gas limit for processBatch() calls */
  PROCESS_BATCH_GAS_LIMIT: 5_000_000,

  /** Maximum settlements per batch (gas optimization) */
  MAX_SETTLEMENTS_PER_BATCH: 50,

  /** Maximum reserve-to-reserve transfers per batch */
  MAX_R2R_PER_BATCH: 100,

  /** Block confirmations before trusting J-event */
  CONFIRMATION_BLOCKS: 12, // ~3 minutes on Ethereum

  /** J-watcher polling interval (milliseconds) */
  J_WATCHER_POLL_INTERVAL_MS: 6_000, // Every 0.5 blocks on Ethereum

  /** Maximum gas price willing to pay (in gwei) */
  MAX_GAS_PRICE_GWEI: 300,
} as const;

// ═══════════════════════════════════════════════════════════════
// TOKEN SYSTEM
// ═══════════════════════════════════════════════════════════════

export const TOKENS = {
  /** Token ID 0 is reserved (invalid) */
  RESERVED_TOKEN_ID: 0,

  /** Token ID 1 is native token (ETH, MATIC, etc.) */
  NATIVE_TOKEN_ID: 1,

  /** Maximum token ID (65535 = uint16 max) */
  MAX_TOKEN_ID: 65535,

  /** Default decimal places for display */
  DEFAULT_DECIMALS: 18,
} as const;

// ═══════════════════════════════════════════════════════════════
// PERFORMANCE & OPTIMIZATION
// ═══════════════════════════════════════════════════════════════

export const PERFORMANCE = {
  /** Enable debug logging (disable in production) */
  DEBUG_LOGGING: false,

  /** Enable consensus debug logs */
  DEBUG_CONSENSUS: false,

  /** Enable account debug logs */
  DEBUG_ACCOUNTS: false,

  /** Enable routing debug logs */
  DEBUG_ROUTING: false,

  /** Always log blockchain errors */
  LOG_BLOCKCHAIN_ERRORS: true,

  /** Batch size for database writes */
  DB_BATCH_SIZE: 100,

  /** Snapshot interval for persistence (every N frames) */
  SNAPSHOT_INTERVAL: 100,
} as const;

// ═══════════════════════════════════════════════════════════════
// CRYPTOGRAPHY
// ═══════════════════════════════════════════════════════════════

export const CRYPTO = {
  /** Hash function for frame hashes */
  HASH_ALGORITHM: 'keccak256' as const,

  /** Signature scheme */
  SIGNATURE_SCHEME: 'secp256k1' as const,

  /** Entity ID length (bytes) */
  ENTITY_ID_LENGTH: 32,

  /** Signature length (bytes) */
  SIGNATURE_LENGTH: 65,
} as const;

// ═══════════════════════════════════════════════════════════════
// VALIDATION THRESHOLDS
// ═══════════════════════════════════════════════════════════════

export const VALIDATION = {
  /** Maximum nonce gap before rejecting (replay protection) */
  MAX_NONCE_GAP: 100,

  /** Maximum counter gap before rejecting (bilateral replay) */
  MAX_COUNTER_GAP: 100,

  /** Maximum age of frame before rejection (milliseconds) */
  MAX_FRAME_AGE_MS: 3600_000, // 1 hour

  /** Minimum shares for entity registration */
  MIN_ENTITY_SHARES: 1n,

  /** Maximum shares for entity registration (prevents overflow) */
  MAX_ENTITY_SHARES: 2n ** 64n - 1n,
} as const;

// ═══════════════════════════════════════════════════════════════
// ENCODING & SERIALIZATION
// ═══════════════════════════════════════════════════════════════

export const ENCODING = {
  /** Default encoding for buffers */
  DEFAULT_ENCODING: 'hex' as const,

  /** UTF-8 encoding for text */
  TEXT_ENCODING: 'utf8' as const,

  /** RLP encoding for Ethereum compatibility */
  USE_RLP: true,
} as const;

// ═══════════════════════════════════════════════════════════════
// TESTNET OVERRIDES (Uncomment for faster testing)
// ═══════════════════════════════════════════════════════════════

// export const TESTNET_OVERRIDES = {
//   TICK_INTERVAL_MS: 10,              // 10ms ticks for fast testing
//   PROPOSAL_TIMEOUT_MS: 1_000,        // 1 second timeout
//   CONFIRMATION_BLOCKS: 1,            // Instant confirmations
//   DEBUG_LOGGING: true,               // Enable all logs
//   DEBUG_CONSENSUS: true,
//   DEBUG_ACCOUNTS: true,
//   DEBUG_ROUTING: true,
// } as const;
