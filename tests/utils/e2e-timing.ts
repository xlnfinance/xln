const E2E_TIMINGS_ENABLED = process.env.E2E_TIMINGS !== '0';

export async function timedStep<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    if (E2E_TIMINGS_ENABLED) {
      const elapsedMs = Date.now() - startedAt;
      // Keep a strict single-line format so shard logs are easy to parse with rg.
      console.log(`[E2E-TIMING] ${label} ${elapsedMs}ms`);
    }
  }
}

