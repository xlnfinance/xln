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
import { QUOTE_EXPIRY_MS, REFERENCE_TOKEN_ID } from './types';
import { isLeftEntity } from './entity-id-utils';
import { resolveEntityProposerId } from './state-helpers';
import { deriveDelta } from './account-utils';

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
    intervalMs: 30000, // Check rebalance every 30s (production interval)
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

  // Get jurisdiction config from entity (set by server.ts after J-adapter init)
  const jurisdiction = replica.state.config.jurisdiction;
  if (!jurisdiction) {
    console.warn(`⚠️ No jurisdiction for entity ${replica.entityId.slice(-4)} - skipping batch broadcast`);
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
    (browserVM || undefined) as any,
    replica.state.timestamp,
    signerId,
  );

  if (result.success) {
    console.log(`✅ jBatch broadcasted successfully: ${result.txHash}`);

    // CRITICAL: Clear pendingBroadcast immediately after successful broadcast.
    // In RPC mode, HankoBatchProcessed j-event should also clear it, but if the
    // j-watcher is slow or events don't propagate, pendingBroadcast stays true
    // forever → blocks ALL future R2C/settlement operations.
    // Safe to clear here: the batch was submitted, worst case it gets re-submitted.
    if (replica.state.jBatchState) {
      replica.state.jBatchState.pendingBroadcast = false;
      // Also reset the batch to empty so new operations can be queued
      const { createEmptyBatch } = await import('./j-batch');
      if (typeof createEmptyBatch === 'function') {
        replica.state.jBatchState.batch = createEmptyBatch();
      }
      console.log(`✅ jBatch cleared: pendingBroadcast=false, batch reset`);
    }

    // CRITICAL: In BrowserVM mode, processBatch returns events directly.
    // There is no j-watcher to pick them up. We must inject them as j_event
    // entityTxs so the bilateral state (collateral, reserves) gets updated.
    // AccountSettled events must reach BOTH left and right entities for 2-of-2 consensus.
    if (result.events && result.events.length > 0) {
      const { isEventRelevantToEntity, rawEventToJEvents } = await import('./jadapter/helpers');
      console.log(`📥 BATCH-EVENTS: ${result.events.length} raw events from processBatch`);

      // Collect all entity IDs that exist in this runtime
      const allEntityIds: string[] = [];
      for (const [, r] of env.eReplicas) {
        if (r?.entityId) allEntityIds.push(String(r.entityId).toLowerCase());
      }

      const observedAt = replica.state.timestamp || 0;
      // For each entity, check which events are relevant and convert to j-event format
      for (const targetEntityId of allEntityIds) {
        const jEvents: Array<{ type: string; data: Record<string, any> }> = [];
        for (const rawEvent of result.events) {
          const eventName = rawEvent.event || rawEvent.eventName || rawEvent.name || 'unknown';
          const args = rawEvent.args || {};
          const blockNumber = Number(rawEvent.blockNumber ?? 0);
          // Check if this entity should see this event
          const relevant = isEventRelevantToEntity(
            { name: eventName, args, blockNumber, blockHash: '', transactionHash: '' },
            targetEntityId,
          );
          if (!relevant) continue;
          // Convert raw event to parsed j-event(s) for this entity
          const parsed = rawEventToJEvents(
            {
              name: eventName,
              args,
              blockNumber,
              blockHash: rawEvent.blockHash || '0x',
              transactionHash: rawEvent.transactionHash || result.txHash || '0x',
            },
            targetEntityId,
          );
          jEvents.push(...parsed);
        }
        if (jEvents.length === 0) continue;

        console.log(`📥 BATCH-EVENTS: ${jEvents.length} j-events for entity ${targetEntityId.slice(-4)}`);
        outputs.push({
          entityId: targetEntityId,
          signerId: 'j-event',
          entityTxs: [
            {
              type: 'j_event',
              data: {
                from: 'j-event',
                events: jEvents,
                observedAt,
                blockNumber: Number(result.events[0]?.blockNumber ?? 0),
                blockHash: result.events[0]?.blockHash || '0x',
                transactionHash: result.txHash || '0x',
              },
            },
          ],
        });
      }
    }

    // Generate success message
    outputs.push({
      entityId: replica.entityId,
      signerId: 'system',
      entityTxs: [
        {
          type: 'chatMessage',
          data: {
            message: `📤 Batch broadcasted: ${result.txHash?.slice(0, 16)}...`,
            timestamp: replica.state.timestamp,
            metadata: {
              type: 'BATCH_BROADCAST',
              txHash: result.txHash,
              eventsApplied: result.events?.length ?? 0,
            },
          },
        },
      ],
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
  // Only hubs should run the rebalance handler
  if (!replica.state.hubRebalanceConfig) return [];

  const outputs: EntityInput[] = [];
  const signerId = resolveEntityProposerId(_env, replica.entityId, 'hub-rebalance');
  const now = replica.state.timestamp; // DETERMINISTIC: use entity's own timestamp
  const strategy = replica.state.hubRebalanceConfig.matchingStrategy || 'hnw';
  const hubId = replica.entityId;

  // ═══════════════════════════════════════════════════════════════════
  // DIRECT R→C: Hub deposits collateral for users with uncollateralized debt.
  //
  // NO quotes. NO bilateral frames. Hub just adds R→C to jBatch.
  // R→C is UNILATERAL — hub is adding security, user always benefits.
  // broadcastBatchHandler will submit the jBatch on-chain.
  //
  // Reference: 2019src.txt lines 2973-3114 (rebalance_channels.ts)
  // ═══════════════════════════════════════════════════════════════════

  // Initialize jBatch if needed
  if (!replica.state.jBatchState) {
    const { initJBatch } = await import('./j-batch');
    replica.state.jBatchState = initJBatch();
  }

  // Skip if batch is pending broadcast (don't pile up operations)
  if (replica.state.jBatchState.pendingBroadcast) {
    return outputs;
  }

  // Effective reserves: actual + pending C→R amounts in batch
  const effectiveReserves = new Map<string, bigint>();
  for (const [tokenKey, amount] of replica.state.reserves.entries()) {
    effectiveReserves.set(tokenKey, amount);
  }

  // Collect R→C targets from TWO sources:
  // 1. User's explicit request_collateral (requestedRebalance map)
  // 2. Hub's own detection of uncollateralized debt > softLimit (fallback)
  type R2CTarget = { counterpartyId: string; tokenId: number; amount: bigint };
  const targets: R2CTarget[] = [];
  const handledTokens = new Set<string>(); // "counterpartyId:tokenId" → avoid duplicates

  for (const [counterpartyId, accountMachine] of replica.state.accounts.entries()) {
    const hubIsLeft = isLeftEntity(hubId, counterpartyId);

    // SOURCE 1: User-initiated request_collateral (highest priority)
    // User already paid the fee inline — hub just needs to fulfill the R→C.
    if (accountMachine.requestedRebalance && accountMachine.requestedRebalance.size > 0) {
      for (const [tokenId, requestedAmount] of accountMachine.requestedRebalance.entries()) {
        if (requestedAmount <= 0n) continue;
        const reserve = effectiveReserves.get(String(tokenId)) || 0n;
        const depositAmount = requestedAmount > reserve ? reserve : requestedAmount;
        if (depositAmount > 0n) {
          targets.push({ counterpartyId, tokenId, amount: depositAmount });
          effectiveReserves.set(String(tokenId), reserve - depositAmount);
          handledTokens.add(`${counterpartyId}:${tokenId}`);
          console.log(
            `🔄 R→C from user request: ${depositAmount} token ${tokenId} → ${counterpartyId.slice(-4)} (requested=${requestedAmount})`,
          );
        }
        // Clear the request (fulfilled or best-effort)
        accountMachine.requestedRebalance.delete(tokenId);
      }
    }

    // SOURCE 2: Hub auto-detection (fallback for accounts without explicit request)
    for (const [tokenId, delta] of accountMachine.deltas.entries()) {
      const key = `${counterpartyId}:${tokenId}`;
      if (handledTokens.has(key)) continue; // Already handled by user request

      const totalDelta = delta.ondelta + delta.offdelta;
      // Hub's debt to user: LEFT with negative total, or RIGHT with positive total
      const hubDebt = hubIsLeft ? (totalDelta < 0n ? -totalDelta : 0n) : totalDelta > 0n ? totalDelta : 0n;
      const uncollateralized = hubDebt > delta.collateral ? hubDebt - delta.collateral : 0n;

      // Default softLimit=0 (any debt triggers), or use explicit policy
      const policy = accountMachine.rebalancePolicy.get(tokenId);
      const softLimit = policy?.softLimit ?? 0n;

      if (uncollateralized > softLimit) {
        const reserve = effectiveReserves.get(String(tokenId)) || 0n;
        const depositAmount = uncollateralized > reserve ? reserve : uncollateralized;
        if (depositAmount > 0n) {
          targets.push({ counterpartyId, tokenId, amount: depositAmount });
          effectiveReserves.set(String(tokenId), reserve - depositAmount);
        }
      }
    }
  }

  // Sort by strategy (biggest first for HNW)
  if (strategy === 'hnw') {
    targets.sort((a, b) => Number(b.amount - a.amount));
  }

  // Add R→C directly to jBatch — no quotes, no bilateral frames
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
        console.log(
          `✅ R→C queued: ${target.amount} token ${target.tokenId} → ${target.counterpartyId.slice(-4)} (direct jBatch, no quotes)`,
        );
      } catch (err) {
        console.warn(`⚠️ R→C batch add failed for ${target.counterpartyId.slice(-4)}: ${(err as Error).message}`);
      }
    }
    console.log(`🔄 Hub rebalance: ${targets.length} R→C ops added to jBatch (awaiting broadcastBatch)`);
  }

  return outputs;
}
