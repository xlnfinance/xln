/**
 * Time helpers
 * - getWallClockMs: wall-clock timestamp without Date.now()
 * - getPerfMs: monotonic clock for durations
 */

export const getWallClockMs = (): number => {
  const perf = typeof globalThis !== 'undefined' ? (globalThis as any).performance : undefined;
  if (perf && typeof perf.timeOrigin === 'number' && typeof perf.now === 'function') {
    return Math.round(perf.timeOrigin + perf.now());
  }
  if (typeof process !== 'undefined' && typeof process.hrtime === 'function') {
    const [sec, ns] = process.hrtime();
    return sec * 1000 + Math.floor(ns / 1e6);
  }
  return 0;
};

export const getPerfMs = (): number => {
  const perf = typeof globalThis !== 'undefined' ? (globalThis as any).performance : undefined;
  if (perf && typeof perf.now === 'function') {
    return perf.now();
  }
  if (typeof process !== 'undefined' && typeof process.hrtime === 'function') {
    const [sec, ns] = process.hrtime();
    return sec * 1000 + Math.floor(ns / 1e6);
  }
  return 0;
};
