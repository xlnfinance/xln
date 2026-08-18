export type SweepHealthSnapshot = {
  healthy: boolean;
  consecutiveFailures: number;
  lastError?: string;
};

export type SweepHealthTracker = {
  failure(error: string): void;
  success(): void;
  snapshot(): SweepHealthSnapshot;
};

export const createSweepHealthTracker = (failureThreshold = 3): SweepHealthTracker => {
  const threshold = Math.max(1, Math.floor(failureThreshold));
  let consecutiveFailures = 0;
  let lastError = '';
  return {
    failure: error => {
      consecutiveFailures += 1;
      lastError = error;
    },
    success: () => {
      consecutiveFailures = 0;
      lastError = '';
    },
    snapshot: () => ({
      healthy: consecutiveFailures < threshold,
      consecutiveFailures,
      ...(lastError ? { lastError } : {}),
    }),
  };
};
