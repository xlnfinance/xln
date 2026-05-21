import { buildRouteOutputKey } from './runtime-output-routing';
import type { Env, EntityReplica, JInput, RoutedEntityInput, RuntimeInput, RuntimeTx } from './types';
import { getWallClockMs } from './utils';

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
export const entityNeedsPeriodicWake = (replica: EntityReplica): boolean => {
  const state = replica?.state;
  if (!state) return false;

  for (const accountMachine of state.accounts.values()) {
    const settlementWorkspace = accountMachine.settlementWorkspace;
    if (settlementWorkspace && settlementWorkspace.status !== 'submitted') {
      const iAmLeft = state.entityId === accountMachine.leftEntity;
      const counterpartyHanko = iAmLeft ? settlementWorkspace.rightHanko : settlementWorkspace.leftHanko;
      if (counterpartyHanko) return true;
    }

    if (accountMachine.activeDispute) return true;
    if (accountMachine.pendingFrame || accountMachine.pendingAccountInput) return true;
  }

  if (!state.hubRebalanceConfig) return false;
  if (state.jBatchState?.sentBatch) return true;

  for (const accountMachine of state.accounts.values()) {
    if ((accountMachine.requestedRebalance?.size ?? 0) > 0) return true;
    if ((accountMachine.requestedRebalanceFeeState?.size ?? 0) > 0) return true;
  }

  return false;
};

export const hasDueEntityHooks = (env: Env, deps: RuntimeWakeDeps): boolean => {
  if (!env.eReplicas || env.eReplicas.size === 0) return false;
  if (!deps.ensureRuntimeState(env).clockPrimed && !env.scenarioMode) return false;
  const nowMs = deps.getRuntimeNowMs(env);
  for (const [, replica] of env.eReplicas) {
    const crontab = replica.state?.crontabState;
    if (!crontab) continue;
    const hooks = crontab.hooks;
    if (hooks && hooks.size > 0) {
      for (const hook of hooks.values()) {
        if (hook.triggerAt <= nowMs) return true;
      }
    }
    if (entityNeedsPeriodicWake(replica)) {
      const tasks = crontab.tasks;
      if (tasks && tasks.size > 0) {
        for (const task of tasks.values()) {
          if (nowMs - task.lastRun >= task.intervalMs) return true;
        }
      }
    }
  }
  return false;
};

export const getEarliestWallClockDueTimestamp = (env: Env, deps: RuntimeWakeDeps): number | null => {
  if (!deps.ensureRuntimeState(env).clockPrimed && !env.scenarioMode) return null;
  const logicalNow = deps.getRuntimeNowMs(env);
  const wallClockNow = getWallClockMs();
  let earliestDue = Infinity;

  if (env.pendingNetworkOutputs && env.pendingNetworkOutputs.length > 0) {
    const deferredMeta = deps.ensureRuntimeState(env).deferredNetworkMeta;
    for (const output of env.pendingNetworkOutputs) {
      const retryAt = deferredMeta?.get(buildRouteOutputKey(output))?.nextRetryAt ?? 0;
      if (retryAt > logicalNow && retryAt <= wallClockNow) {
        earliestDue = Math.min(earliestDue, retryAt);
      }
    }
  }

  if (!env.eReplicas || env.eReplicas.size === 0) {
    return Number.isFinite(earliestDue) ? earliestDue : null;
  }

  for (const [, replica] of env.eReplicas) {
    const crontab = replica.state?.crontabState;
    if (!crontab) continue;

    const hooks = crontab.hooks;
    if (hooks && hooks.size > 0) {
      for (const hook of hooks.values()) {
        if (hook.triggerAt > logicalNow && hook.triggerAt <= wallClockNow) {
          earliestDue = Math.min(earliestDue, hook.triggerAt);
        }
      }
    }

    if (entityNeedsPeriodicWake(replica)) {
      const tasks = crontab.tasks;
      if (tasks && tasks.size > 0) {
        for (const task of tasks.values()) {
          const dueAt = task.lastRun + task.intervalMs;
          if (dueAt > logicalNow && dueAt <= wallClockNow) {
            earliestDue = Math.min(earliestDue, dueAt);
          }
        }
      }
    }
  }

  return Number.isFinite(earliestDue) ? earliestDue : null;
};

export const getNextWallClockWakeTimestamp = (env: Env, deps: RuntimeWakeDeps): number | null => {
  if (!deps.ensureRuntimeState(env).clockPrimed && !env.scenarioMode) return null;
  const logicalNow = deps.getRuntimeNowMs(env);
  let nextWake = Infinity;

  if (env.pendingNetworkOutputs && env.pendingNetworkOutputs.length > 0) {
    const deferredMeta = deps.ensureRuntimeState(env).deferredNetworkMeta;
    for (const output of env.pendingNetworkOutputs) {
      const retryAt = deferredMeta?.get(buildRouteOutputKey(output))?.nextRetryAt ?? 0;
      if (retryAt > logicalNow) {
        nextWake = Math.min(nextWake, retryAt);
      }
    }
  }

  if (!env.eReplicas || env.eReplicas.size === 0) {
    return Number.isFinite(nextWake) ? nextWake : null;
  }

  for (const [, replica] of env.eReplicas) {
    const crontab = replica.state?.crontabState;
    if (!crontab) continue;

    const hooks = crontab.hooks;
    if (hooks && hooks.size > 0) {
      for (const hook of hooks.values()) {
        if (hook.triggerAt > logicalNow) {
          nextWake = Math.min(nextWake, hook.triggerAt);
        }
      }
    }

    if (entityNeedsPeriodicWake(replica)) {
      const tasks = crontab.tasks;
      if (tasks && tasks.size > 0) {
        for (const task of tasks.values()) {
          const dueAt = task.lastRun + task.intervalMs;
          if (dueAt > logicalNow) {
            nextWake = Math.min(nextWake, dueAt);
          }
        }
      }
    }
  }

  return Number.isFinite(nextWake) ? nextWake : null;
};

/**
 * Generate empty entity inputs for due hooks/tasks. These pings are the bridge
 * between wall-clock scheduling and deterministic entity crontab execution.
 */
export const generateHookPings = (
  env: Env,
  deps: RuntimeWakeDeps,
  nowMs = deps.getRuntimeNowMs(env),
  queuedAt = env.timestamp ?? 0,
): void => {
  if (!env.eReplicas || env.eReplicas.size === 0) return;
  if (!deps.ensureRuntimeState(env).clockPrimed && !env.scenarioMode) return;
  const mempool = deps.ensureRuntimeMempool(env);
  const pings: RoutedEntityInput[] = [];

  for (const [key, replica] of env.eReplicas) {
    const crontab = replica.state?.crontabState;
    if (!crontab) continue;

    let hasDue = false;
    const hooks = crontab.hooks;
    if (hooks && hooks.size > 0) {
      for (const hook of hooks.values()) {
        if (hook.triggerAt <= nowMs) {
          hasDue = true;
          break;
        }
      }
    }
    if (!hasDue && entityNeedsPeriodicWake(replica)) {
      const tasks = crontab.tasks;
      if (tasks && tasks.size > 0) {
        for (const task of tasks.values()) {
          if (nowMs - task.lastRun >= task.intervalMs) {
            hasDue = true;
            break;
          }
        }
      }
    }
    if (!hasDue) continue;

    const entityId = replica.entityId || String(key).split(':')[0];
    const signerId = replica.state?.config?.validators?.[0] || String(key).split(':')[1];
    if (!entityId || !signerId) continue;

    const alreadyQueued = mempool.entityInputs.some(ei => ei.entityId === entityId);
    if (alreadyQueued) continue;

    pings.push({ entityId, signerId, entityTxs: [] });
  }

  if (pings.length > 0) {
    deps.enqueueRuntimeInputs(env, pings, undefined, undefined, queuedAt);
  }
};
