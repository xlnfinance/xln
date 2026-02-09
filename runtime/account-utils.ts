/**
 * Account utilities for calculating balances and derived states
 * Based on old_src/app/Channel.ts deriveDelta logic
 */

import type { Delta, DerivedDelta } from './types';
import { PERFORMANCE } from './constants';
import { validateDelta } from './validation-utils';
import { isLeftEntity } from './entity-id-utils';

/**
 * Determine if an entity is the "left" party in a bilateral account (like old_src Channel.ts)
 * @param myEntityId - Current entity ID
 * @param counterpartyEntityId - Other entity ID
 * @returns true if current entity is left (lexicographically smaller)
 */
export function isLeft(myEntityId: string, counterpartyEntityId: string): boolean {
  return isLeftEntity(myEntityId, counterpartyEntityId);
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

  // outPeerCredit = how much peer owes us (backed by THEIR credit to us, i.e. peerCreditLimit)
  let outPeerCredit = nonNegative(totalDelta - collateral);
  if (outPeerCredit > peerCreditLimit) outPeerCredit = peerCreditLimit;

  // outOwnCredit = unused portion of credit WE set (ownCreditLimit), allowing peer to owe us more
  let outOwnCredit = nonNegative(ownCreditLimit - inOwnCredit);

  // inPeerCredit = unused portion of credit PEER opened to us (peerCreditLimit)
  let inPeerCredit = nonNegative(peerCreditLimit - outPeerCredit);

  // Track used credit for reporting (not used in capacity calculation)
  const peerCreditUsed = totalDelta < 0n ? nonNegative(-totalDelta - collateral) : 0n;
  const ownCreditUsed = totalDelta > 0n ? nonNegative(totalDelta - collateral) : 0n;

  let inAllowance = delta.rightAllowance;
  let outAllowance = delta.leftAllowance;

  const totalCapacity = collateral + ownCreditLimit + peerCreditLimit;

  // HTLC holds (capacity locked in pending HTLCs)
  const leftHtlcHold = delta.leftHtlcHold || 0n;
  const rightHtlcHold = delta.rightHtlcHold || 0n;

  // Swap holds (capacity locked in pending swap offers)
  const leftSwapHold = delta.leftSwapHold || 0n;
  const rightSwapHold = delta.rightSwapHold || 0n;

  // Settlement holds (ring-fenced during settlement negotiation)
  const leftSettleHold = delta.leftSettleHold || 0n;
  const rightSettleHold = delta.rightSettleHold || 0n;

  // Total holds = HTLC + Swap + Settlement
  const leftHold = leftHtlcHold + leftSwapHold + leftSettleHold;
  const rightHold = rightHtlcHold + rightSwapHold + rightSettleHold;

  // Original formula: in* components for inCapacity, out* components for outCapacity
  let inCapacity = nonNegative(inOwnCredit + inCollateral + inPeerCredit - inAllowance);
  let outCapacity = nonNegative(outPeerCredit + outCollateral + outOwnCredit - outAllowance);

  // CRITICAL: Deduct holds from capacity in LEFT's perspective (prevents double-spend)
  // Always deduct leftHold from out, rightHold from in — the flip at line 101 handles RIGHT perspective
  outCapacity = nonNegative(outCapacity - leftHold);
  inCapacity = nonNegative(inCapacity - rightHold);

  if (!isLeft) {
    // Flip for RIGHT entity perspective
    [inCollateral, inAllowance, inCapacity,
     outCollateral, outAllowance, outCapacity] =
    [outCollateral, outAllowance, outCapacity,
     inCollateral, inAllowance, inCapacity];

    [ownCreditLimit, peerCreditLimit] = [peerCreditLimit, ownCreditLimit];
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

  if (PERFORMANCE.DEBUG_ACCOUNTS) {
    console.log(`✅ deriveDelta RETURN: isLeft=${isLeft}, inCap=${inCapacity}, outCap=${outCapacity}, SUM=${inCapacity + outCapacity}`);
  }

  return {
    delta: totalDelta,
    collateral,
    inCollateral,
    outCollateral,
    inOwnCredit,
    outPeerCredit,
    inAllowance,
    outAllowance,
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
  2: { symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, color: '#627eea' },
  3: { symbol: 'USDT', name: 'Tether USD', decimals: 18, color: '#26a17b' },
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
