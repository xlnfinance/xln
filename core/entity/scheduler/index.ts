/**
 * Entity Crontab System
 *
 * Two mechanisms for scheduling work inside entity consensus:
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 1. PERIODIC TASKS (setInterval-like)
 *    Run a function every N milliseconds. For continuous monitoring:
 *    account timeouts, batch broadcasts, rebalancing, HTLC polling.
 *
 * 2. SCHEDULED HOOKS (setTimeout-like)
 *    Fire once at a specific logical entity/runtime time. For point-in-time events:
 *    HTLC lock expiry, dispute deadlines, settlement windows.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * SCHEDULED HOOKS — How to use:
 *
 *   // Schedule: "wake this entity at time T to run security check"
 *   scheduleHook(crontabState, {
 *     id: `htlc-timeout:${lockId}`,   // Unique — prevents duplicates
 *     triggerAt: Number(lock.timelock), // Logical unix-ms carried by proposer timestamp
 *     type: 'htlc_timeout',            // Routes to correct handler
 *     data: { accountId, lockId }       // Payload for the handler
 *   });
 *
 *   // Cancel: "lock resolved early, no need to fire"
 *   cancelHook(crontabState, `htlc-timeout:${lockId}`);
 *
 * WHY HOOKS EXIST:
 *   Entities only process crontab during applyEntityInput(). If an entity
 *   is idle (no messages, no payments), periodic tasks never run. Hooks
 *   solve this: the runtime scheduled-wake scanner tracks the next deadline
 *   and injects a ping entityInput to wake the entity at the right time.
 *
 * HOOK TYPES & SECURITY APPLICATIONS:
 *   'htlc_timeout'      — Auto-resolve expired HTLC locks (prevents fund lockup)
 *   'dispute_deadline'   — Auto-finalize disputes after challenge period
 *   'settlement_window'  — Auto-execute approved settlements
 *   'watchdog'           — Detect unresponsive counterparties
 *
 * DETERMINISM: Hooks use logical timestamps carried through core/entity
 * consensus. Both sides see the same hook fire at the same logical time
 * because the proposer's env.timestamp is used for the frame.
 *
 * PERSISTENCE: crontabState is part of entity state, but it stays declarative:
 * task method names, schedule data, and hook payloads. Runtime code rebinds the
 * method names to concrete handlers via a static registry.
 */

import type { EntityOutput, EntityState } from '../types';
import type { EntityRuntimeContext } from '../runtime-context';
import type {
  CrontabExecutionContext,
  EntityTransitionContext,
  CrontabState,
  CrontabTaskMethod,
  CrontabTaskState,
  ScheduledHook,
} from './types';
import { TIMING } from '../../config/constants';
import { createStructuredLogger, shortId } from '../../support/logger';
import { hubRebalanceHandler } from './rebalance';
import { processDueHooks } from './due-hooks';
import { collectDerivedDeadlines, compareDeadlines, type DerivedDeadline } from './derived-deadlines';
import { getRebalanceAccountIds } from '../consensus/account/work-index';
import { PersistentEntityCollectionMap } from '../state/persistent-collection-map';
import { cancelHook } from './hook-state';

export {
  HUB_PENDING_BROADCAST_STALE_MS,
} from './rebalance';
export {
  cancelHook,
  scheduleHook,
} from './hook-state';
const crontabLog = createStructuredLogger('entity.crontab');

export const HUB_REBALANCE_INTERVAL_MS = TIMING.CRONTAB_INTERVAL_MS; // Keep hub rebalance aligned with the canonical 1s runtime cadence.

type CrontabTaskHandler = (
  env: EntityRuntimeContext,
  replica: EntityTransitionContext,
  task: CrontabTaskState,
  context: CrontabExecutionContext,
) => Promise<EntityOutput[]>;

const createTaskState = (
  method: CrontabTaskMethod,
  intervalMs: number,
  params: Record<string, string | number | boolean> = {},
): CrontabTaskState => ({
  method,
  intervalMs,
  lastRun: 0,
  enabled: true,
  params,
});

export const crontabTaskDueAt = (
  task: Pick<CrontabTaskState, 'method' | 'intervalMs' | 'lastRun'>,
): number => task.lastRun + task.intervalMs;

/**
 * Initialize crontab state for an entity
 */
export function initCrontab(): CrontabState {
  return {
    tasks: new Map<CrontabTaskMethod, CrontabTaskState>([
      ['hubRebalance', createTaskState('hubRebalance', HUB_REBALANCE_INTERVAL_MS)],
    ]),
    // Hooks are a growing consensus index. Keep the committed empty Patricia
    // root from genesis so the first checkpoint never has to discover or
    // rebuild a flat collection.
    hooks: PersistentEntityCollectionMap.empty<ScheduledHook>(),
  };
}

/** Only schedule periodic consensus work when its handler can change state or emit output. */
export const crontabTaskHasPendingWork = (
  state: EntityState,
  method: CrontabTaskMethod,
): boolean => {
  void method;
  if (!state.hubRebalanceConfig) return false;
  if (state.jBatchState?.sentBatch) return true;
  return getRebalanceAccountIds(state).size > 0;
};

const CRONTAB_TASK_HANDLERS: Record<CrontabTaskMethod, CrontabTaskHandler> = {
  hubRebalance: hubRebalanceHandler,
};

/**
 * Execute all due crontab tasks
 * Called during entity input processing
 * Uses entity-specific timestamp for determinism (each entity has own clock from frames)
 */
export async function executeCrontab(
  env: EntityRuntimeContext,
  replica: EntityTransitionContext,
  crontabState: CrontabState,
  context: CrontabExecutionContext,
): Promise<EntityOutput[]> {
  const now = replica.state.timestamp; // DETERMINISTIC: Use entity's own timestamp
  const allOutputs: EntityOutput[] = [];

  // ── 1. Scheduled hooks (setTimeout-like, fires once) plus the deadlines
  // derived from Account locks and paybook entries, drained together in
  // (triggerAt, id) order so same-tick deadlines never depend on how they
  // were recorded.
  const dueHooks: Array<ScheduledHook | DerivedDeadline> = collectDerivedDeadlines(replica.state, now);
  if (crontabState.hooks && crontabState.hooks.size > 0) {
    for (const [id, hook] of crontabState.hooks) {
      if (hook.triggerAt <= now) {
        dueHooks.push(hook);
        cancelHook(crontabState, id); // One-shot: remove after firing
      }
    }
  }
  if (dueHooks.length > 0) {
    dueHooks.sort(compareDeadlines);
    crontabLog.debug('hooks.fired', { entity: shortId(replica.entityId), count: dueHooks.length, timestamp: now });
    const hookOutputs = await processDueHooks(env, dueHooks, replica, context);
    allOutputs.push(...hookOutputs);
  }

  // ── 2. Process periodic tasks (setInterval-like, fires repeatedly) ──
  for (const task of crontabState.tasks.values()) {
    if (!task.enabled) continue;
    const timeSinceLastRun = now - task.lastRun;

    if (timeSinceLastRun >= task.intervalMs) {
      const handler = CRONTAB_TASK_HANDLERS[task.method];
      if (!handler) throw new Error(`Unknown crontab task method: ${task.method}`);
      const outputs = await handler(env, replica, task, context);
      allOutputs.push(...outputs);
      task.lastRun = now;
      if (outputs.length > 0) {
        crontabLog.debug('task.outputs', { method: task.method, outputs: outputs.length });
      }
    }
  }

  return allOutputs;
}
