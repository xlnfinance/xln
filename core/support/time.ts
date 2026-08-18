type RuntimePerformance = Pick<Performance, 'now' | 'timeOrigin'>;
type RuntimeGlobal = typeof globalThis & { performance?: RuntimePerformance };

/** External wall clock for orchestration and diagnostics, never consensus. */
export const getWallClockMs = (): number => {
  const perf = typeof globalThis !== 'undefined'
    ? (globalThis as RuntimeGlobal).performance
    : undefined;
  if (perf && typeof perf.timeOrigin === 'number' && typeof perf.now === 'function') {
    return Math.round(perf.timeOrigin + perf.now());
  }
  if (typeof process !== 'undefined' && typeof process.hrtime === 'function') {
    const [seconds, nanoseconds] = process.hrtime();
    return seconds * 1_000 + Math.floor(nanoseconds / 1_000_000);
  }
  return 0;
};

/** Monotonic clock for measuring infrastructure latency. */
export const getPerfMs = (): number => {
  const perf = typeof globalThis !== 'undefined'
    ? (globalThis as RuntimeGlobal).performance
    : undefined;
  if (perf && typeof perf.now === 'function') return perf.now();
  if (typeof process !== 'undefined' && typeof process.hrtime === 'function') {
    const [seconds, nanoseconds] = process.hrtime();
    return seconds * 1_000 + Math.floor(nanoseconds / 1_000_000);
  }
  return 0;
};
