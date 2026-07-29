import { getSignerPrivateKey, getSignerPrivateKeyIfAvailable } from '../account/crypto';
import { extractSignerId } from '../ids';
import { deriveEncryptionKeyPair, pubKeyToHex } from '../protocol/p2p-crypto';
import type { RuntimeState } from '../types';

const bytesToHex = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('')}`;

export const hasLocalSignerKey = (env: RuntimeState, signerId: string): boolean => {
  return getSignerPrivateKeyIfAvailable(env, signerId) !== null;
};

export const deriveLocalEntityCryptoKeys = (
  env: RuntimeState,
  entityId: string,
  signerId: string,
): { publicKey: string; privateKey: string } => {
  const signerPriv = getSignerPrivateKey(env, signerId);
  const signerMaterial = `${bytesToHex(signerPriv)}:${entityId}:htlc-v1`;
  const pair = deriveEncryptionKeyPair(signerMaterial);
  return { publicKey: pubKeyToHex(pair.publicKey), privateKey: bytesToHex(pair.privateKey) };
};

export const resolveReplicaEntityCryptoKeys = (
  env: RuntimeState,
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
  env: RuntimeState,
  entityId: string,
  signerId: string,
  replica: { entityEncPubKey?: string; entityEncPrivKey?: string },
): void => {
  if (!hasLocalSignerKey(env, signerId)) return;
  const { publicKey, privateKey } = deriveLocalEntityCryptoKeys(env, entityId, signerId);
  if (replica.entityEncPubKey && replica.entityEncPubKey !== publicKey) {
    throw new Error(
      `ENTITY_CRYPTO_KEY_MISMATCH: entity=${entityId} signer=${signerId} ` +
        `expectedPub=${publicKey} actualPub=${String(replica.entityEncPubKey || '')}`,
    );
  }
  replica.entityEncPubKey = publicKey;
  replica.entityEncPrivKey = privateKey;
};

/**
 * Persisted validator-local identity is evidence, not a cache. A local signer
 * can rederive the exact keypair from trusted seed material, so a mismatch is
 * storage corruption and must never be repaired implicitly during restore.
 */
export const assertPersistedLocalEntityCryptoKeys = (
  env: RuntimeState,
  entityId: string,
  signerId: string,
  replica: { entityEncPubKey?: string; entityEncPrivKey?: string },
): void => {
  if (!hasLocalSignerKey(env, signerId)) return;
  const expected = deriveLocalEntityCryptoKeys(env, entityId, signerId);
  if (
    replica.entityEncPubKey !== expected.publicKey ||
    replica.entityEncPrivKey !== expected.privateKey
  ) {
    throw new Error(
      `ENTITY_CRYPTO_KEY_MISMATCH: entity=${entityId} signer=${signerId} ` +
      `expectedPub=${expected.publicKey} actualPub=${String(replica.entityEncPubKey || '')} ` +
      `privateKeyMatch=${replica.entityEncPrivKey === expected.privateKey}`,
    );
  }
};

export const assertLocalEntityCryptoKeys = (env: RuntimeState): void => {
  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    const signerId = extractSignerId(replicaKey);
    canonicalizeLocalEntityCryptoKeys(env, replica.entityId, signerId, replica);
  }
};
