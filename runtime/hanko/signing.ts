/**
 * Hanko signing integration for consensus layer
 * Bridges between account-consensus and hanko.ts library
 */

import type { ConsensusConfig, EntityState } from '../entity/types';
import type { EntityRuntimeContext } from '../entity/runtime-context';
import type { HankoBoardDelays, HankoString } from '../types/hanko';
import { ethers } from 'ethers';
import { encodeBoard, hashBoard } from '../entity/factory';
import {
  getSignerAddress,
  getSignerPrivateKey,
  recoverAddressFromDigestSignature,
  signDigestBytesWithPrivateKey,
} from '../account/crypto';
import { compareStableText } from '../protocol/serialization';
import { haltRuntimeFailure } from '../protocol/errors/failure-taxonomy';
import { toUnixMs, unixMsToUnixSFloor } from '../protocol/units';
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardRecord,
  resolveUniqueCertifiedRegisteredBoardRecord,
  resolveSigningCertifiedBoardHash,
} from '../jurisdiction/machine/board-registry';
import {
  decodeHankoEnvelope,
  encodeHankoEnvelope,
  HankoValidationError,
  invalidHanko,
  packHankoSignatures,
  recoverHankoSignatures,
} from './codec';
import {
  hashHankoBoardClaim,
  resolveHankoBoardDelays,
  verifyCanonicalHanko,
} from './claims';

class CertifiedBoardAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CertifiedBoardAuthorityError';
  }
}

/**
 * A signing digest is produced by this Runtime, not supplied by a peer.
 * Keep invariant failures as plain Errors so failure classification halts the
 * faulty local process instead of misreporting its own bad digest as a remote
 * protocol rejection.
 */
const requireLocalSigningDigest = (hash: string): Uint8Array => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error(`LOCAL_SIGNING_DIGEST_INVALID:${hash}`);
  }
  return ethers.getBytes(hash);
};

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

  // Browser decoding path for non-hex input.
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

export async function inspectHankoForHash(
  hankoBytes: HankoString,
  hash: string,
): Promise<{
  placeholders: string[];
  recoveredAddresses: string[];
  claims: Array<{
    entityId: string;
    entityIndexes: bigint[];
    weights: bigint[];
    threshold: bigint;
    boardChangeDelay: bigint;
    controlChangeDelay: bigint;
    dividendChangeDelay: bigint;
    boardEntityIds: string[];
    reconstructedBoardHash: string;
  }>;
}> {
  const hanko = decodeHankoEnvelope(hankoBytes);
  const recovered = recoverHankoSignatures(hash, hanko.packedSignatures);
  const recoveredAddresses = recovered.map((signature) => ethers.getAddress(`0x${signature.signerEntityId.slice(-40)}`));
  const entityIds = [
    ...hanko.placeholders,
    ...recovered.map((signature) => signature.signerEntityId),
    ...hanko.claims.map((claim) => claim.entityId),
  ];

  const claims = hanko.claims.map((claim, claimIndex) => {
    const boardEntityIds = claim.entityIndexes.map((index, memberIndex) => {
      if (index > BigInt(Number.MAX_SAFE_INTEGER) || !entityIds[Number(index)]) {
        throw new Error(`HANKO_ENTITY_INDEX_OOB:${claimIndex}:${memberIndex}`);
      }
      return entityIds[Number(index)]!;
    });
    const delays = resolveHankoBoardDelays(claim);
    return {
      entityId: claim.entityId,
      entityIndexes: [...claim.entityIndexes],
      weights: [...claim.weights],
      threshold: claim.threshold,
      ...delays,
      boardEntityIds,
      reconstructedBoardHash: hashHankoBoardClaim({
        entityId: claim.entityId,
        threshold: claim.threshold,
        members: boardEntityIds.map((entityId, index) => ({ entityId, weight: claim.weights[index]! })),
        delays,
      }),
    };
  });

  return {
    placeholders: [...hanko.placeholders],
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
 * For multi-signer quorum, call buildQuorumHanko with the committed votes.
 */
export async function signEntityHashes(
  env: EntityRuntimeContext,
  entityId: string,
  signerId: string,
  hashes: string[],
  authorityState?: EntityState,
): Promise<HankoString[]> {
  if (env?.runtimeSeed === undefined || env?.runtimeSeed === null) {
    throw new Error(`CRYPTO_DETERMINISM_VIOLATION: signEntityHashes called without env.runtimeSeed for entity ${entityId.slice(-4)}`);
  }

  const hankos: HankoString[] = [];

  // Key ownership is scoped by this Runtime's seed. The signer module already
  // imports the same browser-safe crypto boundary, so a per-seal dynamic import
  // only adds a Promise/module lookup on the Account consensus hot path.
  const privateKey = getSignerPrivateKey(env, signerId);
  const signerAddress = getSignerAddress(env, signerId);
  if (!signerAddress) {
    throw new Error(`HANKO_SIGNER_ADDRESS_MISSING: entityId=${entityId} signerId=${signerId}`);
  }
  const singleSignerBoardHash = hashBoard(encodeBoard({
    mode: 'proposer-based',
    threshold: 1n,
    validators: [signerAddress],
    shares: { [signerAddress]: 1n },
  })).toLowerCase();
  const normalizedEntityId = encodeQuorumEntityId(entityId);
  // This board hash is both the authority check and the exact lazy Entity
  // reconstruction. Rebuilding the same ABI board a second time was pure
  // duplicate hashing; registered Entities instead bind it to certified J-state.
  if (singleSignerBoardHash !== normalizedEntityId) {
    const certifiedBoardHash = resolveSigningCertifiedBoardHash(
      env,
      entityId,
      authorityState?.config.jurisdiction,
      authorityState,
    );
    if (!certifiedBoardHash) {
      throw new Error(`REGISTERED_HANKO_BOARD_UNAVAILABLE: entityId=${entityId}`);
    }
    if (singleSignerBoardHash !== certifiedBoardHash) {
      throw new Error(
        `REGISTERED_HANKO_BOARD_MISMATCH: entityId=${entityId} ` +
        `certified=${certifiedBoardHash} supplied=${singleSignerBoardHash}`,
      );
    }
  }

  const delays = resolveHankoBoardDelays();
  for (const hash of hashes) {
    const hashBuffer = requireLocalSigningDigest(hash);
    const signed = signDigestBytesWithPrivateKey(privateKey, hashBuffer);
    if (signed.signature.length !== 64) {
      throw new Error(`LOCAL_SIGNING_SIGNATURE_LENGTH_INVALID:${signed.signature.length}`);
    }
    if (signed.recovery !== 0 && signed.recovery !== 1) {
      throw new Error(`LOCAL_SIGNING_RECOVERY_INVALID:${signed.recovery}`);
    }
    const signature = new Uint8Array(65);
    signature.set(signed.signature);
    signature[64] = 27 + signed.recovery;
    hankos.push(encodeHankoEnvelope({
      placeholders: [],
      packedSignatures: packHankoSignatures([signature]),
      claims: [{
        entityId: normalizedEntityId as `0x${string}`,
        entityIndexes: [0n],
        weights: [1n],
        threshold: 1n,
        ...delays,
      }],
    }));
  }

  return hankos;
}

type QuorumConfig = {
  threshold: bigint;
  validators: string[];
  shares: Record<string, bigint>;
  jurisdiction?: ConsensusConfig['jurisdiction'];
  boardDelays?: Partial<HankoBoardDelays>;
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
  env: EntityRuntimeContext,
  config: QuorumConfig,
  getSignerAddress: (env: EntityRuntimeContext, signerId: string) => string | null,
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

const canonicalBoardHash = (
  validators: QuorumValidator[],
  threshold: bigint,
  delayInput?: Partial<HankoBoardDelays>,
): string => hashHankoBoardClaim({
  entityId: ethers.ZeroHash as `0x${string}`,
  threshold,
  members: validators.map((validator) => ({
    entityId: ethers.zeroPadValue(validator.address, 32).toLowerCase() as `0x${string}`,
    weight: validator.share,
  })),
  delays: resolveHankoBoardDelays(delayInput),
});

/** Canonical board committed by this config using only this runtime's key store. */
export async function getEntityConfigBoardHash(
  env: EntityRuntimeContext,
  config: QuorumConfig,
): Promise<string> {
  const { getSignerAddress } = await import('../account/crypto');
  return canonicalBoardHash(
    resolveQuorumBoard(env, config, getSignerAddress),
    config.threshold,
    config.boardDelays,
  );
}

const assertQuorumBoardBinding = (
  env: EntityRuntimeContext,
  entityId: string,
  config: QuorumConfig,
  validators: QuorumValidator[],
  authorityState?: EntityState,
): void => {
  const suppliedBoardHash = canonicalBoardHash(validators, config.threshold, config.boardDelays);
  if (suppliedBoardHash === encodeQuorumEntityId(entityId)) {
    return;
  }
  const jurisdiction = config.jurisdiction;
  if (!jurisdiction) {
    throw new Error(`BUILD_QUORUM_HANKO_BOARD_UNAVAILABLE: entityId=${entityId}`);
  }
  const authoritativeBoardHash = resolveSigningCertifiedBoardHash(
    env,
    entityId,
    jurisdiction,
    authorityState,
  );
  if (!authoritativeBoardHash) {
    throw new Error(`BUILD_QUORUM_HANKO_BOARD_UNAVAILABLE: entityId=${entityId}`);
  }
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
  env: EntityRuntimeContext,
  entityId: string,
  hash: string,
  signatures: Array<{ signerId: string; signature: string }>,
  config: QuorumConfig,
  authorityState?: EntityState,
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
  assertQuorumBoardBinding(env, entityId, config, validators, authorityState);

  const byAddress = (left: QuorumValidator, right: QuorumValidator) =>
    compareStableText(left.address, right.address);
  const signingValidators = validators.filter((validator) => signaturesByKey.has(validator.signerKey)).sort(byAddress);
  const nonSigningValidators = validators.filter((validator) => !signaturesByKey.has(validator.signerKey)).sort(byAddress);
  const placeholders = nonSigningValidators.map((validator) => ethers.zeroPadValue(validator.address, 32).toLowerCase() as `0x${string}`);
  const sigBuffers = signingValidators.map((validator) => signaturesByKey.get(validator.signerKey)!);
  const packedSignatures = packHankoSignatures(sigBuffers);
  const signerIndexes = new Map(signingValidators.map((validator, index) => [validator.signerKey, index]));
  const placeholderIndexes = new Map(nonSigningValidators.map((validator, index) => [validator.signerKey, index]));
  const entityIndexes = validators.map((validator) => {
    const signerIndex = signerIndexes.get(validator.signerKey);
    return signerIndex === undefined
      ? placeholderIndexes.get(validator.signerKey)!
      : placeholders.length + signerIndex;
  });
  return encodeHankoEnvelope({
    placeholders,
    packedSignatures,
    claims: [{
      entityId: encodeQuorumEntityId(entityId) as `0x${string}`,
      entityIndexes: entityIndexes.map((value) => BigInt(value)),
      weights: validators.map((validator) => validator.share),
      threshold: config.threshold,
      ...resolveHankoBoardDelays(config.boardDelays),
    }],
  });
}

/** Validators call this after replay and before producing any precommit. */
export async function assertEntityConfigBoardAuthority(
  env: EntityRuntimeContext,
  entityId: string,
  config: QuorumConfig,
  authorityState: EntityState,
): Promise<void> {
  const { getSignerAddress } = await import('../account/crypto');
  const validators = resolveQuorumBoard(env, config, getSignerAddress);
  assertQuorumBoardBinding(env, entityId, config, validators, authorityState);
}

/**
 * Verify hanko signature for single hash with STRICT board validation
 * Returns entityId if valid, null if invalid
 *
 * @param hankoBytes - ABI-encoded HankoBytes
 * @param hash - Hash that was signed
 * @param expectedEntityId - REQUIRED: Entity that MUST have signed
 * @param env - Runtime access to immutable certified-board nodes
 * @param authority - Consensus callers bind an exact observer State/root;
 * global resolution is reserved for profile/gossip discovery.
 */
export async function verifyHankoForHash(
  hankoBytes: HankoString,
  hash: string,
  expectedEntityId: string,
  env?: EntityRuntimeContext,
  authority?: {
    registeredBoardHash?: string;
    allowPreviousBoard?: boolean;
    /** Exact Entity-certified registry root for consensus verification. */
    observerState?: EntityState;
  },
): Promise<{ valid: boolean; entityId: string | null }> {
  try {
    const expectedTarget = encodeQuorumEntityId(expectedEntityId);
    const certifiedRegisteredBoardHash = authority?.registeredBoardHash?.trim().toLowerCase() || null;
    const resolveAuthorityRecord = (entityId: string) => {
      if (!env) return null;
      return authority?.observerState
        ? resolveObserverCertifiedBoardRecord(
            authority.observerState,
            getCertifiedBoardNodeStore(env),
            entityId,
          )
        : resolveUniqueCertifiedRegisteredBoardRecord(env, entityId);
    };
    if (certifiedRegisteredBoardHash && env) {
      const record = resolveAuthorityRecord(expectedEntityId);
      if (!record || record.boardHash !== certifiedRegisteredBoardHash) {
        throw new CertifiedBoardAuthorityError(
          `CERTIFIED_BOARD_AUTHORITY_CURRENT_MISMATCH:${expectedEntityId}:` +
          `expected=${certifiedRegisteredBoardHash}:received=${record?.boardHash ?? 'missing'}`,
        );
      }
    }
    const entityTimestampSeconds = authority?.observerState
      ? unixMsToUnixSFloor(toUnixMs(authority.observerState.timestamp))
      : env
        ? unixMsToUnixSFloor(toUnixMs(env.state.timestamp))
        : 0;
    const verified = verifyCanonicalHanko({
      hanko: hankoBytes,
      digest: hash,
      expectedTargetEntityId: expectedTarget,
      validateBoardAuthority: (entityId, reconstructedBoardHash) => {
      if (!env) return false;
      const record = resolveAuthorityRecord(entityId);
      if (!record) return false;
      if (entityId === expectedTarget && certifiedRegisteredBoardHash && record.boardHash !== certifiedRegisteredBoardHash) {
        throw new CertifiedBoardAuthorityError(
          `CERTIFIED_BOARD_AUTHORITY_CURRENT_MISMATCH:${entityId}:` +
          `expected=${certifiedRegisteredBoardHash}:received=${record.boardHash}`,
        );
      }
      if (reconstructedBoardHash === record.boardHash) return true;
      // Previous-board grace defaults ON to mirror Account.sol:1063, where it
      // exists so that rotating a board cannot repudiate the evidence a
      // counterparty already holds - see the trade-off recorded there.
      //
      // Callers on a *fresh money* path must opt out with
      // `allowPreviousBoard: false`, because the jurisdiction verifies those
      // with verifyCurrentHankoSignature (cooperative settlement at
      // Account.sol:894, C2R at Account.sol:790). Accepting a retired board
      // here would commit a bilateral state the chain then rejects, leaving the
      // channel ahead of settled truth. Historical evidence - dispute proofs -
      // keeps the grace.
      return Boolean(
        authority?.allowPreviousBoard !== false &&
        record.previousBoardHash !== ethers.ZeroHash &&
        reconstructedBoardHash === record.previousBoardHash &&
        entityTimestampSeconds < record.previousBoardValidUntil,
      );
      },
    });
    return { valid: true, entityId: verified.targetEntityId };
  } catch (error) {
    if (error instanceof CertifiedBoardAuthorityError) {
      throw error;
    }
    if (error instanceof HankoValidationError) {
      return { valid: false, entityId: null };
    }
    // Malformed peer Hanko is an expected authentication rejection above.
    // Resolver/storage/programming failures are local invariant faults: hiding
    // them as a bad signature would let validators continue from divergent
    // authority state and make the same consensus input non-deterministic.
    throw haltRuntimeFailure(
      'HANKO_VERIFICATION_INTERNAL',
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}

/**
 * Recover the default proposer encoded by an already-verified Hanko board.
 * Board member zero is always an EOA by the canonical Hanko verifier, so this
 * route is deterministic from durable bilateral evidence and never needs
 * gossip or another Runtime's live replica set.
 */
export async function resolveHankoDefaultProposerSignerId(
  hankoBytes: HankoString,
  hash: string,
  expectedEntityId: string,
  env?: EntityRuntimeContext,
  authority?: {
    registeredBoardHash?: string;
    allowPreviousBoard?: boolean;
    observerState?: EntityState;
  },
): Promise<string> {
  const verified = await verifyHankoForHash(hankoBytes, hash, expectedEntityId, env, authority);
  if (!verified.valid) {
    invalidHanko(`HANKO_PROPOSER_AUTHORITY_INVALID:${expectedEntityId}`);
  }
  const inspection = await inspectHankoForHash(hankoBytes, hash);
  const target = inspection.claims.at(-1);
  const expectedTarget = encodeQuorumEntityId(expectedEntityId);
  if (!target || target.entityId !== expectedTarget) {
    invalidHanko(
      `HANKO_PROPOSER_TARGET_MISMATCH:expected=${expectedTarget}:actual=${target?.entityId ?? 'missing'}`,
    );
  }
  const firstMember = String(target.boardEntityIds[0] || '').toLowerCase();
  if (!/^0x0{24}[0-9a-f]{40}$/.test(firstMember)) {
    invalidHanko(`HANKO_PROPOSER_FIRST_MEMBER_INVALID:${firstMember || 'missing'}`);
  }
  return ethers.getAddress(`0x${firstMember.slice(-40)}`).toLowerCase();
}
