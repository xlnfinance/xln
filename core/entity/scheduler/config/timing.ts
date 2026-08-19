/** Canonical liveness window for a proposed Account frame and its cross-j sibling cohort. */
export const ACCOUNT_PENDING_STALE_WARNING_MS = 30_000;

export const ACCOUNT_MAINTENANCE_INTERVAL_MS = 10_000;
export const ACCOUNT_PENDING_RESEND_AFTER_MS = 8_000;

/** 0 disables. Strict ceiling after which a pending Account frame halts the runtime (HLT/local fail-fast). */
export const ACCOUNT_PENDING_ACK_STRICT_TIMEOUT_MS = Math.max(
  0,
  Math.floor(Number(process.env?.['XLN_ACCOUNT_ACK_STRICT_TIMEOUT_MS'] || '0')),
);
