import { sha256 } from '@noble/hashes/sha2.js';

const INTEGRITY_CHECKSUM_BYTES = 16;
export const INTEGRITY_DIGEST_ALGORITHM_ID = 'sha256' as const;
const HEX_BYTE_TEXT = Array.from(
  { length: 256 },
  (_, value) => value.toString(16).padStart(2, '0'),
);

type NativeHasher = {
  update(data: Uint8Array): NativeHasher;
  digest(): Uint8Array;
};

type NativeHasherConstructor = new (algorithm: string) => NativeHasher;

const nativeHasher = (): NativeHasherConstructor | undefined => {
  const bunRuntime: unknown = Reflect.get(globalThis, 'Bun');
  if (!bunRuntime || typeof bunRuntime !== 'object') return undefined;
  const constructor: unknown = Reflect.get(bunRuntime, 'CryptoHasher');
  return typeof constructor === 'function' ? constructor as NativeHasherConstructor : undefined;
};

const computeIntegrityDigestBytes = (bytes: Uint8Array): Uint8Array => {
  const Native = nativeHasher();
  return Native
    ? new Uint8Array(new Native(INTEGRITY_DIGEST_ALGORITHM_ID).update(bytes).digest())
    : sha256(bytes);
};

const computeIntegrityChecksumBytes = (bytes: Uint8Array): Uint8Array =>
  computeIntegrityDigestBytes(bytes).slice(0, INTEGRITY_CHECKSUM_BYTES);

const integrityChecksumToHex = (bytes: Uint8Array): string => {
  let output = '0x';
  for (const byte of bytes) output += HEX_BYTE_TEXT[byte];
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
