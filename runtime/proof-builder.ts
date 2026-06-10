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
import type { AccountMachine } from './types.js';
import type {
  RuntimeProofBody,
  RuntimeTransformerClause,
  RuntimeBatch,
  RuntimePayment,
  RuntimePull,
  RuntimeSwap,
  RuntimeAllowance,
  ProofBodyResult,
  DisputeConfig,
} from './proof-body-types.ts';
import type { ProofBodyStruct, TransformerClauseStruct } from '../jurisdictions/typechain-types/contracts/Depository.sol/Depository.ts';
import type { DeltaTransformer } from '../jurisdictions/typechain-types/contracts/DeltaTransformer.ts';
import { PROOF_BODY_ABI, BATCH_ABI } from './proof-body-types.ts';
import { sortTransformerEntries } from './transformer-ordering.ts';

type DisputeHashAccount = Pick<AccountMachine, 'leftEntity' | 'rightEntity' | 'proofHeader'>;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const PROOF_BODY_PARAM = ethers.ParamType.from(PROOF_BODY_ABI);
const DELTA_BATCH_PARAM = ethers.ParamType.from(BATCH_ABI);

const isUsableContractAddress = (address: string | null | undefined): address is string =>
  typeof address === 'string' && ethers.isAddress(address) && address !== ZERO_ADDRESS;

const requireContractAddress = (label: string, address: string | null | undefined): string => {
  if (!isUsableContractAddress(address)) {
    throw new Error(`MISSING_${label.toUpperCase()}_ADDRESS`);
  }
  return address;
};

const addDeltaAllowance = (
  allowances: Map<number, { leftAllowance: bigint; rightAllowance: bigint }>,
  deltaIndex: number,
  signedDiff: bigint,
): void => {
  if (signedDiff === 0n) return;
  const entry = allowances.get(deltaIndex) ?? { leftAllowance: 0n, rightAllowance: 0n };
  if (signedDiff > 0n) entry.leftAllowance += signedDiff;
  else entry.rightAllowance += -signedDiff;
  allowances.set(deltaIndex, entry);
};

function buildTransformerAllowances(batch: RuntimeBatch): RuntimeAllowance[] {
  const allowances = new Map<number, { leftAllowance: bigint; rightAllowance: bigint }>();

  for (const payment of batch.payments) {
    addDeltaAllowance(allowances, payment.deltaIndex, payment.amount);
  }
  for (const swap of batch.swaps) {
    addDeltaAllowance(allowances, swap.addDeltaIndex, swap.addAmount);
    addDeltaAllowance(allowances, swap.subDeltaIndex, -swap.subAmount);
  }
  for (const pull of batch.pulls) {
    addDeltaAllowance(allowances, pull.deltaIndex, pull.amount);
  }

  return Array.from(allowances.entries())
    .sort(([a], [b]) => a - b)
    .map(([deltaIndex, allowance]) => ({
      deltaIndex,
      rightAllowance: allowance.rightAllowance,
      leftAllowance: allowance.leftAllowance,
    }));
}

// Set by BrowserVM / RPC adapter after real deployment or real connect.
let deltaTransformerAddress = '';

/**
 * Set the DeltaTransformer contract address
 * Called by BrowserVM after deploying the contract
 */
export function setDeltaTransformerAddress(address: string): void {
  deltaTransformerAddress = isUsableContractAddress(address) ? address : '';
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
  const pulls: RuntimePull[] = [];

  // Convert HTLC locks to Payment structs
  // DETERMINISTIC: Sort by lockId for consistent ordering
  const sortedLocks = sortTransformerEntries(accountMachine.locks.entries());

  for (const [lockId, lock] of sortedLocks) {
    const deltaIndex = tokenIds.indexOf(lock.tokenId);
    if (deltaIndex === -1) {
      // A live commitment without a delta slot is signed-state corruption. Do
      // not omit it from ProofBody: that would underclaim on-chain and make the
      // signed hash look valid while silently dropping money-affecting logic.
      throw new Error(`PROOF_BODY_LOCK_TOKEN_MISSING:${lockId}:${lock.tokenId}`);
    }

    // Amount sign convention:
    // If senderIsLeft=true, left is sending to right → positive amount
    // If senderIsLeft=false, right is sending to left → negative amount
    const signedAmount = lock.senderIsLeft ? lock.amount : -lock.amount;
    const revealedUntilTimestamp = Math.floor(Number(lock.timelock) / 1000);
    if (!Number.isFinite(revealedUntilTimestamp) || revealedUntilTimestamp <= 0) {
      throw new Error(`HTLC_LOCK_INVALID_TIMELOCK:${lockId}`);
    }

    payments.push({
      deltaIndex,
      amount: signedAmount,
      revealedUntilTimestamp,
      hash: lock.hashlock,
    });
  }

  // Convert SwapOffers to Swap structs
  // DETERMINISTIC: Sort by offerId for consistent ordering
  const sortedSwaps = sortTransformerEntries(accountMachine.swapOffers.entries());

  for (const [offerId, offer] of sortedSwaps) {
    if (offer.crossJurisdiction) continue;
    const addDeltaIndex = tokenIds.indexOf(offer.giveTokenId);
    const subDeltaIndex = tokenIds.indexOf(offer.wantTokenId);

    if (addDeltaIndex === -1 || subDeltaIndex === -1) {
      // Same invariant as HTLCs: every resting same-j swap must have both token
      // deltas in the proof. Missing one side means upstream state is corrupt.
      throw new Error(
        `PROOF_BODY_SWAP_TOKEN_MISSING:${offerId}:give=${offer.giveTokenId}:want=${offer.wantTokenId}`,
      );
    }

    swaps.push({
      ownerIsLeft: offer.makerIsLeft,
      addDeltaIndex,
      addAmount: offer.giveAmount,
      subDeltaIndex,
      subAmount: offer.wantAmount,
    });
  }

  const sortedPulls = sortTransformerEntries((accountMachine.pulls ?? new Map()).entries());
  for (const [pullId, pull] of sortedPulls) {
    const deltaIndex = tokenIds.indexOf(pull.tokenId);
    if (deltaIndex === -1) {
      // Pulls include hash-ladder claims. Skipping a missing token would let a
      // dispute proof omit the very claim that protects cross-j/salvage safety.
      throw new Error(`PROOF_BODY_PULL_TOKEN_MISSING:${pullId}:${pull.tokenId}`);
    }
    pulls.push({
      deltaIndex,
      amount: pull.amount,
      claimedRatio: Math.max(0, Math.min(65_535, Math.floor(Number(pull.claimedRatio ?? 0)))),
      revealedUntilTimestamp: pull.revealedUntilTimestamp,
      fullHash: pull.fullHash,
      partialRoot: pull.partialRoot,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 3: Build RuntimeBatch and RuntimeTransformerClause
  // ═══════════════════════════════════════════════════════════════════════════

  const batch: RuntimeBatch = {
    payments,
    swaps,
    pulls,
  };

  // Only include transformer if there are active programmable commitments.
  const transformers: RuntimeTransformerClause[] = [];
  if (payments.length > 0 || swaps.length > 0 || pulls.length > 0) {
    const transformerAddress = requireContractAddress('delta_transformer', deltaTransformerAddress);
    transformers.push({
      transformerAddress,
      batch,
      allowances: buildTransformerAllowances(batch),
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
    [PROOF_BODY_PARAM],
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
        revealedUntilTimestamp: BigInt(p.revealedUntilTimestamp),
        hash: p.hash,
      })),
      swap: t.batch.swaps.map(s => ({
        ownerIsLeft: s.ownerIsLeft,
        addDeltaIndex: BigInt(s.addDeltaIndex),
        addAmount: s.addAmount,
        subDeltaIndex: BigInt(s.subDeltaIndex),
        subAmount: s.subAmount,
      })),
      pull: t.batch.pulls.map(p => ({
        deltaIndex: BigInt(p.deltaIndex),
        amount: p.amount,
        claimedRatio: p.claimedRatio,
        revealedUntilTimestamp: BigInt(Math.floor(p.revealedUntilTimestamp / 1000)),
        fullHash: p.fullHash,
        partialRoot: p.partialRoot,
      })),
    };

    const encodedBatch = abiCoder.encode([DELTA_BATCH_PARAM], [batchStruct]);

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
 * @param starterInitialArguments - starter-side arguments for this proof body
 * @param starterIncrementedArguments - starter-side arguments for one known newer proof body
 */
export function buildInitialDisputeProof(
  accountMachine: AccountMachine,
  counterpartySignature: string,
  starterInitialArguments: string = '0x',
  starterIncrementedArguments: string = '0x',
): {
  counterentity: string;
  nonce: number;
  proofbodyHash: string;
  sig: string;
  starterInitialArguments: string;
  starterIncrementedArguments: string;
} {
  const { proofBodyHash } = buildAccountProofBody(accountMachine);

  return {
    counterentity: accountMachine.proofHeader.toEntity,
    nonce: accountMachine.proofHeader.nonce,
    proofbodyHash: proofBodyHash,
    sig: counterpartySignature,
    starterInitialArguments,
    starterIncrementedArguments,
  };
}

function getCanonicalAccountKey(accountMachine: DisputeHashAccount): string {
  const leftEntity = String(accountMachine.leftEntity).toLowerCase();
  const rightEntity = String(accountMachine.rightEntity).toLowerCase();
  const [first, second] =
    leftEntity < rightEntity
      ? [accountMachine.leftEntity, accountMachine.rightEntity]
      : [accountMachine.rightEntity, accountMachine.leftEntity];
  return ethers.solidityPacked(['bytes32', 'bytes32'], [first, second]);
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
  accountMachine: DisputeHashAccount,
  proofBodyHash: string,
  depositoryAddress: string
): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const chKey = getCanonicalAccountKey(accountMachine);

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
  accountMachine: DisputeHashAccount,
  proofBodyHash: string,
  depositoryAddress: string
): string {
  const encodedMessage = encodeDisputeMessage(
    accountMachine,
    proofBodyHash,
    requireContractAddress('depository', depositoryAddress),
  );
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
  accountMachine: DisputeHashAccount,
  proofBodyHash: string,
  depositoryAddress: string,
  nonce: number,
): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const chKey = getCanonicalAccountKey(accountMachine);
  const MESSAGE_TYPE_DISPUTE_PROOF = 1;
  const encodedMessage = abiCoder.encode(
    ['uint256', 'address', 'bytes', 'uint256', 'bytes32'],
    [
      MESSAGE_TYPE_DISPUTE_PROOF,
      requireContractAddress('depository', depositoryAddress),
      chKey,
      nonce,
      proofBodyHash,
    ]
  );
  return ethers.keccak256(encodedMessage);
}

/**
 * Default dispute config (conservative)
 * Values are encoded in 10-block units. 576 * 10 = 5760 blocks,
 * roughly 24 hours at 15-second block time.
 */
export const DEFAULT_DISPUTE_CONFIG: DisputeConfig = {
  leftDisputeDelay: 576,
  rightDisputeDelay: 576,
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
  // abi.encode(MessageType.CooperativeUpdate, address(this), acct_key, s.nonce, s.diffs, s.forgiveDebtsInTokenIds)
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
