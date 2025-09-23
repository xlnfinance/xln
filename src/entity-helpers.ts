/**
 * Convert bytes32 entityId to human-readable entity number
 */
export function getEntityNumber(entityId: string): number {
  if (!entityId || entityId === '0x' || entityId === '0x0') {
    return 0;
  }
  // Convert hex string to number
  try {
    const num = parseInt(entityId, 16);
    return isNaN(num) ? 0 : num;
  } catch {
    return 0;
  }
}

/**
 * Format entity display - shows entity number
 */
export function formatEntityId(entityId: string): string {
  const num = getEntityNumber(entityId);
  return num > 0 ? `#${num}` : 'Unknown';
}