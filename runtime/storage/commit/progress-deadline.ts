export type StorageProgressDeadlineEvaluation = Readonly<{
  idleMs: number;
  remainingMs: number;
  stalled: boolean;
}>;

/** Evaluate an operational idle deadline without treating active CPU work as a stall. */
export const evaluateStorageProgressDeadline = (
  lastProgressAtMs: number,
  nowMs: number,
  timeoutMs: number,
): StorageProgressDeadlineEvaluation => {
  if (!Number.isSafeInteger(lastProgressAtMs) || lastProgressAtMs < 0) {
    throw new Error(`STORAGE_PROGRESS_LAST_AT_INVALID:${lastProgressAtMs}`);
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < lastProgressAtMs) {
    throw new Error(
      `STORAGE_PROGRESS_CLOCK_INVALID:last=${lastProgressAtMs}:now=${nowMs}`,
    );
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`STORAGE_PROGRESS_TIMEOUT_INVALID:${timeoutMs}`);
  }

  const idleMs = nowMs - lastProgressAtMs;
  return {
    idleMs,
    remainingMs: Math.max(0, timeoutMs - idleMs),
    stalled: idleMs >= timeoutMs,
  };
};
