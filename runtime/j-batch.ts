/**
 * J-Batch Aggregator System
 *
 * Accumulates entity operations into batches for atomic on-chain submission.
 * Pattern from 2019src.txt lines 3309-3399 (sharedState.batch + broadcastBatch)
 *
 * Design:
 * - Each entity accumulates operations in their jBatch
 * - Server periodically broadcasts batches (every 5s or when full)
 * - Batch is cleared after successful submission
 * - Failed batches are retried (with exponential backoff)
 */

import { safeStringify } from './serialization-utils';
import type { JurisdictionConfig } from './types';

/**
 * Batch structure matching Depository.sol (lines 203-231)
 */
export interface JBatch {
  // Reserve ↔ External Token (deposits/withdrawals to/from blockchain)
  reserveToExternalToken: Array<{
    receivingEntity: string;
    tokenId: number;
    amount: bigint;
  }>;
  externalTokenToReserve: Array<{
    entity: string;
    packedToken: string;
    internalTokenId: number;
    amount: bigint;
  }>;

  // Reserve ↔ Reserve (entity-to-entity transfers)
  reserveToReserve: Array<{
    receivingEntity: string;
    tokenId: number;
    amount: bigint;
  }>;

  // Reserve → Collateral (fund account)
  reserveToCollateral: Array<{
    tokenId: number;
    receivingEntity: string; // Which entity is depositing
    pairs: Array<{
      entity: string; // Counterparty in the account
      amount: bigint;
    }>;
  }>;

  // Settlements - MUST match Solidity Settlement struct exactly
  settlements: Array<{
    leftEntity: string;
    rightEntity: string;
    diffs: Array<{
      tokenId: number;
      leftDiff: bigint;
      rightDiff: bigint;
      collateralDiff: bigint;
      ondeltaDiff: bigint;
    }>;
    forgiveDebtsInTokenIds: number[];
    insuranceRegs: Array<{
      insured: string;
      insurer: string;
      tokenId: number;
      limit: bigint;
      expiresAt: bigint;
    }>;
    sig: string; // Signature (0x for testMode)
    entityProvider: string; // EntityProvider address
    hankoData: string; // Hanko signature data
    nonce: number; // Settlement nonce
  }>;

  // Dispute/Cooperative proofs (DEPRECATED in current Depository.sol - empty arrays for now)
  cooperativeUpdate: never[];
  cooperativeDisputeProof: never[];
  disputeStarts: never[];
  disputeFinalizations: never[];

  // Flashloans (for atomic batch execution)
  flashloans: Array<{
    tokenId: number;
    amount: bigint;
  }>;

  // Hub ID (for gas tracking)
  hub_id: number;
}

/**
 * JBatch state for an entity
 */
export interface JBatchState {
  batch: JBatch;
  jurisdiction: JurisdictionConfig | null; // Cached jurisdiction for this entity
  lastBroadcast: number; // Timestamp of last broadcast
  broadcastCount: number; // Total broadcasts
  failedAttempts: number; // Failed broadcast attempts (for exponential backoff)
}

/**
 * Create empty batch (2019src.txt line 3368)
 */
export function createEmptyBatch(): JBatch {
  return {
    flashloans: [],
    reserveToReserve: [],
    reserveToCollateral: [],
    settlements: [],
    disputeStarts: [], // Match Solidity: InitialDisputeProof[]
    disputeFinalizations: [], // Match Solidity: FinalDisputeProof[]
    externalTokenToReserve: [],
    reserveToExternalToken: [],
    hub_id: 0,
  };
}

/**
 * Initialize jBatch state for entity
 */
export function initJBatch(): JBatchState {
  return {
    batch: createEmptyBatch(),
    jurisdiction: null, // Will be set when first operation is added
    lastBroadcast: 0,
    broadcastCount: 0,
    failedAttempts: 0,
  };
}

/**
 * Check if batch has any operations
 */
export function isBatchEmpty(batch: JBatch): boolean {
  return (
    batch.flashloans.length === 0 &&
    batch.reserveToReserve.length === 0 &&
    batch.reserveToCollateral.length === 0 &&
    batch.settlements.length === 0 &&
    batch.disputeStarts.length === 0 &&
    batch.disputeFinalizations.length === 0 &&
    batch.externalTokenToReserve.length === 0 &&
    batch.reserveToExternalToken.length === 0
  );
}

/**
 * Add reserve → collateral operation to batch
 */
export function batchAddReserveToCollateral(
  jBatchState: JBatchState,
  entityId: string,
  counterpartyId: string,
  tokenId: number,
  amount: bigint
): void {
  // Check if we already have an R→C entry for this entity+counterparty+token
  // If yes, aggregate amounts
  const existing = jBatchState.batch.reserveToCollateral.find(
    op => op.receivingEntity === entityId && op.tokenId === tokenId
  );

  if (existing) {
    // Find the pair entry
    const pair = existing.pairs.find(p => p.entity === counterpartyId);
    if (pair) {
      pair.amount += amount; // Aggregate
    } else {
      existing.pairs.push({ entity: counterpartyId, amount });
    }
  } else {
    // Create new entry
    jBatchState.batch.reserveToCollateral.push({
      tokenId,
      receivingEntity: entityId,
      pairs: [{ entity: counterpartyId, amount }],
    });
  }

  console.log(`📦 jBatch: Added R→C ${amount} token ${tokenId} for ${entityId.slice(-4)}→${counterpartyId.slice(-4)}`);
}

/**
 * Insurance registration for settlement
 */
export interface InsuranceReg {
  insured: string;
  insurer: string;
  tokenId: number;
  limit: bigint;
  expiresAt: bigint;
}

/**
 * Add settlement operation to batch
 */
export function batchAddSettlement(
  jBatchState: JBatchState,
  leftEntity: string,
  rightEntity: string,
  diffs: Array<{
    tokenId: number;
    leftDiff: bigint;
    rightDiff: bigint;
    collateralDiff: bigint;
    ondeltaDiff: bigint;
  }>,
  forgiveDebtsInTokenIds: number[] = [],
  insuranceRegs: InsuranceReg[] = [],
  sig: string = '0x',
  entityProvider: string = '0x0000000000000000000000000000000000000000', // Default for testMode
  hankoData: string = '0x', // Default for testMode
  nonce: number = 0 // Default for testMode
): void {
  // Validate entities are in canonical order
  if (leftEntity >= rightEntity) {
    throw new Error(`Settlement entities must be ordered: ${leftEntity} >= ${rightEntity}`);
  }

  // Check if we already have a settlement for this pair
  const existing = jBatchState.batch.settlements.find(
    s => s.leftEntity === leftEntity && s.rightEntity === rightEntity
  );

  if (existing) {
    // Aggregate diffs by token
    for (const newDiff of diffs) {
      const existingDiff = existing.diffs.find(d => d.tokenId === newDiff.tokenId);
      if (existingDiff) {
        existingDiff.leftDiff += newDiff.leftDiff;
        existingDiff.rightDiff += newDiff.rightDiff;
        existingDiff.collateralDiff += newDiff.collateralDiff;
        existingDiff.ondeltaDiff += newDiff.ondeltaDiff;
      } else {
        existing.diffs.push(newDiff);
      }
    }
    // Append new insurance registrations
    existing.insuranceRegs.push(...insuranceRegs);
    // Append debt forgiveness (dedup)
    for (const tokenId of forgiveDebtsInTokenIds) {
      if (!existing.forgiveDebtsInTokenIds.includes(tokenId)) {
        existing.forgiveDebtsInTokenIds.push(tokenId);
      }
    }
  } else {
    jBatchState.batch.settlements.push({
      leftEntity,
      rightEntity,
      diffs,
      forgiveDebtsInTokenIds,
      insuranceRegs,
      sig,
      entityProvider, // testMode default
      hankoData, // testMode default
      nonce, // testMode default
    });
  }

  const insuranceMsg = insuranceRegs.length > 0 ? `, ${insuranceRegs.length} insurance regs` : '';
  console.log(`📦 jBatch: Added settlement ${leftEntity.slice(-4)}↔${rightEntity.slice(-4)}, ${diffs.length} tokens${insuranceMsg}`);
}

/**
 * Add insurance registration to existing settlement (or create new settlement)
 */
export function batchAddInsurance(
  jBatchState: JBatchState,
  leftEntity: string,
  rightEntity: string,
  insuranceReg: InsuranceReg
): void {
  // Validate entities are in canonical order
  const [left, right] = leftEntity < rightEntity ? [leftEntity, rightEntity] : [rightEntity, leftEntity];

  // Find or create settlement
  let existing = jBatchState.batch.settlements.find(
    s => s.leftEntity === left && s.rightEntity === right
  );

  if (!existing) {
    // Create empty settlement just for insurance
    existing = {
      leftEntity: left,
      rightEntity: right,
      diffs: [],
      forgiveDebtsInTokenIds: [],
      insuranceRegs: [],
      sig: '0x',
    };
    jBatchState.batch.settlements.push(existing);
  }

  existing.insuranceRegs.push(insuranceReg);
  console.log(`📦 jBatch: Added insurance ${insuranceReg.insurer.slice(-4)}→${insuranceReg.insured.slice(-4)}, ${insuranceReg.limit} limit`);
}

/**
 * Add reserve → reserve transfer to batch
 */
export function batchAddReserveToReserve(
  jBatchState: JBatchState,
  receivingEntity: string,
  tokenId: number,
  amount: bigint
): void {
  jBatchState.batch.reserveToReserve.push({
    receivingEntity,
    tokenId,
    amount,
  });

  console.log(`📦 jBatch: Added R→R ${amount} token ${tokenId} to ${receivingEntity.slice(-4)}`);
}

/**
 * Get batch size (total operations)
 */
export function getBatchSize(batch: JBatch): number {
  return (
    batch.flashloans.length +
    batch.reserveToReserve.length +
    batch.reserveToCollateral.length +
    batch.settlements.length +
    batch.disputeStarts.length +
    batch.disputeFinalizations.length +
    batch.externalTokenToReserve.length +
    batch.reserveToExternalToken.length
  );
}

/**
 * BrowserVM interface for batch processing
 * Matches frontend/src/lib/view/utils/browserVMProvider.ts
 */
export interface BrowserVMBatchProcessor {
  processBatch(entityId: string, batch: {
    reserveToReserve?: Array<{toEntity: string, tokenId: number, amount: bigint}>,
    reserveToCollateral?: Array<{counterparty: string, tokenId: number, amount: bigint}>,
    settlements?: Array<{leftEntity: string, rightEntity: string, diffs: any[]}>,
  }): Promise<any[]>;
}

/**
 * Broadcast batch to Depository contract (ethers or BrowserVM)
 * Reference: 2019src.txt lines 3384-3399
 */
export async function broadcastBatch(
  entityId: string,
  jBatchState: JBatchState,
  jurisdiction: any, // JurisdictionConfig
  browserVM?: BrowserVMBatchProcessor // Optional BrowserVM for simnet mode
): Promise<{ success: boolean; txHash?: string; events?: any[]; error?: string }> {
  if (isBatchEmpty(jBatchState.batch)) {
    console.log('📦 jBatch: Empty batch, skipping broadcast');
    return { success: true };
  }

  const batchSize = getBatchSize(jBatchState.batch);
  const b = jBatchState.batch;
  console.log(`📤 BATCH: ${entityId.slice(-4)} | ${batchSize} ops | R→C=${b.reserveToCollateral.length} S=${b.settlements.length} R→R=${b.reserveToReserve.length}`);

  try {
    // BrowserVM path - direct in-browser execution
    if (browserVM) {

      // Pass batch directly to contract (no transformation - Solidity handles everything)
      console.log(`📦 Calling Depository.processBatch() with full batch (${getBatchSize(jBatchState.batch)} ops)...`);
      const events = await browserVM.processBatch(entityId, jBatchState.batch);
      console.log(`   ✅ BrowserVM: ${events.length} events`);

      // NOTE: j-events are queued in env.runtimeInput.entityInputs by j-watcher
      // Caller must process them (prepopulate calls processJEvents, browser needs interval)

      // Clear batch after successful broadcast
      jBatchState.batch = createEmptyBatch();
      jBatchState.lastBroadcast = Date.now();
      jBatchState.broadcastCount++;
      jBatchState.failedAttempts = 0;

      return { success: true, events };
    }

    // Ethers path - real blockchain RPC
    const { connectToEthereum } = await import('./evm');
    const { depository } = await connectToEthereum(jurisdiction);

    // Submit to Depository.processBatch (same pattern as evm.ts:338)
    const tx = await depository['processBatch']!(entityId, jBatchState.batch, {
      gasLimit: 5000000, // High limit for complex batches
    });

    const receipt = await tx.wait();
    console.log(`   ✅ Ethers: block=${receipt.blockNumber} gas=${receipt.gasUsed}`);

    // Clear batch after successful broadcast
    jBatchState.batch = createEmptyBatch();
    jBatchState.lastBroadcast = receipt.blockNumber; // Use block number instead of Date.now() for determinism
    jBatchState.broadcastCount++;
    jBatchState.failedAttempts = 0;

    return {
      success: true,
      txHash: receipt.transactionHash,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`   ❌ BATCH FAIL: ${entityId.slice(-4)} | ${errorMessage}`);
    jBatchState.failedAttempts++;

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Check if batch should be broadcast
 * Triggers: batch full, timeout, or manual flush
 */
export function shouldBroadcastBatch(
  jBatchState: JBatchState,
  currentTimestamp: number
): boolean {
  if (isBatchEmpty(jBatchState.batch)) {
    return false;
  }

  const batchSize = getBatchSize(jBatchState.batch);
  const MAX_BATCH_SIZE = 50; // Max operations per batch
  const BATCH_TIMEOUT_MS = 5000; // Broadcast every 5s even if not full

  // Trigger 1: Batch is full
  if (batchSize >= MAX_BATCH_SIZE) {
    console.log(`📦 jBatch: Full (${batchSize}/${MAX_BATCH_SIZE}) - triggering broadcast`);
    return true;
  }

  // Trigger 2: Timeout since last broadcast
  const timeSinceLastBroadcast = currentTimestamp - jBatchState.lastBroadcast;
  if (timeSinceLastBroadcast >= BATCH_TIMEOUT_MS) {
    console.log(`📦 jBatch: Timeout (${timeSinceLastBroadcast}ms) - triggering broadcast`);
    return true;
  }

  return false;
}
