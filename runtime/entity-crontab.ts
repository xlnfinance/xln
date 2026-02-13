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

import type { Env, EntityReplica, EntityInput, AccountMachine } from './types';
import { QUOTE_EXPIRY_MS, REFERENCE_TOKEN_ID } from './types';
import { isLeftEntity } from './entity-id-utils';
import { resolveEntityProposerId } from './state-helpers';

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
  id: string;                    // Unique ID (e.g., "htlc-timeout:0xabc...")
  triggerAt: number;             // Wall-clock ms — when this should fire
  type: string;                  // Hook type for routing (e.g., 'htlc_timeout')
  data: Record<string, any>;    // Payload passed to handler
}

export interface CrontabState {
  tasks: Map<string, CrontabTask>;
  hooks: Map<string, ScheduledHook>;
}

// Configuration constants
export const ACCOUNT_TIMEOUT_MS = 30000; // 30 seconds (configurable)
export const ACCOUNT_TIMEOUT_CHECK_INTERVAL_MS = 10000; // Check every 10 seconds

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

  tasks.set('broadcastBatch', {
    name: 'broadcastBatch',
    intervalMs: 5000, // Broadcast every 5 seconds (2019src.txt pattern)
    lastRun: 0,
    handler: broadcastBatchHandler,
  });

  tasks.set('hubRebalance', {
    name: 'hubRebalance',
    intervalMs: 30000, // Check rebalance opportunities every 30 seconds
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
  console.log(`⏰ HOOK scheduled: ${hook.type} id=${hook.id.slice(0,24)}... triggerAt=${hook.triggerAt}`);
}

/** Cancel a previously scheduled hook (e.g., lock resolved before timeout) */
export function cancelHook(state: CrontabState, hookId: string): void {
  if (!state.hooks) return;
  if (state.hooks.delete(hookId)) {
    console.log(`⏰ HOOK cancelled: ${hookId.slice(0,24)}...`);
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
  crontabState: CrontabState
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
    console.log(`⏰ HOOK FIRED: type=${hook.type} id=${hook.id.slice(0,24)}...`);

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
      entityTxs: [{
        type: 'processHtlcTimeouts',
        data: { expiredLocks: htlcTimeoutLocks }
      }]
    });
    console.log(`⏰ HOOKS: Generated processHtlcTimeouts for ${htlcTimeoutLocks.length} expired locks`);
  }

  return outputs;
}

/**
 * Check all accounts for timeout and suggest disputes
 *
 * Pattern from 2019src.txt lines 1622-1675:
 * - Iterate over all channels
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
          console.warn(`⏰ HTLC-IN-PENDING-EXPIRED: Account ${counterpartyId.slice(-4)} frame h${accountMachine.pendingFrame.height}, lock ${tx.data.lockId.slice(0,12)}... expired`);
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
        console.warn(`⏰ PENDING-FRAME-STALE: Account with ${counterpartyId.slice(-4)} h${accountMachine.pendingFrame.height} for ${Math.floor(frameAge / 1000)}s — consider dispute`);
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
        entityTxs: [{
          type: 'rollbackTimedOutFrames',
          data: { timedOutAccounts }
        }]
      });
      console.warn(`⏰ ROLLBACK: Generated rollbackTimedOutFrames for ${timedOutAccounts.length} accounts (HTLC expired in pendingFrame)`);
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

  console.log(`⏰ HTLC-TIMEOUT-CRON: Checking locks (entity ${replica.entityId.slice(-4)}, height=${currentHeight}, timestamp=${currentTimestamp})`);

  // Collect expired locks per account
  const expiredLocksByAccount: Array<{ accountId: string; lockId: string; lock: any }> = [];
  let totalLocks = 0;

  // Iterate over all accounts
  for (const [counterpartyId, accountMachine] of replica.state.accounts.entries()) {
    if (!accountMachine.locks || accountMachine.locks.size === 0) continue;

    totalLocks += accountMachine.locks.size;

    // Check each lock for expiration
    for (const [lockId, lock] of accountMachine.locks.entries()) {
      console.log(`⏰   Checking lock ${lockId.slice(0,16)}... (heightDeadline=${lock.revealBeforeHeight}, timeDeadline=${lock.timelock})`);

      // Check if lock expired - BOTH conditions (height OR timestamp)
      // Height: Used when J-blocks are active (on-chain settlement)
      // Timestamp: Fallback for off-chain timeout (entity's deterministic clock)
      const heightExpired = currentHeight > 0 && currentHeight > lock.revealBeforeHeight;
      const timestampExpired = currentTimestamp > Number(lock.timelock);
      const expired = heightExpired || timestampExpired;

      if (expired) {
        console.log(`⏰ HTLC-TIMEOUT: Lock ${lockId.slice(0,16)}... EXPIRED`);
        console.log(`   Height: ${currentHeight} > ${lock.revealBeforeHeight} = ${heightExpired}`);
        console.log(`   Timestamp: ${currentTimestamp} > ${lock.timelock} = ${timestampExpired}`);
        console.log(`   Account: ${counterpartyId.slice(-4)}, Amount: ${lock.amount}`);

        expiredLocksByAccount.push({
          accountId: counterpartyId,
          lockId,
          lock
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
        entityTxs: [{
          type: 'processHtlcTimeouts',
          data: { expiredLocks: expiredLocksByAccount }
        }]
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
 * Broadcast jBatch to Depository contract
 * Reference: 2019src.txt lines 3384-3399
 */
async function broadcastBatchHandler(env: Env, replica: EntityReplica): Promise<EntityInput[]> {
  const outputs: EntityInput[] = [];

  // Initialize jBatch on first use
  if (!replica.state.jBatchState) {
    const { initJBatch } = await import('./j-batch');
    replica.state.jBatchState = initJBatch();
  }

  const { shouldBroadcastBatch, isBatchEmpty } = await import('./j-batch');

  // Check if we should broadcast
  if (!shouldBroadcastBatch(replica.state.jBatchState, replica.state.timestamp)) {
    return outputs; // Nothing to broadcast yet
  }

  if (isBatchEmpty(replica.state.jBatchState.batch)) {
    return outputs;
  }

  console.log(`📤 CRONTAB: jBatch ready for broadcast (entity ${replica.entityId.slice(-4)})`);

  // Get jurisdiction from entity config
  const jurisdiction = replica.state.config.jurisdiction;
  if (!jurisdiction) {
    console.warn(`⚠️ No jurisdiction configured for entity ${replica.entityId.slice(-4)} - skipping batch broadcast`);
    return outputs;
  }
  const signerId = replica.state.config.validators[0];
  if (!signerId) {
    console.warn(`⚠️ No signerId for entity ${replica.entityId.slice(-4)} - cannot sign batch`);
    return outputs;
  }

  // Get BrowserVM instance from runtime (proper architecture - not window global)
  const { getBrowserVMInstance } = await import('./evm');
  const browserVM = getBrowserVMInstance(env);
  if (browserVM) {
    console.log(`📤 CRONTAB: Using BrowserVM for batch broadcast`);
  }

  // Broadcast batch to Depository contract (or BrowserVM in browser mode)
  const { broadcastBatch } = await import('./j-batch');
  const result = await broadcastBatch(
    env,
    replica.entityId,
    replica.state.jBatchState,
    jurisdiction,
    // BrowserVMInstance has processBatch at runtime, types are slightly mismatched
    (browserVM || undefined) as any,
    replica.state.timestamp,
    signerId
  );

  if (result.success) {
    console.log(`✅ jBatch broadcasted successfully: ${result.txHash}`);

    // Generate success message
    outputs.push({
      entityId: replica.entityId,
      signerId: 'system',
      entityTxs: [{
        type: 'chatMessage',
        data: {
          message: `📤 Batch broadcasted: ${result.txHash?.slice(0, 16)}...`,
          timestamp: replica.state.timestamp,
          metadata: {
            type: 'BATCH_BROADCAST',
            txHash: result.txHash,
          },
        },
      }],
    });
  } else {
    console.error(`❌ jBatch broadcast failed: ${result.error}`);
  }

  return outputs;
}

/**
 * Hub Rebalance Handler
 * Bilateral quote-based rebalance flow. See docs/rebalance.md for full spec.
 *
 * Phase 1: Execute accepted quotes (deposit_collateral + fee collection)
 * Phase 2: Send new quotes for accounts below softLimit or with pending requests
 *
 * Matching: configurable HNW (biggest first) or FIFO (oldest quote first)
 * Reference: 2019src.txt lines 2973-3114
 */
async function hubRebalanceHandler(_env: Env, replica: EntityReplica): Promise<EntityInput[]> {
  const outputs: EntityInput[] = [];
  const signerId = resolveEntityProposerId(_env, replica.entityId, 'hub-rebalance');
  const now = _env.timestamp;
  const strategy = replica.state.hubRebalanceConfig?.matchingStrategy || 'hnw';

  // Static fee: hub computes from config. V1 = flat $5 USDT.
  // TODO: server-side gas-aware fee computation
  const computeFee = (_amount: bigint): bigint => 5_000_000n; // $5 USDT (6 decimals)

  // Collect all actionable accounts
  type ActionItem = {
    counterpartyId: string;
    tokenId: number;
    amount: bigint;
    quote?: { quoteId: number; feeAmount: bigint; feeTokenId: number };
  };
  const toExecute: ActionItem[] = [];
  const toQuote: ActionItem[] = [];

  for (const [counterpartyId, accountMachine] of replica.state.accounts.entries()) {
    // Phase 1: Check for accepted, non-expired quotes → ready to execute
    const quote = accountMachine.activeRebalanceQuote;
    if (quote && quote.accepted && now <= quote.quoteId + QUOTE_EXPIRY_MS) {
      // Check hub has enough reserve
      const currentReserve = replica.state.reserves.get(String(quote.tokenId)) || 0n;
      if (currentReserve >= quote.amount) {
        toExecute.push({
          counterpartyId,
          tokenId: quote.tokenId,
          amount: quote.amount,
          quote: { quoteId: quote.quoteId, feeAmount: quote.feeAmount, feeTokenId: quote.feeTokenId },
        });
      } else {
        console.log(`⚠️  Insufficient reserve for ${counterpartyId.slice(-4)}: need ${quote.amount}, have ${currentReserve}`);
      }
      continue; // Don't re-quote while we have an active accepted quote
    }

    // Clear expired quotes
    if (quote && now > quote.quoteId + QUOTE_EXPIRY_MS) {
      accountMachine.activeRebalanceQuote = undefined;
    }

    // Phase 2a: Check pending manual requests → need quote
    const pendingReq = accountMachine.pendingRebalanceRequest;
    if (pendingReq) {
      const currentReserve = replica.state.reserves.get(String(pendingReq.tokenId)) || 0n;
      if (currentReserve >= pendingReq.targetAmount) {
        toQuote.push({
          counterpartyId,
          tokenId: pendingReq.tokenId,
          amount: pendingReq.targetAmount,
        });
      }
      continue;
    }

    // Phase 2b: Check absolute policy triggers (collateral < softLimit)
    for (const [tokenId, policy] of accountMachine.rebalancePolicy.entries()) {
      // Skip manual mode
      if (policy.softLimit === policy.hardLimit) continue;

      const delta = accountMachine.deltas.get(tokenId);
      if (!delta) continue;

      const currentCollateral = delta.collateral;
      if (currentCollateral < policy.softLimit) {
        const needed = policy.softLimit - currentCollateral;
        const currentReserve = replica.state.reserves.get(String(tokenId)) || 0n;
        if (currentReserve >= needed) {
          // Don't send new quote if there's already an active one for this token
          if (quote && quote.tokenId === tokenId) continue;
          toQuote.push({ counterpartyId, tokenId, amount: needed });
        }
      }
    }
  }

  // Sort by strategy
  if (strategy === 'hnw') {
    toExecute.sort((a, b) => Number(b.amount - a.amount));
    toQuote.sort((a, b) => Number(b.amount - a.amount));
  } else {
    // fifo: sort by quoteId ascending (oldest first)
    toExecute.sort((a, b) => (a.quote?.quoteId || 0) - (b.quote?.quoteId || 0));
    // For quotes, order doesn't matter much (all new)
  }

  // Execute accepted quotes: deposit_collateral + j_broadcast + fee
  for (const item of toExecute) {
    outputs.push({
      entityId: replica.entityId,
      signerId,
      entityTxs: [
        {
          type: 'deposit_collateral',
          data: {
            counterpartyId: item.counterpartyId,
            tokenId: item.tokenId,
            amount: item.amount,
            rebalanceQuoteId: item.quote!.quoteId,
            rebalanceFeeTokenId: item.quote!.feeTokenId,
            rebalanceFeeAmount: item.quote!.feeAmount,
          },
        },
        {
          type: 'j_broadcast',
          data: {},
        },
      ],
    });
    console.log(`✅ Executing rebalance: ${item.amount} token ${item.tokenId} → ${item.counterpartyId.slice(-4)} (fee: ${item.quote!.feeAmount})`);
  }

  // Send new quotes for accounts that need rebalancing
  for (const item of toQuote) {
    const fee = computeFee(item.amount);
    outputs.push({
      entityId: replica.entityId,
      signerId,
      entityTxs: [{
        type: 'sendRebalanceQuote',
        data: {
          counterpartyEntityId: item.counterpartyId,
          tokenId: item.tokenId,
          amount: item.amount,
          feeTokenId: REFERENCE_TOKEN_ID,
          feeAmount: fee,
        },
      }],
    });
    console.log(`💰 Sent quote: ${item.amount} token ${item.tokenId} → ${item.counterpartyId.slice(-4)} (fee: ${fee})`);
  }

  return outputs;
}
