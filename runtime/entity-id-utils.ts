/**
 * Entity ID normalization and comparison helpers.
 * Ensures deterministic ordering across runtime components.
 */

export function normalizeEntityId(id: string): string {
  const raw = String(id).toLowerCase();
  if (!raw.startsWith('0x')) {
    return raw;
  }
  const hex = raw.slice(2);
  if (!/^[0-9a-f]*$/.test(hex)) {
    return raw;
  }
  if (hex.length === 64) {
    return raw;
  }
  if (hex.length < 64) {
    return `0x${hex.padStart(64, '0')}`;
  }
  return raw;
}

export function compareEntityIds(a: string, b: string): number {
  const left = normalizeEntityId(a);
  const right = normalizeEntityId(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function isLeftEntity(a: string, b: string): boolean {
  return compareEntityIds(a, b) < 0;
}
