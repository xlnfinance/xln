import type { RuntimeReplica } from '../types.ts';
import { inferRuntimeLifecyclePhase } from '../lifecycle.ts';
import { requestRuntimeLoopWake } from '../input-pipeline/input-queue.ts';
import { getRemainingRuntimeFrameDelayMs } from './loop-work.ts';
import { ensureRuntimeInfrastructure } from '../infrastructure/runtime-infrastructure.ts';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export type RuntimeDrainDeps = {
  processRuntime(env: RuntimeReplica): Promise<unknown>;
  hasRuntimeWork(env: RuntimeReplica): boolean;
};

export const waitForPromiseBeforeTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<boolean> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const waitForProcessingCycle = async (env: RuntimeReplica, remaining: number): Promise<void> => {
  const processing = env.infrastructure?.processingPromise;
  if (!processing) return;
  await Promise.race([
    processing.then(
      () => undefined,
      () => undefined,
    ),
    sleep(Math.min(remaining, 250)),
  ]);
};

const hasRuntimeDrainBlocker = (env: RuntimeReplica): boolean => {
  const state = env.infrastructure;
  return Boolean(
    (state?.pendingReliableIngress?.size ?? 0) > 0 ||
    (state?.reliableIngressCommitting?.size ?? 0) > 0 ||
    (state?.inFlightEntityInputs ?? 0) > 0 ||
    (state?.inFlightReliableInputKeys?.size ?? 0) > 0 ||
    state?.stateMutationInFlight,
  );
};

const drainInactiveRuntime = async (
  env: RuntimeReplica,
  remaining: number,
  deps: RuntimeDrainDeps,
): Promise<boolean> => {
  const state = ensureRuntimeInfrastructure(env);
  if (state.persistencePaused) throw new Error('RUNTIME_WORK_DRAIN_PERSISTENCE_PAUSED');
  if (inferRuntimeLifecyclePhase(state) === 'halted') throw new Error('RUNTIME_WORK_DRAIN_HALTED');
  if (state.loopPromise || state.processingPromise) return false;
  const delayMs = getRemainingRuntimeFrameDelayMs(env);
  if (delayMs > 0) {
    await sleep(Math.min(remaining, delayMs, 25));
  } else {
    await deps.processRuntime(env);
  }
  return true;
};

export const waitForRuntimeWorkDrained = async (
  env: RuntimeReplica,
  deps: RuntimeDrainDeps,
  timeoutMs = 10_000,
  quietMs = 250,
  options: { allowPersistencePaused?: boolean } = {},
): Promise<boolean> => {
  const startedAt = Date.now();
  let idleSince: number | null = null;
  requestRuntimeLoopWake(env);
  while (true) {
    const now = Date.now();
    const remaining = timeoutMs - (now - startedAt);
    if (remaining <= 0) return false;
    await waitForProcessingCycle(env, remaining);
    const hasDrainableWork = deps.hasRuntimeWork(env);
    const hasWork =
      hasDrainableWork ||
      hasRuntimeDrainBlocker(env) ||
      Boolean(env.infrastructure?.processingPromise);
    if (!hasWork) {
      idleSince ??= Date.now();
      const quietFor = Date.now() - idleSince;
      if (quietFor >= quietMs) return true;
      await sleep(Math.min(25, quietMs - quietFor));
      continue;
    }
    idleSince = null;
    if (
      hasDrainableWork &&
      !options.allowPersistencePaused &&
      await drainInactiveRuntime(env, remaining, deps)
    ) {
      continue;
    }
    if (
      hasDrainableWork &&
      options.allowPersistencePaused &&
      !env.infrastructure?.loopPromise &&
      !env.infrastructure?.processingPromise
    ) {
      await deps.processRuntime(env);
      continue;
    }
    requestRuntimeLoopWake(env);
    await sleep(10);
  }
};
