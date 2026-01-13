/**
 * Hanko signing integration for consensus layer
 * Bridges between account-consensus and hanko.ts library
 */

import type { Env, HankoString } from './types';
import { buildRealHanko } from './hanko';
import { getSignerPublicKey } from './account-crypto';
import { ethers } from 'ethers';

// Browser-compatible Buffer helpers - ALWAYS use manual hex parsing (Node Buffer.from can be broken in some envs)
const bufferFrom = (data: string | Uint8Array | number[], encoding?: BufferEncoding): Buffer => {
  // ALWAYS use manual parsing for hex to avoid browser Buffer bugs
  if (typeof data === 'string' && encoding === 'hex') {
    const cleaned = data.replace(/^0x/, '');
    const bytes = Uint8Array.from(cleaned.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []);
    return bytes as Buffer;
  }

  // For other encodings, use Buffer if available
  if (typeof Buffer !== 'undefined' && Buffer.from) {
    return Buffer.from(data as any, encoding);
  }

  // Browser fallback for non-hex
  if (typeof data === 'string') {
    return new TextEncoder().encode(data) as Buffer;
  }
  return new Uint8Array(data) as Buffer;
};

const bufferAlloc = (size: number, fill?: number): Buffer => {
  if (typeof Buffer !== 'undefined' && Buffer.alloc) {
    return Buffer.alloc(size, fill);
  }
  // Browser fallback
  const result = new Uint8Array(size);
  if (fill !== undefined) {
    result.fill(fill);
  }
  return result as Buffer;
};

/**
 * Sign multiple hashes as a single-signer entity
 * For single-signer entities (threshold=1, validators=[signerId])
 */
export async function signHashesAsSingleEntity(
  env: Env,
  entityId: string,
  signerId: string,
  hashes: string[]
): Promise<HankoString[]> {
  const hankos: HankoString[] = [];

  // Get private key for this signer
  const { getSignerPrivateKey } = await import('./account-crypto');
  const privateKey = getSignerPrivateKey(signerId);
  if (!privateKey) {
    throw new Error(`Cannot sign - no private key for signerId ${signerId.slice(-4)}`);
  }

  // Sign each hash independently (single-signer = simple case)
  for (const hash of hashes) {
    const hashBuffer = bufferFrom(hash.replace('0x', ''), 'hex');

    // Build hanko with single EOA signature
    const hanko = await buildRealHanko(hashBuffer, {
      noEntities: [],
      privateKeys: [privateKey],
      claims: [
        {
          entityId: bufferFrom(entityId.replace('0x', '').padStart(64, '0'), 'hex'),
          entityIndexes: [0], // Index 0 = first (and only) signature
          weights: [1],
          threshold: 1,
          // NO expectedQuorumHash - EP.sol reconstructs from recovered signers
        },
      ],
    });

    // Encode to ABI format (browser-safe Buffer operations)
    const toHex = (buf: Buffer) => '0x' + Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');

    // ABI encode - MATCH EP.sol struct exactly (4 fields, NO expectedQuorumHash)
    const abiEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ['tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256)[])'],
      [
        [
          hanko.placeholders.map(p => toHex(bufferFrom(p))),
          toHex(bufferFrom(hanko.packedSignatures)),
          hanko.claims.map(c => [
            toHex(bufferFrom(c.entityId)),
            c.entityIndexes,
            c.weights,
            c.threshold,
          ]),
        ],
      ],
    );

    hankos.push(abiEncoded);
  }

  return hankos;
}

/**
 * Verify hanko signature for single hash
 * Returns entityId if valid, null if invalid
 *
 * @param hankoBytes - ABI-encoded HankoBytes
 * @param hash - Hash that was signed
 * @param expectedEntityId - REQUIRED: Entity that MUST have signed (security check)
 */
export async function verifyHankoForHash(
  hankoBytes: HankoString,
  hash: string,
  expectedEntityId: string
): Promise<{ valid: boolean; entityId: string | null }> {
  try {
    // Decode hanko from ABI - MATCH EP.sol struct (4 fields, NO expectedQuorumHash)
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ['tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256)[])'],
      hankoBytes
    );

    const hanko = {
      placeholders: decoded[0][0].map((p: string) => bufferFrom(p.replace('0x', ''), 'hex')),
      packedSignatures: bufferFrom(decoded[0][1].replace('0x', ''), 'hex'),
      claims: decoded[0][2].map((c: any) => ({
        entityId: bufferFrom(c[0].replace('0x', ''), 'hex'),
        entityIndexes: c[1].map((idx: bigint) => Number(idx)),
        weights: c[2].map((w: bigint) => Number(w)),
        threshold: Number(c[3]),
        // NO expectedQuorumHash field
      })),
    };

    // Verify using flashloan governance logic
    const { recoverHankoEntities } = await import('./hanko');
    const hashBuffer = bufferFrom(hash.replace('0x', ''), 'hex');
    const recovered = await recoverHankoEntities(hanko, hashBuffer);

    // CRITICAL: Require at least 1 EOA signature (prevent pure circular validation)
    const { unpackRealSignatures } = await import('./hanko');
    const eoaSignatures = unpackRealSignatures(hanko.packedSignatures);
    if (eoaSignatures.length === 0) {
      console.warn(`❌ Hanko rejected: No EOA signatures (circular claims not allowed in XLN)`);
      return { valid: false, entityId: null };
    }

    // CRITICAL: Must verify that expectedEntityId is the one that signed
    // Check if expectedEntityId is in yesEntities or is the target claim
    const targetEntity = hanko.claims.length > 0
      ? '0x' + Array.from(hanko.claims[hanko.claims.length - 1].entityId).map(b => b.toString(16).padStart(2, '0')).join('')
      : null;

    if (!targetEntity) {
      return { valid: false, entityId: null };
    }

    // Verify that targetEntity matches expectedEntityId (strict check)
    if (targetEntity.toLowerCase() !== expectedEntityId.toLowerCase()) {
      console.warn(`❌ Hanko entityId mismatch: hanko claims ${targetEntity.slice(-4)}, expected ${expectedEntityId.slice(-4)}`);
      return { valid: false, entityId: null };
    }

    // Valid if at least one yes entity AND entityId matches AND has EOA sig
    if (recovered.yesEntities.length > 0) {
      console.log(`✅ Hanko valid: ${eoaSignatures.length} EOA sigs, entity ${targetEntity.slice(-4)}`);
      return { valid: true, entityId: targetEntity };
    }

    return { valid: false, entityId: null };
  } catch (error) {
    console.error(`❌ Hanko verification error:`, error);
    return { valid: false, entityId: null };
  }
}
