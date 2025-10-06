/**
 * Convert bytes32 entityId to human-readable display
 * Numbered entities: Show number
 * Lazy/hash entities: Show first 4 hex chars
 */
export function getEntityNumber(entityId: string): string | number {
  if (!entityId || entityId === '0x' || entityId === '0x0') {
    return 0;
  }

  // Remove 0x prefix for parsing
  const hex = entityId.startsWith('0x') ? entityId.slice(2) : entityId;

  // Try to parse as numbered entity first (works for any length if number is small)
  try {
    const num = parseInt(hex, 16);
    // Numbered entities: 0-1000000 (reasonable range)
    // Lazy hashes will be huge numbers, treat as hash
    if (!isNaN(num) && num >= 0 && num <= 1000000) {
      return num;
    }
  } catch {
    // Fall through to hash mode
  }

  // Lazy/hash mode: return first 4 hex chars
  return hex.slice(0, 4).toUpperCase();
}

/**
 * Format entity display - shows entity number or hash prefix
 */
export function formatEntityId(entityId: string): string {
  const display = getEntityNumber(entityId);
  return typeof display === 'number' ? `#${display}` : display;
}