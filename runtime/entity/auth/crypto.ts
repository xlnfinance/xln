import { pubKeyToHex } from '../../protocol/crypto/p2p-crypto';
import { x25519 } from '@noble/curves/ed25519.js';
import { getBytes } from 'ethers';
import type { EntityRuntimeContext } from '../runtime-context';

const entityEncryptionKeyId = (entityId: string): string => entityId.toLowerCase();

/**
 * Resolve a validator-local encryption secret from Runtime infrastructure.
 *
 * A local signer may deterministically rederive a missing cache entry. Remote
 * replica data can never supply this value: accepting a peer/WAL copy would
 * turn untrusted machine state into local key authority.
 */
export const requireEntityEncryptionPrivateKey = (
  env: EntityRuntimeContext,
  entityId: string,
): string => {
  const keyId = entityEncryptionKeyId(entityId);
  const cached = env.infrastructure?.entityEncryptionPrivateKeys?.get(keyId);
  if (cached) return cached;
  throw new Error(`ENTITY_ENCRYPTION_PRIVATE_KEY_UNAVAILABLE:entity=${entityId}`);
};

/** Install owner-custodied Entity key material into process-local infrastructure. */
export const deriveEntityEncryptionPublicKey = (privateKey: string, entityId: string): string => {
  const normalizedPrivateKey = privateKey.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalizedPrivateKey)) {
    throw new Error(`ENTITY_ENCRYPTION_PRIVATE_KEY_INVALID:entity=${entityId}`);
  }
  return pubKeyToHex(x25519.getPublicKey(getBytes(normalizedPrivateKey))).toLowerCase();
};

export const provisionEntityEncryptionKey = (
  env: EntityRuntimeContext,
  entityId: string,
  privateKey: string,
): string => {
  const normalizedPrivateKey = privateKey.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalizedPrivateKey)) {
    throw new Error(`ENTITY_ENCRYPTION_PRIVATE_KEY_INVALID:entity=${entityId}`);
  }
  const keyId = entityEncryptionKeyId(entityId);
  const existing = env.infrastructure?.entityEncryptionPrivateKeys?.get(keyId);
  if (existing && existing !== normalizedPrivateKey) {
    throw new Error(`ENTITY_ENCRYPTION_KEY_CONFLICT:entity=${keyId}`);
  }
  const publicKey = deriveEntityEncryptionPublicKey(normalizedPrivateKey, entityId);
  env.infrastructure ??= {};
  env.infrastructure.entityEncryptionPrivateKeys ??= new Map();
  env.infrastructure.entityEncryptionPrivateKeys.set(keyId, normalizedPrivateKey);
  return publicKey;
};

export const assertLocalEntityCryptoKeys = (env: EntityRuntimeContext): void => {
  for (const replica of env.state.eReplicas.values()) {
    const privateKey = requireEntityEncryptionPrivateKey(env, replica.entityId);
    const publicKey = provisionEntityEncryptionKey(env, replica.entityId, privateKey);
    if (publicKey !== replica.state.entityEncryptionPublicKey) {
      throw new Error(`ENTITY_CRYPTO_KEY_MISMATCH:entity=${replica.entityId}`);
    }
  }
};
