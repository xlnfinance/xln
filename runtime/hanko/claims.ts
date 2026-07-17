import { ethers } from 'ethers';

import type {
  HankoBoardDelays,
  HankoEnvelope,
  HankoHex,
  HankoRecoveredSignature,
  HankoSemanticClaim,
  HankoString,
} from '../types/hanko';
import {
  asHankoBytes32,
  decodeHankoEnvelope,
  recoverHankoSignatures,
} from './codec';

const BOARD_ABI = ['tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)'] as const;
const MAX_BOARD_POWER = 0xffffn;
const MAX_SAFE_INDEX = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_BOARD_DELAY = 0xffff_ffffn;

export type HankoBoardAuthorityValidator = (
  entityId: HankoHex,
  reconstructedBoardHash: HankoHex,
  claimIndex: number,
) => boolean;

export interface VerifiedHankoClaim extends HankoSemanticClaim {
  readonly boardHash: HankoHex;
  readonly votingPower: bigint;
}

export interface VerifiedHanko {
  readonly targetEntityId: HankoHex;
  readonly envelope: HankoEnvelope;
  readonly signatures: readonly HankoRecoveredSignature[];
  readonly claims: readonly VerifiedHankoClaim[];
}

type ResolvedClaim = VerifiedHankoClaim & {
  readonly referencedClaimIndexes: readonly number[];
  readonly usedIndexes: readonly number[];
};

export const resolveHankoBoardDelays = (
  input?: Partial<HankoBoardDelays>,
): HankoBoardDelays => {
  const delays: HankoBoardDelays = {
    boardChangeDelay: input?.boardChangeDelay ?? 0n,
    controlChangeDelay: input?.controlChangeDelay ?? 0n,
    dividendChangeDelay: input?.dividendChangeDelay ?? 0n,
  };
  Object.entries(delays).forEach(([label, value]) => {
    if (typeof value !== 'bigint' || value < 0n || value > MAX_BOARD_DELAY) {
      throw new Error(`HANKO_BOARD_DELAY_INVALID:${label}`);
    }
  });
  return delays;
};

const isAddressEntityId = (value: HankoHex): boolean => {
  const numeric = BigInt(value);
  return numeric > 0n && numeric <= ((1n << 160n) - 1n);
};

const asBoardPower = (value: bigint, label: string): bigint => {
  if (value <= 0n || value > MAX_BOARD_POWER) throw new Error(`HANKO_${label}_INVALID`);
  return value;
};

export const hashHankoBoardClaim = (claim: HankoSemanticClaim): HankoHex => ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(BOARD_ABI, [[
    claim.threshold,
    claim.members.map((member) => member.entityId),
    claim.members.map((member) => member.weight),
    claim.delays.boardChangeDelay,
    claim.delays.controlChangeDelay,
    claim.delays.dividendChangeDelay,
  ]]),
).toLowerCase() as HankoHex;

const assertUnique = (values: readonly string[], error: string): void => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${error}:${value}`);
    seen.add(value);
  }
};

const resolveClaim = (
  envelope: HankoEnvelope,
  signatures: readonly HankoRecoveredSignature[],
  claimIndex: number,
): ResolvedClaim => {
  const claim = envelope.claims[claimIndex]!;
  if (claim.entityIndexes.length === 0 || claim.entityIndexes.length !== claim.weights.length) {
    throw new Error(`HANKO_CLAIM_SHAPE_INVALID:${claimIndex}`);
  }
  const threshold = asBoardPower(claim.threshold, `THRESHOLD:${claimIndex}`);
  const firstClaimIndex = envelope.placeholders.length + signatures.length;
  const totalEntities = firstClaimIndex + envelope.claims.length;
  const indexes = claim.entityIndexes.map((value, memberIndex) => {
    if (value > MAX_SAFE_INDEX || value >= BigInt(totalEntities)) {
      throw new Error(`HANKO_ENTITY_INDEX_OOB:${claimIndex}:${memberIndex}`);
    }
    return Number(value);
  });
  assertUnique(indexes.map(String), `HANKO_DUPLICATE_ENTITY_INDEX:${claimIndex}`);

  const referenced: number[] = [];
  let votingPower = 0n;
  const members = indexes.map((entityIndex, memberIndex) => {
    const weight = asBoardPower(claim.weights[memberIndex]!, `WEIGHT:${claimIndex}:${memberIndex}`);
    let entityId: HankoHex;
    if (entityIndex < envelope.placeholders.length) {
      entityId = envelope.placeholders[entityIndex]!;
      const earlierClaim = envelope.claims.findIndex((candidate, index) => (
        index < claimIndex && candidate.entityId === entityId
      ));
      if (earlierClaim >= 0) throw new Error(`HANKO_NON_CANONICAL_PLACEHOLDER:${claimIndex}:${memberIndex}`);
    } else if (entityIndex < firstClaimIndex) {
      entityId = signatures[entityIndex - envelope.placeholders.length]!.signerEntityId;
      votingPower += weight;
    } else {
      const nestedIndex = entityIndex - firstClaimIndex;
      if (nestedIndex >= claimIndex) throw new Error(`HANKO_CLAIM_ORDER_INVALID:${claimIndex}:${nestedIndex}`);
      entityId = envelope.claims[nestedIndex]!.entityId;
      votingPower += weight;
      referenced.push(nestedIndex);
    }
    if (memberIndex === 0 && (!isAddressEntityId(entityId) || entityIndex >= firstClaimIndex)) {
      throw new Error(`HANKO_FIRST_MEMBER_EOA_REQUIRED:${claimIndex}`);
    }
    return { entityId, weight };
  });
  assertUnique(members.map((member) => member.entityId), `HANKO_DUPLICATE_BOARD_MEMBER:${claimIndex}`);
  const totalPower = members.reduce((sum, member) => sum + member.weight, 0n);
  if (threshold > totalPower) throw new Error(`HANKO_THRESHOLD_EXCEEDS_BOARD_POWER:${claimIndex}`);
  const delays = resolveHankoBoardDelays(claim);
  const semantic: HankoSemanticClaim = { entityId: claim.entityId, members, threshold, delays };
  return {
    ...semantic,
    boardHash: hashHankoBoardClaim(semantic),
    votingPower,
    referencedClaimIndexes: referenced,
    usedIndexes: indexes,
  };
};

const assertAuthority = (
  claim: ResolvedClaim,
  claimIndex: number,
  validate?: HankoBoardAuthorityValidator,
): void => {
  if (claim.entityId === claim.boardHash) return;
  if (!validate?.(claim.entityId, claim.boardHash, claimIndex)) {
    throw new Error(`HANKO_BOARD_AUTHORITY_INVALID:${claimIndex}:${claim.entityId}:${claim.boardHash}`);
  }
};

const assertMinimalReachability = (
  envelope: HankoEnvelope,
  signatures: readonly HankoRecoveredSignature[],
  claims: readonly ResolvedClaim[],
): void => {
  const reachable = new Set<number>([claims.length - 1]);
  for (let index = claims.length - 1; index >= 0; index--) {
    if (!reachable.has(index)) continue;
    claims[index]!.referencedClaimIndexes.forEach((child) => reachable.add(child));
  }
  if (reachable.size !== claims.length) throw new Error('HANKO_UNUSED_CLAIM');
  const used = new Set(claims.flatMap((claim) => claim.usedIndexes));
  envelope.placeholders.forEach((_, index) => {
    if (!used.has(index)) throw new Error(`HANKO_UNUSED_PLACEHOLDER:${index}`);
  });
  signatures.forEach((_, index) => {
    if (!used.has(envelope.placeholders.length + index)) throw new Error(`HANKO_UNUSED_SIGNATURE:${index}`);
  });
};

export const verifyCanonicalHanko = (input: Readonly<{
  digest: string;
  hanko: HankoString;
  expectedTargetEntityId?: string;
  validateBoardAuthority?: HankoBoardAuthorityValidator;
}>): VerifiedHanko => {
  const digest = asHankoBytes32(input.digest, 'DIGEST');
  const envelope = decodeHankoEnvelope(input.hanko);
  if (envelope.claims.length === 0) throw new Error('HANKO_CLAIM_REQUIRED');
  assertUnique(envelope.placeholders, 'HANKO_DUPLICATE_PLACEHOLDER');
  assertUnique(envelope.claims.map((claim) => claim.entityId), 'HANKO_DUPLICATE_CLAIM_ENTITY');
  const signatures = recoverHankoSignatures(digest, envelope.packedSignatures);
  if (signatures.length === 0) throw new Error('HANKO_EOA_SIGNATURE_REQUIRED');
  const signerIds = new Set(signatures.map((signature) => signature.signerEntityId));
  envelope.placeholders.forEach((placeholder) => {
    if (signerIds.has(placeholder)) throw new Error(`HANKO_NON_CANONICAL_PLACEHOLDER_SIGNER:${placeholder}`);
  });
  const claims = envelope.claims.map((_, index) => resolveClaim(envelope, signatures, index));
  claims.forEach((claim, index) => {
    assertAuthority(claim, index, input.validateBoardAuthority);
    if (claim.votingPower < claim.threshold) {
      throw new Error(`HANKO_QUORUM_INSUFFICIENT:${index}:${claim.votingPower}:${claim.threshold}`);
    }
  });
  assertMinimalReachability(envelope, signatures, claims);
  const target = claims[claims.length - 1]!.entityId;
  if (input.expectedTargetEntityId && target !== asHankoBytes32(input.expectedTargetEntityId, 'TARGET')) {
    throw new Error(`HANKO_TARGET_MISMATCH:${target}`);
  }
  return { targetEntityId: target, envelope, signatures, claims };
};

export const extractHankoSemanticClaims = (
  envelope: HankoEnvelope,
  signatures: readonly HankoRecoveredSignature[],
): readonly HankoSemanticClaim[] => envelope.claims.map((claim, claimIndex) => {
  if (claim.entityIndexes.length === 0 || claim.entityIndexes.length !== claim.weights.length) {
    throw new Error(`HANKO_CLAIM_SHAPE_INVALID:${claimIndex}`);
  }
  const firstClaimIndex = envelope.placeholders.length + signatures.length;
  const members = claim.entityIndexes.map((rawIndex, memberIndex) => {
    if (rawIndex > MAX_SAFE_INDEX) throw new Error(`HANKO_ENTITY_INDEX_OOB:${claimIndex}:${memberIndex}`);
    const index = Number(rawIndex);
    const weight = asBoardPower(claim.weights[memberIndex]!, `WEIGHT:${claimIndex}:${memberIndex}`);
    if (index < envelope.placeholders.length) return { entityId: envelope.placeholders[index]!, weight };
    if (index < firstClaimIndex) return { entityId: signatures[index - envelope.placeholders.length]!.signerEntityId, weight };
    const nested = index - firstClaimIndex;
    if (nested >= envelope.claims.length) throw new Error(`HANKO_ENTITY_INDEX_OOB:${claimIndex}:${memberIndex}`);
    return { entityId: envelope.claims[nested]!.entityId, weight };
  });
  const threshold = asBoardPower(claim.threshold, `THRESHOLD:${claimIndex}`);
  assertUnique(members.map((member) => member.entityId), `HANKO_DUPLICATE_BOARD_MEMBER:${claimIndex}`);
  if (!isAddressEntityId(members[0]!.entityId)) throw new Error(`HANKO_FIRST_MEMBER_EOA_REQUIRED:${claimIndex}`);
  const delays = resolveHankoBoardDelays(claim);
  return { entityId: claim.entityId, members, threshold, delays };
});
