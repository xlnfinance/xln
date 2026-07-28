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
  Env,
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
import { terminateHtlcRoute } from './tx/htlc-route-lifecycle';
import { getEntityCertifiedJurisdictionHeight } from '../jurisdiction/height';
import { createStructuredLogger, shortHash, shortId } from '../infra/logger';
import { accountInputProposal, accountInputReferenceHeight } from '../account/consensus/flush';
import { hasPendingSettlementTransition } from '../account/tx/handlers/settle-transition';
import {
  applyBoardRotationResealMigrations,
  BOARD_RESEAL_HOOK_ID,
  BOARD_RESEAL_RETRY_MS,
  buildPendingBoardRotationResealDrafts,
} from './tx/board-rotation-reseal';
import { hubRebalanceHandler } from './scheduler/rebalance';

export {
  HUB_MAX_C2R_PER_TICK,
  HUB_MAX_R2C_PER_TICK,
  HUB_PENDING_BROADCAST_STALE_MS,
  HUB_SUBMITTED_REQUEST_STALE_MS,
} from './scheduler/rebalance';

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
  env: Env,
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

// ═══════════════════════════════════════════════════════════════════════
// Scheduled Hooks API (setTimeout-like)
// ═══════════════════════════════════════════════════════════════════════

/** Schedule a one-shot hook at a specific logical timestamp */
export function scheduleHook(state: CrontabState, hook: ScheduledHook): void {
  if (!state.hooks) state.hooks = new Map();
  state.hooks.set(hook.id, hook);
  crontabLog.debug('hook.scheduled', { type: hook.type, id: shortHash(hook.id), triggerAt: hook.triggerAt });
}

/** Cancel a previously scheduled hook (e.g., lock resolved before timeout) */
export function cancelHook(state: CrontabState, hookId: string): void {
  if (!state.hooks) return;
  if (state.hooks.delete(hookId)) {
    crontabLog.debug('hook.cancelled', { id: shortHash(hookId) });
  }
}

/**
 * Get the earliest hook trigger time across all hooks.
 * Returns Infinity if no hooks are scheduled.
 * Used by the runtime loop to know when to wake this entity.
 */
export function getEarliestHookTime(state: CrontabState): number {
  if (!state.hooks || state.hooks.size === 0) return Infinity;
  let earliest = Infinity;
  for (const hook of state.hooks.values()) {
    if (hook.triggerAt < earliest) earliest = hook.triggerAt;
  }
  return earliest;
}

/**
 * Execute all due crontab tasks
 * Called during entity input processing
 * Uses entity-specific timestamp for determinism (each entity has own clock from frames)
 */
export async function executeCrontab(
  env: Env,
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
 * Process fired hooks → generate entityTxs by hook type.
 * Each hook type maps to a specific security/protocol action.
 */
async function processDueHooks(
  env: Env,
  hooks: ScheduledHook[],
  replica: EntityReplica,
  context: CrontabExecutionContext,
): Promise<EntityInput[]> {
  const outputs: EntityInput[] = [];
  const firstValidator = replica.state.config.validators?.[0];
  if (!firstValidator) return outputs;

  // Group expired locks by type for batch processing
  const htlcTimeoutLocks: Array<{ accountId: string; lockId: string }> = [];
  const disputePrepareCounterparties = new Set<string>();
  const disputeFinalizeCounterparties = new Set<string>();
  let shouldBroadcastQueuedDisputeFinalizations = false;

  const currentJBlock = getEntityCertifiedJurisdictionHeight(replica.state);

  for (const hook of hooks) {
    crontabLog.debug('hook.fired', { type: hook.type, id: shortHash(hook.id) });

    switch (hook.type) {
      case 'htlc_timeout':
        // HTLC lock expired → resolve with error:timeout
        {
          const { accountId, lockId } = hook.data;
          const account = replica.state.accounts.get(accountId);
          // Stale hook (already resolved/cancelled path) — skip silently.
          if (!account?.locks?.has(lockId)) {
            break;
          }
          htlcTimeoutLocks.push({ accountId, lockId });
        }
        break;

      case 'dispute_deadline':
        {
          const { accountId } = hook.data;
          const account = replica.state.accounts.get(accountId);
          if (!account?.activeDispute) break;
          if (replica.state.hubRebalanceConfig?.disputeAutoFinalizeMode === 'ignore') {
            break;
          }
          const weAreLeft = account.leftEntity === replica.state.entityId;
          const weAreStarter = weAreLeft === account.activeDispute.startedByLeft;

          const timeoutBlock = Number(account.activeDispute.disputeTimeout || 0);
          if (account.activeDispute.observedOnChain !== true) {
            const retryMs = 5000;
            if (replica.state.crontabState) {
              scheduleHook(replica.state.crontabState, {
                id: hook.id,
                triggerAt: replica.state.timestamp + retryMs,
                type: 'dispute_deadline',
                data: { accountId },
              });
            }
            crontabLog.debug('dispute.wait_onchain_start', {
              account: shortId(accountId),
              retryMs,
            });
            break;
          }

          if (weAreStarter && (!timeoutBlock || currentJBlock < timeoutBlock)) {
            const retryMs = 1000;
            if (replica.state.crontabState) {
              scheduleHook(replica.state.crontabState, {
                id: hook.id,
                triggerAt: replica.state.timestamp + retryMs,
                type: 'dispute_deadline',
                data: { accountId },
              });
            }
            crontabLog.debug('dispute.retry_until_timeout', {
              account: shortId(accountId),
              currentJBlock,
              timeoutBlock,
              retryMs,
            });
            break;
          }

          const accountIdNorm = accountId.toLowerCase();
          const draftFinalizations = replica.state.jBatchState?.batch?.disputeFinalizations || [];
          const sentFinalizations = replica.state.jBatchState?.sentBatch?.batch?.disputeFinalizations || [];
          const draftHasFinalize = draftFinalizations.some(
            (entry) => String(entry?.counterentity || '').toLowerCase() === accountIdNorm,
          );
          const sentHasFinalize = sentFinalizations.some(
            (entry) => String(entry?.counterentity || '').toLowerCase() === accountIdNorm,
          );

          if (sentHasFinalize || replica.state.jBatchState?.sentBatch) {
            account.activeDispute.finalizeQueued = sentHasFinalize || (account.activeDispute.finalizeQueued ?? false);
            context.accountChanges.add(accountId);
            const retryMs = 1000;
            if (replica.state.crontabState) {
              scheduleHook(replica.state.crontabState, {
                id: hook.id,
                triggerAt: replica.state.timestamp + retryMs,
                type: 'dispute_deadline',
                data: { accountId },
              });
            }
            crontabLog.debug('dispute.deferred_sent_batch', { account: shortId(accountId), retryMs });
            break;
          }

          if (draftHasFinalize) {
            account.activeDispute.finalizeQueued = true;
            context.accountChanges.add(accountId);
            shouldBroadcastQueuedDisputeFinalizations = true;
            break;
          }

          if (account.activeDispute.finalizeQueued) {
            // Recover from stale local latch (e.g. after abort/drop of previous finalize batch).
            account.activeDispute.finalizeQueued = false;
            context.accountChanges.add(accountId);
          }

          disputeFinalizeCounterparties.add(accountId);
        }
        break;

      case 'htlc_secret_ack_timeout':
        {
          const { hashlock, counterpartyEntityId, inboundLockId } = hook.data;

          const route = replica.state.htlcRoutes.get(hashlock);
          if (!route?.secretAckPending) break;

          const account = replica.state.accounts.get(counterpartyEntityId);
          if (!account) break;

          // ACK already finalized (lock removed) — clear latch and skip.
          if (inboundLockId && !account.locks?.has(inboundLockId)) {
            terminateHtlcRoute(replica.state, hashlock, replica.state.timestamp);
            break;
          }

          // Dispute already active — nothing else to queue.
          if (account.activeDispute) break;

          disputePrepareCounterparties.add(counterpartyEntityId);
          crontabLog.warn('htlc_secret_ack_timeout', {
            counterparty: shortId(counterpartyEntityId),
            hashlock: shortHash(hashlock),
          });
        }
        break;

      case 'settlement_window':
        // Future: auto-execute settlement after approval window
        crontabLog.debug('hook.unimplemented', { type: hook.type });
        break;

      case 'watchdog':
        // Future: detect unresponsive counterparty
        crontabLog.debug('hook.unimplemented', { type: hook.type });
        break;

      case 'hub_rebalance_kick':
        // Force next global hub rebalance pass (across all accounts) on this entity.
        // This is a wake-up hint, not a per-account rebalance decision.
        {
          const task = replica.state.crontabState?.tasks?.get('hubRebalance');
          if (task) {
            task.lastRun = 0;
            crontabLog.debug('hub_rebalance.kick');
          }
        }
        break;

      case 'board_reseal':
        {
          if (!context.hashesToSign) throw new Error('BOARD_RESEAL_HASH_COLLECTOR_MISSING');
          const activation = {
            entityId: replica.state.entityId.toLowerCase(),
            jHeight: hook.data.activationJHeight,
            logIndex: hook.data.activationLogIndex,
          };
          const drafts = buildPendingBoardRotationResealDrafts(
            replica.state,
            env,
            activation,
            hook.data.afterCounterpartyId,
          );
          applyBoardRotationResealMigrations(replica.state, drafts.accountMigrations);
          outputs.push(...drafts.outputs);
          context.hashesToSign.push(...drafts.hashesToSign);
          for (const update of drafts.accountMigrations) {
            context.accountChanges.add(update.counterpartyId);
          }
          const pendingForActivation = [...replica.state.accounts.values()].some(account =>
            account.boardResealMigration?.activationJHeight === activation.jHeight &&
            account.boardResealMigration.activationLogIndex === activation.logIndex);
          if (drafts.hasMore || pendingForActivation) {
            if (!replica.state.crontabState) throw new Error('BOARD_RESEAL_CRONTAB_MISSING');
            scheduleHook(replica.state.crontabState, {
              id: BOARD_RESEAL_HOOK_ID,
              triggerAt: drafts.hasMore
                ? replica.state.timestamp
                : replica.state.timestamp + BOARD_RESEAL_RETRY_MS,
              type: 'board_reseal',
              data: {
                activationJHeight: activation.jHeight,
                activationLogIndex: activation.logIndex,
                afterCounterpartyId: drafts.hasMore ? drafts.nextAfterCounterpartyId : '',
              },
            });
          }
          if (drafts.accountMigrations.length > 0 || drafts.hasMore || pendingForActivation) {
          }
        }
        break;

      case 'cross_j_orderbook_sweep':
        outputs.push({
          entityId: replica.entityId,
          signerId: firstValidator,
          entityTxs: [{
            type: 'orderbookSweepCrossJurisdiction',
            data: { reason: String(hook.data.reason || 'cross-j-orderbook-sweep') },
          }],
        });
        break;
    }
  }

  // Batch HTLC timeouts into single entityTx
  if (htlcTimeoutLocks.length > 0) {
    outputs.push({
      entityId: replica.entityId,
      signerId: firstValidator,
      entityTxs: [
        {
          type: 'processHtlcTimeouts',
          data: { expiredLocks: htlcTimeoutLocks },
        },
      ],
    });
    crontabLog.debug('htlc_timeout.queued', { locks: htlcTimeoutLocks.length });
  }

  if (disputePrepareCounterparties.size > 0) {
    const prepareTxs = Array.from(disputePrepareCounterparties).map((counterpartyEntityId) => ({
      type: 'prepareDispute' as const,
      data: {
        counterpartyEntityId,
        description: 'auto-prepare-dispute-after-secret-ack-timeout',
      },
    }));
    outputs.push({
      entityId: replica.entityId,
      signerId: firstValidator,
      entityTxs: prepareTxs,
    });
    crontabLog.debug('dispute_prepare.queued', { accounts: disputePrepareCounterparties.size });
  }

  if (disputeFinalizeCounterparties.size > 0) {
    const finalizeTxs = Array.from(disputeFinalizeCounterparties).map((counterpartyEntityId) => ({
      type: 'disputeFinalize' as const,
      data: {
        counterpartyEntityId,
        description: 'auto-finalize-after-timeout',
        useOnchainRegistry: true,
      },
    }));
    outputs.push({
      entityId: replica.entityId,
      signerId: firstValidator,
      entityTxs: [
        ...finalizeTxs,
        { type: 'j_broadcast', data: {} },
      ],
    });
    crontabLog.debug('dispute_finalize.queued', { accounts: disputeFinalizeCounterparties.size });
  } else if (shouldBroadcastQueuedDisputeFinalizations) {
    if (!context.manualBroadcastInInput) {
      outputs.push({
        entityId: replica.entityId,
        signerId: firstValidator,
        entityTxs: [{ type: 'j_broadcast', data: {} }],
      });
      crontabLog.debug('j_broadcast.queued_for_drafted_finalize');
    }
  }

  return outputs;
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
  _env: Env,
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

  for (const [counterpartyId, accountMachine] of replica.state.accounts.entries()) {
    if (!accountMachine.pendingFrame) continue;

    // Check if any htlc_lock in the pending frame has expired
    // Cancel ONLY when hashlock expires — until then, counterparty could still claim
    let hasExpiredHtlc = false;
    for (const tx of accountMachine.pendingFrame.accountTxs) {
      if (tx.type === 'htlc_lock') {
        const heightExpired = currentHeight > 0 && currentHeight > tx.data.revealBeforeHeight;
        const timestampExpired = isHtlcTimelockExpired(now, tx.data.timelock);
        if (heightExpired || timestampExpired) {
          console.warn(
            `⏰ HTLC-IN-PENDING-EXPIRED: Account ${counterpartyId.slice(-4)} frame h${accountMachine.pendingFrame.height}, lock ${tx.data.lockId.slice(0, 12)}... expired`,
          );
          hasExpiredHtlc = true;
          break;
        }
      }
    }

    if (hasExpiredHtlc) {
      timedOutAccounts.push({
        counterpartyId,
        frameHeight: accountMachine.pendingFrame.height,
      });
    } else {
      const frameAge = now - accountMachine.pendingFrame.timestamp;

      // ACK may be lost on relay reconnect. Safe resend of the exact cached input
      // unblocks bilateral consensus without mutating account shared state.
      const cachedInputHeight = accountMachine.pendingAccountInput
        ? accountInputProposedFrameHeight(accountMachine.pendingAccountInput)
        : 0;
      if (
        frameAge > ACCOUNT_PENDING_RESEND_AFTER_MS &&
        accountMachine.pendingAccountInput &&
        cachedInputHeight === accountMachine.pendingFrame.height
      ) {
        const targetSignerId = accountMachine.pendingAccountInputSignerId;
        if (!targetSignerId) {
          throw new Error(
            `ACCOUNT_PENDING_INPUT_SIGNER_MISSING: entity=${replica.entityId}` +
            ` counterparty=${accountMachine.pendingAccountInput.toEntityId}` +
            ` height=${accountMachine.pendingFrame.height}`,
          );
        }
        outputs.push({
          entityId: accountMachine.pendingAccountInput.toEntityId,
          signerId: targetSignerId,
          entityTxs: [
            {
              type: 'accountInput',
              data: accountMachine.pendingAccountInput,
            },
          ],
        });
        crontabLog.debug('pending_frame.resend', {
          account: shortId(counterpartyId),
          height: accountMachine.pendingFrame.height,
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
