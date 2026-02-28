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
 *    Fire once at a specific wall-clock time. For point-in-time events:
 *    HTLC lock expiry, dispute deadlines, settlement windows.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * SCHEDULED HOOKS — How to use:
 *
 *   // Schedule: "wake this entity at time T to run security check"
 *   scheduleHook(crontabState, {
 *     id: `htlc-timeout:${lockId}`,   // Unique — prevents duplicates
 *     triggerAt: Number(lock.timelock), // Wall-clock ms
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
 * DETERMINISM: Hooks use wall-clock time for scheduling, but processing
 * happens through entity consensus (deterministic). Both sides see the
 * same hook fire at the same logical time because the proposer's
 * env.timestamp is used for the frame.
 *
 * PERSISTENCE: Hooks live on crontabState (transient, not in consensus hash).
 * Lost on page reload — periodic task polling serves as safety-net fallback.
 */

import type { Env, EntityReplica, EntityInput, AccountMachine, SettlementOp, EntityTx } from './types';
import { isLeftEntity } from './entity-id-utils';
import { deriveDelta } from './account-utils';
import { resolveEntityProposerId } from './state-helpers';
import { normalizeRebalanceMatchingStrategy } from './rebalance-policy';
import { DEFAULT_SOFT_LIMIT } from './types';

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

export interface CrontabTask {
  name: string;
  intervalMs: number; // How often to run (in milliseconds)
  lastRun: number; // Timestamp of last execution
  handler: (env: Env, replica: EntityReplica) => Promise<EntityInput[]>;
}

/** A one-shot hook that fires at a specific wall-clock time */
export interface ScheduledHook {
  id: string; // Unique ID (e.g., "htlc-timeout:0xabc...")
  triggerAt: number; // Wall-clock ms — when this should fire
  type: string; // Hook type for routing (e.g., 'htlc_timeout')
  data: Record<string, any>; // Payload passed to handler
}

export interface CrontabState {
  tasks: Map<string, CrontabTask>;
  hooks: Map<string, ScheduledHook>;
  // Set by entity-consensus for current apply tick only.
  inputHasManualBroadcast?: boolean;
}

// Configuration constants
export const ACCOUNT_TIMEOUT_MS = 30000; // 30 seconds (configurable)
export const ACCOUNT_TIMEOUT_CHECK_INTERVAL_MS = 10000; // Check every 10 seconds
export const ACCOUNT_PENDING_RESEND_AFTER_MS = 8000; // Resend pending frame input after 8s without ACK
export const HUB_REBALANCE_INTERVAL_MS = 3000; // Default production poll cadence (override via hub config if needed)
export const HUB_PENDING_BROADCAST_STALE_MS = 120000; // 2 minutes without finalize = stale
export const HUB_SUBMITTED_REQUEST_STALE_MS = 5 * 60 * 1000; // 5 minutes since jBatch handoff => mark as stale/manual
export const HUB_MAX_R2C_PER_TICK = 10;
export const HUB_MAX_C2R_PER_TICK = 10;

function getEnvJAdapter(env: Env) {
  if (!env.jReplicas || env.jReplicas.size === 0) return null;
  const active = env.activeJurisdiction ? env.jReplicas.get(env.activeJurisdiction) : undefined;
  if (active?.jadapter) return active.jadapter;
  for (const replica of env.jReplicas.values()) {
    if (replica.jadapter) return replica.jadapter;
  }
  return null;
}

const ZERO_HASH_32 = `0x${'0'.repeat(64)}`;
const hasActiveDisputeHash = (hash: unknown): boolean => {
  const normalized = String(hash ?? '').toLowerCase();
  return normalized !== '' && normalized !== '0x' && normalized !== '0x0' && normalized !== ZERO_HASH_32;
};

/**
 * Initialize crontab state for an entity
 */
export function initCrontab(): CrontabState {
  const tasks = new Map<string, CrontabTask>();

  // Register default periodic tasks (setInterval-like)
  tasks.set('checkAccountTimeouts', {
    name: 'checkAccountTimeouts',
    intervalMs: ACCOUNT_TIMEOUT_CHECK_INTERVAL_MS,
    lastRun: 0,
    handler: checkAccountTimeoutsHandler,
  });

  tasks.set('hubRebalance', {
    name: 'hubRebalance',
    intervalMs: HUB_REBALANCE_INTERVAL_MS,
    lastRun: 0,
    handler: hubRebalanceHandler,
  });

  return { tasks, hooks: new Map(), inputHasManualBroadcast: false };
}

// ═══════════════════════════════════════════════════════════════════════
// Scheduled Hooks API (setTimeout-like)
// ═══════════════════════════════════════════════════════════════════════

/** Schedule a one-shot hook at a specific wall-clock time */
export function scheduleHook(state: CrontabState, hook: ScheduledHook): void {
  if (!state.hooks) state.hooks = new Map();
  state.hooks.set(hook.id, hook);
  console.log(`⏰ HOOK scheduled: ${hook.type} id=${hook.id.slice(0, 24)}... triggerAt=${hook.triggerAt}`);
}

/** Cancel a previously scheduled hook (e.g., lock resolved before timeout) */
export function cancelHook(state: CrontabState, hookId: string): void {
  if (!state.hooks) return;
  if (state.hooks.delete(hookId)) {
    console.log(`⏰ HOOK cancelled: ${hookId.slice(0, 24)}...`);
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
      console.log(`⏰ HOOKS: ${dueHooks.length} hooks fired (entity ${replica.entityId.slice(-4)}, timestamp=${now})`);
      const hookOutputs = await processDueHooks(dueHooks, env, replica);
      allOutputs.push(...hookOutputs);
    }
  }

  // ── 2. Process periodic tasks (setInterval-like, fires repeatedly) ──
  for (const task of crontabState.tasks.values()) {
    const timeSinceLastRun = now - task.lastRun;

    if (timeSinceLastRun >= task.intervalMs) {
      try {
        const outputs = await task.handler(env, replica);
        allOutputs.push(...outputs);
        task.lastRun = now;
        if (outputs.length > 0) {
          console.log(`✅ CRONTAB: Task "${task.name}" generated ${outputs.length} outputs`);
        }
      } catch (error) {
        console.error(`❌ CRONTAB: Task "${task.name}" failed:`, error);
      }
    }
  }

  return allOutputs;
}

/**
 * Process fired hooks → generate entityTxs by hook type.
 * Each hook type maps to a specific security/protocol action.
 */
async function processDueHooks(hooks: ScheduledHook[], env: Env, replica: EntityReplica): Promise<EntityInput[]> {
  const outputs: EntityInput[] = [];
  const firstValidator = replica.state.config.validators?.[0];
  if (!firstValidator) return outputs;
  const jadapter = getEnvJAdapter(env);
  const canAutoAdvanceLocalJBlock =
    !!jadapter &&
    jadapter.mode === 'rpc' &&
    Number(jadapter.chainId) === 31337 &&
    typeof jadapter.processBlock === 'function';
  let triedAutoAdvanceThisTick = false;

  // Group expired locks by type for batch processing
  const htlcTimeoutLocks: Array<{ accountId: string; lockId: string }> = [];
  const disputeFinalizeCounterparties = new Set<string>();
  let shouldBroadcastQueuedDisputeFinalizations = false;

  let currentJBlock = Number(replica.state.lastFinalizedJHeight || 0);
  try {
    if (jadapter?.provider && typeof jadapter.provider.getBlockNumber === 'function') {
      currentJBlock = Math.max(currentJBlock, Number(await jadapter.provider.getBlockNumber()));
    }
  } catch {
    // Fallback to lastFinalizedJHeight if provider read fails.
  }

  for (const hook of hooks) {
    console.log(`⏰ HOOK FIRED: type=${hook.type} id=${hook.id.slice(0, 24)}...`);

    switch (hook.type) {
      case 'htlc_timeout':
        // HTLC lock expired → resolve with error:timeout
        {
          const accountId = String(hook.data['accountId'] || '');
          const lockId = String(hook.data['lockId'] || '');
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
          const accountId = String(hook.data['accountId'] || '');
          const account = replica.state.accounts.get(accountId);
          if (!account?.activeDispute) break;
          if (replica.state.hubRebalanceConfig?.disputeAutoFinalizeMode === 'ignore') {
            break;
          }
          const weAreLeft = account.leftEntity === replica.state.entityId;
          const weAreStarter = weAreLeft === account.activeDispute.startedByLeft;

          let timeoutBlock = Number(account.activeDispute.disputeTimeout || 0);
          if (
            jadapter &&
            weAreStarter &&
            timeoutBlock &&
            currentJBlock < timeoutBlock &&
            canAutoAdvanceLocalJBlock &&
            !triedAutoAdvanceThisTick
          ) {
            triedAutoAdvanceThisTick = true;
            try {
              await jadapter.processBlock();
              if (jadapter.provider && typeof jadapter.provider.getBlockNumber === 'function') {
                currentJBlock = Math.max(currentJBlock, Number(await jadapter.provider.getBlockNumber()));
              }
            } catch {
              // Keep retry path below.
            }
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
            console.log(
              `⏰ HOOK: dispute_deadline retry for ${accountId.slice(-4)} ` +
              `(current=${currentJBlock}, timeout=${timeoutBlock}, retryMs=${retryMs})`,
            );
            break;
          }

          if (jadapter?.getAccountInfo) {
            try {
              const onchain = await jadapter.getAccountInfo(replica.state.entityId, accountId);
              if (!hasActiveDisputeHash(onchain.disputeHash)) {
                account.activeDispute = undefined;
                if (account.status === 'disputed') account.status = 'active';
                console.warn(
                  `⏰ HOOK: dispute_deadline stale local dispute cleared for ${accountId.slice(-4)} (no on-chain active dispute)`,
                );
                break;
              }
              const onchainTimeout = Number(onchain.disputeTimeout ?? 0n);
              if (Number.isFinite(onchainTimeout) && onchainTimeout > 0) {
                timeoutBlock = onchainTimeout;
                account.activeDispute.disputeTimeout = onchainTimeout;
              }
            } catch (error) {
              const retryMs = 1000;
              if (replica.state.crontabState) {
                scheduleHook(replica.state.crontabState, {
                  id: hook.id,
                  triggerAt: replica.state.timestamp + retryMs,
                  type: 'dispute_deadline',
                  data: { accountId },
                });
              }
              console.warn(
                `⏰ HOOK: dispute_deadline on-chain check failed for ${accountId.slice(-4)}; retry in ${retryMs}ms`,
                error
              );
              break;
            }
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
            account.activeDispute.finalizeQueued = sentHasFinalize || account.activeDispute.finalizeQueued;
            const retryMs = 1000;
            if (replica.state.crontabState) {
              scheduleHook(replica.state.crontabState, {
                id: hook.id,
                triggerAt: replica.state.timestamp + retryMs,
                type: 'dispute_deadline',
                data: { accountId },
              });
            }
            console.log(
              `⏰ HOOK: dispute_deadline deferred for ${accountId.slice(-4)} ` +
              `(sentBatch pending, retryMs=${retryMs})`,
            );
            break;
          }

          if (draftHasFinalize) {
            account.activeDispute.finalizeQueued = true;
            shouldBroadcastQueuedDisputeFinalizations = true;
            break;
          }

          if (account.activeDispute.finalizeQueued) {
            // Recover from stale local latch (e.g. after abort/drop of previous finalize batch).
            account.activeDispute.finalizeQueued = false;
          }

          disputeFinalizeCounterparties.add(accountId);
        }
        break;

      case 'settlement_window':
        // Future: auto-execute settlement after approval window
        console.log(`⏰ HOOK: settlement_window — not yet implemented`);
        break;

      case 'watchdog':
        // Future: detect unresponsive counterparty
        console.log(`⏰ HOOK: watchdog — not yet implemented`);
        break;

      case 'hub_rebalance_kick':
        // Force next global hub rebalance pass (across all accounts) on this entity.
        // This is a wake-up hint, not a per-account rebalance decision.
        {
          const task = replica.state.crontabState?.tasks?.get('hubRebalance');
          if (task) {
            task.lastRun = 0;
            console.log(`⏰ HOOK: hub_rebalance_kick — forcing next global hubRebalance pass`);
          }
        }
        break;

      default:
        console.warn(`⏰ HOOK: Unknown type "${hook.type}" — skipping`);
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
    console.log(`⏰ HOOKS: Generated processHtlcTimeouts for ${htlcTimeoutLocks.length} expired locks`);
  }

  if (disputeFinalizeCounterparties.size > 0) {
    const finalizeTxs = Array.from(disputeFinalizeCounterparties).map((counterpartyEntityId) => ({
      type: 'disputeFinalize' as const,
      data: {
        counterpartyEntityId,
        description: 'auto-finalize-after-timeout',
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
    console.log(
      `⏰ HOOKS: auto disputeFinalize+j_broadcast queued for ${disputeFinalizeCounterparties.size} account(s)`,
    );
  } else if (shouldBroadcastQueuedDisputeFinalizations) {
    const inputHasManualBroadcast = Boolean(replica.state.crontabState?.inputHasManualBroadcast);
    if (!inputHasManualBroadcast) {
      outputs.push({
        entityId: replica.entityId,
        signerId: firstValidator,
        entityTxs: [{ type: 'j_broadcast', data: {} }],
      });
      console.log('⏰ HOOKS: auto j_broadcast queued for already-drafted disputeFinalize');
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
async function checkAccountTimeoutsHandler(_env: Env, replica: EntityReplica): Promise<EntityInput[]> {
  const outputs: EntityInput[] = [];
  const now = replica.state.timestamp; // DETERMINISTIC: Use entity's own timestamp
  const currentHeight = replica.state.lastFinalizedJHeight || 0;
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
        const timestampExpired = now > Number(tx.data.timelock);
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
      if (
        firstValidator &&
        frameAge > ACCOUNT_PENDING_RESEND_AFTER_MS &&
        accountMachine.pendingAccountInput &&
        accountMachine.pendingAccountInput.height === accountMachine.pendingFrame.height
      ) {
        outputs.push({
          entityId: accountMachine.pendingAccountInput.toEntityId,
          signerId: firstValidator,
          entityTxs: [
            {
              type: 'accountInput',
              data: accountMachine.pendingAccountInput,
            },
          ],
        });
        console.warn(
          `⏰ PENDING-FRAME-RESEND: Account ${counterpartyId.slice(-4)} h${accountMachine.pendingFrame.height} ` +
            `age=${Math.floor(frameAge / 1000)}s`,
        );
      }

      // Non-HTLC pending frames: dispute suggestion after 30s
      if (frameAge > ACCOUNT_TIMEOUT_MS) {
        console.warn(
          `⏰ PENDING-FRAME-STALE: Account with ${counterpartyId.slice(-4)} h${accountMachine.pendingFrame.height} for ${Math.floor(frameAge / 1000)}s — consider dispute`,
        );
      }
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

/**
 * Check all HTLC locks for expiration and auto-timeout
 *
 * Pattern:
 * - Iterate all accounts
 * - Check locks for currentHeight > revealBeforeHeight
 * - Generate htlc_timeout mempoolOps for expired locks
 * - Prevents locks from being stuck forever
 */
async function checkHtlcTimeoutsHandler(_env: Env, replica: EntityReplica): Promise<EntityInput[]> {
  const outputs: EntityInput[] = [];
  const currentHeight = replica.state.lastFinalizedJHeight || 0;
  const currentTimestamp = replica.state.timestamp; // Entity's deterministic clock

  console.log(
    `⏰ HTLC-TIMEOUT-CRON: Checking locks (entity ${replica.entityId.slice(-4)}, height=${currentHeight}, timestamp=${currentTimestamp})`,
  );

  // Collect expired locks per account
  const expiredLocksByAccount: Array<{ accountId: string; lockId: string; lock: any }> = [];
  let totalLocks = 0;

  // Iterate over all accounts
  for (const [counterpartyId, accountMachine] of replica.state.accounts.entries()) {
    if (!accountMachine.locks || accountMachine.locks.size === 0) continue;

    totalLocks += accountMachine.locks.size;

    // Check each lock for expiration
    for (const [lockId, lock] of accountMachine.locks.entries()) {
      console.log(
        `⏰   Checking lock ${lockId.slice(0, 16)}... (heightDeadline=${lock.revealBeforeHeight}, timeDeadline=${lock.timelock})`,
      );

      // Check if lock expired - BOTH conditions (height OR timestamp)
      // Height: Used when J-blocks are active (on-chain settlement)
      // Timestamp: Fallback for off-chain timeout (entity's deterministic clock)
      const heightExpired = currentHeight > 0 && currentHeight > lock.revealBeforeHeight;
      const timestampExpired = currentTimestamp > Number(lock.timelock);
      const expired = heightExpired || timestampExpired;

      if (expired) {
        console.log(`⏰ HTLC-TIMEOUT: Lock ${lockId.slice(0, 16)}... EXPIRED`);
        console.log(`   Height: ${currentHeight} > ${lock.revealBeforeHeight} = ${heightExpired}`);
        console.log(`   Timestamp: ${currentTimestamp} > ${lock.timelock} = ${timestampExpired}`);
        console.log(`   Account: ${counterpartyId.slice(-4)}, Amount: ${lock.amount}`);

        expiredLocksByAccount.push({
          accountId: counterpartyId,
          lockId,
          lock,
        });
      }
    }
  }

  console.log(`⏰ HTLC-TIMEOUT-CRON: Scanned ${totalLocks} locks, found ${expiredLocksByAccount.length} expired`);

  // If we found expired locks, generate EntityTx to process them
  if (expiredLocksByAccount.length > 0) {
    console.log(`⏰ HTLC-TIMEOUT: Found ${expiredLocksByAccount.length} expired locks`);

    const firstValidator = replica.state.config.validators?.[0];
    if (firstValidator) {
      outputs.push({
        entityId: replica.entityId,
        signerId: firstValidator,
        entityTxs: [
          {
            type: 'processHtlcTimeouts',
            data: { expiredLocks: expiredLocksByAccount },
          },
        ],
      });
    }
  }

  return outputs;
}

/**
 * Get statistics about pending frames across all accounts
 */
export function getAccountTimeoutStats(replica: EntityReplica): {
  totalAccounts: number;
  pendingFrames: number;
  timedOutFrames: number;
  oldestPendingFrameAge: number;
} {
  const now = replica.state.timestamp; // DETERMINISTIC: Use entity's own timestamp
  let pendingFrames = 0;
  let timedOutFrames = 0;
  let oldestPendingFrameAge = 0;

  for (const accountMachine of replica.state.accounts.values()) {
    if (accountMachine.pendingFrame) {
      pendingFrames++;
      const frameAge = now - accountMachine.pendingFrame.timestamp;

      if (frameAge > ACCOUNT_TIMEOUT_MS) {
        timedOutFrames++;
      }

      if (frameAge > oldestPendingFrameAge) {
        oldestPendingFrameAge = frameAge;
      }
    }
  }

  return {
    totalAccounts: replica.state.accounts.size,
    pendingFrames,
    timedOutFrames,
    oldestPendingFrameAge,
  };
}

/**
 * Hub Rebalance Handler
 * Prepaid request_collateral flow (no quotes).
 *
 * Users enqueue request_collateral and prepay fee in bilateral frame.
 * Hub consumes pending requests, adds direct R→C ops to jBatch, and broadcasts.
 * Hub never auto-refunds in crontab; any refund must be explicit/manual.
 */
async function hubRebalanceHandler(_env: Env, replica: EntityReplica): Promise<EntityInput[]> {
  // Only hubs should run the rebalance handler
  if (!replica.state.hubRebalanceConfig) return [];

  const outputs: EntityInput[] = [];
  const localEntityTxs: EntityTx[] = [];
  const signerId = resolveEntityProposerId(_env, replica.entityId, 'hub-rebalance');
  const now = replica.state.timestamp; // DETERMINISTIC: use entity's own timestamp
  const strategy = normalizeRebalanceMatchingStrategy(replica.state.hubRebalanceConfig.matchingStrategy);
  const rebalanceBaseFee = replica.state.hubRebalanceConfig.rebalanceBaseFee ?? 10n ** 17n;
  const rebalanceLiquidityFeeBps =
    replica.state.hubRebalanceConfig.rebalanceLiquidityFeeBps ??
    replica.state.hubRebalanceConfig.minFeeBps ??
    1n;
  const rebalanceGasFee = replica.state.hubRebalanceConfig.rebalanceGasFee ?? 0n;
  const c2rWithdrawSoftLimit = replica.state.hubRebalanceConfig.c2rWithdrawSoftLimit ?? DEFAULT_SOFT_LIMIT;
  const currentPolicyVersion = Number.isFinite(replica.state.hubRebalanceConfig.policyVersion)
    && replica.state.hubRebalanceConfig.policyVersion > 0
    ? replica.state.hubRebalanceConfig.policyVersion
    : 1;
  const hubId = replica.entityId;
  const emitRebalanceDebug = (payload: Record<string, unknown>) => {
    const p2p = (_env as any)?.runtimeState?.p2p;
    if (p2p && typeof p2p.sendDebugEvent === 'function') {
      p2p.sendDebugEvent({
        level: 'info',
        code: 'REB_STEP',
        hubId,
        ...payload,
      });
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // DIRECT R→C: process explicit prepaid request_collateral only.
  // No proactive hub risk: if user did not prepay, hub does nothing.
  // Hub builds jBatch and broadcasts immediately in this same task tick.
  // ═══════════════════════════════════════════════════════════════════

  // Initialize jBatch if needed
  if (!replica.state.jBatchState) {
    const { initJBatch } = await import('./j-batch');
    replica.state.jBatchState = initJBatch();
  }

  const resolveJAdapter = () => {
    if (_env.activeJurisdiction) {
      const active = _env.jReplicas?.get(_env.activeJurisdiction);
      if (active?.jadapter) return active.jadapter;
    }
    for (const j of _env.jReplicas?.values?.() || []) {
      if (j?.jadapter) return j.jadapter;
    }
    return null;
  };

  // Pending broadcast blocks direct jBatch mutations (R→C/C→R execute), but we can still
  // prepare C→R settlement proposals that only touch account consensus.
  let canTouchBatch = true;
  if (replica.state.jBatchState.sentBatch) {
    const sentBatch = replica.state.jBatchState.sentBatch;
    const ageMs = now - (sentBatch.lastSubmittedAt || replica.state.jBatchState.lastBroadcast || 0);
    if (ageMs <= HUB_PENDING_BROADCAST_STALE_MS) {
      console.warn(
        `⏳ Hub rebalance blocked: sentBatch pending age=${ageMs}ms nonce=${sentBatch.entityNonce} (entity=${hubId.slice(-4)})`,
      );
      canTouchBatch = false;
    } else {
      // Safety: before clearing stale latch, cross-check on-chain nonce.
      // If chain nonce already advanced beyond local, we must NOT retry submit
      // with stale nonce (would revert E2). Wait for watcher/event sync instead.
      const jadapter = resolveJAdapter();
      if (jadapter && typeof jadapter.getEntityNonce === 'function') {
        try {
          const chainNonce = Number(await jadapter.getEntityNonce(hubId));
          const localNonce = Number(replica.state.jBatchState.entityNonce || 0);
          if (chainNonce > localNonce) {
            replica.state.jBatchState.entityNonce = chainNonce;
            canTouchBatch = false;
            console.warn(
              `⏳ Hub rebalance stale latch guarded: on-chain nonce ${chainNonce} > local ${localNonce}; ` +
              `waiting for HankoBatchProcessed sync before retry`,
            );
          } else {
            console.warn(
              `⚠️ Hub rebalance stale sentBatch (${ageMs}ms) - clearing latch (nonce local=${localNonce}, chain=${chainNonce})`,
            );
            replica.state.jBatchState.sentBatch = undefined;
            replica.state.jBatchState.status = 'empty';
          }
        } catch (error) {
          canTouchBatch = false;
          console.warn(
            `⏳ Hub rebalance stale latch: nonce check failed, keeping sentBatch pending ` +
            `(${error instanceof Error ? error.message : String(error)})`,
          );
        }
      } else {
        console.warn(
          `⚠️ Hub rebalance stale sentBatch (${ageMs}ms) - clearing latch (no jadapter nonce check available)`,
        );
        replica.state.jBatchState.sentBatch = undefined;
        replica.state.jBatchState.status = 'empty';
      }
    }
  }

  // Effective reserves: actual + pending C→R amounts in batch
  const effectiveReserves = new Map<string, bigint>();
  for (const [tokenKey, amount] of replica.state.reserves.entries()) {
    effectiveReserves.set(tokenKey, amount);
  }

  type R2CTarget = {
    counterpartyId: string;
    tokenId: number;
    amount: bigint;
    requestedAt: number;
    feePaidUpfront: bigint;
  };
  const targets: R2CTarget[] = [];

  for (const [counterpartyId, accountMachine] of replica.state.accounts.entries()) {
    const hubIsLeft = isLeftEntity(hubId, counterpartyId);
    if (!accountMachine.requestedRebalance || accountMachine.requestedRebalance.size === 0) continue;

    for (const [tokenId, requestedAmountRaw] of accountMachine.requestedRebalance.entries()) {
      if (requestedAmountRaw <= 0n) continue;

      const feeState = accountMachine.requestedRebalanceFeeState?.get(tokenId);
      if (!feeState) {
        console.warn(
          `⚠️ R→C request dropped (missing fee state): token=${tokenId} cp=${counterpartyId.slice(-4)}`,
        );
        emitRebalanceDebug({
          step: 2,
          status: 'error',
          event: 'request_dropped_missing_fee_state',
          counterpartyId,
          tokenId,
        });
        accountMachine.requestedRebalance.delete(tokenId);
        continue;
      }
      const prepaidFee = feeState.feePaidUpfront;
      const requestedAt = feeState.requestedAt;
      let jBatchSubmittedAt = feeState.jBatchSubmittedAt || 0;
      const submittedAgeMs = jBatchSubmittedAt > 0 ? now - jBatchSubmittedAt : 0;
      let submittedBatchStale = jBatchSubmittedAt > 0 && submittedAgeMs >= HUB_SUBMITTED_REQUEST_STALE_MS;

      // Once a request is handed to J-batch, keep gates blocked while submission is fresh.
      // Partial fills reset this marker in j-events.
      if (jBatchSubmittedAt > 0 && !submittedBatchStale) {
        // In-flight request already handed to J-batch: skip duplicate enqueue silently.
        continue;
      }

      // Policy mismatch is not auto-refunded; leave request pending for explicit manual action.
      if (jBatchSubmittedAt <= 0 && (feeState.policyVersion || 0) !== currentPolicyVersion) {
        console.warn(
          `⏸️ R→C request pending (policy mismatch, manual action required): token=${tokenId} cp=${counterpartyId.slice(-4)} ` +
          `reqPolicy=${feeState.policyVersion} hubPolicy=${currentPolicyVersion}`,
        );
        emitRebalanceDebug({
          step: 2,
          status: 'blocked',
          event: 'policy_mismatch_manual',
          counterpartyId,
          tokenId,
          requestPolicyVersion: feeState.policyVersion || 0,
          hubPolicyVersion: currentPolicyVersion,
        });
        continue;
      }

      // If handoff to J-batch went stale, reset submission marker and retry.
      // Nonce safety is enforced by j-broadcast/on-chain nonce checks, so retrying
      // avoids permanent "awaiting collateral" wedges when broadcasts are dropped.
      if (submittedBatchStale) {
        console.warn(
          `⚠️ R→C stale submission reset for retry: token=${tokenId} cp=${counterpartyId.slice(-4)} ` +
          `submittedAgeMs=${submittedAgeMs}`,
        );
        feeState.jBatchSubmittedAt = 0;
        jBatchSubmittedAt = 0;
        submittedBatchStale = false;
        emitRebalanceDebug({
          step: 2,
          status: 'retry',
          event: 'request_submitted_stale_retry_reset',
          counterpartyId,
          tokenId,
          submittedAgeMs,
        });
      }

      const minFee =
        rebalanceBaseFee +
        rebalanceGasFee +
        (requestedAmountRaw * rebalanceLiquidityFeeBps) / 10000n;
      if (prepaidFee < minFee) {
        console.warn(
          `⏸️ R→C request pending (prepaid fee too low, manual action required): token=${tokenId} cp=${counterpartyId.slice(-4)} ` +
          `prepaid=${prepaidFee} < requiredFee=${minFee} (base=${rebalanceBaseFee},liqBps=${rebalanceLiquidityFeeBps},gas=${rebalanceGasFee})`,
        );
        emitRebalanceDebug({
          step: 2,
          status: 'blocked',
          event: 'prepaid_fee_too_low_manual',
          counterpartyId,
          tokenId,
          prepaidFee: String(prepaidFee),
          requiredFee: String(minFee),
        });
        continue;
      }

      const delta = accountMachine.deltas.get(tokenId);
      if (!delta) {
        console.warn(`⚠️ R→C request ignored (missing delta): token=${tokenId} cp=${counterpartyId.slice(-4)}`);
        emitRebalanceDebug({
          step: 2,
          status: 'error',
          event: 'request_missing_delta',
          counterpartyId,
          tokenId,
        });
        continue;
      }

      // R→C demand is computed strictly from deriveDelta() in counterparty perspective.
      const counterpartyDerived = deriveDelta(delta, !hubIsLeft);
      const uncollateralized = counterpartyDerived.outPeerCredit;
      if (uncollateralized <= 0n) {
        // Fee remains prepaid by design (no automatic refunds in crontab path).
        // Operators can handle discretionary refunds explicitly if needed.
        emitRebalanceDebug({
          step: 2,
          status: 'ok',
          event: 'request_cleared_already_collateralized',
          counterpartyId,
          tokenId,
        });
        accountMachine.requestedRebalance.delete(tokenId);
        accountMachine.requestedRebalanceFeeState?.delete(tokenId);
        continue;
      }

      const requestedAmount = requestedAmountRaw > uncollateralized ? uncollateralized : requestedAmountRaw;
      const reserve = effectiveReserves.get(String(tokenId)) || 0n;
      const depositAmount = requestedAmount > reserve ? reserve : requestedAmount;
      if (depositAmount > 0n) {
        targets.push({
          counterpartyId,
          tokenId,
          amount: depositAmount,
          requestedAt: feeState.requestedAt || 0,
          feePaidUpfront: prepaidFee,
        });
        effectiveReserves.set(String(tokenId), reserve - depositAmount);
      } else {
        console.warn(
          `⚠️ R→C request pending but skipped (zero reserve): token=${tokenId} cp=${counterpartyId.slice(-4)} requested=${requestedAmount}`,
        );
        emitRebalanceDebug({
          step: 2,
          status: 'blocked',
          event: 'hub_reserve_zero',
          counterpartyId,
          tokenId,
          requestedAmount: String(requestedAmount),
        });
      }
    }
  }

  const compareBigDesc = (a: bigint, b: bigint): number => (a === b ? 0 : a > b ? -1 : 1);
  const compareBigAsc = (a: bigint, b: bigint): number => (a === b ? 0 : a < b ? -1 : 1);

  if (strategy === 'amount') {
    targets.sort((a, b) => compareBigDesc(a.amount, b.amount) || compareBigAsc(BigInt(a.requestedAt), BigInt(b.requestedAt)));
  } else if (strategy === 'fee') {
    targets.sort((a, b) => compareBigDesc(a.feePaidUpfront, b.feePaidUpfront) || compareBigDesc(a.amount, b.amount));
  } else {
    targets.sort((a, b) => compareBigAsc(BigInt(a.requestedAt), BigInt(b.requestedAt)) || compareBigDesc(a.amount, b.amount));
  }

  const selectedR2CTargets = targets.slice(0, HUB_MAX_R2C_PER_TICK);
  if (targets.length > selectedR2CTargets.length) {
    console.warn(
      `⚠️ Hub rebalance: capped R→C targets this tick ${selectedR2CTargets.length}/${targets.length}`,
    );
  }


  // Add R→C directly to jBatch — no quotes, no bilateral frames.
  let queuedCount = 0;
  if (selectedR2CTargets.length > 0 && canTouchBatch) {
    const { batchAddReserveToCollateral } = await import('./j-batch');
    for (const target of selectedR2CTargets) {
      try {
        batchAddReserveToCollateral(
          replica.state.jBatchState,
          hubId,
          target.counterpartyId,
          target.tokenId,
          target.amount,
        );
        const targetAccount = replica.state.accounts.get(target.counterpartyId);
        const targetFeeState = targetAccount?.requestedRebalanceFeeState?.get(target.tokenId);
        if (targetFeeState && (targetFeeState.jBatchSubmittedAt || 0) <= 0) {
          targetFeeState.jBatchSubmittedAt = now;
        }
        queuedCount += 1;
        console.log(
          `✅ R→C queued: ${target.amount} token ${target.tokenId} → ${target.counterpartyId.slice(-4)} (direct jBatch, no quotes)`,
        );
        console.log(
          `[REB][2][BATCH_ADD] hub=${hubId.slice(-8)} cp=${target.counterpartyId.slice(-8)} token=${target.tokenId} amount=${target.amount} requestedAt=${target.requestedAt}`,
        );
        emitRebalanceDebug({
          step: 2,
          status: 'ok',
          event: 'batch_add',
          counterpartyId: target.counterpartyId,
          tokenId: target.tokenId,
          amount: String(target.amount),
          requestedAt: target.requestedAt,
        });
      } catch (err) {
        console.warn(`⚠️ R→C batch add failed for ${target.counterpartyId.slice(-4)}: ${(err as Error).message}`);
        emitRebalanceDebug({
          step: 2,
          status: 'error',
          event: 'batch_add_failed',
          counterpartyId: target.counterpartyId,
          tokenId: target.tokenId,
          reason: (err as Error).message || 'unknown',
        });
      }
    }
  } else if (selectedR2CTargets.length > 0 && !canTouchBatch) {
    console.warn(
      `⏳ R→C skipped this tick: sentBatch pending (targets=${selectedR2CTargets.length})`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // C→R path: when account is over-collateralized from deriveDelta perspective,
  // ask user signature via settle_propose(c2r) then execute/broadcast.
  // ═══════════════════════════════════════════════════════════════════
  type C2RPlan = {
    counterpartyId: string;
    ops: SettlementOp[];
    totalAmount: bigint;
  };
  const c2rPlans: C2RPlan[] = [];
  const c2rExecutableAccounts: string[] = [];

  for (const [counterpartyId, accountMachine] of replica.state.accounts.entries()) {
    if (accountMachine.pendingFrame) continue;
    const hubIsLeft = isLeftEntity(hubId, counterpartyId);
    const workspace = accountMachine.settlementWorkspace;

    if (workspace) {
      const hubProposedWorkspace = workspace.lastModifiedByLeft === hubIsLeft;
      const pureC2RWorkspace = workspace.ops.length > 0 && workspace.ops.every((op) => op.type === 'c2r');
      const counterpartyHanko = hubIsLeft ? workspace.rightHanko : workspace.leftHanko;
      if (
        canTouchBatch &&
        hubProposedWorkspace &&
        pureC2RWorkspace &&
        workspace.executorIsLeft === hubIsLeft &&
        workspace.status !== 'submitted' &&
        !!counterpartyHanko
      ) {
        c2rExecutableAccounts.push(counterpartyId);
      }
      continue;
    }

    const ops: SettlementOp[] = [];
    let totalAmount = 0n;
    for (const [tokenId, delta] of accountMachine.deltas.entries()) {
      if ((accountMachine.requestedRebalance.get(tokenId) ?? 0n) > 0n) continue;

      // C→R uses canonical deriveDelta outCollateral in hub perspective.
      // Trigger threshold is c2rWithdrawSoftLimit, withdrawal amount is full freeOutCollateral.
      const hubDerived = deriveDelta(delta, hubIsLeft);
      const hubOwnedCollateral = hubDerived.outCollateral;
      const outHold = hubDerived.outTotalHold || 0n;
      const freeOutCollateral = hubOwnedCollateral > outHold ? hubOwnedCollateral - outHold : 0n;
      if (freeOutCollateral <= c2rWithdrawSoftLimit) continue;

      const withdrawAmount = freeOutCollateral;
      emitRebalanceDebug({
        step: 2,
        status: 'ok',
        event: 'c2r_withdraw_overcollateralized',
        counterpartyId,
        tokenId,
        outCollateral: String(hubOwnedCollateral),
        outHold: String(outHold),
        freeOutCollateral: String(freeOutCollateral),
        c2rWithdrawSoftLimit: String(c2rWithdrawSoftLimit),
        withdrawAmount: String(withdrawAmount),
      });

      if (withdrawAmount <= 0n) continue;
      // Invariant: withdrawAmount cannot exceed free collateral.
      console.assert(
        withdrawAmount <= freeOutCollateral,
        `C2R invariant violated: withdraw(${withdrawAmount}) > freeOutCollateral(${freeOutCollateral}) cp=${counterpartyId} token=${tokenId}`,
      );
      ops.push({ type: 'c2r', tokenId, amount: withdrawAmount });
      totalAmount += withdrawAmount;
    }

    if (ops.length > 0 && totalAmount > 0n) {
      c2rPlans.push({ counterpartyId, ops, totalAmount });
    }
  }

  c2rPlans.sort((a, b) => compareBigDesc(a.totalAmount, b.totalAmount));
  const selectedC2RPlans = c2rPlans.slice(0, HUB_MAX_C2R_PER_TICK);
  if (c2rPlans.length > selectedC2RPlans.length) {
    console.warn(`⚠️ Hub rebalance: capped C→R proposals this tick ${selectedC2RPlans.length}/${c2rPlans.length}`);
  }

  for (const plan of selectedC2RPlans) {
    localEntityTxs.push({
      type: 'settle_propose',
      data: {
        counterpartyEntityId: plan.counterpartyId,
        ops: plan.ops,
        executorIsLeft: isLeftEntity(hubId, plan.counterpartyId),
        memo: 'auto-c2r-rebalance',
      },
    });
    console.log(
      `🔄 C→R propose queued: cp=${plan.counterpartyId.slice(-4)} ops=${plan.ops.length} amount=${plan.totalAmount}`,
    );
    emitRebalanceDebug({
      step: 2,
      status: 'ok',
      event: 'c2r_settle_propose_queued',
      counterpartyId: plan.counterpartyId,
      ops: plan.ops.length,
      amount: String(plan.totalAmount),
    });
  }

  const selectedC2RExec = c2rExecutableAccounts.slice(0, HUB_MAX_C2R_PER_TICK);
  if (c2rExecutableAccounts.length > selectedC2RExec.length) {
    console.warn(
      `⚠️ Hub rebalance: capped C→R executes this tick ${selectedC2RExec.length}/${c2rExecutableAccounts.length}`,
    );
  }
  for (const counterpartyId of selectedC2RExec) {
    localEntityTxs.push({
      type: 'settle_execute',
      data: { counterpartyEntityId: counterpartyId },
    });
    console.log(`🔄 C→R execute queued: cp=${counterpartyId.slice(-4)} (signed workspace)`);
    emitRebalanceDebug({
      step: 2,
      status: 'ok',
      event: 'c2r_settle_execute_queued',
      counterpartyId,
    });
  }

  const inputHasManualBroadcast = Boolean(replica.state.crontabState?.inputHasManualBroadcast);
  const shouldBroadcast =
    canTouchBatch &&
    !replica.state.jBatchState.sentBatch &&
    !inputHasManualBroadcast &&
    (queuedCount > 0 || selectedC2RExec.length > 0);
  if (shouldBroadcast) {
    localEntityTxs.push({ type: 'j_broadcast', data: {} });
    console.log(
      `[REB][3][BROADCAST_ENTITY_TX_QUEUED] hub=${hubId.slice(-8)} sentPending=${!!replica.state.jBatchState.sentBatch} queuedR2C=${queuedCount} queuedC2RExec=${selectedC2RExec.length}`,
    );
    emitRebalanceDebug({
      step: 3,
      status: 'ok',
      event: 'j_broadcast_queued',
      queuedCount: queuedCount + selectedC2RExec.length,
      sentBatchPending: !!replica.state.jBatchState.sentBatch,
    });
  } else if (
    queuedCount > 0 || selectedC2RExec.length > 0
  ) {
    const blockedByBatchState = !canTouchBatch || !!replica.state.jBatchState.sentBatch;
    const blockedByInputBroadcast = inputHasManualBroadcast;
    if (!blockedByBatchState && !blockedByInputBroadcast) {
      // Nothing blocked and still no broadcast means we had no eligible work.
      // Keep silent to avoid noisy logs.
    } else {
      console.warn(
        `[REB][3][BROADCAST_ENTITY_TX_SKIPPED] hub=${hubId.slice(-8)} reason=${blockedByInputBroadcast ? 'manual-broadcast-in-input' : 'sent_batch_pending-or-batch-locked'} sentPending=${!!replica.state.jBatchState.sentBatch} canTouchBatch=${canTouchBatch} queuedR2C=${queuedCount} queuedC2RExec=${selectedC2RExec.length}`,
      );
      emitRebalanceDebug({
        step: 3,
        status: 'blocked',
        event: 'j_broadcast_skipped',
        queuedCount: queuedCount + selectedC2RExec.length,
        sentBatchPending: !!replica.state.jBatchState.sentBatch,
      });
    }
  }

  if (localEntityTxs.length > 0) {
    outputs.push({
      entityId: replica.entityId,
      signerId,
      entityTxs: localEntityTxs,
    });
  }

  return outputs;
}
