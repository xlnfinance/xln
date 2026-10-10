/**
 * Entity ID normalization, comparison, and provider-scoped ids.
 * Ensures deterministic ordering and cross-provider compatibility.
 */

import { ethers } from 'ethers';
import { cachedChecksumAddress } from '../protocol/crypto/address-cache';
import { normalizeEntityId } from '../protocol/identity/entity-id';

export { compareEntityIds, isLeftEntity, normalizeEntityId } from '../protocol/identity/entity-id';

/**
 * Create a provider-scoped entity ID.
 * Universal format: keccak256(abi.encodePacked(provider, entityId)), so the
 * same boardHash under different EntityProviders never collides.
 *
 * @param provider - EntityProvider contract address
 * @param entityId - The entity's ID within that provider (32 bytes)
 * @returns Globally unique 32-byte hash
 */
export function createProviderScopedEntityId(provider: string, entityId: string): string {
  // Normalize inputs
  const providerAddr = cachedChecksumAddress(provider);
  const normalizedEntity = normalizeEntityId(entityId);

  // ABI encode packed: address (20 bytes) + bytes32 (32 bytes)
  const packed = ethers.solidityPacked(['address', 'bytes32'], [providerAddr, normalizedEntity]);

  // Hash to get final 32-byte ID
  return ethers.keccak256(packed);
}
