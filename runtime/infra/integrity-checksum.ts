import { sha256 } from '@noble/hashes/sha2.js';

export const INTEGRITY_CHECKSUM_BYTES = 16;
export const INTEGRITY_DIGEST_BYTES = 32;
export const INTEGRITY_DIGEST_ALGORITHM_ID = 'sha256' as const;

type NativeHasher = {
  update(data: Uint8Array): NativeHasher;
  digest(): Uint8Array;
};

type NativeHasherConstructor = new (algorithm: string) => NativeHasher;

const nativeHasher = (): NativeHasherConstructor | undefined =>
  (globalThis as unknown as { Bun?: { CryptoHasher?: NativeHasherConstructor } }).Bun?.CryptoHasher;

export const computeIntegrityDigestBytes = (bytes: Uint8Array): Uint8Array => {
  const Native = nativeHasher();
  return Native
    ? new Uint8Array(new Native(INTEGRITY_DIGEST_ALGORITHM_ID).update(bytes).digest())
    : sha256(bytes);
};

export const computeIntegrityChecksumBytes = (bytes: Uint8Array): Uint8Array =>
  computeIntegrityDigestBytes(bytes).slice(0, INTEGRITY_CHECKSUM_BYTES);

export const integrityChecksumToHex = (bytes: Uint8Array): string => {
  let output = '0x';
  for (const byte of bytes) output += byte.toString(16).padStart(2, '0');
  return output;
};

export const integrityChecksumFromHex = (value: string): Uint8Array => {
  const normalized = value.startsWith('0x') ? value.slice(2) : value;
  const expectedLength = INTEGRITY_CHECKSUM_BYTES * 2;
  if (!new RegExp(`^[0-9a-f]{${expectedLength}}$`, 'i').test(normalized)) {
    throw new Error(`INTEGRITY_CHECKSUM_INVALID:${value}`);
  }
  const output = new Uint8Array(INTEGRITY_CHECKSUM_BYTES);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
};

export const computeIntegrityChecksum = (bytes: Uint8Array): string =>
  integrityChecksumToHex(computeIntegrityChecksumBytes(bytes));

export const computeIntegrityDigest = (bytes: Uint8Array): string =>
  integrityChecksumToHex(computeIntegrityDigestBytes(bytes));
