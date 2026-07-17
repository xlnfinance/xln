import {
  keccak256,
  recoverAddress,
  toUtf8Bytes,
} from 'ethers';
import { normalizeRuntimeAdapterIdentityChallenge } from './server-identity';

const OWNER_BINDING_DOMAIN = 'xln-radapter-owner-lane-v1';
const RUNTIME_ID_PATTERN = /^0x[0-9a-f]{40}$/;

const normalizeRuntimeId = (value: unknown): string => {
  const runtimeId = String(value || '').trim().toLowerCase();
  if (!RUNTIME_ID_PATTERN.test(runtimeId)) {
    throw new Error('RADAPTER_OWNER_BINDING_RUNTIME_ID_INVALID');
  }
  return runtimeId;
};

const capabilityHash = (value: unknown): string => {
  const capability = String(value || '').trim();
  if (!capability) throw new Error('RADAPTER_OWNER_BINDING_CAPABILITY_REQUIRED');
  return keccak256(toUtf8Bytes(capability)).toLowerCase();
};

export const buildRuntimeAdapterOwnerBindingDigest = (
  runtimeId: string,
  challenge: string,
  capability: string,
): string => keccak256(toUtf8Bytes([
  OWNER_BINDING_DOMAIN,
  normalizeRuntimeId(runtimeId),
  normalizeRuntimeAdapterIdentityChallenge(challenge),
  capabilityHash(capability),
].join(':'))).toLowerCase();

/**
 * The stable lane is selected only after recovery against the server's local
 * runtime identity. A caller-supplied lane or client id would let a bearer
 * capability reset another wallet's retry frontier after response loss.
 */
export const verifyRuntimeAdapterOwnerBinding = (
  runtimeId: string,
  challenge: string,
  capability: string,
  signature: string,
): boolean => {
  const expected = normalizeRuntimeId(runtimeId);
  try {
    return recoverAddress(
      buildRuntimeAdapterOwnerBindingDigest(expected, challenge, capability),
      String(signature || '').trim(),
    ).toLowerCase() === expected;
  } catch {
    return false;
  }
};
