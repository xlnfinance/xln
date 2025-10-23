/**
 * Format utilities for XLN frontend
 */

/**
 * Shorten an Ethereum-style address to "0xabc...def" format
 * @param address Full address (0x + 40 hex chars)
 * @param prefixLen Number of chars after 0x to show at start (default 3)
 * @param suffixLen Number of chars to show at end (default 3)
 */
export function shortAddress(address: string, prefixLen = 3, suffixLen = 3): string {
  if (!address || address.length < 10) return address;
  if (!address.startsWith('0x')) return address;

  return `${address.slice(0, 2 + prefixLen)}...${address.slice(-suffixLen)}`;
}

/**
 * Format a large number with k/M/B suffixes
 * @param value Number to format
 * @param decimals Number of decimal places (default 1)
 */
export function shortNumber(value: number | bigint, decimals = 1): string {
  const num = typeof value === 'bigint' ? Number(value) : value;

  if (num >= 1_000_000_000) {
    return `${(num / 1_000_000_000).toFixed(decimals)}B`;
  } else if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(decimals)}M`;
  } else if (num >= 1_000) {
    return `${(num / 1_000).toFixed(decimals)}k`;
  }

  return num.toString();
}
