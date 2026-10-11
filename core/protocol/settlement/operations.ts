/**
 * Settlement Operations Compiler
 *
 * Compiles typed SettlementOp[] into SettlementDiff[] for on-chain execution.
 * All ops are from the PROPOSER's perspective (the entity that created/last-modified the workspace).
 *
 * Conservation law: leftDiff + rightDiff + collateralDiff = 0 for every diff.
 * ondeltaDiff tracks left's share change (left operations change ondelta, right don't).
 *
 * Reference: types.ts SettlementOp / SettlementDiff
 */

import type { AccountReplica, SettlementOp, SettlementDiff } from '../../types/account';
import { TOKENS } from '../../config/constants';
import { UINT256_MAX } from '../boundary/integer-ranges';
const MAX_SETTLEMENT_DIFFS = 32;
const MAX_SETTLEMENT_FORGIVENESS_IDS = 32;

export const assertSettlementTokenId = (value: unknown, context: string): number => {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || value > TOKENS.MAX_TOKEN_ID
  ) {
    throw new Error(`SETTLEMENT_TOKEN_INVALID:${context}:${String(value)}`);
  }
  return value;
};

/**
 * Cooperative settlement and both sides' dispute proofs share the Account
 * contract nonce. Every bilateral replica therefore chooses above every
 * locally-known signed proof, not merely above its own signing cursor.
 */
export class AccountNonceExhaustedError extends Error {
  constructor(value: number) {
    super(`SETTLEMENT_NONCE_EXHAUSTED:${String(value)}`);
    this.name = 'AccountNonceExhaustedError';
  }
}

const assertSettlementNonceCursor = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new AccountNonceExhaustedError(value);
  }
  return value;
};

export const getMinimumSafeSettlementNonce = (account: AccountReplica): number =>
  assertSettlementNonceCursor(Math.max(
    Number(account.state.jNonce ?? 0) + 1,
    Number(account.proofHeader?.nextProofNonce ?? 0),
    Number(account.currentDisputeProofNonce ?? 0) + 1,
    Number(account.counterpartyDisputeProofNonce ?? 0) + 1,
  ));

export const getNextSettlementNonce = (account: AccountReplica): number => {
  // `nextProofNonce` is already the first unused bilateral proof nonce. Adding
  // one here silently skipped a nonce on one replica and was the root cause of
  // the settlement-hanko divergence. The exact candidate must be derived from
  // committed cursors only and then agreed byte-for-byte by both Account sides.
  return getMinimumSafeSettlementNonce(account);
};

const assertSignedMovement = (value: bigint, field: keyof Omit<SettlementDiff, 'tokenId'>, tokenId: number): void => {
  if (value < -UINT256_MAX || value > UINT256_MAX) {
    throw new Error(`SETTLEMENT_SIGNED_AMOUNT_RANGE:${field}:token=${tokenId}`);
  }
};

const assertContractExecutableDiff = (diff: SettlementDiff): void => {
  assertSignedMovement(diff.leftDiff, 'leftDiff', diff.tokenId);
  assertSignedMovement(diff.rightDiff, 'rightDiff', diff.tokenId);
  assertSignedMovement(diff.collateralDiff, 'collateralDiff', diff.tokenId);
  assertSignedMovement(diff.ondeltaDiff, 'ondeltaDiff', diff.tokenId);
};

/**
 * Compile typed settlement operations into canonical diffs.
 *
 * @param ops - Array of typed settlement operations
 * @param proposerIsLeft - Whether the proposer (last modifier) is the left entity
 * @returns { diffs, forgiveTokenIds }
 */
export function compileOps(
  ops: SettlementOp[],
  proposerIsLeft: boolean,
): { diffs: SettlementDiff[]; forgiveTokenIds: number[] } {
  // Group by tokenId — multiple ops on same token merge into one diff
  const diffMap = new Map<number, SettlementDiff>();
  const forgiveTokenIds: number[] = [];
  const forgivenTokenIds = new Set<number>();

  const ensureDiff = (tokenId: number): SettlementDiff => {
    let diff = diffMap.get(tokenId);
    if (!diff) {
      diff = {
        tokenId,
        leftDiff: 0n,
        rightDiff: 0n,
        collateralDiff: 0n,
        ondeltaDiff: 0n,
      };
      diffMap.set(tokenId, diff);
    }
    return diff;
  };

  for (const [index, op] of ops.entries()) {
    assertSettlementTokenId(op.tokenId, `op=${index}`);
    if (op.type === 'forgive') {
      if (forgivenTokenIds.has(op.tokenId)) {
        throw new Error(`SETTLEMENT_DUPLICATE_FORGIVENESS_TOKEN:${op.tokenId}`);
      }
      forgivenTokenIds.add(op.tokenId);
      forgiveTokenIds.push(op.tokenId);
      continue;
    }

    if (op.type === 'rawDiff') {
      // Escape hatch: directly specify all diffs
      const diff = ensureDiff(op.tokenId);
      diff.leftDiff += op.leftDiff;
      diff.rightDiff += op.rightDiff;
      diff.collateralDiff += op.collateralDiff;
      diff.ondeltaDiff += op.ondeltaDiff;
      continue;
    }

    if (op.type !== 'r2c' && op.type !== 'c2r' && op.type !== 'r2r') {
      const unknownOp = op as { type?: unknown; tokenId?: unknown };
      throw new Error(
        `SETTLEMENT_UNKNOWN_OP_TYPE: type=${String(unknownOp.type ?? 'unknown')} tokenId=${String(unknownOp.tokenId ?? 'unknown')}`,
      );
    }

    const diff = ensureDiff(op.tokenId);
    const amount = op.amount;

    switch (op.type) {
      case 'r2c': {
        // Proposer's reserve → collateral
        // Conservation: proposer loses reserve, collateral gains
        if (proposerIsLeft) {
          // Left proposer: leftDiff = -amount, collateralDiff = +amount
          diff.leftDiff -= amount;
          diff.collateralDiff += amount;
          // ondelta tracks left's share: left deposited → ondelta increases
          diff.ondeltaDiff += amount;
        } else {
          // Right proposer: rightDiff = -amount, collateralDiff = +amount
          diff.rightDiff -= amount;
          diff.collateralDiff += amount;
          // Right operations don't change ondelta (ondelta = left's share)
        }
        break;
      }

      case 'c2r': {
        // Collateral → proposer's reserve
        // Conservation: collateral decreases, proposer gains reserve
        if (proposerIsLeft) {
          diff.collateralDiff -= amount;
          diff.leftDiff += amount;
          // Left withdraws from collateral → ondelta decreases
          diff.ondeltaDiff -= amount;
        } else {
          diff.collateralDiff -= amount;
          diff.rightDiff += amount;
          // Right operations don't change ondelta
        }
        break;
      }

      case 'r2r': {
        // Proposer's reserve → counterparty's reserve
        // Conservation: proposer loses, counterparty gains
        if (proposerIsLeft) {
          diff.leftDiff -= amount;
          diff.rightDiff += amount;
          // ondelta unchanged (no collateral involved, direct reserve transfer)
        } else {
          diff.rightDiff -= amount;
          diff.leftDiff += amount;
          // ondelta unchanged
        }
        break;
      }

      default:
        break;
    }
  }

  // Validate conservation law on each diff
  const diffs: SettlementDiff[] = [];
  for (const diff of diffMap.values()) {
    assertContractExecutableDiff(diff);
    const sum = diff.leftDiff + diff.rightDiff + diff.collateralDiff;
    if (sum !== 0n) {
      throw new Error(
        `SETTLEMENT_INVARIANT_VIOLATION: leftDiff(${diff.leftDiff}) + rightDiff(${diff.rightDiff}) + collateralDiff(${diff.collateralDiff}) = ${sum} !== 0 for tokenId ${diff.tokenId}`,
      );
    }
    diffs.push(diff);
  }

  if (diffs.length > MAX_SETTLEMENT_DIFFS) {
    throw new Error(`SETTLEMENT_DIFF_LIMIT_EXCEEDED:${diffs.length}:${MAX_SETTLEMENT_DIFFS}`);
  }
  if (forgiveTokenIds.length > MAX_SETTLEMENT_FORGIVENESS_IDS) {
    throw new Error(
      `SETTLEMENT_FORGIVENESS_LIMIT_EXCEEDED:${forgiveTokenIds.length}:${MAX_SETTLEMENT_FORGIVENESS_IDS}`,
    );
  }

  return { diffs, forgiveTokenIds };
}

/**
 * Check if a settlement diff is safe for the user to auto-approve.
 * Used by hub C→R withdrawals — user auto-approves if hub only withdraws from hub's share.
 *
 * @param diff - The settlement diff to check
 * @param iAmLeft - Whether the checking entity is the left entity
 * @returns true if safe to auto-approve
 */
export function userAutoApprove(diff: SettlementDiff, iAmLeft: boolean): boolean {
  // User auto-approves if:
  // 1. Their reserve doesn't decrease (they don't lose money)
  // 2. Collateral changes are within counterparty's share

  const myReserveDiff = iAmLeft ? diff.leftDiff : diff.rightDiff;
  const myCollateralShareDiff = iAmLeft
    ? diff.ondeltaDiff
    : diff.collateralDiff - diff.ondeltaDiff;

  // If my reserve decreases, I need to manually approve
  if (myReserveDiff < 0n) return false;

  // `ondelta` is left's collateral share; right owns the remainder. Checking
  // only when total collateral decreases misses a pure ownership transfer with
  // collateralDiff=0. Such a raw diff can take one side's collateral share
  // without changing either reserve, so every negative own-share delta needs
  // an explicit signature regardless of the aggregate collateral movement.
  if (myCollateralShareDiff < 0n) return false;

  return true;
}
