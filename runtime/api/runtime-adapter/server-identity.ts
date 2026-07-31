import {
  computeAddress,
  hexlify,
  keccak256,
  recoverAddress,
  toUtf8Bytes,
} from 'ethers';

const SERVER_IDENTITY_DOMAIN = 'xln-radapter-server-identity-v1';
const CHALLENGE_PATTERN = /^0x[0-9a-f]{64}$/;
const RUNTIME_ID_PATTERN = /^0x[0-9a-f]{40}$/;

export type RuntimeAdapterServerIdentityProof = {
  runtimeId: string;
  identityPublicKey: string;
  identitySignature: string;
  identityFingerprint: string;
};

const normalizeRuntimeId = (value: unknown): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!RUNTIME_ID_PATTERN.test(normalized)) {
    throw new Error('RADAPTER_SERVER_IDENTITY_RUNTIME_ID_INVALID');
  }
  return normalized;
};

export const normalizeRuntimeAdapterIdentityChallenge = (value: unknown): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!CHALLENGE_PATTERN.test(normalized)) {
    throw new Error('RADAPTER_SERVER_IDENTITY_CHALLENGE_INVALID');
  }
  return normalized;
};

export const createRuntimeAdapterIdentityChallenge = (): string => {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('RADAPTER_SERVER_IDENTITY_CRYPTO_UNAVAILABLE');
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return hexlify(bytes).toLowerCase();
};

export const buildRuntimeAdapterServerIdentityDigest = (
  runtimeId: string,
  identityPublicKey: string,
  challenge: string,
): string => keccak256(toUtf8Bytes([
  SERVER_IDENTITY_DOMAIN,
  normalizeRuntimeId(runtimeId),
  String(identityPublicKey || '').trim().toLowerCase(),
  normalizeRuntimeAdapterIdentityChallenge(challenge),
].join(':')));

/** The expected runtime pin is checked after both pubkey and signature recovery. */
export const verifyRuntimeAdapterServerIdentity = (
  proof: RuntimeAdapterServerIdentityProof,
  challenge: string,
  expectedRuntimeId?: string,
): RuntimeAdapterServerIdentityProof => {
  const runtimeId = normalizeRuntimeId(proof.runtimeId);
  const publicKey = String(proof.identityPublicKey || '').trim().toLowerCase();
  let publicKeyRuntimeId: string;
  try {
    publicKeyRuntimeId = computeAddress(publicKey).toLowerCase();
  } catch (error) {
    throw new Error('RADAPTER_SERVER_IDENTITY_PUBLIC_KEY_INVALID', { cause: error });
  }
  if (publicKeyRuntimeId !== runtimeId) {
    throw new Error('RADAPTER_SERVER_IDENTITY_PUBLIC_KEY_MISMATCH');
  }
  const fingerprint = keccak256(publicKey).toLowerCase();
  if (String(proof.identityFingerprint || '').trim().toLowerCase() !== fingerprint) {
    throw new Error('RADAPTER_SERVER_IDENTITY_FINGERPRINT_MISMATCH');
  }
  const digest = buildRuntimeAdapterServerIdentityDigest(runtimeId, publicKey, challenge);
  let recovered: string;
  try {
    recovered = recoverAddress(digest, proof.identitySignature).toLowerCase();
  } catch (error) {
    throw new Error('RADAPTER_SERVER_IDENTITY_SIGNATURE_INVALID', { cause: error });
  }
  if (recovered !== runtimeId) {
    throw new Error('RADAPTER_SERVER_IDENTITY_SIGNATURE_MISMATCH');
  }
  if (expectedRuntimeId && runtimeId !== normalizeRuntimeId(expectedRuntimeId)) {
    throw new Error('RADAPTER_SERVER_IDENTITY_EXPECTED_RUNTIME_MISMATCH');
  }
  return { ...proof, runtimeId, identityPublicKey: publicKey, identityFingerprint: fingerprint };
};
