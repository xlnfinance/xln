/**
 * Browser-compatible cryptographic utilities
 * Uses window.crypto for real SHA-256 hashing
 */

/**
 * Universal hash function using window.crypto
 * @param content - String content to hash
 * @returns Promise<string> - Full SHA-256 hash with 0x prefix
 */
export async function hash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  const hashHex = Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
  return `0x${hashHex}`;
}

/**
 * Hash any object deterministically
 * @param obj - Object to hash
 * @returns Promise<string> - Full SHA-256 hash
 */
export async function hashObject(obj: any): Promise<string> {
  const content = deterministicStringify(obj);
  return await hash(content);
}

/**
 * Hash for 20-byte addresses (like old_src)
 * @param content - String content to hash
 * @returns Promise<string> - First 20 bytes as hex
 */
export async function hash20(content: string): Promise<string> {
  const fullHash = await hash(content);
  return fullHash.slice(0, 42); // 0x + 40 chars = 20 bytes
}

// Keep old names for backward compatibility
export const sha256Hash = hash;
export const sha256Hash20 = hash20;

/**
 * Deterministic object serialization for hashing
 * @param obj - Object to serialize
 * @returns string - Deterministic JSON string
 */
export function deterministicStringify(obj: any): string {
  return JSON.stringify(obj, (_key, value) => {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    return value;
  });
}