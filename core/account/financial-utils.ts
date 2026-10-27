/**
 * Financial utilities using ethers.js for proper BigInt handling
 * Single source of truth for all financial calculations and formatting
 */

import { formatUnits, parseUnits } from 'ethers';
import { getTokenInfo } from './utils';
import { haltRuntimeFailure } from '../protocol/errors/failure-taxonomy';

/**
 * Format token amount for display using ethers formatUnits
 * Maintains full precision, uses established ETH ecosystem standards
 */
export function formatTokenAmount(tokenId: number, amount: bigint | null | undefined): string {
  if (amount === null || amount === undefined) {
    throw haltRuntimeFailure('TOKEN_AMOUNT_MISSING', `TOKEN_AMOUNT_MISSING:${tokenId}`);
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
