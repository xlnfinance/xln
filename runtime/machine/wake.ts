import type { Env, JInput, RoutedEntityInput, RuntimeInput, RuntimeTx } from '../types';
import { getWallClockMs } from '../utils';
import {
  createDueScheduledWakeInputs,
  entityNeedsPeriodicWake,
  getNextScheduledWakeTimestamp,
} from './scheduled-wake';
import {
  collectDueJSubmitRuntimeTxs,
  getNextJSubmitRetryTimestamp,
} from './j-submit-scheduler';
import {
  collectDueEntityProviderActionRuntimeTxs,
  getNextEntityProviderActionRetryTimestamp,
} from './entity-provider-action-submit-scheduler';

type RuntimeState = NonNullable<Env['runtimeState']>;

export type RuntimeWakeDeps = {
  ensureRuntimeState(env: Env): RuntimeState;
  ensureRuntimeMempool(env: Env): RuntimeInput;
  enqueueRuntimeInputs(
    env: Env,
    inputs?: RoutedEntityInput[],
    runtimeTxs?: RuntimeTx[],
    jInputs?: JInput[],
    explicitTimestamp?: number,
  ): void;
  getRuntimeNowMs(env: Env): number;
};

/**
 * True when an entity has periodic/security work that actually needs wakeups.
 * Generic bilateral work must not be hub-gated: a normal user runtime with a
 * lost ACK still needs to wake up and resend its pending account frame.
 */
export { entityNeedsPeriodicWake };

export const hasDueEntityHooks = (env: Env, deps: RuntimeWakeDeps): boolean => {
  const dueAt = getNextScheduledWakeTimestamp(env);
  const jDueAt = getNextJSubmitRetryTimestamp(env);
  const actionDueAt = getNextEntityProviderActionRetryTimestamp(env);
  const now = deps.getRuntimeNowMs(env);
  return (dueAt !== null && dueAt <= now) ||
    (jDueAt !== null && jDueAt <= now) ||
    (actionDueAt !== null && actionDueAt <= now);
};

export const getEarliestWallClockDueTimestamp = (env: Env, _deps: RuntimeWakeDeps): number | null => {
  const wallClockNow = getWallClockMs();
  const due = [
    getNextScheduledWakeTimestamp(env),
    getNextJSubmitRetryTimestamp(env),
    getNextEntityProviderActionRetryTimestamp(env),
  ]
    .filter((value): value is number => value !== null && value <= wallClockNow);
  return due.length > 0 ? Math.min(...due) : null;
};

export const getNextWallClockWakeTimestamp = (env: Env, _deps: RuntimeWakeDeps): number | null => {
  const due = [
    getNextScheduledWakeTimestamp(env),
    getNextJSubmitRetryTimestamp(env),
    getNextEntityProviderActionRetryTimestamp(env),
  ]
    .filter((value): value is number => value !== null);
  return due.length > 0 ? Math.min(...due) : null;
};

/**
 * Generate explicit scheduler transactions for due hooks/tasks. The marker is
 * replayed inside the signed entity frame, so proposer and validators execute
 * the same crontab transition.
 */
export const generateHookPings = (
  env: Env,
  deps: RuntimeWakeDeps,
  nowMs = deps.getRuntimeNowMs(env),
  queuedAt = env.timestamp ?? 0,
): void => {
  deps.ensureRuntimeMempool(env);
  const pings: RoutedEntityInput[] = createDueScheduledWakeInputs(env, nowMs);
  const jRetries = collectDueJSubmitRuntimeTxs(env, nowMs);
  const actionRetries = collectDueEntityProviderActionRuntimeTxs(env, nowMs);
  if (pings.length > 0) {
    deps.enqueueRuntimeInputs(env, pings, undefined, undefined, queuedAt);
  }
  if (jRetries.length > 0) {
    deps.enqueueRuntimeInputs(env, undefined, jRetries, undefined, queuedAt);
  }
  if (actionRetries.length > 0) {
    deps.enqueueRuntimeInputs(env, undefined, actionRetries, undefined, queuedAt);
  }
};
