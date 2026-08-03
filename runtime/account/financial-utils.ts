/**
 * Financial utilities using ethers.js for proper BigInt handling
 * Single source of truth for all financial calculations and formatting
 */

import { formatUnits, parseUnits } from 'ethers';
import { getTokenInfo } from './utils';

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
