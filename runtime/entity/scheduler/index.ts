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
 * DETERMINISM: Hooks use logical timestamps carried through runtime/entity
 * consensus. Both sides see the same hook fire at the same logical time
 * because the proposer's env.timestamp is used for the frame.
 *
 * PERSISTENCE: crontabState is part of entity state, but it stays declarative:
 * task method names, schedule data, and hook payloads. Runtime code rebinds the
 * method names to concrete handlers via a static registry.
 */

import type { AccountInput } from '../../types/account';
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
import { createStructuredLogger, shortId } from '../../infra/logger';
import { accountInputProposal, accountInputReferenceHeight } from '../../account/consensus/flush';
import { hubRebalanceHandler } from './rebalance';
import { processDueHooks } from './due-hooks';
import {
  getPendingAccountIds,
  getRebalanceAccountIds,
} from '../consensus/account/work-index';

export {
  HUB_PENDING_BROADCAST_STALE_MS,
} from './rebalance';
export {
  cancelHook,
  scheduleHook,
} from './hook-state';

const crontabLog = createStructuredLogger('entity.crontab');

// Configuration constants
export const ACCOUNT_PENDING_STALE_WARNING_MS = 30_000;
export const ACCOUNT_MAINTENANCE_INTERVAL_MS = 10_000;
export const ACCOUNT_PENDING_RESEND_AFTER_MS = 8000; // Resend pending frame input after 8s without ACK
export const HUB_REBALANCE_INTERVAL_MS = TIMING.CRONTAB_INTERVAL_MS; // Keep hub rebalance aligned with the canonical 1s runtime cadence.

const accountInputProposedFrameHeight = (input: AccountInput): number => {
  const candidate = accountInputProposal(input)?.frame.height ?? accountInputReferenceHeight(input) ?? 0;
  const height = Number(candidate);
  return Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
};

/** Emit liveness diagnostics only from the canonical post-frame state. */
export const emitCommittedPendingFrameWarnings = (
  previousState: EntityState,
  committedState: EntityState,
): void => {
  const previousRun = previousState.crontabState?.tasks.get('maintainPendingAccounts')?.lastRun;
  const committedRun = committedState.crontabState?.tasks.get('maintainPendingAccounts')?.lastRun;
  if (
    committedRun === undefined ||
    committedRun !== committedState.timestamp ||
    committedRun === previousRun
  ) return;

  for (const counterpartyId of getPendingAccountIds(committedState)) {
    const account = committedState.accounts.get(counterpartyId);
    if (!account) throw new Error(`PENDING_ACCOUNT_INDEX_STALE:${counterpartyId}`);
    const pending = account.pendingFrame;
    if (!pending) throw new Error(`PENDING_ACCOUNT_INDEX_FRAME_MISSING:${counterpartyId}`);
    const frameAge = committedState.timestamp - pending.timestamp;
    if (frameAge > ACCOUNT_PENDING_STALE_WARNING_MS) {
      console.warn(
        `⏰ PENDING-FRAME-STALE: Account with ${counterpartyId.slice(-4)} h${pending.height} for ${Math.floor(frameAge / 1000)}s — consider dispute`,
      );
    }
  }
};

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

/**
 * Initialize crontab state for an entity
 */
export function initCrontab(): CrontabState {
  return {
    tasks: new Map<CrontabTaskMethod, CrontabTaskState>([
      ['maintainPendingAccounts', createTaskState('maintainPendingAccounts', ACCOUNT_MAINTENANCE_INTERVAL_MS)],
      ['hubRebalance', createTaskState('hubRebalance', HUB_REBALANCE_INTERVAL_MS)],
    ]),
    hooks: new Map(),
  };
}

const accountNeedsMaintenance = (state: EntityState): boolean =>
  getPendingAccountIds(state).size > 0;

/** Only schedule periodic consensus work when its handler can change state or emit output. */
export const crontabTaskHasPendingWork = (
  state: EntityState,
  method: CrontabTaskMethod,
): boolean => {
  if (method === 'maintainPendingAccounts') return accountNeedsMaintenance(state);
  if (!state.hubRebalanceConfig) return false;
  if (state.jBatchState?.sentBatch) return true;
  return getRebalanceAccountIds(state).size > 0;
};

const CRONTAB_TASK_HANDLERS: Record<CrontabTaskMethod, CrontabTaskHandler> = {
  maintainPendingAccounts: maintainPendingAccounts,
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

  // ── 1. Process scheduled hooks (setTimeout-like, fires once) ──
  if (crontabState.hooks && crontabState.hooks.size > 0) {
    const dueHooks: ScheduledHook[] = [];
    for (const [id, hook] of crontabState.hooks) {
      if (hook.triggerAt <= now) {
        dueHooks.push(hook);
        crontabState.hooks.delete(id); // One-shot: remove after firing
      }
    }

    if (dueHooks.length > 0) {
      // Map insertion order is not scheduling priority. Deterministically pick
      // the oldest hook, then its stable id, so same-tick dispute deadlines
      // cannot depend on historical insertion order.
      dueHooks.sort((left, right) =>
        left.triggerAt - right.triggerAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      );
      crontabLog.debug('hooks.fired', { entity: shortId(replica.entityId), count: dueHooks.length, timestamp: now });
      const hookOutputs = await processDueHooks(env, dueHooks, replica, context);
      allOutputs.push(...hookOutputs);
    }
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

/**
 * Resend the exact signed proposal; a Hanko-backed Account frame never expires.
 *
 * Do not add a local timeout rollback here. Once the signature leaves this
 * replica, the peer may accept or submit it later. Liveness comes from exact
 * resend and, ultimately, the dispute protocol. Same-height collision rollback
 * belongs exclusively to Account consensus, where the fixed LEFT winner does
 * not depend on arrival time. Depository separately enforces canonical pair
 * identity and strictly increasing dispute nonces.
 */
async function maintainPendingAccounts(
  _env: EntityRuntimeContext,
  replica: EntityTransitionContext,
  _task: CrontabTaskState,
  _context: CrontabExecutionContext,
): Promise<EntityOutput[]> {
  const outputs: EntityOutput[] = [];
  const now = replica.state.timestamp; // DETERMINISTIC: Use entity's own timestamp

  for (const counterpartyId of getPendingAccountIds(replica.state)) {
    const account = replica.state.accounts.get(counterpartyId);
    if (!account) throw new Error(`PENDING_ACCOUNT_INDEX_STALE:${counterpartyId}`);
    if (!account.pendingFrame) {
      throw new Error(`PENDING_ACCOUNT_INDEX_FRAME_MISSING:${counterpartyId}`);
    }
    const frameAge = now - account.pendingFrame.timestamp;
    const cachedInputHeight = account.pendingAccountInput
      ? accountInputProposedFrameHeight(account.pendingAccountInput)
      : 0;
    if (
      frameAge <= ACCOUNT_PENDING_RESEND_AFTER_MS ||
      !account.pendingAccountInput ||
      cachedInputHeight !== account.pendingFrame.height
    ) continue;

    outputs.push({
      entityId: account.pendingAccountInput.toEntityId,
      entityTxs: [{ type: 'accountInput', data: account.pendingAccountInput }],
    });
    crontabLog.debug('pending_frame.resend', {
      account: shortId(counterpartyId),
      height: account.pendingFrame.height,
      ageSeconds: Math.floor(frameAge / 1000),
    });
  }

  return outputs;
}
