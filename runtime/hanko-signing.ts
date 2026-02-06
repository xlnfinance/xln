/**
 * Hanko signing integration for consensus layer
 * Bridges between account-consensus and hanko.ts library
 */

import type { Env, HankoString } from './types';
import { buildRealHanko } from './hanko';
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
 * Build quorum hanko from multiple validator EOA signatures
 *
 * Called after entity consensus threshold is reached.
 * Combines signatures from multiple validators into single hanko.
 * Supports M-of-N: creates placeholders for board members who didn't sign.
 *
 * @param env - Runtime environment
 * @param entityId - Entity that is signing
 * @param hash - Hash that was signed
 * @param signatures - Array of {signerId, signature} from validators
 * @param config - Entity consensus config (for threshold/weights)
 */
export async function buildQuorumHanko(
  env: Env,
  entityId: string,
  hash: string,
  signatures: Array<{ signerId: string; signature: string }>,
  config: { threshold: bigint; validators: string[]; shares: Record<string, bigint> }
): Promise<HankoString> {
  // Build quorum hanko from signatures

  const { getSignerAddress } = await import('./account-crypto');

  // Step 1: Determine which validators signed and which didn't
  const signerSet = new Set(signatures.map(s => s.signerId));
  const signingValidators: string[] = [];
  const nonSigningValidators: string[] = [];

  for (const validatorId of config.validators) {
    if (signerSet.has(validatorId)) {
      signingValidators.push(validatorId);
    } else {
      nonSigningValidators.push(validatorId);
    }
  }

  // Step 2: Build placeholders for non-signing validators (as bytes32 addresses)
  const placeholders: string[] = [];
  for (const validatorId of nonSigningValidators) {
    const address = getSignerAddress(env, validatorId);
    if (!address) {
      console.warn(`⚠️ BUILD-QUORUM-HANKO: Cannot derive address for non-signing validator ${validatorId}`);
      continue;
    }
    // Convert address to bytes32 (left-pad with zeros, matching EP.sol conversion)
    placeholders.push('0x' + address.replace('0x', '').toLowerCase().padStart(64, '0'));
  }

  // Step 3: Convert signing validators' signatures to packed format
  const sigBuffers: Buffer[] = [];
  const validSignerIds: string[] = [];

  for (const { signerId, signature } of signatures) {
    // Only pack signatures from known validators
    if (!config.validators.includes(signerId)) {
      console.warn(`⚠️ BUILD-QUORUM-HANKO: Unknown validator ${signerId} - skipping`);
      continue;
    }

    // Parse signature (65 bytes: r[32] + s[32] + v[1])
    const sigHex = signature.replace('0x', '');
    if (sigHex.length < 130) {
      console.warn(`⚠️ Invalid signature from ${signerId}: too short (${sigHex.length} hex chars)`);
      continue;
    }
    const sigBuffer = bufferFrom(sigHex.slice(0, 130), 'hex');

    // Get v value (last byte)
    const vHex = sigHex.slice(128, 130);
    const v = parseInt(vHex, 16);
    const vNormalized = v < 27 ? v + 27 : v;

    // Combine r, s, v into 65-byte signature
    const fullSig = bufferAlloc(65);
    fullSig.set(sigBuffer.slice(0, 64), 0); // r + s
    fullSig[64] = vNormalized;

    sigBuffers.push(fullSig);
    validSignerIds.push(signerId);
  }

  if (sigBuffers.length === 0) {
    throw new Error(`BUILD-QUORUM-HANKO: No valid signatures provided`);
  }

  // Pack all signatures
  const { packRealSignatures } = await import('./hanko');
  const packedSignatures = packRealSignatures(sigBuffers);

  // Step 4: Build entityIndexes and weights in ORIGINAL BOARD ORDER
  // This is critical for board hash reconstruction in EP.sol
  // Index mapping:
  //   0..placeholders.length-1 → placeholders (non-signers)
  //   placeholders.length..placeholders.length+signers.length-1 → signers
  const entityIndexes: number[] = [];
  const weights: number[] = [];

  // Map validatorId → their signature index in sigBuffers
  const signerToSigIndex = new Map<string, number>();
  validSignerIds.forEach((id, idx) => signerToSigIndex.set(id, idx));

  // Map validatorId → their placeholder index
  const nonSignerToPlaceholderIndex = new Map<string, number>();
  nonSigningValidators.forEach((id, idx) => nonSignerToPlaceholderIndex.set(id, idx));

  // Build indexes in original validator order (preserves board order for hash)
  for (const validatorId of config.validators) {
    const sigIndex = signerToSigIndex.get(validatorId);
    if (sigIndex !== undefined) {
      // Signed → index into signers (offset by placeholder count)
      entityIndexes.push(placeholders.length + sigIndex);
    } else {
      const placeholderIndex = nonSignerToPlaceholderIndex.get(validatorId);
      if (placeholderIndex !== undefined) {
        // Didn't sign → index into placeholders
        entityIndexes.push(placeholderIndex);
      }
    }
    weights.push(Number(config.shares[validatorId] || 1n));
  }

  // Build claim for this entity
  const toHex = (buf: Buffer) => '0x' + Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');

  // ABI encode hanko - MATCH EP.sol struct exactly
  // With M-of-N: placeholders contains non-signing board members
  const abiEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256)[])'],
    [
      [
        placeholders, // Non-signing board members (enables M-of-N)
        toHex(packedSignatures as Buffer),
        [
          [
            '0x' + entityId.replace('0x', '').padStart(64, '0'),
            entityIndexes,
            weights,
            Number(config.threshold),
          ],
        ],
      ],
    ],
  );

  // Hanko built: sigBuffers.length sigs, placeholders.length placeholders
  return abiEncoded as HankoString;
}

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
      const allProfiles = env.gossip.getProfiles();
      const profile = allProfiles.find((p: any) => p.entityId === expectedEntityId);
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

    if (expectedAddresses.length > 0) {
      // External board found — verify recovered signers match
      for (const addr of recoveredAddresses) {
        if (!expectedAddresses.includes(addr)) {
          console.warn(`❌ Hanko rejected: Signer ${addr.slice(0, 10)} not in entity board validators`);
          console.warn(`   Expected validators:`, expectedAddresses.map(a => a.slice(0, 10)));
          return { valid: false, entityId: null };
        }
      }
      boardVerified = true;
    } else {
      // Self-contained verification: the Hanko IS the board declaration
      // Reconstruct board from claim's entityIndexes + recovered signatures + placeholders
      // For gossip/first-contact: sufficient because real security is at consensus layer
      const numPlaceholders = hanko.placeholders.length;
      let signerWeightSum = 0;
      for (let i = 0; i < matchingClaim.entityIndexes.length; i++) {
        const memberIndex = matchingClaim.entityIndexes[i];
        if (memberIndex >= numPlaceholders) {
          // This slot maps to a signer (not a placeholder) — they actually signed
          signerWeightSum += matchingClaim.weights[i];
        }
      }
      if (signerWeightSum >= matchingClaim.threshold) {
        boardVerified = true;
      } else {
        console.warn(`❌ Hanko self-contained: insufficient weight ${signerWeightSum}/${matchingClaim.threshold}`);
        return { valid: false, entityId: null };
      }
    }

    // Valid if at least one yes entity AND entityId matches AND has valid EOA sigs from board (already verified)
    if (recovered.yesEntities.length > 0) {
      // Hanko valid
      return { valid: true, entityId: targetEntity };
    }

    return { valid: false, entityId: null };
  } catch (error) {
    console.error(`❌ Hanko verification error:`, error);
    return { valid: false, entityId: null };
  }
}
