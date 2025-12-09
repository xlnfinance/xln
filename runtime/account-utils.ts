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

// CRITICAL: Default credit is 0 - credit must be explicitly extended via set_credit_limit
const BASE_CREDIT_LIMIT = 0n;

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

  // When delta > 0: peer owes us (peer is using OUR credit or we hold their collateral)
  // When delta < 0: we owe peer (we're using PEER's credit or they hold our collateral)

  // inOwnCredit = how much we owe using OUR OWN credit (when delta < 0 beyond collateral)
  let inOwnCredit = nonNegative(-totalDelta);
  if (inOwnCredit > ownCreditLimit) inOwnCredit = ownCreditLimit;

  // outPeerCredit = how much peer owes using OUR credit (when delta > 0 beyond collateral)
  let outPeerCredit = nonNegative(totalDelta - collateral);
  if (outPeerCredit > peerCreditLimit) outPeerCredit = peerCreditLimit;

  // outOwnCredit = remaining OWN credit we can extend
  let outOwnCredit = nonNegative(ownCreditLimit - inOwnCredit);

  // HYBRID MODEL: Track used credit for both directions
  // peerCreditUsed = credit peer lent that WE'RE using (when delta < 0)
  const peerCreditUsed = totalDelta < 0n ? nonNegative(-totalDelta - collateral) : 0n;
  let inPeerCredit = nonNegative(peerCreditLimit - outPeerCredit - peerCreditUsed);

  // ownCreditUsed = credit WE lent that PEER is using (when delta > 0)
  const ownCreditUsed = totalDelta > 0n ? nonNegative(totalDelta - collateral) : 0n;

  let inAllowence = delta.rightAllowance;
  let outAllowence = delta.leftAllowance;

  const totalCapacity = collateral + ownCreditLimit + peerCreditLimit;

  // FIXED: outCapacity = collateral I CAN SEND (inCollateral) + credit peer extended to me
  // inCapacity = collateral THEY can send (outCollateral) + credit I extended to them
  let inCapacity = nonNegative(outCollateral + inOwnCredit + outPeerCredit - inAllowence);
  let outCapacity = nonNegative(inCollateral + outOwnCredit + inPeerCredit - outAllowence);

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
    peerCreditUsed,  // HYBRID: credit peer lent that we're using
    ownCreditUsed,   // HYBRID: credit we lent that peer is using
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
    leftAllowance: 0n,
    rightAllowance: 0n,
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
