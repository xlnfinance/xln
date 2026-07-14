/**
 * Hanko signing integration for consensus layer
 * Bridges between account-consensus and hanko.ts library
 */

import type { ConsensusConfig, Env, HankoString } from '../types';
import { buildRealHanko } from './core';
import { ethers } from 'ethers';
import { detectEntityType, encodeBoard, generateLazyEntityId, hashBoard } from '../entity/factory';
import { recoverAddressFromDigestSignature } from '../account/crypto';

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
    if (typeof data === 'string') return Buffer.from(data, encoding);
    return Buffer.from(data);
  }

  // Browser fallback for non-hex
  if (typeof data === 'string') {
    return new TextEncoder().encode(data) as Buffer;
  }
  return new Uint8Array(data) as Buffer;
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

const HANKO_ABI = ['tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256)[])'];
const ABI_CODER = ethers.AbiCoder.defaultAbiCoder();

const recoverAddressFromPackedSignature = (hashBuffer: Buffer, sig: Buffer): string | null => {
  if (!sig || sig.length < 65) return null;
  const v = sig[64];
  if (v === undefined) return null;
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) return null;
  return recoverAddressFromDigestSignature(hashBuffer, sig.slice(0, 64), recovery);
};

type DecodedHankoClaim = {
  entityId: string;
  entityIndexes: number[];
  weights: bigint[];
  threshold: bigint;
};

type DecodedHankoEnvelope = {
  placeholders: string[];
  packedSignatures: Buffer;
  claims: DecodedHankoClaim[];
};

type AbiDecodedHankoClaim = readonly [
  entityId: Uint8Array | string,
  entityIndexes: readonly bigint[],
  weights: readonly bigint[],
  threshold: bigint,
];

type AbiDecodedHankoEnvelope = readonly [
  readonly [
    placeholders: readonly string[],
    packedSignatures: string,
    claims: readonly AbiDecodedHankoClaim[],
  ],
];

const toEntityIdHex = (value: Uint8Array | Buffer): string =>
  `0x${Array.from(value).map((b) => b.toString(16).padStart(2, '0')).join('')}`;

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_BOARD_POWER = 0xffffn;

const decodeSafeEntityIndex = (value: bigint): number => {
  if (value < 0n || value > MAX_SAFE_BIGINT) {
    throw new Error(`HANKO_ENTITY_INDEX_UNSAFE: value=${value}`);
  }
  return Number(value);
};

const decodeBoardPower = (value: bigint, label: string): bigint => {
  if (value < 0n || value > MAX_BOARD_POWER) {
    throw new Error(`HANKO_BOARD_POWER_OUT_OF_RANGE: ${label}=${value}`);
  }
  return value;
};

function decodeHankoEnvelope(hankoBytes: HankoString): DecodedHankoEnvelope {
  const decoded = ABI_CODER.decode(HANKO_ABI, hankoBytes) as unknown as AbiDecodedHankoEnvelope;
  const [placeholders, packedSignatures, claims] = decoded[0];
  return {
    placeholders: placeholders.map((p) => ethers.hexlify(p).toLowerCase()),
    packedSignatures: bufferFrom(packedSignatures.replace('0x', ''), 'hex'),
    claims: claims.map((c, claimIndex) => {
      if (c[1].length !== c[2].length) {
        throw new Error(`HANKO_CLAIM_SHAPE_MISMATCH: claim=${claimIndex}`);
      }
      return {
        entityId: ethers.hexlify(c[0]).toLowerCase(),
        entityIndexes: c[1].map(decodeSafeEntityIndex),
        weights: c[2].map((weight, index) => decodeBoardPower(weight, `claim=${claimIndex} weight=${index}`)),
        threshold: decodeBoardPower(c[3], `claim=${claimIndex} threshold`),
      };
    }),
  };
}

const reconstructBoardEntityIds = (
  claim: { entityIndexes: number[] },
  placeholders: string[],
  recoveredAddresses: string[],
  claimEntityIds: string[],
): string[] =>
  claim.entityIndexes.map((idx) => {
    if (idx < placeholders.length) {
      return placeholders[idx]!;
    }
    const signerIndex = idx - placeholders.length;
    if (signerIndex < recoveredAddresses.length) {
      return ethers.zeroPadValue(recoveredAddresses[signerIndex]!, 32).toLowerCase();
    }
    const nestedClaimIndex = signerIndex - recoveredAddresses.length;
    return claimEntityIds[nestedClaimIndex] ?? ethers.ZeroHash;
  });

const reconstructBoardHash = (
  threshold: bigint,
  weights: bigint[],
  boardEntityIds: string[],
): string => {
  const encodedBoard = ABI_CODER.encode(
    ['tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)'],
    [[threshold, boardEntityIds, weights, 0, 0, 0]],
  );
  return ethers.keccak256(encodedBoard).toLowerCase();
};

const findLocalConsensusConfig = (env: Env | undefined, expectedEntityId: string): ConsensusConfig | null => {
  const expected = expectedEntityId.toLowerCase();
  if (!env?.eReplicas) return null;
  const replica = Array.from(env.eReplicas.values()).find(
    (r) => String(r.state?.entityId || '').toLowerCase() === expected,
  );
  return replica?.state?.config ?? null;
};

const computeRegisteredBoardHash = (config: ConsensusConfig): string =>
  hashBoard(encodeBoard(config)).toLowerCase();

export async function inspectHankoForHash(
  hankoBytes: HankoString,
  hash: string,
): Promise<{
  placeholders: string[];
  recoveredAddresses: string[];
  claims: Array<{
    entityId: string;
    entityIndexes: number[];
    weights: bigint[];
    threshold: bigint;
    boardEntityIds: string[];
    reconstructedBoardHash: string;
  }>;
}> {
  const hanko = decodeHankoEnvelope(hankoBytes);
  const { unpackRealSignatures } = await import('./core');
  const eoaSignatures = unpackRealSignatures(hanko.packedSignatures);
  const hashBuffer = bufferFrom(hash.replace('0x', ''), 'hex');
  const recoveredAddresses: string[] = [];

  for (const sig of eoaSignatures) {
    const recoveredAddr = recoverAddressFromPackedSignature(hashBuffer, sig);
    if (recoveredAddr) recoveredAddresses.push(recoveredAddr);
  }

  const claims = hanko.claims.map((claim) => {
    const boardEntityIds = reconstructBoardEntityIds(
      claim,
      hanko.placeholders,
      recoveredAddresses,
      hanko.claims.map((nestedClaim) => nestedClaim.entityId),
    );
    return {
      entityId: claim.entityId,
      entityIndexes: [...claim.entityIndexes],
      weights: [...claim.weights],
      threshold: claim.threshold,
      boardEntityIds,
      reconstructedBoardHash: reconstructBoardHash(claim.threshold, claim.weights, boardEntityIds),
    };
  });

  return {
    placeholders: hanko.placeholders,
    recoveredAddresses,
    claims,
  };
}

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
  const { getSignerPrivateKey, getSignerAddress } = await import('../account/crypto');
  const privateKey = getSignerPrivateKey(env, signerId);
  const entityType = detectEntityType(entityId);
  const signerAddress = getSignerAddress(env, signerId);
  if (entityType === 'lazy') {
    if (!signerAddress) {
      throw new Error(`LAZY_HANKO_SIGNER_ADDRESS_MISSING: entityId=${entityId} signerId=${signerId}`);
    }
    // signEntityHashes builds a single-signer threshold=1 hanko below. The old
    // guard decoded the just-built hanko and recovered the same ECDSA signature
    // again for every hash. That was correct but doubled hot-path crypto cost.
    // The safety invariant is simpler: before signing, the signer address must
    // reconstruct exactly the lazy entity board hash that the hanko will claim.
    const reconstructedEntityId = generateLazyEntityId([signerAddress], 1n).toLowerCase();
    if (reconstructedEntityId !== entityId.toLowerCase()) {
      throw new Error(
        `LAZY_HANKO_SELF_MISMATCH: entityId=${entityId} reconstructed=${reconstructedEntityId} ` +
          `signerId=${signerId} signerAddress=${signerAddress}`,
      );
    }
  }

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
    const abiEncoded = ABI_CODER.encode(
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

type QuorumConfig = {
  threshold: bigint;
  validators: string[];
  shares: Record<string, bigint>;
};

type QuorumValidator = {
  signerId: string;
  signerKey: string;
  address: string;
  share: bigint;
};

const canonicalSignerKey = (signerId: string): string => {
  if (typeof signerId !== 'string' || signerId.trim().length === 0) {
    throw new Error('BUILD_QUORUM_HANKO_INVALID_SIGNER_ID');
  }
  return signerId.trim().toLowerCase();
};

const buildCanonicalShareMap = (shares: Record<string, bigint>): Map<string, bigint> => {
  const result = new Map<string, bigint>();
  for (const [signerId, share] of Object.entries(shares)) {
    const signerKey = canonicalSignerKey(signerId);
    if (result.has(signerKey)) {
      throw new Error(`BUILD_QUORUM_HANKO_DUPLICATE_SHARE: signerId=${signerId}`);
    }
    if (typeof share !== 'bigint' || share <= 0n) {
      throw new Error(`BUILD_QUORUM_HANKO_INVALID_SHARE: signerId=${signerId}`);
    }
    result.set(signerKey, share);
  }
  return result;
};

const assertExactBoardShares = (signerKeys: Set<string>, shares: Map<string, bigint>): void => {
  for (const signerKey of signerKeys) {
    if (!shares.has(signerKey)) {
      throw new Error(`BUILD_QUORUM_HANKO_MISSING_SHARE: signerId=${signerKey}`);
    }
  }
  for (const shareKey of shares.keys()) {
    if (!signerKeys.has(shareKey)) {
      throw new Error(`BUILD_QUORUM_HANKO_UNKNOWN_SHARE: signerId=${shareKey}`);
    }
  }
};

const resolveQuorumBoard = (
  env: Env,
  config: QuorumConfig,
  getSignerAddress: (env: Env, signerId: string) => string | null,
): QuorumValidator[] => {
  if (typeof config.threshold !== 'bigint' || config.threshold <= 0n) {
    throw new Error('BUILD_QUORUM_HANKO_INVALID_THRESHOLD');
  }
  if (!Array.isArray(config.validators) || config.validators.length === 0) {
    throw new Error('BUILD_QUORUM_HANKO_EMPTY_BOARD');
  }
  const shares = buildCanonicalShareMap(config.shares);
  const signerKeys = new Set<string>();
  const validatorIds = config.validators.map((signerId) => {
    const signerKey = canonicalSignerKey(signerId);
    if (signerKeys.has(signerKey)) {
      throw new Error(`BUILD_QUORUM_HANKO_DUPLICATE_VALIDATOR: signerId=${signerId}`);
    }
    signerKeys.add(signerKey);
    return { signerId, signerKey };
  });
  assertExactBoardShares(signerKeys, shares);
  const addresses = new Set<string>();
  return validatorIds.map(({ signerId, signerKey }) => {
    const address = publicKeyToAddress(signerId) ?? normalizeAddress(getSignerAddress(env, signerId) ?? '');
    if (!address) {
      throw new Error(`BUILD_QUORUM_HANKO_PLACEHOLDER_ADDRESS_MISSING: signerId=${signerId}`);
    }
    if (addresses.has(address)) {
      throw new Error(`BUILD_QUORUM_HANKO_DUPLICATE_VALIDATOR_ADDRESS: address=${address}`);
    }
    addresses.add(address);
    return { signerId, signerKey, address, share: shares.get(signerKey)! };
  });
};

const canonicalBoardHash = (validators: QuorumValidator[], threshold: bigint): string => {
  const validatorAddresses = validators.map((validator) => validator.address);
  return hashBoard(encodeBoard({
    mode: 'proposer-based',
    threshold,
    validators: validatorAddresses,
    shares: Object.fromEntries(validators.map((validator) => [validator.address, validator.share])),
  })).toLowerCase();
};

const assertQuorumBoardBinding = (
  env: Env,
  entityId: string,
  config: QuorumConfig,
  validators: QuorumValidator[],
  getSignerAddress: (env: Env, signerId: string) => string | null,
): void => {
  const suppliedBoardHash = canonicalBoardHash(validators, config.threshold);
  if (detectEntityType(entityId) === 'lazy') {
    if (suppliedBoardHash !== encodeQuorumEntityId(entityId)) {
      throw new Error(
        `BUILD_QUORUM_HANKO_BOARD_MISMATCH: entityId=${entityId} suppliedBoard=${suppliedBoardHash}`,
      );
    }
    return;
  }
  const authoritativeConfig = findLocalConsensusConfig(env, entityId);
  if (!authoritativeConfig) {
    throw new Error(`BUILD_QUORUM_HANKO_BOARD_UNAVAILABLE: entityId=${entityId}`);
  }
  const authoritativeValidators = resolveQuorumBoard(env, authoritativeConfig, getSignerAddress);
  const authoritativeBoardHash = canonicalBoardHash(authoritativeValidators, authoritativeConfig.threshold);
  if (suppliedBoardHash !== authoritativeBoardHash) {
    throw new Error(
      `BUILD_QUORUM_HANKO_BOARD_MISMATCH: entityId=${entityId} ` +
        `authoritative=${authoritativeBoardHash} supplied=${suppliedBoardHash}`,
    );
  }
};

const parseQuorumDigest = (hash: string): Buffer => {
  if (!/^0x[0-9a-f]{64}$/i.test(hash)) {
    throw new Error(`BUILD_QUORUM_HANKO_INVALID_DIGEST: hash=${hash}`);
  }
  return bufferFrom(hash.slice(2), 'hex');
};

const parseQuorumSignature = (
  digest: Buffer,
  validator: QuorumValidator,
  signature: string,
): Buffer => {
  if (!/^0x[0-9a-f]{130}$/i.test(signature)) {
    throw new Error(`BUILD_QUORUM_HANKO_INVALID_SIGNATURE_LENGTH: signerId=${validator.signerId}`);
  }
  const bytes = bufferFrom(signature.slice(2), 'hex');
  const recovery = bytes[64];
  // Precommit signatures have one wire representation: signAccountFrame emits
  // recovery 0/1. Accepting 27/28 here would give the same vote two byte-level
  // encodings; only the Hanko packer below converts the canonical vote to 27/28.
  if (recovery !== 0 && recovery !== 1) {
    throw new Error(`BUILD_QUORUM_HANKO_NON_CANONICAL_RECOVERY: signerId=${validator.signerId}`);
  }
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const secp256k1HalfOrder = BigInt('0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0');
  if (s === 0n || s > secp256k1HalfOrder) {
    throw new Error(`BUILD_QUORUM_HANKO_NON_CANONICAL_SIGNATURE: signerId=${validator.signerId}`);
  }
  const recovered = recoverAddressFromDigestSignature(digest, bytes.slice(0, 64), recovery);
  if (!recovered || recovered !== validator.address) {
    throw new Error(
      `BUILD_QUORUM_HANKO_SIGNER_MISMATCH: signerId=${validator.signerId} ` +
        `expected=${validator.address} recovered=${recovered ?? 'null'}`,
    );
  }
  const packed = bufferFrom(bytes);
  packed[64] = 27 + recovery;
  return packed;
};

const encodeQuorumEntityId = (entityId: string): string => {
  const normalized = entityId.trim();
  if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(normalized)) {
    throw new Error(`BUILD_QUORUM_HANKO_INVALID_ENTITY_ID: entityId=${entityId}`);
  }
  try {
    return ethers.toBeHex(BigInt(normalized), 32).toLowerCase();
  } catch {
    throw new Error(`BUILD_QUORUM_HANKO_INVALID_ENTITY_ID: entityId=${entityId}`);
  }
};

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
  config: QuorumConfig,
): Promise<HankoString> {
  const { getSignerAddress } = await import('../account/crypto');
  const digest = parseQuorumDigest(hash);
  const validators = resolveQuorumBoard(env, config, getSignerAddress);
  const validatorsByKey = new Map(validators.map((validator) => [validator.signerKey, validator]));
  const signaturesByKey = new Map<string, Buffer>();
  for (const entry of signatures) {
    const signerKey = canonicalSignerKey(entry.signerId);
    if (signaturesByKey.has(signerKey)) {
      throw new Error(`BUILD_QUORUM_HANKO_DUPLICATE_SIGNATURE: signerId=${entry.signerId}`);
    }
    const validator = validatorsByKey.get(signerKey);
    if (!validator) {
      throw new Error(`BUILD_QUORUM_HANKO_UNKNOWN_SIGNER: signerId=${entry.signerId}`);
    }
    signaturesByKey.set(signerKey, parseQuorumSignature(digest, validator, entry.signature));
  }
  const signedPower = validators.reduce(
    (power, validator) => power + (signaturesByKey.has(validator.signerKey) ? validator.share : 0n),
    0n,
  );
  if (signedPower < config.threshold) {
    throw new Error(`BUILD_QUORUM_HANKO_INSUFFICIENT_QUORUM: power=${signedPower} threshold=${config.threshold}`);
  }
  assertQuorumBoardBinding(env, entityId, config, validators, getSignerAddress);

  const signingValidators = validators.filter((validator) => signaturesByKey.has(validator.signerKey));
  const nonSigningValidators = validators.filter((validator) => !signaturesByKey.has(validator.signerKey));
  const placeholders = nonSigningValidators.map((validator) => ethers.zeroPadValue(validator.address, 32));
  const sigBuffers = signingValidators.map((validator) => signaturesByKey.get(validator.signerKey)!);
  const { packRealSignatures } = await import('./core');
  const packedSignatures = packRealSignatures(sigBuffers);
  const signerIndexes = new Map(signingValidators.map((validator, index) => [validator.signerKey, index]));
  const placeholderIndexes = new Map(nonSigningValidators.map((validator, index) => [validator.signerKey, index]));
  const entityIndexes = validators.map((validator) => {
    const signerIndex = signerIndexes.get(validator.signerKey);
    return signerIndex === undefined
      ? placeholderIndexes.get(validator.signerKey)!
      : placeholders.length + signerIndex;
  });
  const abiEncoded = ABI_CODER.encode(
    HANKO_ABI,
    [[
      placeholders,
      ethers.hexlify(packedSignatures),
      [[encodeQuorumEntityId(entityId), entityIndexes, validators.map((validator) => validator.share), config.threshold]],
    ]],
  );
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
  env?: Env,
): Promise<{ valid: boolean; entityId: string | null }> {
  try {
    const decodedHanko = decodeHankoEnvelope(hankoBytes);
    const hashBuffer = bufferFrom(hash.replace('0x', ''), 'hex');
    const hanko = {
      placeholders: decodedHanko.placeholders.map((p) => bufferFrom(p.replace('0x', ''), 'hex')),
      packedSignatures: decodedHanko.packedSignatures,
      claims: decodedHanko.claims.map((c) => ({
        entityId: bufferFrom(c.entityId.replace('0x', ''), 'hex'),
        entityIndexes: [...c.entityIndexes],
        // recoverHankoEntities predates bigint board powers. decodeHankoEnvelope
        // already enforces uint16 board bounds, so this conversion is exact.
        weights: c.weights.map((weight) => Number(weight)),
        threshold: Number(c.threshold),
      })),
    };

    // CRITICAL: Require at least 1 EOA signature (prevent pure circular validation)
    const { unpackRealSignatures } = await import('./core');
    const eoaSignatures = unpackRealSignatures(hanko.packedSignatures);
    if (eoaSignatures.length === 0) {
      console.warn(`❌ Hanko rejected: No EOA signatures (circular claims not allowed in XLN)`);
      return { valid: false, entityId: null };
    }

    const expectedEntityType = detectEntityType(expectedEntityId);
    const expectedEntityIdPadded = expectedEntityId.replace('0x', '').padStart(64, '0');
    const localConsensusConfig = findLocalConsensusConfig(env, expectedEntityId);

    if (
      expectedEntityType === 'lazy' &&
      decodedHanko.placeholders.length === 0 &&
      decodedHanko.claims.length === 1 &&
      eoaSignatures.length === 1
    ) {
      const claim = decodedHanko.claims[0]!;
      const canonicalSingleSignerClaim =
        claim.entityId.replace('0x', '') === expectedEntityIdPadded &&
        claim.threshold === 1n &&
        claim.entityIndexes.length === 1 &&
        claim.entityIndexes[0] === 0 &&
        claim.weights.length === 1 &&
        claim.weights[0] === 1n;
      if (canonicalSingleSignerClaim) {
        // Hot path for the normal runtime shape: one lazy entity, one EOA,
        // threshold 1. We still recover the signer from the exact signed hash,
        // then reconstruct the lazy entity id from that signer. Anything more
        // complex falls through to the full flashloan-governance verifier below.
        const recoveredAddr = recoverAddressFromPackedSignature(hashBuffer, eoaSignatures[0]!);
        if (!recoveredAddr) {
          console.warn(`❌ Hanko rejected: single-signer lazy recovery failed`);
          return { valid: false, entityId: null };
        }
        const reconstructedEntityId = generateLazyEntityId([recoveredAddr], 1n).toLowerCase();
        if (reconstructedEntityId !== expectedEntityId.toLowerCase()) {
          console.warn(
            `❌ Hanko rejected: lazy signer mismatch ` +
              `expected=${expectedEntityId.slice(-8)} reconstructed=${reconstructedEntityId.slice(-8)}`,
          );
          return { valid: false, entityId: null };
        }
        return { valid: true, entityId: claim.entityId };
      }
    }

    // Verify using full flashloan governance logic for multisig, nested, and
    // non-canonical Hanko envelopes. The single-signer lazy path above is only
    // a specialization of the same rule and never accepts a shape this fallback
    // would reject.
    const { recoverHankoEntities } = await import('./core');
    const recovered = await recoverHankoEntities(hanko, hashBuffer);

    // CRITICAL: Recover EOA addresses from signatures
    const recoveredAddresses: string[] = [];
    for (let i = 0; i < eoaSignatures.length; i++) {
      const sig = eoaSignatures[i];
      if (!sig || sig.length < 65) {
        console.warn(`❌ Hanko signature ${i} is invalid or too short`);
        continue;
      }
      try {
        const recoveredAddr = recoverAddressFromPackedSignature(hashBuffer, sig);
        if (!recoveredAddr) {
          console.warn(`❌ Hanko signature ${i} has invalid recovery byte`);
          continue;
        }
        recoveredAddresses.push(recoveredAddr);
      } catch (error) {
        console.warn(`❌ Hanko signature ${i} recovery failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }

    // CRITICAL: Find claim for expectedEntityId (NOT just last claim!)
    const matchingClaim = decodedHanko.claims.find(
      (claim) => claim.entityId.replace('0x', '') === expectedEntityIdPadded,
    );

    if (!matchingClaim) {
      console.warn(`❌ Hanko rejected: No claim found for entity ${expectedEntityId.slice(-4)}`);
      return { valid: false, entityId: null };
    }

    const targetEntity = matchingClaim.entityId;
    const claimEntityIds = decodedHanko.claims.map((claim) => claim.entityId);
    const reconstructedBoardEntityIds = reconstructBoardEntityIds(
      matchingClaim,
      decodedHanko.placeholders,
      recoveredAddresses,
      claimEntityIds,
    );
    const reconstructedBoardHash = reconstructBoardHash(
      matchingClaim.threshold,
      matchingClaim.weights,
      reconstructedBoardEntityIds,
    );

    if (expectedEntityType === 'lazy') {
      if (reconstructedBoardHash !== expectedEntityId.toLowerCase()) {
        console.warn(
          `❌ Hanko rejected: lazy entity board hash mismatch ` +
            `expected=${expectedEntityId.slice(-8)} reconstructed=${reconstructedBoardHash.slice(-8)}`,
        );
        return { valid: false, entityId: null };
      }
    } else {
      if (!localConsensusConfig) {
        console.warn(
          `❌ Hanko rejected: registered entity board unavailable ` +
            `entity=${expectedEntityId.slice(-8)}`,
        );
        return { valid: false, entityId: null };
      }
      const authoritativeBoardHash = computeRegisteredBoardHash(localConsensusConfig);
      if (reconstructedBoardHash !== authoritativeBoardHash) {
        console.warn(
          `❌ Hanko rejected: registered entity board hash mismatch ` +
            `expected=${authoritativeBoardHash.slice(-8)} reconstructed=${reconstructedBoardHash.slice(-8)}`,
        );
        return { valid: false, entityId: null };
      }
    }

    // CRITICAL: Verify recovered addresses match entity's board validators
    let expectedAddresses: string[] = [];
    if (localConsensusConfig && env) {
      const validators = (localConsensusConfig.validators || []) as unknown[];

      // Convert validators to addresses (local entity: signerId derivation is allowed)
      const { getSignerAddress } = await import('../account/crypto');
      expectedAddresses = validators.map((validator) => {
        if (typeof validator !== 'string' || !validator) return null;
        const v = validator.trim();
        if (!v) return null;
        // Validator may already be an EOA address (0x + 40 hex chars)
        if (ethers.isAddress(v)) {
          return v.toLowerCase();
        }
        // Or it may be a secp256k1 public key (33/65 bytes hex)
        // Public keys and signer IDs share the same wire slot. Try a key/address
        // interpretation first, then fall back to deterministic local signer IDs.
        return publicKeyToAddress(v) ?? getSignerAddress(env, v)?.toLowerCase();
      }).filter(Boolean) as string[];
    }

    // IMPORTANT (determinism): do NOT use gossip metadata as board-of-record
    // for consensus signature verification. Gossip can be stale/incomplete and
    // must not make valid WAL replay fail. If no local replica board is present,
    // fall back to self-contained hanko quorum verification below.

    if (expectedAddresses.length > 0) {
      // External board found — verify recovered signers match
      for (const addr of recoveredAddresses) {
        if (!expectedAddresses.includes(addr)) {
          console.warn(`❌ Hanko rejected: Signer ${addr.slice(0, 10)} not in entity board validators`);
          console.warn(`   Expected validators:`, expectedAddresses.map(a => a.slice(0, 10)));
          return { valid: false, entityId: null };
        }
      }
    } else {
      // Self-contained verification: the Hanko IS the board declaration
      // Reconstruct board from claim's entityIndexes + recovered signatures + placeholders
      // For gossip/first-contact: sufficient because real security is at consensus layer
      const numPlaceholders = hanko.placeholders.length;
      const numSignatures = eoaSignatures.length;
      let signerWeightSum = 0n;
      for (let i = 0; i < matchingClaim.entityIndexes.length; i++) {
        const memberIndex = matchingClaim.entityIndexes[i];
        if (memberIndex === undefined) continue;
        if (memberIndex >= numPlaceholders && memberIndex < numPlaceholders + numSignatures) {
          // This slot maps to a signer (not a placeholder) — they actually signed
          signerWeightSum += matchingClaim.weights[i] ?? 0n;
        }
      }
      if (signerWeightSum >= matchingClaim.threshold) {
        // Self-contained quorum is valid. The yes-entity check below still ensures
        // the hanko core recovered at least one affirmative entity from the envelope.
      } else {
        console.warn(`❌ Hanko self-contained: insufficient weight ${signerWeightSum}/${matchingClaim.threshold}`);
        return { valid: false, entityId: null };
      }
    }

    // Valid only if the target claim itself passed Hanko recovery. A nested
    // yes-entity is not enough: otherwise an attacker can include one valid
    // child claim and a target claim that only reaches threshold via nested
    // assumed-yes weight, which the contract rejects.
    const targetRecovered = recovered.yesEntities.some((entity) =>
      toEntityIdHex(entity).toLowerCase() === targetEntity.toLowerCase(),
    );
    if (targetRecovered) {
      // Hanko valid
      return { valid: true, entityId: targetEntity };
    }

    return { valid: false, entityId: null };
  } catch (error) {
    console.error(`❌ Hanko verification error:`, error);
    return { valid: false, entityId: null };
  }
}
