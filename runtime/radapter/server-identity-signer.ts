import { SigningKey, computeAddress, hexlify, keccak256 } from 'ethers';
import { deriveSignerKeySync } from '../account/crypto';
import type { Env } from '../types';
import {
  buildRuntimeAdapterServerIdentityDigest,
  type RuntimeAdapterServerIdentityProof,
} from './server-identity';

/**
 * The server signs only identity derived from its local runtime seed. Accepting
 * runtimeId or a public key from the request would let a proxy choose the domain
 * and turn this into another unsigned assertion. The client challenge makes a
 * captured response useless on the next socket.
 */
export const signRuntimeAdapterServerIdentity = (
  env: Env,
  challenge: string,
): RuntimeAdapterServerIdentityProof => {
  const seed = String(env.runtimeSeed || '').trim();
  if (!seed) throw new Error('RADAPTER_SERVER_IDENTITY_RUNTIME_SEED_REQUIRED');
  const signingKey = new SigningKey(hexlify(deriveSignerKeySync(seed, '1')));
  const identityPublicKey = signingKey.compressedPublicKey.toLowerCase();
  const derivedRuntimeId = computeAddress(identityPublicKey).toLowerCase();
  const runtimeId = env.runtimeId ? String(env.runtimeId).trim().toLowerCase() : derivedRuntimeId;
  if (derivedRuntimeId !== runtimeId) {
    throw new Error('RADAPTER_SERVER_IDENTITY_SEED_MISMATCH');
  }
  const digest = buildRuntimeAdapterServerIdentityDigest(runtimeId, identityPublicKey, challenge);
  return {
    runtimeId,
    identityPublicKey,
    identitySignature: signingKey.sign(digest).serialized.toLowerCase(),
    identityFingerprint: keccak256(identityPublicKey).toLowerCase(),
  };
};
