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
