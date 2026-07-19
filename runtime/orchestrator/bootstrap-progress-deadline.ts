export type BootstrapProgressDeadlineEvaluation = Readonly<{
  progressed: boolean;
  signature: string;
  lastProgressAt: number;
  idleMs: number;
  stalled: boolean;
}>;

/** Observe causal state before deciding whether its idle deadline expired. */
export const evaluateBootstrapProgressDeadline = (
  previous: Readonly<{ signature: string; lastProgressAt: number }>,
  currentSignature: string,
  now: number,
  timeoutMs: number,
): BootstrapProgressDeadlineEvaluation => {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error(`BOOTSTRAP_PROGRESS_NOW_INVALID:${now}`);
  }
  if (!Number.isSafeInteger(previous.lastProgressAt) || previous.lastProgressAt < 0) {
    throw new Error(`BOOTSTRAP_PROGRESS_LAST_AT_INVALID:${previous.lastProgressAt}`);
  }
  if (now < previous.lastProgressAt) {
    throw new Error(
      `BOOTSTRAP_PROGRESS_CLOCK_REGRESSION:previous=${previous.lastProgressAt}:now=${now}`,
    );
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`BOOTSTRAP_PROGRESS_TIMEOUT_INVALID:${timeoutMs}`);
  }
  const progressed = currentSignature !== previous.signature;
  const lastProgressAt = progressed ? now : previous.lastProgressAt;
  const idleMs = now - lastProgressAt;
  return {
    progressed,
    signature: currentSignature,
    lastProgressAt,
    idleMs,
    stalled: idleMs >= timeoutMs,
  };
};

/** Track each contiguous Runtime-work segment, including remotely delivered follow-ups. */
export const updateBootstrapWorkStartedAt = (
  previousStartedAt: number | null,
  hasWork: boolean,
  now: number,
  activeFrameStartedAt?: number,
): number | null => {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error(`BOOTSTRAP_WORK_NOW_INVALID:${now}`);
  }
  if (!hasWork) return null;
  if (activeFrameStartedAt !== undefined) {
    if (!Number.isSafeInteger(activeFrameStartedAt) || activeFrameStartedAt < 0) {
      throw new Error(`BOOTSTRAP_FRAME_STARTED_AT_INVALID:${activeFrameStartedAt}`);
    }
    if (activeFrameStartedAt > now) {
      throw new Error(`BOOTSTRAP_FRAME_CLOCK_INVALID:started=${activeFrameStartedAt}:now=${now}`);
    }
  }
  if (previousStartedAt === null) return activeFrameStartedAt ?? now;
  if (!Number.isSafeInteger(previousStartedAt) || previousStartedAt < 0) {
    throw new Error(`BOOTSTRAP_WORK_STARTED_AT_INVALID:${previousStartedAt}`);
  }
  if (now < previousStartedAt) {
    throw new Error(`BOOTSTRAP_WORK_CLOCK_INVALID:started=${previousStartedAt}:now=${now}`);
  }
  // A newly entered Runtime frame gets its own execution deadline. Its start
  // is not semantic progress: once this bounded window expires, bootstrap
  // still fails even if unrelated work remains continuously queued.
  return Math.max(previousStartedAt, activeFrameStartedAt ?? previousStartedAt);
};

/**
 * A detached bootstrap batch is not semantic progress, but it owns a separate
 * bounded execution window. This prevents the semantic idle deadline from
 * killing a Runtime frame that is still completing deterministically.
 */
export const isBootstrapWorkWithinDeadline = (
  workStartedAt: number | null,
  now: number,
  timeoutMs: number,
): boolean => {
  if (workStartedAt === null) return false;
  if (!Number.isSafeInteger(workStartedAt) || workStartedAt < 0) {
    throw new Error(`BOOTSTRAP_WORK_STARTED_AT_INVALID:${workStartedAt}`);
  }
  if (!Number.isSafeInteger(now) || now < workStartedAt) {
    throw new Error(`BOOTSTRAP_WORK_CLOCK_INVALID:started=${workStartedAt}:now=${now}`);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`BOOTSTRAP_WORK_TIMEOUT_INVALID:${timeoutMs}`);
  }
  return now - workStartedAt < timeoutMs;
};
