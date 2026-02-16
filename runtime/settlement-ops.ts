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

import type { SettlementOp, SettlementDiff } from './types';

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

      default: {
        // Unknown op type — skip (shouldn't happen with TS types)
        console.warn(`⚠️ compileOps: unknown op type "${(op as any).type}"`);
        break;
      }
    }
  }

  // Validate conservation law on each diff
  const diffs: SettlementDiff[] = [];
  for (const diff of diffMap.values()) {
    const sum = diff.leftDiff + diff.rightDiff + diff.collateralDiff;
    if (sum !== 0n) {
      throw new Error(
        `SETTLEMENT_INVARIANT_VIOLATION: leftDiff(${diff.leftDiff}) + rightDiff(${diff.rightDiff}) + collateralDiff(${diff.collateralDiff}) = ${sum} !== 0 for tokenId ${diff.tokenId}`,
      );
    }
    diffs.push(diff);
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
