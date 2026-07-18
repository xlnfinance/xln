export type BootstrapProgress = Readonly<{
  startedAtMs: number;
  lastProgressAtMs: number;
  step: string;
}>;

const requireTimestamp = (label: string, value: number): number => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`BOOTSTRAP_PROGRESS_TIMESTAMP_INVALID:${label}=${value}`);
  }
  return value;
};

export const beginBootstrapProgress = (nowMs: number): BootstrapProgress => {
  const now = requireTimestamp('begin', nowMs);
  return { startedAtMs: now, lastProgressAtMs: now, step: 'start' };
};

export const advanceBootstrapProgress = (
  progress: BootstrapProgress,
  step: string,
  nowMs: number,
): BootstrapProgress => {
  const now = requireTimestamp('advance', nowMs);
  const normalizedStep = String(step || '').trim();
  if (!normalizedStep) throw new Error('BOOTSTRAP_PROGRESS_STEP_EMPTY');
  if (now < progress.lastProgressAtMs) {
    throw new Error(`BOOTSTRAP_PROGRESS_TIME_REGRESSED:previous=${progress.lastProgressAtMs}:next=${now}`);
  }
  return { ...progress, lastProgressAtMs: now, step: normalizedStep };
};

export const assertBootstrapNotStalled = (
  progress: BootstrapProgress,
  nowMs: number,
  stallTimeoutMs: number,
): void => {
  const now = requireTimestamp('check', nowMs);
  if (!Number.isFinite(stallTimeoutMs) || stallTimeoutMs <= 0) {
    throw new Error(`BOOTSTRAP_STALL_TIMEOUT_INVALID:${stallTimeoutMs}`);
  }
  const idleMs = Math.max(0, now - progress.lastProgressAtMs);
  if (idleMs <= stallTimeoutMs) return;
  const totalMs = Math.max(0, now - progress.startedAtMs);
  throw new Error(
    `MESH_BOOTSTRAP_STALLED step=${progress.step} idleMs=${idleMs} totalMs=${totalMs} timeoutMs=${stallTimeoutMs}`,
  );
};
