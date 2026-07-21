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

/** Maximum unsigned 16-bit value. Domain-specific ratio code should expose a named alias. */
export const UINT16_MAX = 0xffff;

export const LIMITS = {
  /** Maximum messages stored per entity (memory limit) */
  MESSAGE_HISTORY: 100,

  /** Maximum transactions in entity mempool before rejection */
  MEMPOOL_SIZE: 1000,

  /** Maximum pending transactions in one bilateral Account mempool/frame. */
  ACCOUNT_MEMPOOL_SIZE: 1000,

  /** Maximum size of a single frame in bytes. 1000 tx frames get a 10KB/tx budget. */
  MAX_FRAME_SIZE_BYTES: 10_000_000,

  /** Maximum number of accounts per entity (prevents state bloat) */
  MAX_ACCOUNTS_PER_ENTITY: 1000,

  /** Maximum live proposals per entity; at most one pending per board signer. */
  MAX_PENDING_PROPOSALS_PER_ENTITY: 100,

  /** Maximum retained terminal proposal receipts per entity. */
  MAX_TERMINAL_PROPOSALS_PER_ENTITY: 100,

  /** Aggregate proposal state bound (pending + terminal). */
  MAX_PROPOSALS_PER_ENTITY: 200,

  /** Maximum validators per entity (BFT performance limit) */
  MAX_VALIDATORS: 100,

  /** Maximum active HTLC locks per bilateral account; 16-bit hashledger cross-j swaps need 16 live legs. */
  MAX_ACCOUNT_HTLC_LOCKS: 32,

  /** Maximum active swap offers per bilateral account */
  MAX_ACCOUNT_SWAP_OFFERS: 1000,

  /** Maximum live offers for one maker, direction, and economic market. */
  MAX_ACCOUNT_SWAP_OFFERS_PER_SIDE_PER_MARKET: 10,

  /** Recent terminal swap lifecycle rows retained in the live Account projection. */
  MAX_ACCOUNT_TERMINAL_SWAP_HISTORY: 100,

  /** Recent partial-fill details retained per swap; full frames remain in frame DB. */
  MAX_ACCOUNT_SWAP_RESOLVES_PER_ORDER: 100,

  /** Maximum offer-id/comment characters retained in the live swap projection. */
  MAX_ACCOUNT_SWAP_HISTORY_TEXT: 256,

  /** Two lookup keys for every live HTLC across every allowed Entity account. */
  MAX_ENTITY_HTLC_NOTES: 64_000,

  /** Payment descriptions are UI metadata, never an unbounded storage blob. */
  MAX_ENTITY_HTLC_NOTE_LENGTH: 256,

  /** Maximum resting orders per pair book */
  MAX_ORDERBOOK_ORDERS_PER_PAIR: 10_000,
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
  MAX_ROUTE_HOPS: 100,
} as const;

// ═══════════════════════════════════════════════════════════════
// HTLC (Hash Time-Locked Contracts)
// ═══════════════════════════════════════════════════════════════

export const HTLC = {
  /** Minimum timelock delta per hop (simnet-optimized for speed) */
  MIN_TIMELOCK_DELTA_MS: 10_000, // 10 seconds per hop

  /**
   * Jurisdiction-block reserve between adjacent hops.
   *
   * One block is unsafe: the downstream Account can commit at its deadline
   * while the watcher advances before the upstream Account can durably reveal.
   * Three blocks match the 30-second Account network allowance without using a
   * live wall clock or a chain-specific block-time estimate in consensus.
   */
  MIN_REVEAL_HEIGHT_DELTA_BLOCKS: 3,

  /** Minimum time remaining for the first forward (prevents TIMELOCK_TOO_TIGHT) */
  MIN_FORWARD_TIMELOCK_MS: 20_000, // 20 seconds minimum at first hop

  /** Maximum hops for HTLC routing (prevents loops) */
  MAX_HOPS: 100,

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
// SWAP / ORDERBOOK
// ═══════════════════════════════════════════════════════════════

export const SWAP = {
  /** Soft warning: limit price deviates >10% from best available */
  PRICE_WARN_BPS: 1000, // 10%

  /** Hard reject: limit price deviates >30% from current market anchor */
  PRICE_REJECT_BPS: 3000, // 30%

  /** BPS base (10000 = 100%) */
  BPS_BASE: 10000,
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
  // Idle RPC runtimes share the same chain, so a 1s poll per runtime amplifies
  // into dozens of identical eth_blockNumber calls. Local submissions invoke
  // pollNow() at the durability boundary; the interval is only the external
  // chain fallback and therefore may stay deliberately cold.
  J_WATCHER_POLL_INTERVAL_MS: 5_000,

  /** Maximum finalized block range fetched by one J-watcher poll. */
  J_WATCHER_MAX_BLOCKS_PER_POLL: 256,

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
// OPERATOR UI / DEBUG DISPLAY
// ═══════════════════════════════════════════════════════════════

export const DISPLAY = {
  /** Default compact hash width: first 4 bytes = 8 hex chars, matching Git-style short fingerprints. */
  SHORT_HASH_BYTES: 4,
  SHORT_HASH_HEX_CHARS: 8,

  /** Keep endpoint labels compact while still showing both ends of long values. */
  ENDPOINT_PREFIX_CHARS: 8,
  ENDPOINT_SUFFIX_CHARS: 4,

  /** Health flow graph preview size. */
  HEALTH_FLOW_EDGE_LIMIT: 12,
} as const;

// ═══════════════════════════════════════════════════════════════
// REMOTE RUNTIME / R-ADAPTER
// ═══════════════════════════════════════════════════════════════

export const REMOTE_RUNTIME = {
  DEFAULT_ADAPTER_PATH: '/rpc',

  /** Default page size for aggregate-first remote runtime views. */
  VIEW_PAGE_SIZE: 10,

  /** Number of recent frames requested for the live remote history tail. */
  HISTORY_FRAME_LIMIT: 12,

  /** Per-frame page size for history tail reads; live view pages stay larger. */
  HISTORY_VIEW_PAGE_SIZE: 1,

  /** Browser-side cap for scanned historical remote frames. */
  HISTORY_SCAN_CACHE_LIMIT: 24,

  IMPORT_HASH_PARAM: 'runtime-import',
  IMPORT_SOURCE_HASH_PARAM: 'runtime-import-src',
  IMPORT_STORAGE_KEY: 'xln-remote-runtime-imports',
  IMPORT_RESULT_STORAGE_KEY: 'xln-remote-runtime-import-last-result',
  MAX_IMPORTS: 100,

  /** Default lifetime for one-click dev import capability tokens. */
  IMPORT_TOKEN_TTL_MS: 60 * 60 * 1000,

  /** Re-issue the dev import manifest before one-click tokens expire. */
  IMPORT_TOKEN_REFRESH_MARGIN_MS: 5 * 60 * 1000,
} as const;

export const TIME_MACHINE = {
  HASH_HEIGHT_PARAM: 'tmHeight',
  HASH_ENTITY_PARAM: 'tmEntity',
  HASH_RUNTIME_PARAM: 'tmRuntime',
} as const;

// ═══════════════════════════════════════════════════════════════
// QA / RELEASE EVIDENCE
// ═══════════════════════════════════════════════════════════════

export const QA = {
  RUN_WINDOW_STEP: 80,
  SHARD_WINDOW_STEP: 80,
  HISTORY_WINDOW_STEP: 80,
  LEDGER_WINDOW_STEP: 80,
  ARTIFACT_WINDOW_STEP: 40,
  RECENT_TREND_LIMIT: 12,
  HISTORY_PREVIEW_LIMIT: 12,
  BROWSER_ISSUE_PREVIEW_LIMIT: 8,
  STORY_TAG_LIMIT: 12,
  SHARD_TIMELINE_STEP_LIMIT: 80,
  SHARD_SLOW_STEP_LIMIT: 12,
  LOG_TAIL_LINES: 80,
  BOOTSTRAP_PAIR_PREVIEW_LIMIT: 6,
  BOOTSTRAP_CROSS_ROUTE_PREVIEW_LIMIT: 8,

  HISTORY_DEFAULT_LIMIT: 120,
  HISTORY_MAX_LIMIT: 500,
  HISTORY_BACKFILL_DEFAULT_LIMIT: 500,
  HISTORY_BACKFILL_MAX_LIMIT: 2_000,

  RETENTION_MIN_DAYS: 30,

  RESTART_CONFIRM: 'RUN',
  RESTART_ABORT_CONFIRM: 'ABORT_RESTART',
  HISTORY_BACKFILL_CONFIRM: 'BACKFILL_QA_HISTORY',
  RETENTION_CONFIRM: 'DELETE_OLDER_THAN_30_DAYS',

  PHASE_BUDGET_MS: {
    preflight: 1_000,
    anvilBoot: 5_000,
    apiBoot: 5_000,
    apiHealthy: 5_000,
    viteBoot: 5_000,
    playwright: 5_000,
  },
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
