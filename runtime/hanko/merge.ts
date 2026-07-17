import { ethers } from 'ethers';

import type {
  CanonicalHankoMergeResult,
  HankoEnvelope,
  HankoHex,
  HankoRecoveredSignature,
  HankoSemanticClaim,
  HankoString,
} from '../types/hanko';
import {
  asHankoBytes32,
  decodeHankoEnvelope,
  encodeHankoEnvelope,
  packHankoSignatures,
  recoverHankoSignatures,
} from './codec';
import {
  extractHankoSemanticClaims,
  hashHankoBoardClaim,
  type HankoBoardAuthorityValidator,
  verifyCanonicalHanko,
} from './claims';

type MergeInput = Readonly<{
  digest: string;
  targetEntityId: string;
  fragments: readonly HankoString[];
  validateBoardAuthority?: HankoBoardAuthorityValidator;
}>;

type RankedClaim = HankoSemanticClaim & {
  readonly boardHash: HankoHex;
  readonly rank: number;
};

const claimKey = (claim: HankoSemanticClaim): string => JSON.stringify({
  entityId: claim.entityId,
  members: claim.members.map((member) => [member.entityId, member.weight.toString()]),
  threshold: claim.threshold.toString(),
  delays: Object.values(claim.delays).map(String),
});

const collectParts = (digest: HankoHex, fragments: readonly HankoString[]) => {
  const signatures = new Map<HankoHex, HankoRecoveredSignature>();
  const claims = new Map<HankoHex, HankoSemanticClaim>();
  for (const fragment of fragments) {
    const envelope = decodeHankoEnvelope(fragment);
    const recovered = recoverHankoSignatures(digest, envelope.packedSignatures);
    recovered.forEach((signature) => {
      const existing = signatures.get(signature.signerEntityId);
      if (!existing || signature.signature < existing.signature) signatures.set(signature.signerEntityId, signature);
    });
    extractHankoSemanticClaims(envelope, recovered).forEach((claim) => {
      const existing = claims.get(claim.entityId);
      if (existing && claimKey(existing) !== claimKey(claim)) {
        throw new Error(`HANKO_MERGE_CLAIM_CONFLICT:${claim.entityId}`);
      }
      claims.set(claim.entityId, claim);
    });
  }
  return { signatures, claims };
};

const rankClaims = (
  claims: ReadonlyMap<HankoHex, HankoSemanticClaim>,
  signerIds: ReadonlySet<HankoHex>,
  validate?: HankoBoardAuthorityValidator,
): Map<HankoHex, RankedClaim> => {
  const ranked = new Map<HankoHex, RankedClaim>();
  for (let rank = 0; rank <= claims.size; rank++) {
    let added = 0;
    for (const claim of [...claims.values()].sort((a, b) => a.entityId.localeCompare(b.entityId))) {
      if (ranked.has(claim.entityId)) continue;
      const hash = hashHankoBoardClaim(claim);
      if (hash !== claim.entityId && !validate?.(claim.entityId, hash, rank)) continue;
      const power = claim.members.reduce((sum, member, index) => {
        if (signerIds.has(member.entityId)) return sum + member.weight;
        return index > 0 && ranked.has(member.entityId) ? sum + member.weight : sum;
      }, 0n);
      if (power < claim.threshold) continue;
      ranked.set(claim.entityId, { ...claim, boardHash: hash, rank });
      added++;
    }
    if (added === 0) break;
  }
  return ranked;
};

const reachableClaims = (
  target: RankedClaim,
  ranked: ReadonlyMap<HankoHex, RankedClaim>,
  signerIds: ReadonlySet<HankoHex>,
): Map<HankoHex, RankedClaim> => {
  const reachable = new Map<HankoHex, RankedClaim>();
  const visit = (claim: RankedClaim): void => {
    if (reachable.has(claim.entityId)) return;
    reachable.set(claim.entityId, claim);
    claim.members.forEach((member, index) => {
      const child = ranked.get(member.entityId);
      if (index > 0 && !signerIds.has(member.entityId) && child && child.rank < claim.rank) visit(child);
    });
  };
  visit(target);
  return reachable;
};

const orderClaims = (target: RankedClaim, claims: Iterable<RankedClaim>): RankedClaim[] =>
  [...claims].sort((left, right) => (
    left.entityId === target.entityId ? 1 : right.entityId === target.entityId ? -1 :
      left.rank - right.rank || left.entityId.localeCompare(right.entityId)
  ));

const collectUsedSlots = (
  claims: readonly RankedClaim[],
  reachable: ReadonlyMap<HankoHex, RankedClaim>,
  signerIds: ReadonlySet<HankoHex>,
) => {
  const usedSigners = new Set<HankoHex>();
  const placeholders = new Set<HankoHex>();
  claims.forEach((claim) => claim.members.forEach((member, index) => {
    const child = reachable.get(member.entityId);
    if (signerIds.has(member.entityId)) usedSigners.add(member.entityId);
    else if (!(index > 0 && child && child.rank < claim.rank)) placeholders.add(member.entityId);
  }));
  return { usedSigners, placeholders };
};

const buildEnvelope = (
  target: RankedClaim,
  ranked: ReadonlyMap<HankoHex, RankedClaim>,
  signatures: ReadonlyMap<HankoHex, HankoRecoveredSignature>,
): HankoEnvelope => {
  const signerIds = new Set(signatures.keys());
  const reachable = reachableClaims(target, ranked, signerIds);
  const claims = orderClaims(target, reachable.values());
  const used = collectUsedSlots(claims, reachable, signerIds);
  const placeholders = [...used.placeholders].sort();
  const signed = [...used.usedSigners].sort().map((id) => signatures.get(id)!);
  const placeholderIndex = new Map(placeholders.map((id, index) => [id, BigInt(index)]));
  const signerIndex = new Map(signed.map((signature, index) => [
    signature.signerEntityId,
    BigInt(placeholders.length + index),
  ]));
  const claimIndex = new Map(claims.map((claim, index) => [
    claim.entityId,
    BigInt(placeholders.length + signed.length + index),
  ]));
  return {
    placeholders,
    packedSignatures: packHankoSignatures(signed.map((signature) => ethers.getBytes(signature.signature))),
    claims: claims.map((claim) => ({
      entityId: claim.entityId,
      entityIndexes: claim.members.map((member, index) => {
        const child = reachable.get(member.entityId);
        if (signerIndex.has(member.entityId)) return signerIndex.get(member.entityId)!;
        if (index > 0 && child && child.rank < claim.rank) return claimIndex.get(member.entityId)!;
        return placeholderIndex.get(member.entityId)!;
      }),
      weights: claim.members.map((member) => member.weight),
      threshold: claim.threshold,
      ...claim.delays,
    })),
  };
};

export const mergeHankoFragments = (input: MergeInput): CanonicalHankoMergeResult => {
  const digest = asHankoBytes32(input.digest, 'DIGEST');
  const targetEntityId = asHankoBytes32(input.targetEntityId, 'TARGET');
  const { signatures, claims } = collectParts(digest, input.fragments);
  const targetDefinition = claims.get(targetEntityId);
  if (!targetDefinition) throw new Error(`HANKO_MERGE_TARGET_CLAIM_MISSING:${targetEntityId}`);
  const ranked = rankClaims(claims, new Set(signatures.keys()), input.validateBoardAuthority);
  const target = ranked.get(targetEntityId);
  if (!target) {
    const power = targetDefinition.members.reduce(
      (sum, member) => sum + (signatures.has(member.entityId) ? member.weight : 0n),
      0n,
    );
    const missing = targetDefinition.members
      .filter((member) => !signatures.has(member.entityId) && !ranked.has(member.entityId))
      .map((member) => member.entityId);
    return {
      complete: false,
      targetEntityId,
      power,
      threshold: targetDefinition.threshold,
      missingEntityIds: [...new Set(missing)].sort(),
    };
  }
  const hanko = encodeHankoEnvelope(buildEnvelope(target, ranked, signatures));
  verifyCanonicalHanko({
    digest,
    hanko,
    expectedTargetEntityId: targetEntityId,
    ...(input.validateBoardAuthority
      ? { validateBoardAuthority: input.validateBoardAuthority }
      : {}),
  });
  return { complete: true, targetEntityId, hanko };
};
