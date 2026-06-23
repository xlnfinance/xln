const E2E_TIMINGS_ENABLED = process.env['E2E_TIMINGS'] !== '0';

type E2ETimingGlobal = typeof globalThis & {
  __xlnE2ETimingOriginMs?: number;
};

const timingGlobal = (): E2ETimingGlobal => globalThis as E2ETimingGlobal;

export function setE2ETimingOrigin(originMs = Date.now()): void {
  timingGlobal().__xlnE2ETimingOriginMs = originMs;
}

const readTimingOrigin = (): number => {
  const globalOrigin = timingGlobal().__xlnE2ETimingOriginMs;
  if (Number.isFinite(globalOrigin)) return Number(globalOrigin);
  const envOrigin = Number(process.env['E2E_PLAYWRIGHT_STARTED_AT_MS'] || '');
  return Number.isFinite(envOrigin) && envOrigin > 0 ? envOrigin : Date.now();
};

export async function timedStep<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    if (E2E_TIMINGS_ENABLED) {
      const elapsedMs = Date.now() - startedAt;
      const originMs = readTimingOrigin();
      const startMs = Math.max(0, startedAt - originMs);
      const endMs = startMs + elapsedMs;
      // Keep a strict single-line format so shard logs are easy to parse with rg.
      console.log(`[E2E-TIMING] ${label} ${elapsedMs}ms`);
      console.log(`[E2E-CUE] ${label} start=${startMs}ms end=${endMs}ms duration=${elapsedMs}ms`);
    }
  }
}
