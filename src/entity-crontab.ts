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

import type { EntityReplica, EntityInput, AccountMachine } from './types';

export interface CrontabTask {
  name: string;
  intervalMs: number; // How often to run (in milliseconds)
  lastRun: number; // Timestamp of last execution
  handler: (replica: EntityReplica) => Promise<EntityInput[]>; // Returns messages to send
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

  return { tasks };
}

/**
 * Execute all due crontab tasks
 * Called during entity input processing
 * Uses entity-specific timestamp for determinism (each entity has own clock from frames)
 */
export async function executeCrontab(
  replica: EntityReplica,
  crontabState: CrontabState
): Promise<EntityInput[]> {
  const now = replica.state.timestamp; // DETERMINISTIC: Use entity's own timestamp
  const allOutputs: EntityInput[] = [];

  for (const task of crontabState.tasks.values()) {
    const timeSinceLastRun = now - task.lastRun;

    if (timeSinceLastRun >= task.intervalMs) {
      console.log(`⏰ CRONTAB: Running task "${task.name}" (${timeSinceLastRun}ms since last run)`);

      try {
        const outputs = await task.handler(replica);
        allOutputs.push(...outputs);

        // Update last run time
        task.lastRun = now;
        console.log(`✅ CRONTAB: Task "${task.name}" completed, generated ${outputs.length} outputs`);
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
async function checkAccountTimeoutsHandler(replica: EntityReplica): Promise<EntityInput[]> {
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
