/**
 * Entity Crontab System
 *
 * Generalized periodic task execution within entity consensus.
 * Runs during applyEntityInput/applyEntityFrame to execute tasks at specified intervals.
 *
 * Design:
 * - Every N seconds, execute a function
 * - Tracks last execution time per task
 * - Runs inside entity processing (not a separate thread)
 * - Tasks are idempotent (safe to run multiple times)
 */

import type { Env, EntityReplica, EntityInput, AccountMachine } from './types';
import { isLeftEntity } from './entity-id-utils';

export interface CrontabTask {
  name: string;
  intervalMs: number; // How often to run (in milliseconds)
  lastRun: number; // Timestamp of last execution
  handler: (env: Env, replica: EntityReplica) => Promise<EntityInput[]>; // Returns messages to send
}

export interface CrontabState {
  tasks: Map<string, CrontabTask>;
}

// Configuration constants
export const ACCOUNT_TIMEOUT_MS = 30000; // 30 seconds (configurable)
export const ACCOUNT_TIMEOUT_CHECK_INTERVAL_MS = 10000; // Check every 10 seconds

/**
 * Initialize crontab state for an entity
 */
export function initCrontab(): CrontabState {
  const tasks = new Map<string, CrontabTask>();

  // Register default tasks
  tasks.set('checkAccountTimeouts', {
    name: 'checkAccountTimeouts',
    intervalMs: ACCOUNT_TIMEOUT_CHECK_INTERVAL_MS,
    lastRun: 0, // Never run yet
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

  tasks.set('checkHtlcTimeouts', {
    name: 'checkHtlcTimeouts',
    intervalMs: 5000, // Check HTLC expirations every 5 seconds
    lastRun: 0,
    handler: checkHtlcTimeoutsHandler,
  });

  return { tasks };
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

  for (const task of crontabState.tasks.values()) {
    const timeSinceLastRun = now - task.lastRun;

    if (timeSinceLastRun >= task.intervalMs) {
      // Removed verbose crontab logging (only log task completion)

      try {
        const outputs = await task.handler(env, replica);
        allOutputs.push(...outputs);

        // Update last run time
        task.lastRun = now;
        // Only log if outputs generated
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

  // Iterate over all accounts
  for (const [counterpartyId, accountMachine] of replica.state.accounts.entries()) {
    // Check if there's a pending frame waiting for ACK
    if (accountMachine.pendingFrame) {
      const frameAge = now - accountMachine.pendingFrame.timestamp;

      if (frameAge > ACCOUNT_TIMEOUT_MS) {
        console.warn(`⏰ TIMEOUT DETECTED: Account with ${counterpartyId.slice(-4)} has pending frame ${accountMachine.pendingFrame.height} for ${frameAge}ms`);
        console.warn(`   Frame timestamp: ${accountMachine.pendingFrame.timestamp}`);
        console.warn(`   Current time: ${now}`);
        console.warn(`   Age: ${frameAge}ms (threshold: ${ACCOUNT_TIMEOUT_MS}ms)`);

        // Generate chat message event for entity members to see
        const disputeSuggestion = createDisputeSuggestionEvent(
          replica,
          counterpartyId,
          accountMachine,
          frameAge
        );

        outputs.push(disputeSuggestion);

        console.warn(`💬 DISPUTE-SUGGESTION: Generated event for entity ${replica.entityId.slice(-4)}`);
        console.warn(`   Counterparty: ${counterpartyId.slice(-4)}`);
        console.warn(`   Frame: ${accountMachine.pendingFrame.height}`);
        console.warn(`   Age: ${Math.floor(frameAge / 1000)}s`);
      }
    }
  }

  return outputs;
}

/**
 * Create a chat message suggesting dispute to entity members
 *
 * This doesn't auto-initiate dispute - it's up to entity signers to decide.
 * Frame stays in "sent" status.
 */
function createDisputeSuggestionEvent(
  replica: EntityReplica,
  counterpartyId: string,
  accountMachine: AccountMachine,
  frameAge: number
): EntityInput {
  const message = `🚨 DISPUTE SUGGESTION: Account with ${counterpartyId.slice(-4)} has not acknowledged frame #${accountMachine.pendingFrame!.height} for ${Math.floor(frameAge / 1000)}s (threshold: ${Math.floor(ACCOUNT_TIMEOUT_MS / 1000)}s). Consider initiating dispute or investigating network issues.`;

  // Create a chat message entity transaction
  // For now, just create an EntityInput with a message
  // In production, this would be a proper EntityTx that gets added to mempool
  return {
    entityId: replica.entityId,
    signerId: 'system', // System-generated message
    entityTxs: [
      {
        type: 'chatMessage',
        data: {
          message,
          timestamp: replica.state.timestamp, // DETERMINISTIC: Use entity's own timestamp
          metadata: {
            type: 'DISPUTE_SUGGESTION',
            counterpartyId,
            height: accountMachine.pendingFrame!.height,
            frameAge,
          },
        },
      }
    ],
  };
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
 * Scans all accounts, matches net-spenders with net-receivers
 * Reference: 2019src.txt lines 2973-3114
 */
async function hubRebalanceHandler(_env: Env, replica: EntityReplica): Promise<EntityInput[]> {
  const outputs: EntityInput[] = [];
  // Removed verbose scan start log

  const { deriveDelta } = await import('./account-utils');

  const tokenAccountMap = new Map<number, {
    netSpenders: Array<{ entityId: string; debt: bigint; collateral: bigint }>;
    netReceivers: Array<{ entityId: string; requested: bigint }>;
  }>();

  for (const [counterpartyId, accountMachine] of replica.state.accounts.entries()) {
    for (const [tokenId, delta] of accountMachine.deltas.entries()) {
      const weAreLeft = isLeftEntity(replica.entityId, counterpartyId);
      const derived = deriveDelta(delta, weAreLeft);

      if (derived.delta < 0n) {
        const debtAmount = -derived.delta;
        if (debtAmount > 0n) {
          if (!tokenAccountMap.has(tokenId)) {
            tokenAccountMap.set(tokenId, { netSpenders: [], netReceivers: [] });
          }
          tokenAccountMap.get(tokenId)!.netSpenders.push({
            entityId: counterpartyId,
            debt: debtAmount,
            collateral: delta.collateral,
          });
        }
      }

      const requestedRebalance = accountMachine.requestedRebalance.get(tokenId);
      if (requestedRebalance && requestedRebalance > 0n) {
        if (!tokenAccountMap.has(tokenId)) {
          tokenAccountMap.set(tokenId, { netSpenders: [], netReceivers: [] });
        }
        tokenAccountMap.get(tokenId)!.netReceivers.push({
          entityId: counterpartyId,
          requested: requestedRebalance,
        });
      }
    }
  }

  for (const [tokenId, { netSpenders, netReceivers }] of tokenAccountMap.entries()) {
    if (netSpenders.length === 0 || netReceivers.length === 0) continue;

    const totalDebt = netSpenders.reduce((sum, s) => sum + s.debt, 0n);
    const totalRequested = netReceivers.reduce((sum, r) => sum + r.requested, 0n);
    const rebalanceAmount = totalDebt < totalRequested ? totalDebt : totalRequested;

    if (rebalanceAmount === 0n) continue;

    console.log(`🔄 REBALANCE OPPORTUNITY token ${tokenId}: ${rebalanceAmount}`);

    const message = `🔄 REBALANCE OPPORTUNITY (Token ${tokenId}):
Spenders: ${netSpenders.length} (debt: ${totalDebt})
Receivers: ${netReceivers.length} (requested: ${totalRequested})
Match: ${rebalanceAmount} (${Number(rebalanceAmount * 100n) / Number(totalDebt || 1n)}%)`;

    outputs.push({
      entityId: replica.entityId,
      signerId: 'system',
      entityTxs: [{
        type: 'chatMessage',
        data: {
          message,
          timestamp: replica.state.timestamp,
          metadata: {
            type: 'REBALANCE_OPPORTUNITY',
            tokenId,
            rebalanceAmount: rebalanceAmount.toString(),
          },
        },
      }],
    });
  }

  return outputs;
}
