import { getSignerPrivateKey } from './account-crypto';
import { extractSignerId } from './ids';
import { deriveEncryptionKeyPair, pubKeyToHex } from './networking/p2p-crypto';
import type { Env } from './types';

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

export const assertLocalEntityCryptoKeys = (env: Env): void => {
  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    const signerId = extractSignerId(replicaKey);
    if (!hasLocalSignerKey(env, signerId)) continue;
    const { publicKey, privateKey } = deriveLocalEntityCryptoKeys(env, replica.entityId, signerId);
    if (replica.state.entityEncPubKey !== publicKey || replica.state.entityEncPrivKey !== privateKey) {
      throw new Error(
        `ENTITY_CRYPTO_KEY_MISMATCH: entity=${replica.entityId} signer=${signerId} ` +
          `expectedPub=${publicKey} actualPub=${String(replica.state.entityEncPubKey || '')}`,
      );
    }
  }
};
