/**
 * ProofBody Builder - Constructs ABI-encoded dispute proofs from AccountMachine state
 *
 * This module bridges runtime AccountMachine state to on-chain dispute proofs.
 * The proofBodyHash is what gets signed for bilateral consensus AND dispute submission.
 *
 * Reference: 2024 Channel.ts lines 434-546, Types.sol, DeltaTransformer.sol
 *
 * CRITICAL: Deterministic ordering is essential for consensus.
 * Both sides must compute identical proofBodyHash from identical state.
 */

import { ethers } from 'ethers';
import type { AccountMachine, HtlcLock, SwapOffer, Delta } from './types.js';
import type {
  RuntimeProofBody,
  RuntimeTransformerClause,
  RuntimeBatch,
  RuntimePayment,
  RuntimeSwap,
  RuntimeAllowance,
  ProofBodyResult,
  DisputeConfig,
} from './proof-body-types.js';
import type { ProofBodyStruct, TransformerClauseStruct } from './typechain/Depository.js';
import type { DeltaTransformer } from './typechain/DeltaTransformer.js';
import { PROOF_BODY_ABI, BATCH_ABI } from './proof-body-types.js';

// Default DeltaTransformer address - set by BrowserVM on deploy
let deltaTransformerAddress: string = '0x0000000000000000000000000000000000000000';

/**
 * Set the DeltaTransformer contract address
 * Called by BrowserVM after deploying the contract
 */
export function setDeltaTransformerAddress(address: string): void {
  deltaTransformerAddress = address;
  console.log(`[ProofBuilder] DeltaTransformer address set: ${address}`);
}

/**
 * Get the current DeltaTransformer contract address
 */
export function getDeltaTransformerAddress(): string {
  return deltaTransformerAddress;
}

/**
 * Build ABI-encoded ProofBody from AccountMachine state
 *
 * This is the core function that transforms runtime state into on-chain proof format.
 * The resulting proofBodyHash is signed during bilateral consensus.
 *
 * @param accountMachine - Current bilateral account state
 * @returns ProofBodyResult with runtime, struct, encoded, and hash forms
 */
export function buildAccountProofBody(accountMachine: AccountMachine): ProofBodyResult {
  // ═══════════════════════════════════════════════════════════════════════════
  // Step 1: Extract and sort deltas (DETERMINISTIC ordering by tokenId)
  // ═══════════════════════════════════════════════════════════════════════════

  const sortedDeltas = Array.from(accountMachine.deltas.entries())
    .sort((a, b) => a[0] - b[0]); // Sort by tokenId ascending

  const tokenIds: number[] = [];
  const offdeltas: bigint[] = [];

  for (const [tokenId, delta] of sortedDeltas) {
    tokenIds.push(tokenId);
    // proofbody.offdeltas = ONLY the off-chain component
    // Contract adds on-chain ondelta separately from storage
    offdeltas.push(delta.offdelta);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 2: Build transformer batch (HTLCs + Swaps)
  // ═══════════════════════════════════════════════════════════════════════════

  const payments: RuntimePayment[] = [];
  const swaps: RuntimeSwap[] = [];

  // Convert HTLC locks to Payment structs
  // DETERMINISTIC: Sort by lockId for consistent ordering
  const sortedLocks = Array.from(accountMachine.locks.entries())
    .sort((a, b) => a[0].localeCompare(b[0]));

  for (const [lockId, lock] of sortedLocks) {
    const deltaIndex = tokenIds.indexOf(lock.tokenId);
    if (deltaIndex === -1) {
      console.warn(`[ProofBuilder] Lock ${lockId} references unknown tokenId ${lock.tokenId}`);
      continue;
    }

    // Amount sign convention:
    // If senderIsLeft=true, left is sending to right → positive amount
    // If senderIsLeft=false, right is sending to left → negative amount
    const signedAmount = lock.senderIsLeft ? lock.amount : -lock.amount;

    payments.push({
      deltaIndex,
      amount: signedAmount,
      revealedUntilBlock: lock.revealBeforeHeight,
      hash: lock.hashlock,
    });
  }

  // Convert SwapOffers to Swap structs
  // DETERMINISTIC: Sort by offerId for consistent ordering
  const sortedSwaps = Array.from(accountMachine.swapOffers.entries())
    .sort((a, b) => a[0].localeCompare(b[0]));

  for (const [offerId, offer] of sortedSwaps) {
    const addDeltaIndex = tokenIds.indexOf(offer.giveTokenId);
    const subDeltaIndex = tokenIds.indexOf(offer.wantTokenId);

    if (addDeltaIndex === -1 || subDeltaIndex === -1) {
      console.warn(`[ProofBuilder] Swap ${offerId} references unknown tokenId`);
      continue;
    }

    swaps.push({
      ownerIsLeft: offer.makerIsLeft,
      addDeltaIndex,
      addAmount: offer.giveAmount,
      subDeltaIndex,
      subAmount: offer.wantAmount,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 3: Build RuntimeBatch and RuntimeTransformerClause
  // ═══════════════════════════════════════════════════════════════════════════

  const batch: RuntimeBatch = {
    payments,
    swaps,
  };

  // Only include transformer if there are HTLCs or swaps
  const transformers: RuntimeTransformerClause[] = [];
  if (payments.length > 0 || swaps.length > 0) {
    transformers.push({
      transformerAddress: deltaTransformerAddress,
      batch,
      allowances: [], // Phase 2: Stub with empty array
    });
  }

  const runtimeProofBody: RuntimeProofBody = {
    offdeltas,
    tokenIds,
    transformers,
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 4: Convert to ABI-compatible structs
  // ═══════════════════════════════════════════════════════════════════════════

  const proofBodyStruct = runtimeToProofBodyStruct(runtimeProofBody);

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 5: ABI-encode and hash
  // ═══════════════════════════════════════════════════════════════════════════

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();

  // Encode ProofBody struct
  const encodedProofBody = abiCoder.encode(
    [PROOF_BODY_ABI as any],
    [proofBodyStruct]
  );

  // Hash for signing
  const proofBodyHash = ethers.keccak256(encodedProofBody);

  return {
    runtimeProofBody,
    proofBodyStruct,
    encodedProofBody,
    proofBodyHash,
  };
}

/**
 * Convert RuntimeProofBody to ABI-compatible ProofBodyStruct
 */
function runtimeToProofBodyStruct(runtime: RuntimeProofBody): ProofBodyStruct {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();

  const transformers: TransformerClauseStruct[] = runtime.transformers.map(t => {
    // Encode batch to bytes
    const batchStruct: DeltaTransformer.BatchStruct = {
      payment: t.batch.payments.map(p => ({
        deltaIndex: BigInt(p.deltaIndex),
        amount: p.amount,
        revealedUntilBlock: BigInt(p.revealedUntilBlock),
        hash: p.hash,
      })),
      swap: t.batch.swaps.map(s => ({
        ownerIsLeft: s.ownerIsLeft,
        addDeltaIndex: BigInt(s.addDeltaIndex),
        addAmount: s.addAmount,
        subDeltaIndex: BigInt(s.subDeltaIndex),
        subAmount: s.subAmount,
      })),
    };

    const encodedBatch = abiCoder.encode([BATCH_ABI as any], [batchStruct]);

    return {
      transformerAddress: t.transformerAddress,
      encodedBatch,
      allowances: t.allowances.map(a => ({
        deltaIndex: BigInt(a.deltaIndex),
        rightAllowance: a.rightAllowance,
        leftAllowance: a.leftAllowance,
      })),
    };
  });

  return {
    offdeltas: runtime.offdeltas,
    tokenIds: runtime.tokenIds.map(id => BigInt(id)),
    transformers,
  };
}

/**
 * Build InitialDisputeProof for submitting to Account.sol
 *
 * @param accountMachine - Current bilateral account state
 * @param counterpartySignature - Counterparty's signature on proofBodyHash
 * @param initialArguments - ABI-encoded initial arguments (leftArguments for left, rightArguments for right)
 */
export function buildInitialDisputeProof(
  accountMachine: AccountMachine,
  counterpartySignature: string,
  initialArguments: string = '0x'
): {
  counterentity: string;
  nonce: number;
  proofbodyHash: string;
  sig: string;
  initialArguments: string;
} {
  const { proofBodyHash } = buildAccountProofBody(accountMachine);

  return {
    counterentity: accountMachine.proofHeader.toEntity,
    nonce: accountMachine.proofHeader.nonce,
    proofbodyHash: proofBodyHash,
    sig: counterpartySignature,
    initialArguments,
  };
}

/**
 * Encode dispute message for signing (matches Account.sol verifyDisputeProofHanko)
 *
 * MessageType.DisputeProof = 1
 * Format: abi.encode(MessageType.DisputeProof, depository, account_key, nonce, proofbodyHash)
 *
 * The depository address binds the proof to a specific chain+depository for replay protection.
 */
export function encodeDisputeMessage(
  accountMachine: AccountMachine,
  proofBodyHash: string,
  depositoryAddress: string
): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();

  // Account key is canonical (left:right)
  const leftEntity = accountMachine.leftEntity;
  const rightEntity = accountMachine.rightEntity;
  const chKey = ethers.solidityPacked(
    ['bytes32', 'bytes32'],
    [leftEntity, rightEntity]
  );

  // MessageType.DisputeProof = 1
  const MESSAGE_TYPE_DISPUTE_PROOF = 1;

  return abiCoder.encode(
    ['uint256', 'address', 'bytes', 'uint256', 'bytes32'],
    [
      MESSAGE_TYPE_DISPUTE_PROOF,
      depositoryAddress,
      chKey,
      accountMachine.proofHeader.nonce,
      proofBodyHash,
    ]
  );
}

/**
 * Create full dispute proof hash for signing
 * This is what both parties sign to authorize a dispute proof
 */
export function createDisputeProofHash(
  accountMachine: AccountMachine,
  proofBodyHash: string,
  depositoryAddress: string
): string {
  const encodedMessage = encodeDisputeMessage(accountMachine, proofBodyHash, depositoryAddress);
  return ethers.keccak256(encodedMessage);
}

/**
 * Create dispute proof hash with explicit nonce.
 * Used for nonce+1 pre-signing during settlement: after a settlement is applied
 * on-chain, nonce is incremented. Proofs signed at the old nonce
 * become invalid. Pre-signing at nonce+1 ensures valid dispute proofs exist
 * immediately after settlement.
 *
 * proofBodyHash is UNCHANGED by settlement (settlement modifies ondelta/collateral,
 * but proofBody only includes offdelta). So the same proofBodyHash can be re-signed
 * at the new nonce.
 */
export function createDisputeProofHashWithNonce(
  accountMachine: AccountMachine,
  proofBodyHash: string,
  depositoryAddress: string,
  nonce: number,
): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const chKey = ethers.solidityPacked(
    ['bytes32', 'bytes32'],
    [accountMachine.leftEntity, accountMachine.rightEntity]
  );
  const MESSAGE_TYPE_DISPUTE_PROOF = 1;
  const encodedMessage = abiCoder.encode(
    ['uint256', 'address', 'bytes', 'uint256', 'bytes32'],
    [
      MESSAGE_TYPE_DISPUTE_PROOF,
      depositoryAddress,
      chKey,
      nonce,
      proofBodyHash,
    ]
  );
  return ethers.keccak256(encodedMessage);
}

/**
 * Default dispute config (conservative)
 * 2 * 10 = 20 blocks delay for both sides
 */
export const DEFAULT_DISPUTE_CONFIG: DisputeConfig = {
  leftDisputeDelay: 2,  // 20 blocks
  rightDisputeDelay: 2, // 20 blocks
};

/**
 * Calculate actual block delay from config value
 * Value * 10 = blocks
 */
export function getDisputeDelayBlocks(configValue: number): number {
  return configValue * 10;
}

/**
 * Create settlement hash for bilateral signature with explicit nonce
 * Matches Account.sol CooperativeUpdate encoding
 * @param nonce The on-chain nonce for cooperative settlement
 *
 * The depository address binds the settlement to a specific chain+depository for replay protection.
 */
export function createSettlementHashWithNonce(
  accountMachine: AccountMachine,
  diffs: Array<{
    tokenId: number;
    leftDiff: bigint;
    rightDiff: bigint;
    collateralDiff: bigint;
    ondeltaDiff: bigint;
  }>,
  depositoryAddress: string,
  nonce: number
): string {
  // Account key is canonical (left:right)
  const accountKey = ethers.solidityPacked(
    ['bytes32', 'bytes32'],
    [accountMachine.leftEntity, accountMachine.rightEntity]
  );

  // Match Account.sol CooperativeUpdate encoding exactly:
  // abi.encode(MessageType.CooperativeUpdate, address(this), ch_key, s.nonce, s.diffs, s.forgiveDebtsInTokenIds)
  const MESSAGE_TYPE_COOPERATIVE_UPDATE = 0;
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encodedMsg = abiCoder.encode(
    ['uint256', 'address', 'bytes', 'uint256', 'tuple(uint256,int256,int256,int256,int256)[]', 'uint256[]'],
    [
      MESSAGE_TYPE_COOPERATIVE_UPDATE,
      depositoryAddress,
      accountKey,
      nonce,
      diffs.map(d => [d.tokenId, d.leftDiff, d.rightDiff, d.collateralDiff, d.ondeltaDiff]),
      [], // forgiveDebtsInTokenIds
    ]
  );

  return ethers.keccak256(encodedMsg);
}
