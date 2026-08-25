/**
 * GC settings inherited by every supervised Runtime child.
 *
 * JSC sizes its marker-thread pool from the machine's core count, so each
 * co-located Runtime spawns a pool as if it owned the box. The marking threads
 * then walk their heaps concurrently and evict each other from the shared L3,
 * which is where a Runtime's hot state lives. One marker per process removes
 * that collision.
 *
 * Measured on the pay200 cutover replay, N independent Runtimes on a 32-core
 * box: no difference at one process, +5.6% at four, +24.9% at twenty. There is
 * no measured cost at any process count, so it is a default rather than a knob,
 * and an operator who sets the variable explicitly still wins.
 */
const RUNTIME_CHILD_GC_DEFAULTS: Readonly<Record<string, string>> = {
  BUN_JSC_numberOfGCMarkers: '1',
};

export const buildRuntimeChildGcEnv = (
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(RUNTIME_CHILD_GC_DEFAULTS)) {
    env[key] = source[key] ?? value;
  }
  return env;
};
