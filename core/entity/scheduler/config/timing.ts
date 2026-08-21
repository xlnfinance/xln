/** Canonical liveness window for a proposed Account frame and its cross-j sibling cohort. */
export const ACCOUNT_PENDING_STALE_WARNING_MS = 30_000;

export const ACCOUNT_MAINTENANCE_INTERVAL_MS = 10_000;

const envMs = (name: string, fallback: string): number =>
  Math.max(0, Math.floor(Number(process.env?.[name] || fallback)));

/**
 * Age at which Account liveness replays the exact signed AccountInput so a
 * peer that consumed the frame can reproduce a lost ACK. The Runtime outbox
 * independently owns exact certified-envelope transport retry until WAL ACK.
 */
export const ACCOUNT_PENDING_RESEND_AFTER_MS = Math.max(
  1,
  envMs('XLN_ACCOUNT_PENDING_RESEND_AFTER_MS', '8000'),
);

/** 0 disables. Strict ceiling after which a pending Account frame halts the runtime (HLT/local fail-fast). */
export const ACCOUNT_PENDING_ACK_STRICT_TIMEOUT_MS = envMs('XLN_ACCOUNT_ACK_STRICT_TIMEOUT_MS', '0');

if (
  ACCOUNT_PENDING_ACK_STRICT_TIMEOUT_MS > 0 &&
  ACCOUNT_PENDING_ACK_STRICT_TIMEOUT_MS <= ACCOUNT_PENDING_RESEND_AFTER_MS
) {
  throw new Error(
      `ACCOUNT_ACK_STRICT_TIMEOUT_MS_MUST_EXCEED_RESEND` +
      `:timeout=${String(ACCOUNT_PENDING_ACK_STRICT_TIMEOUT_MS)}` +
      `:resend=${String(ACCOUNT_PENDING_RESEND_AFTER_MS)}`,
  );
}
