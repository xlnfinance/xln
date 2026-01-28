/**
 * Hanko signing integration for consensus layer
 * Bridges between account-consensus and hanko.ts library
 */

import type { Env, HankoString } from './types';
import { buildRealHanko } from './hanko';
import { ethers } from 'ethers';
import { getCachedSignerPublicKey } from './account-crypto';

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

const normalizeAddress = (value: string): string | null => {
  try {
    return ethers.getAddress(value).toLowerCase();
  } catch {
    return null;
  }
};

const publicKeyToAddress = (value: string): string | null => {
  const hex = value.startsWith('0x') ? value : `0x${value}`;
  if (hex.length === 42) {
    return normalizeAddress(hex);
  }
  if (hex.length === 130 || hex.length === 132) {
    try {
      return ethers.computeAddress(hex).toLowerCase();
    } catch {
      return null;
    }
  }
  return null;
};

/**
 * Sign hashes on behalf of an entity using one validator's key
 *
 * Works for any entity (single or multi-signer). The signer must be
 * a member of entity's board.validators[]. Verification checks this.
 *
 * For multi-signer quorum, call multiple times with different signers
 * and combine the hankos, or use buildRealHanko directly.
 */
export async function signEntityHashes(
  env: Env,
  entityId: string,
  signerId: string,
  hashes: string[]
): Promise<HankoString[]> {
  if (env?.runtimeSeed === undefined || env?.runtimeSeed === null) {
    throw new Error(`CRYPTO_DETERMINISM_VIOLATION: signEntityHashes called without env.runtimeSeed for entity ${entityId.slice(-4)}`);
  }

  const hankos: HankoString[] = [];

  // Get private key for this signer (pass env for pure function)
  const { getSignerPrivateKey } = await import('./account-crypto');
  const privateKey = getSignerPrivateKey(env, signerId);

  // Sign each hash independently (single-signer = simple case)
  for (const hash of hashes) {
    const hashBuffer = bufferFrom(hash.replace('0x', ''), 'hex');

    // Build hanko with single EOA signature
    const hanko = await buildRealHanko(hashBuffer, {
      noEntities: [],
      privateKeys: [privateKey as Buffer],
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

/** @deprecated Use signEntityHashes instead */
export const signHashesAsSingleEntity = signEntityHashes;

/**
 * Verify hanko signature for single hash with STRICT board validation
 * Returns entityId if valid, null if invalid
 *
 * @param hankoBytes - ABI-encoded HankoBytes
 * @param hash - Hash that was signed
 * @param expectedEntityId - REQUIRED: Entity that MUST have signed
 * @param env - Runtime env to lookup entity board validators
 */
export async function verifyHankoForHash(
  hankoBytes: HankoString,
  hash: string,
  expectedEntityId: string,
  env?: any
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

    // CRITICAL: Recover EOA addresses from signatures
    const recoveredAddresses: string[] = [];
    for (let i = 0; i < eoaSignatures.length; i++) {
      const sig = eoaSignatures[i];
      if (!sig || sig.length < 65) {
        console.warn(`❌ Hanko signature ${i} is invalid or too short`);
        continue;
      }
      const r = ethers.hexlify(sig.slice(0, 32));
      const s = ethers.hexlify(sig.slice(32, 64));
      const v = sig[64];
      if (v === undefined) {
        console.warn(`❌ Hanko signature ${i} missing recovery byte`);
        continue;
      }
      const yParity = (v >= 27 ? v - 27 : v) as 0 | 1;
      const recoveredAddr = ethers.recoverAddress(ethers.hexlify(hashBuffer), { r, s, v, yParity });
      recoveredAddresses.push(recoveredAddr.toLowerCase());
    }

    // CRITICAL: Find claim for expectedEntityId (NOT just last claim!)
    const expectedEntityIdPadded = expectedEntityId.replace('0x', '').padStart(64, '0');
    const matchingClaim = hanko.claims.find((c: { entityId: Uint8Array }) => {
      const claimEntityHex = Array.from(c.entityId).map((b: number) => b.toString(16).padStart(2, '0')).join('');
      return claimEntityHex === expectedEntityIdPadded;
    });

    if (!matchingClaim) {
      console.warn(`❌ Hanko rejected: No claim found for entity ${expectedEntityId.slice(-4)}`);
      return { valid: false, entityId: null };
    }

    const targetEntity = '0x' + Array.from(matchingClaim.entityId).map((b) => (b as number).toString(16).padStart(2, '0')).join('');

    // CRITICAL: Verify recovered addresses match entity's board validators
    let expectedAddresses: string[] = [];
    let boardVerified = false;

    if (env && env.eReplicas) {
      const replica: any = Array.from(env.eReplicas.values()).find((r: any) => r.state?.entityId === expectedEntityId);
      if (replica) {
        const validators: string[] = replica.state?.config?.validators || [];

        // Convert validators to addresses (local entity: signerId derivation is allowed)
        const { getSignerAddress } = await import('./account-crypto');
        expectedAddresses = validators.map((v: string) => {
          if (v.startsWith('0x')) {
            return publicKeyToAddress(v);
          }
          return getSignerAddress(env, v)?.toLowerCase();
        }).filter(Boolean) as string[];
      }
    }

    // Fallback: use gossip profile metadata (remote entity) if no local replica
    if (expectedAddresses.length === 0 && env?.gossip?.getProfiles) {
      const profile = env.gossip.getProfiles().find((p: any) => p.entityId === expectedEntityId);
      if (profile) {
        const boardMeta = profile.metadata?.board;
        const publicKey = profile.metadata?.entityPublicKey;
        if (typeof publicKey === 'string') {
          const derived = publicKeyToAddress(publicKey);
          if (derived) expectedAddresses.push(derived);
        }

        const boardEntries = Array.isArray(boardMeta)
          ? boardMeta.map(entry => ({ signer: entry }))
          : (boardMeta?.validators || []);

        for (const entry of boardEntries) {
          if (!entry) continue;
          if (typeof entry === 'string') {
            const derived = publicKeyToAddress(entry);
            if (derived) expectedAddresses.push(derived);
            continue;
          }
          if (entry.publicKey) {
            const derived = publicKeyToAddress(entry.publicKey);
            if (derived) expectedAddresses.push(derived);
          }
          if (entry.signer) {
            const derived = publicKeyToAddress(entry.signer);
            if (derived) expectedAddresses.push(derived);
          }
        }

        expectedAddresses = Array.from(new Set(expectedAddresses));
      }
    }

    // Fallback: check registered public keys (from P2P gossip applyIncomingProfiles)
    if (expectedAddresses.length === 0) {
      const registeredPubKey = getCachedSignerPublicKey(expectedEntityId);
      if (registeredPubKey) {
        const pubKeyHex = '0x' + Array.from(registeredPubKey).map(b => b.toString(16).padStart(2, '0')).join('');
        const derived = publicKeyToAddress(pubKeyHex);
        if (derived) {
          expectedAddresses.push(derived);
          console.log(`✅ Using registered public key for ${expectedEntityId.slice(-4)}`);
        }
      }
    }

    if (expectedAddresses.length > 0) {
      for (const addr of recoveredAddresses) {
        if (!expectedAddresses.includes(addr)) {
          console.warn(`❌ Hanko rejected: Signer ${addr.slice(0, 10)} not in entity board validators`);
          console.warn(`   Expected validators:`, expectedAddresses.map(a => a.slice(0, 10)));
          return { valid: false, entityId: null };
        }
      }
      console.log(`✅ Board validation passed: ${recoveredAddresses.length} signers match board validators`);
      boardVerified = true;
    }

    // SECURITY: Board verification is MANDATORY in production
    // External entities MUST have board metadata in gossip profiles before signatures are accepted
    if (!boardVerified) {
      console.error(`❌ SECURITY: Cannot verify board for entity ${expectedEntityId.slice(-4)} - board/publicKey missing in replicas or gossip`);
      console.error(`   Rejecting Hanko signature - board verification is mandatory for production`);
      return { valid: false, entityId: null };
    }

    // Valid if at least one yes entity AND entityId matches AND has valid EOA sigs from board (already verified)
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
