/**
 * Settlement types - workspace, diffs, HTLC locks, swap offers
 */

import type { HankoString } from './core';

// ═══════════════════════════════════════════════════════════════
// SETTLEMENT DIFFS
// ═══════════════════════════════════════════════════════════════

/**
 * Settlement diff - single token operation in a settlement
 * CONSERVATION LAW: leftDiff + rightDiff + collateralDiff = 0
 */
export interface SettlementDiff {
  tokenId: number;
  leftDiff: bigint;       // Change to left's reserve (+ = credit, - = debit)
  rightDiff: bigint;      // Change to right's reserve
  collateralDiff: bigint; // Change to account collateral
  ondeltaDiff: bigint;    // Change to ondelta (tracks left's share)
}

/** Create SettlementDiff with conservation law validation: leftDiff + rightDiff + collateralDiff = 0 */
export const createSettlementDiff = (diff: SettlementDiff): SettlementDiff => {
  if (diff.leftDiff + diff.rightDiff + diff.collateralDiff !== 0n) {
    throw new Error(
      `FINTECH-SAFETY: Settlement conservation violation for token ${diff.tokenId}: ` +
      `leftDiff(${diff.leftDiff}) + rightDiff(${diff.rightDiff}) + collateralDiff(${diff.collateralDiff}) != 0`
    );
  }
  return diff;
};

// ═══════════════════════════════════════════════════════════════
// SETTLEMENT WORKSPACE
// ═══════════════════════════════════════════════════════════════

/**
 * Settlement workspace - shared editing area per bilateral account
 *
 * Flow:
 * 1. Either party creates workspace via settle_propose
 * 2. Both parties can update via settle_update (replaces diffs)
 * 3. Either party can approve via settle_approve (signs + bumps coopNonce)
 * 4. Initiator or counterparty executes via settle_execute (adds to jBatch)
 * 5. Execute or reject clears workspace
 */
interface SettlementWorkspaceBase {
  diffs: SettlementDiff[];                    // The settlement operations
  forgiveTokenIds: number[];                  // Debts to forgive (optional)
  insuranceRegs: Array<{                      // Insurance registrations (optional)
    insured: string;
    insurer: string;
    tokenId: number;
    limit: bigint;
    expiresAt: bigint;
  }>;

  // Metadata
  initiatedBy: 'left' | 'right';              // Who created the workspace
  memo?: string;                              // Human-readable description
  version: number;                            // Increments on each update
  createdAt: number;                          // Timestamp when created
  lastUpdatedAt: number;                      // Timestamp of last update

  // Broadcast responsibility: true = left broadcasts, false = right broadcasts
  // When cross-signed, this determines whose responsibility it is to submit on-chain.
  // Generally hub (larger batches = cheaper gas) should broadcast.
  broadcastByLeft: boolean;
}

export type SettlementWorkspace =
  | (SettlementWorkspaceBase & { status: 'draft' })
  | (SettlementWorkspaceBase & { status: 'awaiting_counterparty'; leftHanko?: HankoString; rightHanko?: HankoString })
  | (SettlementWorkspaceBase & { status: 'ready_to_submit'; leftHanko: HankoString; rightHanko: HankoString; cooperativeNonceAtSign: number });

// ═══════════════════════════════════════════════════════════════
// HTLC (Hash Time-Locked Contracts)
// ═══════════════════════════════════════════════════════════════

/**
 * HTLC Lock - Conditional payment held until secret reveal or timeout
 * Reference: 2024 StoredSubcontract (ChannelState.ts:4-11)
 */
export interface HtlcLock {
  lockId: string;              // keccak256(hash + height + nonce)
  hashlock: string;            // keccak256(abi.encode(secret)) - 32 bytes hex
  timelock: bigint;            // Expiry timestamp (unix-ms)
  revealBeforeHeight: number;  // J-block height deadline (enforced on-chain)
  amount: bigint;              // Locked amount
  tokenId: number;             // Token being locked
  senderIsLeft: boolean;       // Who initiated (canonical direction)
  createdHeight: number;       // AccountFrame height when created
  createdTimestamp: number;    // When lock was added (for logging)

  // Onion routing envelope (cleartext JSON in Phase 2, encrypted in Phase 3)
  envelope?: import('../htlc-envelope-types').HtlcEnvelope | string;
}

// Swap offer (limit order) in bilateral account
export interface SwapOffer {
  offerId: string;              // UUID for this offer
  giveTokenId: number;          // Token maker is giving
  giveAmount: bigint;           // Original amount (partial fills reduce this)
  wantTokenId: number;          // Token maker wants in return
  wantAmount: bigint;           // Corresponding want amount (maintains ratio)
  minFillRatio: number;         // 0-65535, minimum acceptable fill
  makerIsLeft: boolean;         // Who created this offer (canonical direction)
  createdHeight: number;        // AccountFrame height when created
  // Quantized amounts for orderbook consistency (set by hub when adding to book)
  // These ensure fill ratios computed from lots match settlement amounts exactly
  quantizedGive?: bigint;       // giveAmount rounded to LOT_SCALE multiple
  quantizedWant?: bigint;       // wantAmount scaled proportionally
}

/**
 * HTLC Routing Context (replaces 2024 User.hashlockMap)
 * Tracks inbound/outbound hops for automatic secret propagation
 */
export interface HtlcRoute {
  hashlock: string;

  // Inbound hop (who sent us this HTLC)
  inboundEntity?: string;
  inboundLockId?: string;

  // Outbound hop (who we forwarded to)
  outboundEntity?: string;
  outboundLockId?: string;

  // Resolution
  secret?: string;
  pendingFee?: bigint; // Fee to accrue on successful reveal (not on forward)
  createdTimestamp: number;
}

// ═══════════════════════════════════════════════════════════════
// AGGREGATED BOOKS (E-Machine view of A-Machine positions)
// ═══════════════════════════════════════════════════════════════

/** Aggregated swap order entry at E-Machine level */
export interface SwapBookEntry {
  offerId: string;
  accountId: string;        // counterparty entity ID where order lives
  giveTokenId: number;
  giveAmount: bigint;       // remaining amount
  wantTokenId: number;
  wantAmount: bigint;       // remaining want
  minFillRatio: number;
  createdAt: bigint;
}

/** Aggregated HTLC lock entry at E-Machine level */
export interface LockBookEntry {
  lockId: string;
  accountId: string;        // counterparty entity ID where lock lives
  tokenId: number;
  amount: bigint;
  hashlock: string;
  timelock: bigint;
  direction: 'outgoing' | 'incoming';
  createdAt: bigint;
}
