/**
 * Browser-safe canonical Base64 codec for protocol bytes.
 *
 * Every producer emits padded RFC 4648 text. The decoder rejects malformed or
 * non-canonical spellings before they reach crypto code, so Bun and browsers
 * cannot disagree through their different Buffer/atob permissiveness.
 */

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export const encodeBase64Bytes = (bytes: Uint8Array): string => {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)));
  }
  return btoa(binary);
};

export const decodeBase64Bytes = (
  value: string,
  errorCode = 'PROTOCOL_BASE64_INVALID',
): Uint8Array => {
  if (!CANONICAL_BASE64.test(value)) throw new Error(errorCode);
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64'));
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
};
