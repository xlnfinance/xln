// Verifying a Hanko: who signed, which Entity the signatures speak for, and whether a board may speak for it.
//
// The verdict (accepted or refused) is what the contract gives, with two departures that only ever refuse more: a
// Hanko whose bytes are not the canonical spelling is refused (`non_canonical`), and so is any member signature
// (`member_signature`): the contract lets an ERC-1271 contract placeholder vote, this verifier does not, which suits
// v1 boards (1-of-1 or 2-of-3 of plain keys, D10). Which refusal is named first is this module's own order, not a
// claim about the contract's revert reason. A claim's board is checked against a registry the caller supplies
// (`BoardAuthorizer`), which has no `currentOnly` switch: the Entity layer supplies one authorizer per use (batch
// authentication takes the current board only, dispute evidence also the retired boards that still live).
import { abiBytes, abiBytesElement, abiCursorOk, abiFits, abiLengthRef, abiLengthWord, abiRoot, abiStaticBytes,
  abiStaticWord, abiTupleBytes, abiTupleElement, abiTupleRef, abiWord, type AbiLength, type AbiTuple,
} from "../kernel/abi-read.ts";
import type { AbiFault } from "../kernel/abi.ts";
import { bytesToHex, hexToBytes } from "../kernel/bytes.ts";
import { none, orElse, some, type Option } from "../kernel/option.ts";
import {
  err, everyResult, flatMap, foldResult, map, mapAccum, mapErr, ok, traverse, type Result,
} from "../kernel/result.ts";
import { addressOf, recoverPublicKey } from "../kernel/signature.ts";
import { match, type Tagged } from "../kernel/tagged.ts";
import {
  addressAsId, boardHash, encodeHanko, isLowS, isZeroWord, lazyEntityId, packedCount, paddingClear,
  recoverRawSigner, unpackSignature, type Hanko, type HankoClaim, type RawFault,
} from "./hanko.ts";

export type HankoFault = Tagged<
  | "expected_entity" | "digest" | "decode" | "too_large" | "member_signatures_shape" | "packed_length"
  | "claim_shape" | "non_canonical" | "claim_required" | "member_signature" | "duplicate_placeholder"
  | "duplicate_claim_entity" | "packed_padding" | "signature_non_canonical" | "recovery_failed"
  | "duplicate_signer" | "signature_required" | "placeholder_signer" | "threshold" | "entity_index"
  | "duplicate_entity_index" | "weight" | "placeholder_claim" | "claim_order" | "first_member"
  | "duplicate_member" | "threshold_power" | "quorum" | "unused_claim" | "unused_placeholder"
  | "unused_signature" | "authority" | "target"
>;

/** Which Entity the Hanko must speak for: a named one, or whichever its last claim names. */
export type Target = Tagged<"any"> | Tagged<"entity", { entityId: string }>;

export type HankoVerdict = Readonly<{ entityId: string; signers: readonly string[]; firstMember: string }>;

/** Whether a board is the one registered for an Entity. A fault here is not a refusal: it aborts the whole check. */
export type BoardAuthorizer<F> = (entityId: string, boardHash: string) => Result<boolean, F>;

const MAX_HANKO_BYTES = 64 * 1024;
const MAX_ENTITIES = 256;
const MAX_CLAIMS = 64;
const MAX_MEMBERS_PER_CLAIM = 256;
const MAX_TOTAL_MEMBERS = 1024;
const MAX_MEMBER_SIGNATURES = 8;
const MAX_POWER = 0xffffn;
const MAX_DELAY = 0xffff_ffffn;
const MAX_SAFE_INDEX = BigInt(Number.MAX_SAFE_INTEGER);
const ADDRESS_MAX = (1n << 160n) - 1n;

const refuse = (tag: HankoFault["_tag"]): Result<never, HankoFault> => err({ _tag: tag } as HankoFault);
const unique = (xs: readonly string[]): boolean => new Set(xs).size === xs.length;
const WORD_TEXT = /^0x[0-9a-f]{64}$/i;
const EVEN_HEX = /^0[xX](?:[0-9a-fA-F]{2})*$/;

/** The bytes of `text` when it has the expected shape, and the named refusal when it has not. */
const hexBytes = (text: string, shape: RegExp, fault: HankoFault["_tag"]): Result<Uint8Array, HankoFault> =>
  shape.test(text) ? mapErr(hexToBytes(text), () => ({ _tag: fault }) as HankoFault) : refuse(fault);
const isAddressId = (id: string): boolean => {
  const v = BigInt(id);
  return v > 0n && v <= ADDRESS_MAX;
};

// ---- decoding ----

const listOf = <X>(buf: Uint8Array, at: AbiLength, read: (i: number) => X): Result<X[], HankoFault> => {
  const count = abiLengthWord(buf, at);
  return abiFits(buf, at, count, 32) ? ok(Array.from({ length: Number(count) }, (_, i) => read(i))) : refuse("decode");
};

const wordsAt = (buf: Uint8Array, at: AbiTuple, slot: number): Result<bigint[], HankoFault> => {
  const list = abiLengthRef(buf, at, slot);
  return listOf(buf, list, (i) => abiStaticWord(buf, list, i));
};

/** The claim at a cursor; none when the cursor itself is out of range, which makes the whole Hanko empty. */
const decodeClaim = (buf: Uint8Array, at: AbiTuple): Result<Option<HankoClaim>, HankoFault> => {
  if (!abiCursorOk(at)) return ok(none);
  const claimOf = (entityIndexes: bigint[], weights: bigint[]): Result<Option<HankoClaim>, HankoFault> =>
    ok(some({
      entityId: bytesToHex(abiTupleBytes(buf, at, 0)),
      entityIndexes,
      weights,
      threshold: abiWord(buf, at, 96),
      boardChangeDelay: abiWord(buf, at, 128),
      controlChangeDelay: abiWord(buf, at, 160),
      dividendChangeDelay: abiWord(buf, at, 192),
    }));
  return flatMap(wordsAt(buf, at, 32), (indexes) =>
    flatMap(wordsAt(buf, at, 64), (weights) => claimOf(indexes, weights)));
};

const EMPTY_HANKO: Hanko = { placeholders: [], packedSignatures: new Uint8Array(), claims: [], memberSignatures: [] };

const decodeHanko = (buf: Uint8Array): Result<Hanko, HankoFault> => {
  const body = abiTupleRef(buf, abiRoot(), 0);
  if (!abiCursorOk(body)) return ok(EMPTY_HANKO);
  const placeholdersAt = abiLengthRef(buf, body, 0);
  const signaturesAt = abiLengthRef(buf, body, 32);
  const claimsAt = abiLengthRef(buf, body, 64);
  const membersAt = abiLengthRef(buf, body, 96);
  const placeholders = listOf(buf, placeholdersAt, (i) => bytesToHex(abiStaticBytes(buf, placeholdersAt, i)));
  return flatMap(placeholders, (placeholders) =>
    flatMap(listOf(buf, claimsAt, (i) => decodeClaim(buf, abiTupleElement(buf, claimsAt, i))), (decoded) => {
      const firstStop = decoded.find((c) => !c.ok || c.value._tag === "none");
      if (firstStop !== undefined) return firstStop.ok ? ok(EMPTY_HANKO) : firstStop;
      const claims = decoded.flatMap((c) => (c.ok && c.value._tag === "some" ? [c.value.value] : []));
      const members = listOf(buf, membersAt, (i) => abiBytes(buf, abiBytesElement(buf, membersAt, i)));
      return flatMap(members, (memberSignatures): Result<Hanko, HankoFault> =>
        ok({ placeholders, packedSignatures: abiBytes(buf, signaturesAt), claims, memberSignatures }));
    }));
};

// ---- shape: the limits and canonical form the contract enforces before it reads a signature ----

/** The contract's size limits, checked claim by claim so the first oversized claim is the one named. */
const withinLimits = (h: Hanko): Result<void, HankoFault> => {
  const members = h.memberSignatures;
  const counted = packedCount(h.packedSignatures.length);
  if (members.length !== 0 && members.length !== h.placeholders.length) return refuse("member_signatures_shape");
  if (members.filter((s) => s.length > 0).length > MAX_MEMBER_SIGNATURES) return refuse("too_large");
  if (counted._tag === "none") return refuse("packed_length");
  const signatures = counted.value;
  const entities = h.placeholders.length + signatures + h.claims.length;
  const tooMany = h.claims.length > MAX_CLAIMS || entities > MAX_ENTITIES
    || h.placeholders.length > MAX_ENTITIES || signatures > MAX_ENTITIES;
  if (tooMany) return refuse("too_large");
  const [, membersSoFar] = mapAccum(h.claims, 0, (sum, c) => {
    const total = sum + c.entityIndexes.length;
    return [total, total] as const;
  });
  const claimWithinLimits = (c: HankoClaim, i: number): Result<void, HankoFault> => {
    const n = c.entityIndexes.length;
    if (n === 0 || n !== c.weights.length || n > MAX_MEMBERS_PER_CLAIM) return refuse("claim_shape");
    return (membersSoFar[i] ?? 0) > MAX_TOTAL_MEMBERS ? refuse("too_large") : ok(undefined);
  };
  return map(traverse(h.claims, claimWithinLimits), () => undefined);
};

/**
 * A Hanko is canonical when re-encoding its decoded form gives back the same bytes. This check is load-bearing twice:
 * it refuses the spellings the contract tolerates (trailing bytes, dirty padding), and it stops the decoder's leniency,
 * which reads past the end as zero words where the contract's strict `abi.decode` reverts (619 of 16,000 byte flips
 * in review). Without it this verifier would accept Hankos the contract refuses.
 */
const isCanonical = (h: Hanko, bytes: Uint8Array): boolean => {
  const delaysFit = (c: HankoClaim): boolean =>
    c.boardChangeDelay <= MAX_DELAY && c.controlChangeDelay <= MAX_DELAY && c.dividendChangeDelay <= MAX_DELAY;
  const again = encodeHanko(h);
  const sameBytes = again.ok && again.value === bytesToHex(bytes);
  return h.claims.every((c) => c.entityId.length === 66 && delaysFit(c)) && sameBytes;
};

/** The decoded Hanko, if its bytes are well formed, canonical and within the contract's limits. */
const decodedHanko = (hanko: string): Result<Hanko, HankoFault> => {
  const read = hexBytes(hanko, EVEN_HEX, "decode");
  if (!read.ok) return read;
  const bytes = read.value;
  if (bytes.length > MAX_HANKO_BYTES) return refuse("too_large");
  const decoded = decodeHanko(bytes);
  if (!decoded.ok) return refuse("non_canonical");
  const env = decoded.value;
  const limits = withinLimits(env);
  if (!limits.ok) return limits;
  if (!isCanonical(env, bytes)) return refuse("non_canonical");
  if (env.claims.length === 0) return refuse("claim_required");
  if (env.memberSignatures.some((s) => s.length > 0)) return refuse("member_signature");
  if (!unique(env.placeholders)) return refuse("duplicate_placeholder");
  if (!unique(env.claims.map((c) => c.entityId))) return refuse("duplicate_claim_entity");
  return ok(env);
};

// ---- signatures ----

const recoverSigners = (digest: Uint8Array, packed: Uint8Array): Result<readonly string[], HankoFault> => {
  const count = orElse(packedCount(packed.length), 0);
  if (!paddingClear(packed, count)) return refuse("packed_padding");
  const parts = Array.from({ length: count }, (_, i) => unpackSignature(packed, count, i));
  const nonCanonical = parts.some(({ r, s }) => isZeroWord(r) || isZeroWord(s) || !isLowS(s));
  if (nonCanonical) return refuse("signature_non_canonical");
  return foldResult(parts, [] as readonly string[], (signers, { r, s, recoveryBit }) => {
    const key = recoverPublicKey(digest, r, s, recoveryBit);
    if (key._tag === "none") return refuse("recovery_failed");
    const signer = addressOf(key.value).toLowerCase();
    return signers.includes(signer) ? refuse("duplicate_signer") : ok([...signers, signer]);
  });
};

// ---- claims ----

type ResolvedClaim = Readonly<{
  entityId: string; boardHash: string; threshold: bigint; votingPower: bigint;
  referenced: readonly number[]; used: readonly number[]; firstMember: string;
}>;

/** One board member: its id, its weight, whether its weight counts toward quorum, and the claim it nests. */
type Member = Tagged<"placeholder" | "signer" | "claim", { id: string; weight: bigint }>;
const votes = (m: Member): boolean => m._tag !== "placeholder";

/**
 * Placeholders did not sign, so they carry no vote; signers and earlier claims do. A placeholder may not stand in
 * for an Entity that an earlier claim already proves.
 */
const memberAt = (
  h: Hanko, signerIds: readonly string[], claimIndex: number, index: number,
): Result<Member, HankoFault> => {
  const placeholders = h.placeholders.length;
  const firstClaim = placeholders + signerIds.length;
  if (index < placeholders) {
    const id = h.placeholders[index] ?? "";
    const provenEarlier = h.claims.slice(0, claimIndex).some((c) => c.entityId === id);
    return provenEarlier ? refuse("placeholder_claim") : ok({ _tag: "placeholder", id, weight: 0n });
  }
  if (index < firstClaim) return ok({ _tag: "signer", id: signerIds[index - placeholders] ?? "", weight: 0n });
  const nested = index - firstClaim;
  return nested >= claimIndex
    ? refuse("claim_order")
    : ok({ _tag: "claim", id: h.claims[nested]?.entityId ?? "", weight: 0n });
};

const weighted = (m: Member, weight: bigint): Member => ({ ...m, weight });

const resolveMember = (h: Hanko, signerIds: readonly string[], claimIndex: number) =>
  (index: number, position: number): Result<Member, HankoFault> => {
    const weight = h.claims[claimIndex]?.weights[position] ?? 0n;
    if (weight <= 0n || weight > MAX_POWER) return refuse("weight");
    return flatMap(memberAt(h, signerIds, claimIndex, index), (m) => {
      const firstMustBeAddress = position === 0 && (m._tag === "claim" || !isAddressId(m.id));
      return firstMustBeAddress ? refuse("first_member") : ok(weighted(m, weight));
    });
  };

const resolveClaim = (
  h: Hanko, signerIds: readonly string[], claimIndex: number,
): Result<ResolvedClaim, HankoFault> => {
  const claim = h.claims[claimIndex];
  if (claim === undefined) return refuse("claim_shape");
  if (claim.threshold <= 0n || claim.threshold > MAX_POWER) return refuse("threshold");
  const totalCount = BigInt(h.placeholders.length + signerIds.length + h.claims.length);
  if (claim.entityIndexes.some((i) => i > MAX_SAFE_INDEX || i >= totalCount)) return refuse("entity_index");
  const indexes = claim.entityIndexes.map(Number);
  if (!unique(indexes.map(String))) return refuse("duplicate_entity_index");
  const resolved = traverse(indexes, resolveMember(h, signerIds, claimIndex));
  return flatMap(resolved, (members): Result<ResolvedClaim, HankoFault> => {
    const ids = members.map((m) => m.id);
    if (!unique(ids)) return refuse("duplicate_member");
    if (claim.threshold > claim.weights.reduce((sum, w) => sum + w, 0n)) return refuse("threshold_power");
    const votingPower = members.reduce((sum, m) => (votes(m) ? sum + m.weight : sum), 0n);
    const referenced = indexes.flatMap((index) => {
      const nested = index - h.placeholders.length - signerIds.length;
      return nested >= 0 ? [nested] : [];
    });
    const board = boardHash({
      votingThreshold: claim.threshold, entityIds: ids, votingPowers: members.map((m) => m.weight),
      boardChangeDelay: claim.boardChangeDelay, controlChangeDelay: claim.controlChangeDelay,
      dividendChangeDelay: claim.dividendChangeDelay,
    });
    return board.ok
      ? ok({
        entityId: claim.entityId, boardHash: board.value, threshold: claim.threshold, votingPower, referenced,
        used: indexes, firstMember: ids[0] ?? "",
      })
      : refuse("decode");
  });
};

/** Every claim must be reachable from the target, and every placeholder and signature used by some claim. */
const everythingUsed = (
  placeholders: number, signatures: number, claims: readonly ResolvedClaim[],
): Result<void, HankoFault> => {
  // A claim only nests earlier claims, so one pass from the last claim down finds everything reachable.
  const reachable = claims.reduceRight(
    (set, c, i) => (set.has(i) ? new Set([...set, ...c.referenced]) : set),
    new Set([claims.length - 1]),
  );
  const used = new Set(claims.flatMap((c) => c.used));
  const unusedFrom = (start: number, count: number): boolean =>
    Array.from({ length: count }, (_, i) => start + i).some((i) => !used.has(i));
  if (reachable.size !== claims.length) return refuse("unused_claim");
  if (unusedFrom(0, placeholders)) return refuse("unused_placeholder");
  if (unusedFrom(placeholders, signatures)) return refuse("unused_signature");
  return ok(undefined);
};

/** Claims that resolve, reach quorum, are all used and sit on authorized boards. */
const acceptedClaims = <F>(
  h: Hanko, signerIds: readonly string[], authorize: BoardAuthorizer<F>,
): Result<readonly ResolvedClaim[], HankoFault | F> => {
  const authorized = (c: ResolvedClaim): Result<boolean, F> =>
    (c.entityId === c.boardHash ? ok(true) : authorize(c.entityId, c.boardHash));
  const resolved = traverse(h.claims, (_, i) => resolveClaim(h, signerIds, i));
  return flatMap(resolved, (claims): Result<readonly ResolvedClaim[], HankoFault | F> => {
    if (claims.some((c) => c.votingPower < c.threshold)) return refuse("quorum");
    const used = everythingUsed(h.placeholders.length, signerIds.length, claims);
    return flatMap(used, () =>
      flatMap(everyResult(claims, authorized), (all) => (all ? ok(claims) : refuse("authority"))));
  });
};

/** The Entity the Hanko must speak for, as lower case bytes32: none when any Entity will do. */
const requiredEntity = (target: Target): Result<Option<string>, HankoFault> =>
  match(target, {
    any: () => ok(none),
    entity: ({ entityId }) => (WORD_TEXT.test(entityId) ? ok(some(entityId.toLowerCase())) : refuse("expected_entity")),
  });

/**
 * The contract's verdict on a Hanko envelope for `digest`: the Entity it speaks for, the addresses that signed and
 * the first member of the target claim. A claim whose board hashes to its own id needs no registration; any other
 * claim is asked of `authorize`.
 */
export const verifyHanko = <F = never>(
  hanko: string, digest: string, target: Target, authorize: BoardAuthorizer<F>,
): Result<HankoVerdict, HankoFault | F> => {
  const required = requiredEntity(target);
  if (!required.ok) return required;
  const expected = required.value;
  const digestBytes = hexBytes(digest, WORD_TEXT, "digest");
  if (!digestBytes.ok) return digestBytes;
  return flatMap(decodedHanko(hanko), (env) =>
    flatMap(recoverSigners(digestBytes.value, env.packedSignatures), (signers) => {
      if (signers.length === 0) return refuse("signature_required");
      const signerIds = signers.map(addressAsId);
      if (env.placeholders.some((p) => signerIds.includes(p))) return refuse("placeholder_signer");
      return flatMap(acceptedClaims(env, signerIds, authorize), (claims): Result<HankoVerdict, HankoFault | F> => {
        const last = claims.at(-1);
        const named = expected._tag === "some" ? expected.value : last?.entityId;
        if (last === undefined || last.entityId !== named) return refuse("target");
        return ok({ entityId: last.entityId, signers, firstMember: last.firstMember });
      });
    }));
};

export type RawHankoFault = RawFault | AbiFault;

/** A bare 65-byte signature is its signer's own lazy Entity: one member, threshold 1. */
const verifyRawHanko = (hanko: string, digest: string): Result<HankoVerdict, RawHankoFault> =>
  flatMap(recoverRawSigner(digest, hanko), (signer) =>
    map(lazyEntityId(signer), (entityId) => ({
      entityId, signers: [signer.toLowerCase()], firstMember: addressAsId(signer),
    })));

const RAW_SIGNATURE_DIGITS = 2 + 2 * 65;

/**
 * `EntityProvider.verifyHankoSignature`: a bare 65-byte signature stands for its signer's lazy Entity, anything else
 * is a Hanko envelope.
 */
export const verifyHankoSignature = <F = never>(
  hanko: string, digest: string, authorize: BoardAuthorizer<F>,
): Result<HankoVerdict, HankoFault | RawHankoFault | F> =>
  hanko.length === RAW_SIGNATURE_DIGITS
    ? verifyRawHanko(hanko, digest)
    : verifyHanko(hanko, digest, { _tag: "any" }, authorize);
