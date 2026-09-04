/**
 * Strict hexadecimal encoding at BrainVault module boundaries.
 *
 * Worker messages cannot transfer implementation-specific Buffer objects as a
 * protocol assumption. Lowercase hex is the small, deterministic wire format;
 * odd length or non-hex input must fail instead of being partially parsed.
 */

export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error('BRAINVAULT_HEX_INVALID');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Copy a backend-owned secret before erasing the backend allocation. */
export function copyAndWipe(bytes: Uint8Array): Uint8Array {
  try {
    return new Uint8Array(bytes);
  } finally {
    bytes.fill(0);
  }
}
