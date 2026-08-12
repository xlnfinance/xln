export type CausalProgressState = {
  signature: string;
  lastProgressAtMs: number;
};

export type MmHealthProbeFailureDecision = {
  action: 'continue' | 'fatal';
  msSinceProgress: number;
};

const requireTimestamp = (value: number, code: string): number => {
  if (!Number.isFinite(value) || value < 0) throw new Error(code);
  return value;
};

export const trackCausalProgress = (
  previous: CausalProgressState | null,
  signature: string,
  nowMs: number,
): CausalProgressState => {
  const now = requireTimestamp(nowMs, 'CAUSAL_PROGRESS_NOW_INVALID');
  if (signature.length === 0) throw new Error('CAUSAL_PROGRESS_SIGNATURE_EMPTY');
  if (previous === null) return { signature, lastProgressAtMs: now };
  if (now < previous.lastProgressAtMs) throw new Error('CAUSAL_PROGRESS_CLOCK_REGRESSION');
  if (previous.signature === signature) return previous;
  return { signature, lastProgressAtMs: now };
};

export const evaluateMmHealthProbeFailure = ({
  nowMs,
  lastProgressAtMs,
  noProgressFatalMs,
}: {
  nowMs: number;
  lastProgressAtMs: number;
  noProgressFatalMs: number;
}): MmHealthProbeFailureDecision => {
  const now = requireTimestamp(nowMs, 'MM_HEALTH_PROBE_NOW_INVALID');
  const lastProgress = requireTimestamp(lastProgressAtMs, 'MM_HEALTH_PROBE_PROGRESS_AT_INVALID');
  if (!Number.isFinite(noProgressFatalMs) || noProgressFatalMs <= 0) {
    throw new Error('MM_HEALTH_PROBE_FATAL_WINDOW_INVALID');
  }
  if (now < lastProgress) throw new Error('MM_HEALTH_PROBE_CLOCK_REGRESSION');
  const msSinceProgress = now - lastProgress;
  return {
    action: msSinceProgress >= noProgressFatalMs ? 'fatal' : 'continue',
    msSinceProgress,
  };
};
