/**
 * Browser-safe remote Runtime constants.
 *
 * Keep this module free of operator environment reads so frontend adapters can
 * consume the canonical import protocol without evaluating Node-only config.
 */
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
