export const DEV_STARTUP_HEARTBEAT_MS = 10_000;

export type DevStartupProgress = Readonly<{
  reason: string;
  totalElapsedMs: number;
  probeElapsedMs: number;
}>;

export type DevStartupProgressState = Readonly<{
  phase: string;
  reason: string;
  emittedAtMs: number;
}>;

export const initialDevStartupProgressState = (): DevStartupProgressState => ({
  phase: '',
  reason: '',
  emittedAtMs: -DEV_STARTUP_HEARTBEAT_MS,
});

export const classifyDevStartupPhase = (reason: string): string => {
  if (reason.startsWith('reset-')) return 'reset';
  if (
    reason.startsWith('fatal:') ||
    reason === 'system-not-ok' ||
    reason === 'core-not-ok' ||
    reason.startsWith('degraded:')
  ) {
    return 'core';
  }
  if (reason.startsWith('runtime-bundle')) return 'runtime-bundle';
  if (reason.startsWith('wallet-http') || reason.startsWith('runtime-http')) return 'wallet';
  if (reason.startsWith('watchtower')) return 'watchtower';
  if (reason.includes('relay-')) return 'relay';
  if (reason.includes('faucet-')) return 'faucet';
  if (reason.startsWith('market-maker-')) return 'market-maker';
  if (reason.startsWith('custody-')) return 'custody';
  if (reason.startsWith('bootstrap-reserve')) return 'reserves';
  return 'mesh';
};

export const reduceDevStartupProgress = (
  state: DevStartupProgressState,
  progress: DevStartupProgress,
): { state: DevStartupProgressState; line: string | null } => {
  const phase = classifyDevStartupPhase(progress.reason);
  const phaseChanged = phase !== state.phase;
  const heartbeatDue = progress.probeElapsedMs - state.emittedAtMs >= DEV_STARTUP_HEARTBEAT_MS;
  if (!phaseChanged && !heartbeatDue) return { state, line: null };
  const event = phaseChanged ? 'DEV_PHASE' : 'DEV_HEARTBEAT';
  return {
    state: { phase, reason: progress.reason, emittedAtMs: progress.probeElapsedMs },
    line:
      `${event} phase=${phase} totalElapsedMs=${progress.totalElapsedMs} ` +
      `probeElapsedMs=${progress.probeElapsedMs} reason=${progress.reason}`,
  };
};
