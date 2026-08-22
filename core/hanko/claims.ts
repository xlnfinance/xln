import { countOpWithSite } from '../support/performance/op-counters';
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
  invalidHanko,
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

interface VerifiedHankoClaim extends HankoSemanticClaim {
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
      invalidHanko(`HANKO_BOARD_DELAY_INVALID:${label}`);
    }
  });
  return delays;
};

const isAddressEntityId = (value: HankoHex): boolean => {
  const numeric = BigInt(value);
  return numeric > 0n && numeric <= ((1n << 160n) - 1n);
};

const asBoardPower = (value: bigint, label: string): bigint => {
  if (value <= 0n || value > MAX_BOARD_POWER) invalidHanko(`HANKO_${label}_INVALID`);
  return value;
};

// The same board (one entity's validators) is resolved for every hanko that
// entity emits; the ABI encode + keccak is a pure function of the claim
// content, so a bounded content-keyed memo is exact.
const BOARD_HASH_MEMO_MAX = 4_096;
const boardHashMemo = new Map<string, HankoHex>();
const BOARD_ABI_CODER = ethers.AbiCoder.defaultAbiCoder();

export const hashHankoBoardClaim = (claim: HankoSemanticClaim): HankoHex => {
  const memoKey = [
    claim.threshold,
    ...claim.members.map((member) => `${member.entityId}:${member.weight}`),
    claim.delays.boardChangeDelay,
    claim.delays.controlChangeDelay,
    claim.delays.dividendChangeDelay,
  ].join('|');
  const cached = boardHashMemo.get(memoKey);
  if (cached !== undefined) return cached;
  const hash = ethers.keccak256(
    BOARD_ABI_CODER.encode(BOARD_ABI, [[
      claim.threshold,
      claim.members.map((member) => member.entityId),
      claim.members.map((member) => member.weight),
      claim.delays.boardChangeDelay,
      claim.delays.controlChangeDelay,
      claim.delays.dividendChangeDelay,
    ]]),
  ).toLowerCase() as HankoHex;
  if (boardHashMemo.size >= BOARD_HASH_MEMO_MAX) boardHashMemo.clear();
  boardHashMemo.set(memoKey, hash);
  return hash;
};

const assertUnique = (values: readonly string[], error: string): void => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) invalidHanko(`${error}:${value}`);
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
    invalidHanko(`HANKO_CLAIM_SHAPE_INVALID:${claimIndex}`);
  }
  const threshold = asBoardPower(claim.threshold, `THRESHOLD:${claimIndex}`);
  const firstClaimIndex = envelope.placeholders.length + signatures.length;
  const totalEntities = firstClaimIndex + envelope.claims.length;
  const indexes = claim.entityIndexes.map((value, memberIndex) => {
    if (value > MAX_SAFE_INDEX || value >= BigInt(totalEntities)) {
      invalidHanko(`HANKO_ENTITY_INDEX_OOB:${claimIndex}:${memberIndex}`);
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
      if (earlierClaim >= 0) invalidHanko(`HANKO_NON_CANONICAL_PLACEHOLDER:${claimIndex}:${memberIndex}`);
    } else if (entityIndex < firstClaimIndex) {
      entityId = signatures[entityIndex - envelope.placeholders.length]!.signerEntityId;
      votingPower += weight;
    } else {
      const nestedIndex = entityIndex - firstClaimIndex;
      if (nestedIndex >= claimIndex) invalidHanko(`HANKO_CLAIM_ORDER_INVALID:${claimIndex}:${nestedIndex}`);
      entityId = envelope.claims[nestedIndex]!.entityId;
      votingPower += weight;
      referenced.push(nestedIndex);
    }
    if (memberIndex === 0 && (!isAddressEntityId(entityId) || entityIndex >= firstClaimIndex)) {
      invalidHanko(`HANKO_FIRST_MEMBER_EOA_REQUIRED:${claimIndex}`);
    }
    return { entityId, weight };
  });
  assertUnique(members.map((member) => member.entityId), `HANKO_DUPLICATE_BOARD_MEMBER:${claimIndex}`);
  const totalPower = members.reduce((sum, member) => sum + member.weight, 0n);
  if (threshold > totalPower) invalidHanko(`HANKO_THRESHOLD_EXCEEDS_BOARD_POWER:${claimIndex}`);
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
    invalidHanko(`HANKO_BOARD_AUTHORITY_INVALID:${claimIndex}:${claim.entityId}:${claim.boardHash}`);
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
  if (reachable.size !== claims.length) invalidHanko('HANKO_UNUSED_CLAIM');
  const used = new Set(claims.flatMap((claim) => claim.usedIndexes));
  envelope.placeholders.forEach((_, index) => {
    if (!used.has(index)) invalidHanko(`HANKO_UNUSED_PLACEHOLDER:${index}`);
  });
  signatures.forEach((_, index) => {
    if (!used.has(envelope.placeholders.length + index)) invalidHanko(`HANKO_UNUSED_SIGNATURE:${index}`);
  });
};

export const verifyCanonicalHanko = (input: Readonly<{
  digest: string;
  hanko: HankoString;
  expectedTargetEntityId?: string;
  validateBoardAuthority?: HankoBoardAuthorityValidator;
}>): VerifiedHanko => {
  countOpWithSite('hanko.verifyCanonical', input.hanko.length, 1);
  // Envelope decode and signature recovery are memoized in the codec (and
  // pre-warmed by the worker pool); claim resolution is cheap arithmetic.
  const verified = verifyCanonicalHankoStructure(input.digest, input.hanko);
  for (const [index, claim] of verified.claims.entries()) {
    assertAuthority(claim as ResolvedClaim, index, input.validateBoardAuthority);
  }
  if (
    input.expectedTargetEntityId &&
    verified.targetEntityId !== asHankoBytes32(input.expectedTargetEntityId, 'TARGET')
  ) {
    invalidHanko(`HANKO_TARGET_MISMATCH:${verified.targetEntityId}`);
  }
  return verified;
};

const verifyCanonicalHankoStructure = (
  digestInput: string,
  hanko: HankoString,
): VerifiedHanko => {
  const digest = asHankoBytes32(digestInput, 'DIGEST');
  const envelope = decodeHankoEnvelope(hanko);
  if (envelope.claims.length === 0) invalidHanko('HANKO_CLAIM_REQUIRED');
  assertUnique(envelope.placeholders, 'HANKO_DUPLICATE_PLACEHOLDER');
  assertUnique(envelope.claims.map((claim) => claim.entityId), 'HANKO_DUPLICATE_CLAIM_ENTITY');
  const signatures = recoverHankoSignatures(digest, envelope.packedSignatures);
  if (signatures.length === 0) invalidHanko('HANKO_EOA_SIGNATURE_REQUIRED');
  const signerIds = new Set(signatures.map((signature) => signature.signerEntityId));
  envelope.placeholders.forEach((placeholder) => {
    if (signerIds.has(placeholder)) invalidHanko(`HANKO_NON_CANONICAL_PLACEHOLDER_SIGNER:${placeholder}`);
  });
  const claims = envelope.claims.map((_, index) => resolveClaim(envelope, signatures, index));
  claims.forEach((claim, index) => {
    if (claim.votingPower < claim.threshold) {
      invalidHanko(`HANKO_QUORUM_INSUFFICIENT:${index}:${claim.votingPower}:${claim.threshold}`);
    }
  });
  assertMinimalReachability(envelope, signatures, claims);
  const target = claims[claims.length - 1]!.entityId;
  return { targetEntityId: target, envelope, signatures, claims };
};
