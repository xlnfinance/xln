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

import type { AccountMachine, SettlementOp, SettlementDiff } from '../../types';

const INT256_MIN = -(1n << 255n);
const INT256_MAX = (1n << 255n) - 1n;
const MAX_SETTLEMENT_DIFFS = 32;
const MAX_SETTLEMENT_FORGIVENESS_IDS = 32;

/**
 * Cooperative settlement and both sides' dispute proofs share the Account
 * contract nonce. Every bilateral replica therefore chooses above every
 * locally-known signed proof, not merely above its own signing cursor.
 */
const assertSettlementNonceCursor = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`SETTLEMENT_NONCE_EXHAUSTED:${String(value)}`);
  }
  return value;
};

export const getMinimumSafeSettlementNonce = (account: AccountMachine): number =>
  assertSettlementNonceCursor(Math.max(
    Number(account.jNonce ?? 0) + 1,
    Number(account.proofHeader?.nextProofNonce ?? 0),
    Number(account.currentDisputeProofNonce ?? 0) + 1,
    Number(account.counterpartyDisputeProofNonce ?? 0) + 1,
  ));

export const getNextSettlementNonce = (account: AccountMachine): number => {
  // `nextProofNonce` is already the first unused bilateral proof nonce. Adding
  // one here silently skipped a nonce on one replica and was the root cause of
  // the settlement-seal divergence. The exact candidate must be derived from
  // committed cursors only and then agreed byte-for-byte by both Account sides.
  return getMinimumSafeSettlementNonce(account);
};

const assertInt256 = (value: bigint, field: keyof Omit<SettlementDiff, 'tokenId'>, tokenId: number): void => {
  if (value < INT256_MIN || value > INT256_MAX) {
    throw new Error(`SETTLEMENT_INT256_RANGE:${field}:token=${tokenId}`);
  }
};

const checkedInt256Add = (left: bigint, right: bigint, tokenId: number): bigint => {
  const result = left + right;
  if (result < INT256_MIN || result > INT256_MAX) {
    throw new Error(`SETTLEMENT_INT256_ADD_OVERFLOW:token=${tokenId}`);
  }
  return result;
};

const assertContractExecutableDiff = (diff: SettlementDiff): void => {
  assertInt256(diff.leftDiff, 'leftDiff', diff.tokenId);
  assertInt256(diff.rightDiff, 'rightDiff', diff.tokenId);
  assertInt256(diff.collateralDiff, 'collateralDiff', diff.tokenId);
  assertInt256(diff.ondeltaDiff, 'ondeltaDiff', diff.tokenId);
  const partial = checkedInt256Add(diff.leftDiff, diff.rightDiff, diff.tokenId);
  checkedInt256Add(partial, diff.collateralDiff, diff.tokenId);
  for (const [field, value] of [
    ['leftDiff', diff.leftDiff],
    ['rightDiff', diff.rightDiff],
    ['collateralDiff', diff.collateralDiff],
  ] as const) {
    if (value === INT256_MIN) throw new Error(`SETTLEMENT_INT256_NEGATION:${field}:token=${diff.tokenId}`);
  }
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

  for (const op of ops) {
    if (op.type === 'forgive') {
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

  // If my reserve decreases, I need to manually approve
  if (myReserveDiff < 0n) return false;

  // If collateral decreases, check ondelta to see whose share is affected
  if (diff.collateralDiff < 0n) {
    // Collateral is being withdrawn
    if (iAmLeft) {
      // I'm left. ondeltaDiff < 0 means my share decreases → need approval
      if (diff.ondeltaDiff < 0n) return false;
    } else {
      // I'm right. Right's share = collateral - ondelta.
      // ondeltaDiff > 0 means left's share increases → right's share decreases → need approval
      // ondeltaDiff = 0 and collateralDiff < 0 means right's share decreases → need approval
      // Only safe if ondeltaDiff <= collateralDiff (left absorbs all the decrease)
      // Actually: right's share change = collateralDiff - ondeltaDiff
      // Safe if right's share doesn't decrease: collateralDiff - ondeltaDiff >= 0
      if (diff.collateralDiff - diff.ondeltaDiff < 0n) return false;
    }
  }

  return true;
}
