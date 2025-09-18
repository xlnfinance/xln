/**
 * Frontend account utilities for calculating balances and derived states
 */

import type { Delta, DerivedDelta } from '../types';

const nonNegative = (x: bigint): bigint => x < 0n ? 0n : x;

/**
 * Derive account balance information for a specific token
 */
export function deriveDelta(delta: Delta, isLeft: boolean): DerivedDelta {
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
    // flip the view for right party
    [inCollateral, inAllowence, inCapacity,
     outCollateral, outAllowence, outCapacity] = 
    [outCollateral, outAllowence, outCapacity,
     inCollateral, inAllowence, inCapacity];

    [ownCreditLimit, peerCreditLimit] = [peerCreditLimit, ownCreditLimit];
    // swap in<->out own<->peer credit
    [outOwnCredit, inOwnCredit, outPeerCredit, inPeerCredit] = 
    [inPeerCredit, outPeerCredit, inOwnCredit, outOwnCredit];
  }

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
  };
}

/**
 * Token registry for display information
 */
export const TOKEN_REGISTRY: Record<number, { symbol: string; name: string; decimals: number; color: string }> = {
  0: { symbol: 'NULL', name: 'Null Token', decimals: 18, color: '#777' },
  1: { symbol: 'ETH', name: 'Ethereum', decimals: 18, color: '#627eea' },
  2: { symbol: 'USDT', name: 'Tether USD', decimals: 18, color: '#26a17b' },
  3: { symbol: 'USDC', name: 'USD Coin', decimals: 18, color: '#2775ca' },
  4: { symbol: 'ACME', name: 'ACME Corp Shares', decimals: 18, color: '#ff6b6b' },
  5: { symbol: 'BTC', name: 'Bitcoin Shares', decimals: 8, color: '#f7931a' },
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
 * Format amount for display with proper decimals
 */
export function formatTokenAmount(tokenId: number, amount: bigint): string {
  const tokenInfo = getTokenInfo(tokenId);
  const divisor = BigInt(10) ** BigInt(tokenInfo.decimals);
  const wholePart = amount / divisor;
  const fractionalPart = amount % divisor;

  if (fractionalPart === 0n) {
    return `${wholePart} ${tokenInfo.symbol}`;
  }

  const fractionalStr = fractionalPart.toString().padStart(tokenInfo.decimals, '0');
  return `${wholePart}.${fractionalStr} ${tokenInfo.symbol}`;
}

/**
 * Calculate percentage for progress bar
 */
export function calculatePercentage(value: bigint, total: bigint): number {
  if (total === 0n) return 0;
  return Number((value * 100n) / total);
}