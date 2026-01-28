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
 * Format entity ID to short form (last 4 chars or "0001" style for numbered entities)
 * @param entityId Full entity ID (0x + 64 hex chars)
 */
export function formatEntityId(entityId: string): string {
  if (!entityId || entityId.length < 10) return entityId;

  // Check if it's a numbered entity (0x0000...0001 format)
  const withoutPrefix = entityId.slice(2);
  const leadingZeros = withoutPrefix.match(/^0*/)?.[0]?.length || 0;

  if (leadingZeros >= 60) {
    // Numbered entity - show the number
    const num = parseInt(withoutPrefix, 16);
    return `#${num}`;
  }

  // Regular entity - show first 4 hex chars after 0x (matches runtime getEntityShortId)
  return entityId.startsWith('0x') ? entityId.slice(2, 6).toUpperCase() : entityId.slice(0, 4).toUpperCase();
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
