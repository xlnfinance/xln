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
 *   solve this: the runtime loop checks getEarliestHookTime() and injects
 *   a ping entityInput to wake the entity at the right time.
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

import type {
  AccountInput,
  EntityInput,
  EntityReplica,
  RuntimeState,
} from '../types';
import type {
  CrontabExecutionContext,
  CrontabState,
  CrontabTaskMethod,
  CrontabTaskState,
  ScheduledHook,
} from './scheduler-types';
import { isLeftEntity } from './id';
import { deriveDelta } from '../account/utils';
import { isHtlcTimelockExpired } from '../account/htlc-deadline';
import { TIMING } from '../constants';
import {
  getDefaultRebalancePolicyForToken,
} from '../account/rebalance-defaults';
import { getEntityCertifiedJurisdictionHeight } from '../jurisdiction/height';
import { createStructuredLogger, shortId } from '../infra/logger';
import { accountInputProposal, accountInputReferenceHeight } from '../account/consensus/flush';
import { hasPendingSettlementTransition } from '../account/tx/handlers/settle-transition';
import { hubRebalanceHandler } from './scheduler/rebalance';
import { processDueHooks } from './scheduler/due-hooks';

export {
  HUB_MAX_C2R_PER_TICK,
  HUB_MAX_R2C_PER_TICK,
  HUB_PENDING_BROADCAST_STALE_MS,
  HUB_SUBMITTED_REQUEST_STALE_MS,
} from './scheduler/rebalance';
export {
  cancelHook,
  getEarliestHookTime,
  scheduleHook,
} from './scheduler/hook-state';

const crontabLog = createStructuredLogger('entity.crontab');

// Configuration constants
export const ACCOUNT_TIMEOUT_MS = 30000; // 30 seconds (configurable)
export const HTLC_SECRET_ACK_TIMEOUT_MS = 30000; // auto-dispute if secret-return ACK missing
export const ACCOUNT_TIMEOUT_CHECK_INTERVAL_MS = 10000; // Check every 10 seconds
export const ACCOUNT_PENDING_RESEND_AFTER_MS = 8000; // Resend pending frame input after 8s without ACK
export const HUB_REBALANCE_INTERVAL_MS = TIMING.CRONTAB_INTERVAL_MS; // Keep hub rebalance aligned with the canonical 1s runtime cadence.

const accountInputProposedFrameHeight = (input: AccountInput): number => {
  const candidate = accountInputProposal(input)?.frame.height ?? accountInputReferenceHeight(input) ?? 0;
  const height = Number(candidate);
  return Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
};

/** Emit liveness diagnostics only from the canonical post-frame state. */
export const emitCommittedPendingFrameWarnings = (
  previousState: EntityReplica['state'],
  committedState: EntityReplica['state'],
): void => {
  const previousRun = previousState.crontabState?.tasks.get('checkAccountTimeouts')?.lastRun;
  const committedRun = committedState.crontabState?.tasks.get('checkAccountTimeouts')?.lastRun;
  if (
    committedRun === undefined ||
    committedRun !== committedState.timestamp ||
    committedRun === previousRun
  ) return;

  for (const [counterpartyId, account] of committedState.accounts) {
    const pending = account.pendingFrame;
    if (!pending) continue;
    const hasExpiredHtlc = pending.accountTxs.some(tx => tx.type === 'htlc_lock' && (
      (getEntityCertifiedJurisdictionHeight(committedState) > 0 &&
        getEntityCertifiedJurisdictionHeight(committedState) > tx.data.revealBeforeHeight) ||
      isHtlcTimelockExpired(committedState.timestamp, tx.data.timelock)
    ));
    const frameAge = committedState.timestamp - pending.timestamp;
    if (!hasExpiredHtlc && frameAge > ACCOUNT_TIMEOUT_MS) {
      console.warn(
        `⏰ PENDING-FRAME-STALE: Account with ${counterpartyId.slice(-4)} h${pending.height} for ${Math.floor(frameAge / 1000)}s — consider dispute`,
      );
    }
  }
};

type CrontabTaskHandler = (
  env: RuntimeState,
  replica: EntityReplica,
  task: CrontabTaskState,
  context: CrontabExecutionContext,
) => Promise<EntityInput[]>;

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
      ['checkAccountTimeouts', createTaskState('checkAccountTimeouts', ACCOUNT_TIMEOUT_CHECK_INTERVAL_MS)],
      ['hubRebalance', createTaskState('hubRebalance', HUB_REBALANCE_INTERVAL_MS)],
    ]),
    hooks: new Map(),
  };
}

const accountNeedsTimeoutTask = (state: EntityReplica['state']): boolean =>
  [...state.accounts.values()].some(account => Boolean(account.pendingFrame));

const accountNeedsHubRebalanceTask = (
  state: EntityReplica['state'],
  counterpartyId: string,
): boolean => {
  const account = state.accounts.get(counterpartyId);
  if (!account) return false;
  if ([...account.requestedRebalance.values()].some(amount => amount > 0n)) return true;
  if (account.pendingFrame || hasPendingSettlementTransition(account)) return false;

  const workspace = account.settlementWorkspace;
  const hubIsLeft = isLeftEntity(state.entityId, counterpartyId);
  if (
    workspace?.status === 'ready_to_submit' &&
    workspace.lastModifiedByLeft === hubIsLeft &&
    workspace.executorIsLeft === hubIsLeft &&
    workspace.ops.length > 0 &&
    workspace.ops.every(op => op.type === 'c2r') &&
    Boolean(hubIsLeft ? workspace.rightHanko : workspace.leftHanko)
  ) return true;
  if (workspace) return false;

  for (const [tokenId, delta] of account.deltas) {
    if ((account.requestedRebalance.get(tokenId) ?? 0n) > 0n) continue;
    const hubDerived = deriveDelta(delta, hubIsLeft);
    const outHold = hubDerived.outTotalHold;
    if (outHold === undefined) {
      throw new Error(`deriveDelta missing outTotalHold for token ${String(tokenId)} on ${counterpartyId}`);
    }
    const freeOutCollateral = hubDerived.outCollateral > outHold
      ? hubDerived.outCollateral - outHold
      : 0n;
    if (freeOutCollateral > getDefaultRebalancePolicyForToken(tokenId).r2cRequestSoftLimit) return true;
  }
  return false;
};

/** Only schedule periodic consensus work when its handler can change state or emit output. */
export const crontabTaskHasPendingWork = (
  state: EntityReplica['state'],
  method: CrontabTaskMethod,
): boolean => {
  if (method === 'checkAccountTimeouts') return accountNeedsTimeoutTask(state);
  if (!state.hubRebalanceConfig) return false;
  if (state.jBatchState?.sentBatch) return true;
  for (const counterpartyId of state.accounts.keys()) {
    if (accountNeedsHubRebalanceTask(state, counterpartyId)) return true;
  }
  return false;
};

const CRONTAB_TASK_HANDLERS: Record<CrontabTaskMethod, CrontabTaskHandler> = {
  checkAccountTimeouts: checkAccountTimeoutsHandler,
  hubRebalance: hubRebalanceHandler,
};

/**
 * Execute all due crontab tasks
 * Called during entity input processing
 * Uses entity-specific timestamp for determinism (each entity has own clock from frames)
 */
export async function executeCrontab(
  env: RuntimeState,
  replica: EntityReplica,
  crontabState: CrontabState,
  context: CrontabExecutionContext,
): Promise<EntityInput[]> {
  const now = replica.state.timestamp; // DETERMINISTIC: Use entity's own timestamp
  const allOutputs: EntityInput[] = [];

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
 * Check all accounts for timeout and suggest disputes
 *
 * Pattern from 2019src.txt lines 1622-1675:
 * - Iterate over all accounts
 * - Check missed_ack time
 * - If > threshold, suggest dispute to entity members
 */
async function checkAccountTimeoutsHandler(
  _env: RuntimeState,
  replica: EntityReplica,
  _task: CrontabTaskState,
  _context: CrontabExecutionContext,
): Promise<EntityInput[]> {
  const outputs: EntityInput[] = [];
  const now = replica.state.timestamp; // DETERMINISTIC: Use entity's own timestamp
  const currentHeight = getEntityCertifiedJurisdictionHeight(replica.state);
  const firstValidator = replica.state.config.validators?.[0];

  // Collect accounts with expired HTLC locks in their pending frames
  const timedOutAccounts: Array<{ counterpartyId: string; frameHeight: number }> = [];

  for (const [counterpartyId, account] of replica.state.accounts.entries()) {
    if (!account.pendingFrame) continue;

    // Check if any htlc_lock in the pending frame has expired
    // Cancel ONLY when hashlock expires — until then, counterparty could still claim
    let hasExpiredHtlc = false;
    for (const tx of account.pendingFrame.accountTxs) {
      if (tx.type === 'htlc_lock') {
        const heightExpired = currentHeight > 0 && currentHeight > tx.data.revealBeforeHeight;
        const timestampExpired = isHtlcTimelockExpired(now, tx.data.timelock);
        if (heightExpired || timestampExpired) {
          console.warn(
            `⏰ HTLC-IN-PENDING-EXPIRED: Account ${counterpartyId.slice(-4)} frame h${account.pendingFrame.height}, lock ${tx.data.lockId.slice(0, 12)}... expired`,
          );
          hasExpiredHtlc = true;
          break;
        }
      }
    }

    if (hasExpiredHtlc) {
      timedOutAccounts.push({
        counterpartyId,
        frameHeight: account.pendingFrame.height,
      });
    } else {
      const frameAge = now - account.pendingFrame.timestamp;

      // ACK may be lost on relay reconnect. Safe resend of the exact cached input
      // unblocks bilateral consensus without mutating account shared state.
      const cachedInputHeight = account.pendingAccountInput
        ? accountInputProposedFrameHeight(account.pendingAccountInput)
        : 0;
      if (
        frameAge > ACCOUNT_PENDING_RESEND_AFTER_MS &&
        account.pendingAccountInput &&
        cachedInputHeight === account.pendingFrame.height
      ) {
        const targetSignerId = account.pendingAccountInputSignerId;
        if (!targetSignerId) {
          throw new Error(
            `ACCOUNT_PENDING_INPUT_SIGNER_MISSING: entity=${replica.entityId}` +
            ` counterparty=${account.pendingAccountInput.toEntityId}` +
            ` height=${account.pendingFrame.height}`,
          );
        }
        outputs.push({
          entityId: account.pendingAccountInput.toEntityId,
          signerId: targetSignerId,
          entityTxs: [
            {
              type: 'accountInput',
              data: account.pendingAccountInput,
            },
          ],
        });
        crontabLog.debug('pending_frame.resend', {
          account: shortId(counterpartyId),
          height: account.pendingFrame.height,
          ageSeconds: Math.floor(frameAge / 1000),
        });
      }

      // Non-HTLC pending frames: dispute suggestion after 30s
      // Observability is emitted only after this Entity frame commits. A valid
      // ACK later in the same frame must clear the pending state before a
      // liveness warning is evaluated.
    }
  }

  // Generate rollback EntityTx for accounts with expired HTLC locks in pending frames
  if (timedOutAccounts.length > 0) {
    if (firstValidator) {
      outputs.push({
        entityId: replica.entityId,
        signerId: firstValidator,
        entityTxs: [
          {
            type: 'rollbackTimedOutFrames',
            data: { timedOutAccounts },
          },
        ],
      });
      console.warn(
        `⏰ ROLLBACK: Generated rollbackTimedOutFrames for ${timedOutAccounts.length} accounts (HTLC expired in pendingFrame)`,
      );
    }
  }

  return outputs;
}
