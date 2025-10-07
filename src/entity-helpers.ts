/**
 * Get short display ID for entity (always returns string)
 * Numbered entities (< 256**6): "2", "42", "1337"
 * Hash-based entities (>= 256**6): "07FF", "A3B2"
 */
export function getEntityShortId(entityId: string): string {
  if (!entityId || entityId === '0x' || entityId === '0x0') {
    return '0';
  }

  // Remove 0x prefix for parsing
  const hex = entityId.startsWith('0x') ? entityId.slice(2) : entityId;

  // Parse as BigInt to handle full 256-bit range
  try {
    const value = BigInt('0x' + hex);
    const NUMERIC_THRESHOLD = BigInt(256 ** 6); // 281474976710656

    // Numbered entities: return decimal string
    if (value >= 0n && value < NUMERIC_THRESHOLD) {
      return value.toString();
    }
  } catch {
    // Fall through to hash mode
  }

  // Hash-based: return first 4 hex chars
  return hex.slice(0, 4).toUpperCase();
}

/**
 * Format entity display with prefix
 * Numbered entities: "#2", "#42"
 * Hash-based entities: "07FF", "A3B2" (no prefix)
 */
export function formatEntityId(entityId: string): string {
  const shortId = getEntityShortId(entityId);
  // Check if it's purely numeric
  const num = parseInt(shortId, 10);
  if (!isNaN(num) && shortId === num.toString()) {
    return `#${shortId}`;
  }
  return shortId;
}

/**
 * @deprecated Use getEntityShortId instead
 */
export function getEntityNumber(entityId: string): string {
  return getEntityShortId(entityId);
}