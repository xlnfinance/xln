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

import type { Env, EntityReplica, EntityInput, AccountMachine, SettlementOp } from './types';
import { isLeftEntity } from './entity-id-utils';
import { resolveEntityProposerId } from './state-helpers';
import { normalizeRebalanceMatchingStrategy } from './rebalance-policy';

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
}

// Configuration constants
export const ACCOUNT_TIMEOUT_MS = 30000; // 30 seconds (configurable)
export const ACCOUNT_TIMEOUT_CHECK_INTERVAL_MS = 10000; // Check every 10 seconds
export const HUB_REBALANCE_INTERVAL_MS = 3000; // Default production poll cadence (override via hub config if needed)
export const HUB_PENDING_BROADCAST_STALE_MS = 120000; // 2 minutes without finalize = stale
export const HUB_SUBMITTED_REQUEST_STALE_MS = 5 * 60 * 1000; // 5 minutes since jBatch handoff => mark as stale/manual

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

  return { tasks, hooks: new Map() };
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
      const hookOutputs = processDueHooks(dueHooks, replica);
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
function processDueHooks(hooks: ScheduledHook[], replica: EntityReplica): EntityInput[] {
  const outputs: EntityInput[] = [];
  const firstValidator = replica.state.config.validators?.[0];
  if (!firstValidator) return outputs;

  // Group expired locks by type for batch processing
  const htlcTimeoutLocks: Array<{ accountId: string; lockId: string }> = [];

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
        // Future: auto-finalize dispute after challenge period
        console.log(`⏰ HOOK: dispute_deadline — not yet implemented`);
        break;

      case 'settlement_window':
        // Future: auto-execute settlement after approval window
        console.log(`⏰ HOOK: settlement_window — not yet implemented`);
        break;

      case 'watchdog':
        // Future: detect unresponsive counterparty
        console.log(`⏰ HOOK: watchdog — not yet implemented`);
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
      // Non-HTLC pending frames: dispute suggestion after 30s
      const frameAge = now - accountMachine.pendingFrame.timestamp;
      if (frameAge > ACCOUNT_TIMEOUT_MS) {
        console.warn(
          `⏰ PENDING-FRAME-STALE: Account with ${counterpartyId.slice(-4)} h${accountMachine.pendingFrame.height} for ${Math.floor(frameAge / 1000)}s — consider dispute`,
        );
      }
    }
  }

  // Generate rollback EntityTx for accounts with expired HTLC locks in pending frames
  if (timedOutAccounts.length > 0) {
    const firstValidator = replica.state.config.validators?.[0];
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
  const signerId = resolveEntityProposerId(_env, replica.entityId, 'hub-rebalance');
  const now = replica.state.timestamp; // DETERMINISTIC: use entity's own timestamp
  const strategy = normalizeRebalanceMatchingStrategy(replica.state.hubRebalanceConfig.matchingStrategy);
  const rebalanceBaseFee = replica.state.hubRebalanceConfig.rebalanceBaseFee ?? 10n ** 17n;
  const rebalanceLiquidityFeeBps =
    replica.state.hubRebalanceConfig.rebalanceLiquidityFeeBps ??
    replica.state.hubRebalanceConfig.minFeeBps ??
    1n;
  const rebalanceGasFee = replica.state.hubRebalanceConfig.rebalanceGasFee ?? 0n;
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

  // Skip if batch is pending broadcast (don't pile up operations).
  // If the latch is stale, clear it so rebalance can recover.
  if (replica.state.jBatchState.pendingBroadcast) {
    const ageMs = now - (replica.state.jBatchState.lastBroadcast || 0);
    if (ageMs <= HUB_PENDING_BROADCAST_STALE_MS) {
      console.warn(
        `⏳ Hub rebalance blocked: pendingBroadcast=true age=${ageMs}ms (entity=${hubId.slice(-4)})`,
      );
      return outputs;
    }
    console.warn(
      `⚠️ Hub rebalance stale pendingBroadcast (${ageMs}ms) - clearing latch to unblock new R→C`,
    );
    replica.state.jBatchState.pendingBroadcast = false;
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
      const jBatchSubmittedAt = feeState.jBatchSubmittedAt || 0;
      const submittedAgeMs = jBatchSubmittedAt > 0 ? now - jBatchSubmittedAt : 0;
      const submittedBatchStale = jBatchSubmittedAt > 0 && submittedAgeMs >= HUB_SUBMITTED_REQUEST_STALE_MS;

      // Once a request is handed to J-batch, keep refund gates blocked while the
      // submission is fresh. If submission marker goes stale, re-enable refund gates
      // (policy/timeout/fee) but still block duplicate R→C enqueue below.
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

      // Stale already-submitted requests remain frozen for manual handling.
      if (jBatchSubmittedAt > 0) {
        // Stale in-flight requests are also skipped to avoid duplicate submissions.
        continue;
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

      // If handoff to J-batch went stale, keep request frozen until one of the
      // refund gates above applies (typically timeout). Avoid duplicate R→C enqueue.
      if (submittedBatchStale) {
        emitRebalanceDebug({
          step: 2,
          status: 'blocked',
          event: 'request_submitted_stale_manual',
          counterpartyId,
          tokenId,
          submittedAgeMs,
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

      const totalDelta = delta.ondelta + delta.offdelta;
      const hubDebt = hubIsLeft ? (totalDelta < 0n ? -totalDelta : 0n) : totalDelta > 0n ? totalDelta : 0n;
      const uncollateralized = hubDebt > delta.collateral ? hubDebt - delta.collateral : 0n;
      if (uncollateralized <= 0n) {
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

  // Add R→C directly to jBatch — no quotes, no bilateral frames.
  let queuedCount = 0;
  if (targets.length > 0) {
    const { batchAddReserveToCollateral } = await import('./j-batch');
    for (const target of targets) {
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
    if (queuedCount > 0) {
      console.log(`🔄 Hub rebalance: ${queuedCount} R→C ops queued, forcing immediate j_broadcast`);
      outputs.push({
        entityId: replica.entityId,
        signerId,
        entityTxs: [{ type: 'j_broadcast', data: {} }],
      });
      console.log(
        `[REB][3][BROADCAST_ENTITY_TX_QUEUED] hub=${hubId.slice(-8)} outputs=1 pendingBroadcast=${replica.state.jBatchState.pendingBroadcast}`,
      );
      emitRebalanceDebug({
        step: 3,
        status: 'ok',
        event: 'j_broadcast_queued',
        queuedCount,
        pendingBroadcast: !!replica.state.jBatchState.pendingBroadcast,
      });
      if (outputs.length === 0) {
        emitRebalanceDebug({
          step: 3,
          status: 'error',
          event: 'j_broadcast_not_queued',
          queuedCount,
        });
        throw new Error(`REB_STEP3_ASSERT_FAILED: queuedCount=${queuedCount} but no j_broadcast output`);
      }
    }
  }

  return outputs;
}
