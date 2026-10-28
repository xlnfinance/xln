/**
 * Entity ID normalization, comparison, and provider-scoped ids.
 * Ensures deterministic ordering and cross-provider compatibility.
 */
import { toEntityId, type EntityId } from '../protocol/identity';


import { ethers } from 'ethers';
import { cachedChecksumAddress } from '../protocol/crypto/address-cache';


export { compareEntityIds, isLeftEntity } from '../protocol/identity/entity-id';

/**
 * Create a provider-scoped entity ID.
 * Universal format: keccak256(abi.encodePacked(provider, entityId)), so the
 * same boardHash under different EntityProviders never collides.
 *
 * @param provider - EntityProvider contract address
 * @param entityId - The entity's ID within that provider (32 bytes)
 * @returns Globally unique 32-byte hash
 */
export function createProviderScopedEntityId(provider: string, entityId: string): EntityId {
  // Provider address and Entity id are validated at this construction boundary.
  const providerAddr = cachedChecksumAddress(provider);
  const normalizedEntity = toEntityId(entityId);

  // ABI encode packed: address (20 bytes) + bytes32 (32 bytes)
  const packed = ethers.solidityPacked(['address', 'bytes32'], [providerAddr, normalizedEntity]);

  // Hash to get final 32-byte ID
  return toEntityId(ethers.keccak256(packed));
}
