import { getSignerPrivateKey } from '../account/crypto';
import { extractSignerId } from '../ids';
import { deriveEncryptionKeyPair, pubKeyToHex } from '../networking/p2p-crypto';
import type { Env } from '../types';

const bytesToHex = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('')}`;

export const hasLocalSignerKey = (env: Env, signerId: string): boolean => {
  try {
    getSignerPrivateKey(env, signerId);
    return true;
  } catch {
    return false;
  }
};

export const deriveLocalEntityCryptoKeys = (
  env: Env,
  entityId: string,
  signerId: string,
): { publicKey: string; privateKey: string } => {
  const signerPriv = getSignerPrivateKey(env, signerId);
  const signerMaterial = `${bytesToHex(signerPriv)}:${entityId}:htlc-v1`;
  const pair = deriveEncryptionKeyPair(signerMaterial);
  return { publicKey: pubKeyToHex(pair.publicKey), privateKey: bytesToHex(pair.privateKey) };
};

export const resolveReplicaEntityCryptoKeys = (
  env: Env,
  entityId: string,
  signerId: string,
  existing?: { publicKey?: string; privateKey?: string },
): { publicKey: string; privateKey: string; isLocal: boolean } => {
  if (hasLocalSignerKey(env, signerId)) {
    const keys = deriveLocalEntityCryptoKeys(env, entityId, signerId);
    return { ...keys, isLocal: true };
  }
  return {
    publicKey: String(existing?.publicKey || ''),
    privateKey: String(existing?.privateKey || ''),
    isLocal: false,
  };
};

export const canonicalizeLocalEntityCryptoKeys = (
  env: Env,
  entityId: string,
  signerId: string,
  state: { entityEncPubKey?: string; entityEncPrivKey?: string },
): void => {
  if (!hasLocalSignerKey(env, signerId)) return;
  const { publicKey, privateKey } = deriveLocalEntityCryptoKeys(env, entityId, signerId);
  if (state.entityEncPubKey && state.entityEncPubKey !== publicKey) {
    throw new Error(
      `ENTITY_CRYPTO_KEY_MISMATCH: entity=${entityId} signer=${signerId} ` +
        `expectedPub=${publicKey} actualPub=${String(state.entityEncPubKey || '')}`,
    );
  }
  state.entityEncPubKey = publicKey;
  state.entityEncPrivKey = privateKey;
};

/**
 * Persisted validator-local identity is evidence, not a cache. A local signer
 * can rederive the exact keypair from trusted seed material, so a mismatch is
 * storage corruption and must never be repaired implicitly during restore.
 */
export const assertPersistedLocalEntityCryptoKeys = (
  env: Env,
  entityId: string,
  signerId: string,
  state: { entityEncPubKey?: string; entityEncPrivKey?: string },
): void => {
  if (!hasLocalSignerKey(env, signerId)) return;
  const expected = deriveLocalEntityCryptoKeys(env, entityId, signerId);
  if (
    state.entityEncPubKey !== expected.publicKey ||
    state.entityEncPrivKey !== expected.privateKey
  ) {
    throw new Error(
      `ENTITY_CRYPTO_KEY_MISMATCH: entity=${entityId} signer=${signerId} ` +
      `expectedPub=${expected.publicKey} actualPub=${String(state.entityEncPubKey || '')} ` +
      `privateKeyMatch=${state.entityEncPrivKey === expected.privateKey}`,
    );
  }
};

export const assertLocalEntityCryptoKeys = (env: Env): void => {
  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    const signerId = extractSignerId(replicaKey);
    canonicalizeLocalEntityCryptoKeys(env, replica.entityId, signerId, replica.state);
  }
};
