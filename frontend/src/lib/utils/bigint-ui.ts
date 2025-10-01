/**
 * BigInt utilities for UI components
 * Handles formatting, parsing, and arithmetic for financial amounts
 */

export interface TokenInfo {
  symbol: string;
  decimals: number;
}

// Common token configurations
export const TOKEN_CONFIGS: Record<number, TokenInfo> = {
  1: { symbol: 'ETH', decimals: 18 },
  2: { symbol: 'USDC', decimals: 6 },
};

/**
 * Format BigInt as human-readable decimal string
 * Example: 1500000000000000000n (18 decimals) → "1.5"
 */
export function formatBigInt(amount: bigint, decimals: number): string {
  if (amount === 0n) return '0';

  const isNegative = amount < 0n;
  const absoluteAmount = isNegative ? -amount : amount;

  const divisor = BigInt(10 ** decimals);
  const wholePart = absoluteAmount / divisor;
  const fractionalPart = absoluteAmount % divisor;

  if (fractionalPart === 0n) {
    return `${isNegative ? '-' : ''}${wholePart}`;
  }

  const fractionalStr = fractionalPart.toString().padStart(decimals, '0');
  const trimmed = fractionalStr.replace(/0+$/, ''); // Remove trailing zeros
  return `${isNegative ? '-' : ''}${wholePart}.${trimmed}`;
}

/**
 * Parse decimal string to BigInt with specified decimals
 * Example: "1.5" (18 decimals) → 1500000000000000000n
 */
export function parseBigInt(str: string, decimals: number): bigint {
  if (!str || str.trim() === '') return 0n;

  const trimmed = str.trim();
  const isNegative = trimmed.startsWith('-');
  const cleanStr = isNegative ? trimmed.slice(1) : trimmed;

  const parts = cleanStr.split('.');
  if (parts.length > 2) throw new Error('Invalid decimal format');

  const wholePart = BigInt(parts[0] || '0');
  const fractionalPart = parts[1] || '';

  if (fractionalPart.length > decimals) {
    throw new Error(`Too many decimal places. Max: ${decimals}`);
  }

  const paddedFractional = fractionalPart.padEnd(decimals, '0');
  const result = wholePart * BigInt(10 ** decimals) + BigInt(paddedFractional);

  return isNegative ? -result : result;
}

/**
 * Format token amount with symbol
 * Example: formatTokenAmount(1500000000000000000n, 1) → "1.5 ETH"
 */
export function formatTokenAmount(amount: bigint, tokenId: number): string {
  const config = TOKEN_CONFIGS[tokenId];
  if (!config) return `${formatBigInt(amount, 18)} TKN${tokenId}`;

  return `${formatBigInt(amount, config.decimals)} ${config.symbol}`;
}

/**
 * Parse token amount from string with validation
 * Example: parseTokenAmount("1.5", 1) → 1500000000000000000n
 */
export function parseTokenAmount(str: string, tokenId: number): bigint {
  const config = TOKEN_CONFIGS[tokenId] || { decimals: 18 };
  return parseBigInt(str, config.decimals);
}

/**
 * BigInt arithmetic helpers (no precision loss)
 */
export const BigMath = {
  // Safe addition
  add: (a: bigint, b: bigint): bigint => a + b,

  // Safe subtraction
  sub: (a: bigint, b: bigint): bigint => a - b,

  // Percentage calculation (maintains precision)
  percentage: (amount: bigint, percent: number): bigint => {
    const percentBigInt = BigInt(Math.floor(percent * 10000)); // 4 decimal precision
    return (amount * percentBigInt) / 1000000n;
  },

  // Compare amounts
  gt: (a: bigint, b: bigint): boolean => a > b,
  gte: (a: bigint, b: bigint): boolean => a >= b,
  lt: (a: bigint, b: bigint): boolean => a < b,
  lte: (a: bigint, b: bigint): boolean => a <= b,
  eq: (a: bigint, b: bigint): boolean => a === b,

  // Minimum/Maximum
  min: (...amounts: bigint[]): bigint => amounts.reduce((min, curr) => curr < min ? curr : min),
  max: (...amounts: bigint[]): bigint => amounts.reduce((max, curr) => curr > max ? curr : max),

  // Absolute value
  abs: (amount: bigint): bigint => amount < 0n ? -amount : amount,
};

/**
 * Validate BigInt input string without converting
 */
export function isValidBigIntInput(str: string): boolean {
  if (!str || str.trim() === '') return true; // Empty is valid (becomes 0)

  const trimmed = str.trim();
  // Allow: digits, one decimal point, optional leading minus
  return /^-?\d*\.?\d*$/.test(trimmed) && (trimmed.match(/\./g) || []).length <= 1;
}

/**
 * Safe BigInt percentage calculation for UI
 * Example: calculatePercentage(1000n, 10) → 100n (10% of 1000)
 */
export function calculatePercentage(amount: bigint, percentage: number): bigint {
  if (percentage === 0) return 0n;
  if (percentage === 100) return amount;

  // Use fixed-point arithmetic to maintain precision
  const percentBigInt = BigInt(Math.floor(percentage * 100));
  return (amount * percentBigInt) / 10000n;
}

export default {
  format: formatBigInt,
  parse: parseBigInt,
  formatToken: formatTokenAmount,
  parseToken: parseTokenAmount,
  isValid: isValidBigIntInput,
  percentage: calculatePercentage,
  Math: BigMath,
  TOKEN_CONFIGS,
};
