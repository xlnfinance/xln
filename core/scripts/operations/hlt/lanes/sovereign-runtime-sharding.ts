/** CPU isolation inside one sovereign Runtime OS process. */

export const SOVEREIGN_RUNTIMES_PER_WORKER = 25;

export const sovereignRuntimeWorkerStart = (runtimeIndex: number): number => {
  if (!Number.isSafeInteger(runtimeIndex) || runtimeIndex < 0) {
    throw new Error(`HLT_SOVEREIGN_RUNTIME_INDEX_INVALID:${runtimeIndex}`);
  }
  return Math.floor(runtimeIndex / SOVEREIGN_RUNTIMES_PER_WORKER) * SOVEREIGN_RUNTIMES_PER_WORKER;
};
