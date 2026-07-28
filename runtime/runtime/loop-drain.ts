import type { Env } from '../types';
import { inferRuntimeLifecyclePhase } from './lifecycle';
import { requestRuntimeLoopWake } from './input-queue';
import { getRemainingRuntimeFrameDelayMs } from './loop-work';
import { ensureRuntimeState } from './runtime-state';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export type RuntimeDrainDeps = {
  processRuntime(env: Env): Promise<unknown>;
  hasRuntimeWork(env: Env): boolean;
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

const waitForProcessingCycle = async (env: Env, remaining: number): Promise<void> => {
  const processing = env.runtimeState?.processingPromise;
  if (!processing) return;
  await Promise.race([
    processing.then(
      () => undefined,
      () => undefined,
    ),
    sleep(Math.min(remaining, 250)),
  ]);
};

const drainInactiveRuntime = async (
  env: Env,
  remaining: number,
  deps: RuntimeDrainDeps,
): Promise<boolean> => {
  const state = ensureRuntimeState(env);
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
  env: Env,
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
    const hasWork = deps.hasRuntimeWork(env) || Boolean(env.runtimeState?.processingPromise);
    if (!hasWork) {
      idleSince ??= Date.now();
      const quietFor = Date.now() - idleSince;
      if (quietFor >= quietMs) return true;
      await sleep(Math.min(25, quietMs - quietFor));
      continue;
    }
    idleSince = null;
    if (!options.allowPersistencePaused && await drainInactiveRuntime(env, remaining, deps)) {
      continue;
    }
    if (
      options.allowPersistencePaused &&
      !env.runtimeState?.loopPromise &&
      !env.runtimeState?.processingPromise
    ) {
      await deps.processRuntime(env);
      continue;
    }
    requestRuntimeLoopWake(env);
    await sleep(10);
  }
};
