/**
 * Account utilities for calculating balances and derived states
 * Based on old_src/app/Channel.ts deriveDelta logic
 */

import type { Delta, DerivedDelta } from './types';
import { validateDelta } from './validation-utils';

/**
 * Determine if an entity is the "left" party in a bilateral account (like old_src Channel.ts)
 * @param myEntityId - Current entity ID
 * @param counterpartyEntityId - Other entity ID
 * @returns true if current entity is left (lexicographically smaller)
 */
export function isLeft(myEntityId: string, counterpartyEntityId: string): boolean {
  return myEntityId < counterpartyEntityId;
}

const BASE_CREDIT_LIMIT = 1_000_000n;

/**
 * Derive account balance information for a specific token
 * @param delta - The delta structure for this token
 * @param isLeft - Whether we are the left party in this account
 * @returns Derived balance information including capacities and credits
 */
export function deriveDelta(delta: Delta, isLeft: boolean): DerivedDelta {
  // VALIDATE AT SOURCE: Financial data must be valid
  validateDelta(delta, 'deriveDelta');

  const nonNegative = (x: bigint): bigint => x < 0n ? 0n : x;

  const totalDelta = delta.ondelta + delta.offdelta;
  const collateral = nonNegative(delta.collateral);

  let ownCreditLimit = delta.leftCreditLimit;
  let peerCreditLimit = delta.rightCreditLimit;

  let inCollateral = totalDelta > 0n ? nonNegative(collateral - totalDelta) : collateral;
  let outCollateral = totalDelta > 0n ? (totalDelta > collateral ? collateral : totalDelta) : 0n;

  let inOwnCredit = nonNegative(-totalDelta);
  if (inOwnCredit > ownCreditLimit) inOwnCredit = ownCreditLimit;

  let outPeerCredit = nonNegative(totalDelta - collateral);
  if (outPeerCredit > peerCreditLimit) outPeerCredit = peerCreditLimit;

  let outOwnCredit = nonNegative(ownCreditLimit - inOwnCredit);
  let inPeerCredit = nonNegative(peerCreditLimit - outPeerCredit);

  let inAllowence = delta.rightAllowence;
  let outAllowence = delta.leftAllowence;

  const totalCapacity = collateral + ownCreditLimit + peerCreditLimit;

  let inCapacity = nonNegative(inOwnCredit + inCollateral + inPeerCredit - inAllowence);
  let outCapacity = nonNegative(outPeerCredit + outCollateral + outOwnCredit - outAllowence);

  if (!isLeft) {
    // flip the view
    [inCollateral, inAllowence, inCapacity,
     outCollateral, outAllowence, outCapacity] =
    [outCollateral, outAllowence, outCapacity,
     inCollateral, inAllowence, inCapacity];

    [ownCreditLimit, peerCreditLimit] = [peerCreditLimit, ownCreditLimit];
    // swap in<->out own<->peer credit
    [outOwnCredit, inOwnCredit, outPeerCredit, inPeerCredit] =
    [inPeerCredit, outPeerCredit, inOwnCredit, outOwnCredit];
  }

  // ASCII visualization
  const totalWidth = Number(totalCapacity);
  const leftCreditWidth = Math.floor((Number(ownCreditLimit) / totalWidth) * 50);
  const collateralWidth = Math.floor((Number(collateral) / totalWidth) * 50);
  const rightCreditWidth = 50 - leftCreditWidth - collateralWidth;
  const deltaPosition = Math.floor(((Number(totalDelta) + Number(ownCreditLimit)) / totalWidth) * 50);

  // ASCII visualization - proper bar with position marker
  // Build the full capacity bar first
  const fullBar =
    '-'.repeat(leftCreditWidth) +
    '='.repeat(collateralWidth) +
    '-'.repeat(rightCreditWidth);

  // Insert position marker at deltaPosition
  const clampedPosition = Math.max(0, Math.min(deltaPosition, fullBar.length));
  const ascii =
    '[' +
    fullBar.substring(0, clampedPosition) +
    '|' +
    fullBar.substring(clampedPosition) +
    ']';

  return {
    delta: totalDelta,
    collateral,
    inCollateral,
    outCollateral,
    inOwnCredit,
    outPeerCredit,
    inAllowence,
    outAllowence,
    totalCapacity,
    ownCreditLimit,
    peerCreditLimit,
    inCapacity,
    outCapacity,
    outOwnCredit,
    inPeerCredit,
    ascii,
  };
}

/**
 * Create a simple delta for demo purposes
 * @param tokenId - Token ID
 * @param collateral - Collateral amount
 * @param delta - Delta amount
 * @returns Delta object with reasonable defaults
 */
export function createDemoDelta(tokenId: number, collateral: bigint = 1000n, delta: bigint = 0n): Delta {
  const creditLimit = getDefaultCreditLimit(tokenId);

  const deltaData = {
    tokenId,
    collateral,
    ondelta: delta,
    offdelta: 0n,
    leftCreditLimit: creditLimit,
    rightCreditLimit: creditLimit,
    leftAllowence: 0n,
    rightAllowence: 0n,
  };

  // VALIDATE AT SOURCE: Guarantee type safety from this point forward
  return validateDelta(deltaData, 'createDemoDelta');
}

/**
 * Get token information for display
 * USDC is primary token (1), ETH is secondary (2)
 */
export const TOKEN_REGISTRY: Record<number, { symbol: string; name: string; decimals: number; color: string }> = {
  1: { symbol: 'USDC', name: 'USD Coin', decimals: 18, color: '#2775ca' },
  2: { symbol: 'ETH', name: 'Ethereum', decimals: 18, color: '#627eea' },
};

export function getTokenInfo(tokenId: number) {
  return TOKEN_REGISTRY[tokenId] || { 
    symbol: `TKN${tokenId}`, 
    name: `Token ${tokenId}`, 
    decimals: 18, 
    color: '#999' 
  };
}

/**
 * Default per-token credit limit scaled to token decimals (matches old channel behavior)
 */
export function getDefaultCreditLimit(tokenId: number): bigint {
  const tokenInfo = getTokenInfo(tokenId);
  const decimals = BigInt(tokenInfo.decimals ?? 18);
  return BASE_CREDIT_LIMIT * 10n ** decimals;
}

/**
 * Format amount for display with proper decimals
 */
// DEPRECATED: Use financial-utils.ts formatTokenAmount instead
// This is kept for backwards compatibility during migration
export { formatTokenAmount } from './financial-utils';

/**
 * Calculate percentage for capacity bar display
 */
// DEPRECATED: Use financial-utils.ts calculatePercentage instead
// This is kept for backwards compatibility during migration
export { calculatePercentage } from './financial-utils';
