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
 * Format entity ID for display (full ID, no truncation)
 * @param entityId Full entity ID (0x + 64 hex chars)
 */
export function formatEntityId(entityId: string): string {
  return entityId || '';
}
