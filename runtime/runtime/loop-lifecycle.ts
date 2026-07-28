import type { Env } from '../types';
import { getWallClockMs } from '../utils';
import { inferRuntimeLifecyclePhase, transitionRuntimeLifecycle } from './lifecycle';
import { requestRuntimeLoopWake, requireRuntimeMempool } from './input-queue';
import {
  waitForRuntimeLoopWake,
  waitForRuntimeLoopWakeOrTimeout,
} from './loop-infrastructure';
import {
  generateHookPings,
  getEarliestWallClockDueTimestamp,
  getRemainingRuntimeFrameDelayMs,
} from './loop-work';
import { yieldRuntimeIoTurn } from './platform';
import { ensureRuntimeState } from './runtime-state';
import { deleteScheduledWakeIndex, rebuildScheduledWakeIndex } from './scheduled-wake';
import {
  startJurisdictionWatchers,
  stopJurisdictionWatchers,
  stopJurisdictionWatchersAndWait,
} from './loop-watchers';
import {
  waitForPromiseBeforeTimeout,
  waitForRuntimeWorkDrained,
} from './loop-drain';
import { emitRuntimeLoopError, reportFatalLoopError } from './loop-failure';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
type RuntimeState = NonNullable<Env['runtimeState']>;

export type RuntimeLoopConfig = {
  tickDelayMs?: number;
  maxEntityInputsPerFrame?: number;
  maxEntityTxsPerFrame?: number;
  onFatal?: (payload: {
    code: string;
    message: string;
    height: number;
    timestamp: number;
  }) => void | Promise<void>;
};

export type RuntimeLoopLifecycleDeps = {
  processRuntime(env: Env): Promise<unknown>;
  waitForRuntimeProcessingIdle(env: Env, timeoutMs: number): Promise<boolean>;
  getRuntimeProcessGlobal(): { exit?: (code: number) => unknown } | null;
  hasRuntimeWork(env: Env): boolean;
  getNextWallClockWakeTimestamp(env: Env): number | null;
};

type LoopControl = {
  running: boolean;
  promise: Promise<void> | null;
};

const setPositiveFrameCap = (
  state: RuntimeState,
  key: 'maxEntityInputsPerFrame' | 'maxEntityTxsPerFrame',
  value: number | undefined,
): void => {
  if (value === undefined) return;
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    state[key] = Math.floor(parsed);
  } else {
    delete state[key];
  }
};

const configureFrameCaps = (state: RuntimeState, config?: RuntimeLoopConfig): void => {
  setPositiveFrameCap(state, 'maxEntityInputsPerFrame', config?.maxEntityInputsPerFrame);
  setPositiveFrameCap(state, 'maxEntityTxsPerFrame', config?.maxEntityTxsPerFrame);
};

const waitForNextRuntimeWork = async (
  env: Env,
  tickDelayMs: number,
  deps: RuntimeLoopLifecycleDeps,
): Promise<void> => {
  if (deps.hasRuntimeWork(env)) {
    const remainingDelayMs = getRemainingRuntimeFrameDelayMs(env);
    if (remainingDelayMs > 0) await sleep(remainingDelayMs);
    else if (tickDelayMs > 0) await sleep(tickDelayMs);
    return;
  }
  const nextDueAt = deps.getNextWallClockWakeTimestamp(env);
  if (nextDueAt === null) {
    await waitForRuntimeLoopWake(env);
    return;
  }
  const waitResult = await waitForRuntimeLoopWakeOrTimeout(
    env,
    Math.max(0, nextDueAt - getWallClockMs()),
  );
  if (waitResult !== 'timeout') return;
  const dueTimestamp = getEarliestWallClockDueTimestamp(env) ?? nextDueAt;
  const mempool = requireRuntimeMempool(env);
  mempool.queuedAt =
    mempool.queuedAt === undefined ? dueTimestamp : Math.max(mempool.queuedAt, dueTimestamp);
  generateHookPings(env, dueTimestamp, dueTimestamp);
};

const processAvailableRuntimeWork = async (
  env: Env,
  deps: RuntimeLoopLifecycleDeps,
): Promise<void> => {
  startJurisdictionWatchers(env);
  if (!deps.hasRuntimeWork(env)) return;
  const remainingDelayMs = getRemainingRuntimeFrameDelayMs(env);
  if (remainingDelayMs > 0) {
    await sleep(remainingDelayMs);
    return;
  }
  await deps.processRuntime(env);
  // Yielding prevents a zero-delay frame chain from starving transport ACKs.
  await yieldRuntimeIoTurn();
};

const finishRuntimeLoop = (
  env: Env,
  state: RuntimeState,
  control: LoopControl,
  haltedMessage: string | null,
): void => {
  if (haltedMessage) emitRuntimeLoopError(env, 'RUNTIME_LOOP_HALTED', { message: haltedMessage });
  if (inferRuntimeLifecyclePhase(state) === 'running') {
    transitionRuntimeLifecycle(state, 'stopped');
  }
  state.stopLoop = null;
  if (state.loopPromise === control.promise) state.loopPromise = null;
  state.wakeLoop = null;
  state.wakeRequested = false;
};

const runRuntimeLoop = async (
  env: Env,
  state: RuntimeState,
  config: RuntimeLoopConfig | undefined,
  control: LoopControl,
  deps: RuntimeLoopLifecycleDeps,
): Promise<void> => {
  const tickDelayMs = Math.max(0, Math.floor(Number(config?.tickDelayMs ?? 0)));
  let haltedMessage: string | null = null;
  try {
    while (control.running) {
      try {
        await processAvailableRuntimeWork(env, deps);
      } catch (error) {
        haltedMessage = await reportFatalLoopError(env, state, config, deps, error);
        control.running = false;
      }
      if (control.running) await waitForNextRuntimeWork(env, tickDelayMs, deps);
    }
  } finally {
    finishRuntimeLoop(env, state, control, haltedMessage);
  }
};

const startRuntimeLoopWithDeps = (
  env: Env,
  config: RuntimeLoopConfig | undefined,
  deps: RuntimeLoopLifecycleDeps,
): (() => void) => {
  if (env.scenarioMode) return () => {};
  const state = ensureRuntimeState(env);
  configureFrameCaps(state, config);
  const phase = inferRuntimeLifecyclePhase(state);
  if (phase === 'halted' || phase === 'running') return state.stopLoop ?? (() => {});
  if (phase === 'quiescing' && state.persistenceQuiescing) return state.stopLoop ?? (() => {});

  const control: LoopControl = { running: true, promise: null };
  transitionRuntimeLifecycle(state, 'running');
  rebuildScheduledWakeIndex(env);
  startJurisdictionWatchers(env);
  control.promise = runRuntimeLoop(env, state, config, control, deps);
  state.loopPromise = control.promise;
  void control.promise;
  state.stopLoop = () => {
    control.running = false;
    requestRuntimeLoopWake(env);
  };
  return state.stopLoop;
};

const stopRuntimeLoopAndWaitWithDeps = async (
  env: Env,
  timeoutMs: number,
  deps: RuntimeLoopLifecycleDeps,
): Promise<boolean> => {
  const state = env.runtimeState;
  if (state && inferRuntimeLifecyclePhase(state) !== 'halted') {
    transitionRuntimeLifecycle(state, 'quiescing');
  }
  state?.stopLoop?.();
  const startedAt = Date.now();
  if (state?.loopPromise) {
    const loopDone = await waitForPromiseBeforeTimeout(state.loopPromise, timeoutMs);
    if (!loopDone) return false;
  }
  return deps.waitForRuntimeProcessingIdle(
    env,
    Math.max(0, timeoutMs - (Date.now() - startedAt)),
  );
};

const resumeRuntimeLoopWithDeps = (
  env: Env,
  config: RuntimeLoopConfig | undefined,
  deps: RuntimeLoopLifecycleDeps,
): (() => void) => {
  const state = ensureRuntimeState(env);
  const phase = inferRuntimeLifecyclePhase(state);
  if (phase === 'halted') throw new Error('RUNTIME_RESUME_HALTED');
  if (phase === 'running') return state.stopLoop ?? (() => {});
  if (phase === 'quiescing') {
    if (state.loopPromise || state.processingPromise) {
      throw new Error('RUNTIME_RESUME_BEFORE_QUIESCE_DRAINED');
    }
    transitionRuntimeLifecycle(state, 'stopped');
  }
  return startRuntimeLoopWithDeps(env, config, deps);
};

const resumeAfterPersistenceQuiesce = (
  env: Env,
  config: RuntimeLoopConfig | undefined,
  deps: RuntimeLoopLifecycleDeps,
): (() => void) => {
  const state = ensureRuntimeState(env);
  const phase = inferRuntimeLifecyclePhase(state);
  if (phase === 'halted') throw new Error('RUNTIME_RESUME_HALTED');
  if (phase === 'running' && (state.persistencePaused || state.persistenceQuiescing)) {
    throw new Error('RUNTIME_DURABLE_RESUME_RUNNING_WITH_PERSISTENCE_FENCE');
  }
  if (phase === 'running') return state.stopLoop ?? (() => {});
  if (state.processingPromise || state.loopPromise) {
    throw new Error('RUNTIME_DURABLE_RESUME_BEFORE_QUIESCE_DRAINED');
  }
  state.persistencePaused = false;
  state.persistenceQuiescing = false;
  return resumeRuntimeLoopWithDeps(env, config, deps);
};

const detachRuntimeEnv = (env: Env): void => {
  const state = env.runtimeState;
  stopJurisdictionWatchers(env);
  state?.stopLoop?.();
  if (state) {
    try {
      state.runtimeSyncChannel?.close();
    } finally {
      state.runtimeSyncChannel = null;
    }
    state.lastP2PConfig = null;
    state.pendingP2PConfig = null;
    state.directEntityInputsDispatch = null;
    state.loopPromise = null;
    state.stopLoop = null;
    state.wakeLoop = null;
    state.wakeRequested = false;
    if (inferRuntimeLifecyclePhase(state) !== 'halted') {
      transitionRuntimeLifecycle(state, 'stopped');
    }
  }
  deleteScheduledWakeIndex(env);
};

export const createRuntimeLifecycleApi = (deps: RuntimeLoopLifecycleDeps) => ({
  startRuntimeLoop: (env: Env, config?: RuntimeLoopConfig) =>
    startRuntimeLoopWithDeps(env, config, deps),
  stopRuntimeLoopAndWait: (env: Env, timeoutMs = 10_000) =>
    stopRuntimeLoopAndWaitWithDeps(env, timeoutMs, deps),
  resumeRuntimeLoop: (env: Env, config?: RuntimeLoopConfig) =>
    resumeRuntimeLoopWithDeps(env, config, deps),
  resumeRuntimeAfterPersistenceQuiesce: (env: Env, config?: RuntimeLoopConfig) =>
    resumeAfterPersistenceQuiesce(env, config, deps),
  waitForRuntimeWorkDrained: (
    env: Env,
    timeoutMs = 10_000,
    quietMs = 250,
    options: { allowPersistencePaused?: boolean } = {},
  ) => waitForRuntimeWorkDrained(
    env,
    deps,
    timeoutMs,
    quietMs,
    options,
  ),
  startJurisdictionWatchers,
  stopJurisdictionWatchers,
  stopJurisdictionWatchersAndWait,
  detachRuntimeEnv,
});
