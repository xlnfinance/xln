/**
 * ProofBody Types - ABI-compatible types for dispute proofs
 *
 * Re-exports typechain-generated types and adds runtime-specific interfaces.
 * These types MUST match Solidity structs exactly for on-chain dispute resolution.
 *
 * Reference: Types.sol, DeltaTransformer.sol
 */

// Re-export typechain types for external use
export type {
  ProofBodyStruct,
  ProofBodyStructOutput,
  TransformerClauseStruct,
  TransformerClauseStructOutput,
  AllowanceStruct,
  AllowanceStructOutput,
  InitialDisputeProofStruct,
  InitialDisputeProofStructOutput,
  FinalDisputeProofStruct,
  FinalDisputeProofStructOutput,
} from './typechain/Depository.js';

export type {
  DeltaTransformer,
} from './typechain/DeltaTransformer.js';

// Import for internal use
import type {
  ProofBodyStruct,
  TransformerClauseStruct,
  AllowanceStruct,
} from './typechain/Depository.js';

import type { DeltaTransformer } from './typechain/DeltaTransformer.js';

/**
 * Runtime-friendly ProofBody (uses native types, not BigNumberish)
 * Converted to ProofBodyStruct for ABI encoding
 */
export interface RuntimeProofBody {
  offdeltas: bigint[];           // int256[] - ondelta + offdelta per token
  tokenIds: number[];            // uint256[] - sorted ascending
  transformers: RuntimeTransformerClause[];
}

/**
 * Runtime-friendly TransformerClause
 */
export interface RuntimeTransformerClause {
  transformerAddress: string;    // DeltaTransformer contract address
  batch: RuntimeBatch;           // Decoded batch (not encoded bytes)
  allowances: RuntimeAllowance[];
}

/**
 * Runtime-friendly Batch (HTLCs + Swaps)
 */
export interface RuntimeBatch {
  payments: RuntimePayment[];
  swaps: RuntimeSwap[];
}

/**
 * Runtime-friendly Payment (HTLC)
 * Maps to DeltaTransformer.PaymentStruct
 */
export interface RuntimePayment {
  deltaIndex: number;            // Index in tokenIds array
  amount: bigint;                // int256 - positive = right owes left after reveal
  revealedUntilBlock: number;    // Block deadline for secret reveal
  hash: string;                  // bytes32 hashlock
}

/**
 * Runtime-friendly Swap
 * Maps to DeltaTransformer.SwapStruct
 */
export interface RuntimeSwap {
  ownerIsLeft: boolean;          // Who placed this order
  addDeltaIndex: number;         // Token to add (give token)
  addAmount: bigint;             // Amount to add
  subDeltaIndex: number;         // Token to subtract (want token)
  subAmount: bigint;             // Amount to subtract
}

/**
 * Runtime-friendly Allowance
 */
export interface RuntimeAllowance {
  deltaIndex: number;
  rightAllowance: bigint;
  leftAllowance: bigint;
}

/**
 * ProofBody build result - contains both runtime and ABI-encoded forms
 */
export interface ProofBodyResult {
  // Runtime representation (for storage/display)
  runtimeProofBody: RuntimeProofBody;

  // ABI-encoded representation (for on-chain submission)
  proofBodyStruct: ProofBodyStruct;
  encodedProofBody: string;      // ABI-encoded bytes

  // Hash for signing
  proofBodyHash: string;         // keccak256(encodedProofBody)
}

/**
 * Dispute configuration per bilateral account
 * Value * 10 = blocks. E.g.: 0=instant(unsafe), 1=10 blocks, 2=20 blocks
 */
export interface DisputeConfig {
  leftDisputeDelay: number;      // uint16 - left entity's required delay
  rightDisputeDelay: number;     // uint16 - right entity's required delay
}

/**
 * ABI fragment for ProofBody encoding
 * Must match Types.sol ProofBody struct exactly
 */
export const PROOF_BODY_ABI = {
  components: [
    { name: 'offdeltas', type: 'int256[]' },
    { name: 'tokenIds', type: 'uint256[]' },
    {
      name: 'transformers',
      type: 'tuple[]',
      components: [
        { name: 'transformerAddress', type: 'address' },
        { name: 'encodedBatch', type: 'bytes' },
        {
          name: 'allowances',
          type: 'tuple[]',
          components: [
            { name: 'deltaIndex', type: 'uint256' },
            { name: 'rightAllowance', type: 'uint256' },
            { name: 'leftAllowance', type: 'uint256' },
          ],
        },
      ],
    },
  ],
  name: 'proofBody',
  type: 'tuple',
} as const;

/**
 * ABI fragment for DeltaTransformer.Batch encoding
 * Must match DeltaTransformer.sol Batch struct exactly
 */
export const BATCH_ABI = {
  components: [
    {
      name: 'payment',
      type: 'tuple[]',
      components: [
        { name: 'deltaIndex', type: 'uint256' },
        { name: 'amount', type: 'int256' },
        { name: 'revealedUntilBlock', type: 'uint256' },
        { name: 'hash', type: 'bytes32' },
      ],
    },
    {
      name: 'swap',
      type: 'tuple[]',
      components: [
        { name: 'ownerIsLeft', type: 'bool' },
        { name: 'addDeltaIndex', type: 'uint256' },
        { name: 'addAmount', type: 'uint256' },
        { name: 'subDeltaIndex', type: 'uint256' },
        { name: 'subAmount', type: 'uint256' },
      ],
    },
  ],
  name: 'batch',
  type: 'tuple',
} as const;
