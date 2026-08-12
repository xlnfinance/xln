import { getSignerPrivateKey, getSignerPrivateKeyIfAvailable } from '../../account/crypto';
import { extractSignerId } from '../../protocol/identity';
import { deriveEncryptionKeyPair, pubKeyToHex } from '../../protocol/p2p-crypto';
import type { EntityRuntimeContext } from '../runtime-context';

const bytesToHex = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('')}`;

const entityEncryptionKeyId = (entityId: string, signerId: string): string =>
  `${entityId.toLowerCase()}:${signerId.toLowerCase()}`;

const rememberEntityEncryptionPrivateKey = (
  env: EntityRuntimeContext,
  entityId: string,
  signerId: string,
  privateKey: string,
): void => {
  env.infrastructure ??= {};
  env.infrastructure.entityEncryptionPrivateKeys ??= new Map();
  env.infrastructure.entityEncryptionPrivateKeys.set(
    entityEncryptionKeyId(entityId, signerId),
    privateKey,
  );
};

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
  signerId: string,
): string => {
  const keyId = entityEncryptionKeyId(entityId, signerId);
  const cached = env.infrastructure?.entityEncryptionPrivateKeys?.get(keyId);
  if (cached) return cached;
  if (!hasLocalSignerKey(env, signerId)) {
    throw new Error(
      `ENTITY_ENCRYPTION_PRIVATE_KEY_UNAVAILABLE:entity=${entityId}:signer=${signerId}`,
    );
  }
  const privateKey = deriveLocalEntityCryptoKeys(
    env,
    entityId,
    signerId,
  ).privateKey;
  rememberEntityEncryptionPrivateKey(env, entityId, signerId, privateKey);
  return privateKey;
};

export const hasLocalSignerKey = (env: EntityRuntimeContext, signerId: string): boolean => {
  return getSignerPrivateKeyIfAvailable(env, signerId) !== null;
};

export const deriveLocalEntityCryptoKeys = (
  env: EntityRuntimeContext,
  entityId: string,
  signerId: string,
): { publicKey: string; privateKey: string } => {
  const signerPriv = getSignerPrivateKey(env, signerId);
  const signerMaterial = `${bytesToHex(signerPriv)}:${entityId}:htlc-v1`;
  const pair = deriveEncryptionKeyPair(signerMaterial);
  return { publicKey: pubKeyToHex(pair.publicKey), privateKey: bytesToHex(pair.privateKey) };
};

export const resolveReplicaEntityCryptoKeys = (
  env: EntityRuntimeContext,
  entityId: string,
  signerId: string,
  existing?: { publicKey?: string },
): { publicKey: string; isLocal: boolean } => {
  if (hasLocalSignerKey(env, signerId)) {
    const keys = deriveLocalEntityCryptoKeys(env, entityId, signerId);
    rememberEntityEncryptionPrivateKey(
      env,
      entityId,
      signerId,
      keys.privateKey,
    );
    return { publicKey: keys.publicKey, isLocal: true };
  }
  return {
    publicKey: String(existing?.publicKey || ''),
    isLocal: false,
  };
};

export const canonicalizeLocalEntityCryptoKeys = (
  env: EntityRuntimeContext,
  entityId: string,
  signerId: string,
  replica: { entityEncPubKey?: string },
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
  rememberEntityEncryptionPrivateKey(env, entityId, signerId, privateKey);
};

/**
 * Persisted validator-local identity is evidence, not a cache. A local signer
 * can rederive the exact keypair from trusted seed material, so a mismatch is
 * storage corruption and must never be repaired implicitly during restore.
 */
export const assertPersistedLocalEntityCryptoKeys = (
  env: EntityRuntimeContext,
  entityId: string,
  signerId: string,
  replica: { entityEncPubKey?: string },
): void => {
  if (!hasLocalSignerKey(env, signerId)) return;
  const expected = deriveLocalEntityCryptoKeys(env, entityId, signerId);
  if (replica.entityEncPubKey !== expected.publicKey) {
    throw new Error(
      `ENTITY_CRYPTO_KEY_MISMATCH: entity=${entityId} signer=${signerId} ` +
      `expectedPub=${expected.publicKey} actualPub=${String(replica.entityEncPubKey || '')}`,
    );
  }
  rememberEntityEncryptionPrivateKey(
    env,
    entityId,
    signerId,
    expected.privateKey,
  );
};

export const assertLocalEntityCryptoKeys = (env: EntityRuntimeContext): void => {
  for (const [replicaKey, replica] of env.state.eReplicas.entries()) {
    const signerId = extractSignerId(replicaKey);
    canonicalizeLocalEntityCryptoKeys(env, replica.entityId, signerId, replica);
  }
};
