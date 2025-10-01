/**
 * Financial utilities using ethers.js for proper BigInt handling
 * Single source of truth for all financial calculations and formatting
 */

import { formatUnits, parseUnits } from 'ethers';
import { getTokenInfo } from './account-utils';

/**
 * Format token amount for display using ethers formatUnits
 * Maintains full precision, uses established ETH ecosystem standards
 */
export function formatTokenAmount(tokenId: number, amount: bigint | null | undefined): string {
  // Handle null/undefined values that are causing ethers.js to crash
  if (amount === null || amount === undefined) {
    const tokenInfo = getTokenInfo(tokenId);
    return `0 ${tokenInfo.symbol}`;
  }

  const tokenInfo = getTokenInfo(tokenId);
  const formattedAmount = formatUnits(amount, tokenInfo.decimals);
  return `${formattedAmount} ${tokenInfo.symbol}`;
}

/**
 * Parse user input into token base units using ethers parseUnits
 * Converts human-readable amounts to BigInt base units
 */
export function parseTokenAmount(tokenId: number, humanAmount: string): bigint {
  const tokenInfo = getTokenInfo(tokenId);
  return parseUnits(humanAmount, tokenInfo.decimals);
}

/**
 * Convert between different token precisions while maintaining BigInt
 * Useful for cross-token calculations
 */
export function convertTokenPrecision(
  amount: bigint,
  fromDecimals: number,
  toDecimals: number
): bigint {
  if (fromDecimals === toDecimals) return amount;

  if (fromDecimals > toDecimals) {
    const divisor = 10n ** BigInt(fromDecimals - toDecimals);
    return amount / divisor;
  } else {
    const multiplier = 10n ** BigInt(toDecimals - fromDecimals);
    return amount * multiplier;
  }
}

/**
 * Calculate percentage for UI display (returns number for width calculations)
 * Only converts to number at the final display layer
 */
export function calculatePercentage(amount: bigint | null | undefined, total: bigint | null | undefined): number {
  // Handle null/undefined values
  if (amount === null || amount === undefined || total === null || total === undefined) return 0;
  if (total === 0n) return 0;
  // Use BigInt arithmetic until final conversion
  return Number((amount * 100n) / total);
}

/**
 * Format asset balance using ethers (for AssetBalance type)
 */
export function formatAssetAmount(balance: { amount: bigint | null | undefined; decimals: number; symbol: string }): string {
  // Handle null/undefined amounts
  if (balance.amount === null || balance.amount === undefined) {
    return `0 ${balance.symbol}`;
  }

  const formattedAmount = formatUnits(balance.amount, balance.decimals);
  return `${formattedAmount} ${balance.symbol}`;
}

/**
 * Safe BigInt arithmetic operations with overflow protection
 */
export const BigIntMath = {
  /**
   * Safe addition with null checking
   */
  add: (a: bigint | null | undefined, b: bigint | null | undefined): bigint => {
    const safeA = a ?? 0n;
    const safeB = b ?? 0n;
    return safeA + safeB;
  },

  /**
   * Safe subtraction with underflow check and null handling
   */
  subtract: (a: bigint | null | undefined, b: bigint | null | undefined): bigint => {
    const safeA = a ?? 0n;
    const safeB = b ?? 0n;
    if (safeB > safeA) throw new Error(`Underflow: ${safeA} - ${safeB}`);
    return safeA - safeB;
  },

  /**
   * Safe multiplication with null handling
   */
  multiply: (a: bigint | null | undefined, b: bigint | null | undefined): bigint => {
    const safeA = a ?? 0n;
    const safeB = b ?? 0n;
    return safeA * safeB;
  },

  /**
   * Safe division with remainder and null handling
   */
  divide: (dividend: bigint | null | undefined, divisor: bigint | null | undefined): { quotient: bigint; remainder: bigint } => {
    const safeDividend = dividend ?? 0n;
    const safeDivisor = divisor ?? 1n; // Avoid division by zero
    if (safeDivisor === 0n) throw new Error('Division by zero');
    return {
      quotient: safeDividend / safeDivisor,
      remainder: safeDividend % safeDivisor
    };
  },

  /**
   * Compare two BigInts with null handling
   */
  compare: (a: bigint | null | undefined, b: bigint | null | undefined): -1 | 0 | 1 => {
    const safeA = a ?? 0n;
    const safeB = b ?? 0n;
    if (safeA < safeB) return -1;
    if (safeA > safeB) return 1;
    return 0;
  },

  /**
   * Get absolute value with null handling
   */
  abs: (a: bigint | null | undefined): bigint => {
    const safeA = a ?? 0n;
    return safeA < 0n ? -safeA : safeA;
  },

  /**
   * Get minimum of two values with null handling
   */
  min: (a: bigint | null | undefined, b: bigint | null | undefined): bigint => {
    const safeA = a ?? 0n;
    const safeB = b ?? 0n;
    return safeA < safeB ? safeA : safeB;
  },

  /**
   * Get maximum of two values with null handling
   */
  max: (a: bigint | null | undefined, b: bigint | null | undefined): bigint => {
    const safeA = a ?? 0n;
    const safeB = b ?? 0n;
    return safeA > safeB ? safeA : safeB;
  },
};

/**
 * Financial constants in proper BigInt format
 */
export const FINANCIAL_CONSTANTS = {
  ZERO: 0n,
  ONE: 1n,
  WEI_PER_ETH: 10n ** 18n,
  USDC_DECIMALS: 6,
  ETH_DECIMALS: 18,
  DEFAULT_DECIMALS: 18,
} as const;
