import { ethers } from 'ethers';
import { hexToBytes } from '../support/bytes/hex-bytes';
import { FailureDispositionError } from '../protocol/errors/failure-taxonomy';

import { decodeHankoAbi, encodeHankoAbi, type HankoAbiClaim } from './abi';
import type {
  HankoEnvelope,
  HankoEnvelopeInput,
  HankoHex,
  HankoRecoveredSignature,
  HankoString,
  HankoWireClaim,
} from '../types/hanko';
import {
  recoverAddressFromDigestSignature,
  signDigestBytesWithPrivateKey,
} from '../account/crypto';
import {
  ECDSA_RECOVER_RECORD_BYTES,
  ECDSA_RECOVER_RESULT_BYTES,
  recoverAddressesBatch,
} from '../protocol/crypto/crypto-pool';
import { countOp } from '../support/performance/op-counters';

// Wire type: tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256,uint32,uint32,uint32)[],bytes[])
// laid out by the direct codec in ./abi (byte-identical to AbiCoder).
// Hanko strings are re-decoded several times per input (verify, proposer
// inspection, witness checks, ack validation). Decoding and signature recovery
// are pure functions of their string inputs, so bounded memos are exact.
// One 1000-peer Hub wave carries roughly two current Hankos per Account plus
// their ACK echoes. A 2048-entry clear-all cache repeatedly discarded the
// same signatures mid-wave and paid secp recovery again. Keep a bounded
// rolling working set large enough for several concurrent waves.
const MEMO_MAX_ENTRIES = 16_384;
const decodedEnvelopes = new Map<string, HankoEnvelope>();
const recoveredSignatures = new Map<string, readonly HankoRecoveredSignature[]>();
const memoSet = <T>(memo: Map<string, T>, key: string, value: T): T => {
  if (memo.size >= MEMO_MAX_ENTRIES) {
    const oldest = memo.keys().next();
    if (!oldest.done) memo.delete(oldest.value);
  }
  memo.set(key, value);
  return value;
};
const freezeClaim = (claim: HankoWireClaim): HankoWireClaim => {
  Object.freeze(claim.entityIndexes);
  Object.freeze(claim.weights);
  return Object.freeze(claim);
};
// Exact HankoVerifier.sol resource limits. Off-chain consensus must reject a
// proof which the jurisdiction can never verify; otherwise peers can certify
// an Account state whose only enforcement evidence is permanently unmineable.
export const HANKO_MAX_BYTES = 64 * 1024;
const HANKO_MAX_ENTITIES = 256;
const HANKO_MAX_CLAIMS = 64;
const HANKO_MAX_MEMBERS_PER_CLAIM = 256;
const HANKO_MAX_TOTAL_MEMBERS = 1024;
// Contract (ERC-1271) members per proof; each costs one capped STATICCALL.
const HANKO_MAX_MEMBER_SIGNATURES = 8;
const SECP256K1_HALF_ORDER = BigInt(
  '0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0',
);

export class HankoValidationError extends FailureDispositionError {
  constructor(message: string) {
    super('reject', 'HANKO_INVALID', message);
    this.name = 'HankoValidationError';
  }
}

export function invalidHanko(message: string): never {
  throw new HankoValidationError(message);
}

// The regexes admit exactly the strings ethers.hexlify/isHexString accept
// here, so lowercasing the validated input is the same normalisation without
// a bytes round-trip (hexlify(string) parses to bytes and re-formats).
const asHex = (value: string, label: string): HankoHex => {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) invalidHanko(`HANKO_${label}_HEX_INVALID`);
  return value.toLowerCase() as HankoHex;
};

export const asHankoBytes32 = (value: string, label: string): HankoHex => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) invalidHanko(`HANKO_${label}_BYTES32_INVALID`);
  return value.toLowerCase() as HankoHex;
};

const assertUint256 = (value: bigint, label: string): void => {
  if (typeof value !== 'bigint' || value < 0n || value > ethers.MaxUint256) {
    invalidHanko(`HANKO_${label}_UINT256_INVALID`);
  }
};

const assertUint32 = (value: bigint, label: string): void => {
  if (typeof value !== 'bigint' || value < 0n || value > 0xffff_ffffn) {
    invalidHanko(`HANKO_${label}_UINT32_INVALID`);
  }
};

const encodeClaim = (claim: HankoWireClaim, index: number): HankoAbiClaim => {
  const entityId = asHankoBytes32(claim.entityId, `CLAIM_${index}_ENTITY_ID`);
  claim.entityIndexes.forEach((value, member) => assertUint256(value, `CLAIM_${index}_INDEX_${member}`));
  claim.weights.forEach((value, member) => assertUint256(value, `CLAIM_${index}_WEIGHT_${member}`));
  assertUint256(claim.threshold, `CLAIM_${index}_THRESHOLD`);
  assertUint32(claim.boardChangeDelay, `CLAIM_${index}_BOARD_CHANGE_DELAY`);
  assertUint32(claim.controlChangeDelay, `CLAIM_${index}_CONTROL_CHANGE_DELAY`);
  assertUint32(claim.dividendChangeDelay, `CLAIM_${index}_DIVIDEND_CHANGE_DELAY`);
  return [
    entityId,
    claim.entityIndexes,
    claim.weights,
    claim.threshold,
    claim.boardChangeDelay,
    claim.controlChangeDelay,
    claim.dividendChangeDelay,
  ];
};

const assertContractHankoShape = (envelope: HankoEnvelope): void => {
  if (
    envelope.memberSignatures.length !== 0
    && envelope.memberSignatures.length !== envelope.placeholders.length
  ) invalidHanko('HANKO_MEMBER_SIGNATURES_INVALID');
  let memberCount = 0;
  for (const signature of envelope.memberSignatures) {
    if (signature.length > 2) memberCount += 1;
  }
  if (memberCount > HANKO_MAX_MEMBER_SIGNATURES) invalidHanko('HANKO_PROOF_TOO_LARGE');
  const packedBytes = (envelope.packedSignatures.length - 2) / 2;
  const signatures = signatureCount(packedBytes);
  const totalEntities = envelope.placeholders.length + signatures + envelope.claims.length;
  if (
    envelope.claims.length > HANKO_MAX_CLAIMS
    || totalEntities > HANKO_MAX_ENTITIES
    || envelope.placeholders.length > HANKO_MAX_ENTITIES
    || signatures > HANKO_MAX_ENTITIES
  ) invalidHanko('HANKO_PROOF_TOO_LARGE');
  let totalMembers = 0;
  for (const [index, claim] of envelope.claims.entries()) {
    const members = claim.entityIndexes.length;
    if (
      members === 0
      || members !== claim.weights.length
      || members > HANKO_MAX_MEMBERS_PER_CLAIM
    ) invalidHanko(`HANKO_CLAIM_SHAPE_INVALID:${index}`);
    totalMembers += members;
    if (totalMembers > HANKO_MAX_TOTAL_MEMBERS) invalidHanko('HANKO_PROOF_TOO_LARGE');
  }
};

export const encodeHankoEnvelope = (input: HankoEnvelopeInput): HankoString => {
  const envelope: HankoEnvelope = {
    placeholders: input.placeholders,
    packedSignatures: input.packedSignatures,
    claims: input.claims,
    memberSignatures: input.memberSignatures ?? [],
  };
  assertContractHankoShape(envelope);
  const encoded = encodeHankoAbi([
    envelope.placeholders.map((value, index) => asHankoBytes32(value, `PLACEHOLDER_${index}`)),
    asHex(envelope.packedSignatures, 'PACKED_SIGNATURES'),
    envelope.claims.map(encodeClaim),
    envelope.memberSignatures.map((value, index) => asHex(value, `MEMBER_SIGNATURE_${index}`)),
  ]);
  if ((encoded.length - 2) / 2 > HANKO_MAX_BYTES) invalidHanko('HANKO_PROOF_TOO_LARGE');
  return encoded as HankoString;
};

const requireAbiArray = (value: unknown, label: string): readonly unknown[] => {
  if (!Array.isArray(value)) invalidHanko(`HANKO_${label}_ARRAY_INVALID`);
  return value;
};

const requireAbiBigInt = (value: unknown, label: string): bigint => {
  if (typeof value !== 'bigint') invalidHanko(`HANKO_${label}_BIGINT_INVALID`);
  return value;
};

const requireAbiString = (value: unknown, label: string): string => {
  if (typeof value !== 'string') invalidHanko(`HANKO_${label}_STRING_INVALID`);
  return value;
};

const decodeClaim = (value: unknown, index: number): HankoWireClaim => {
  const claim = requireAbiArray(value, `CLAIM_${index}`);
  if (claim.length !== 7) invalidHanko(`HANKO_CLAIM_${index}_LENGTH_INVALID`);
  const indexes = requireAbiArray(claim[1], `CLAIM_${index}_INDEXES`)
    .map((entry, member) => requireAbiBigInt(entry, `CLAIM_${index}_INDEX_${member}`));
  const weights = requireAbiArray(claim[2], `CLAIM_${index}_WEIGHTS`)
    .map((entry, member) => requireAbiBigInt(entry, `CLAIM_${index}_WEIGHT_${member}`));
  return {
    entityId: asHankoBytes32(
      requireAbiString(claim[0], `CLAIM_${index}_ENTITY_ID`),
      `CLAIM_${index}_ENTITY_ID`,
    ),
    entityIndexes: indexes,
    weights,
    threshold: requireAbiBigInt(claim[3], `CLAIM_${index}_THRESHOLD`),
    boardChangeDelay: requireAbiBigInt(claim[4], `CLAIM_${index}_BOARD_CHANGE_DELAY`),
    controlChangeDelay: requireAbiBigInt(claim[5], `CLAIM_${index}_CONTROL_CHANGE_DELAY`),
    dividendChangeDelay: requireAbiBigInt(claim[6], `CLAIM_${index}_DIVIDEND_CHANGE_DELAY`),
  };
};

export const decodeHankoEnvelope = (encoded: HankoString): HankoEnvelope => {
  const memoized = decodedEnvelopes.get(encoded);
  if (memoized) return memoized;
  return memoSet(decodedEnvelopes, encoded, decodeHankoEnvelopeUncached(encoded));
};

const decodeHankoEnvelopeUncached = (encoded: HankoString): HankoEnvelope => {
  const canonicalInput = asHex(encoded, 'ENVELOPE');
  if ((canonicalInput.length - 2) / 2 > HANKO_MAX_BYTES) {
    invalidHanko('HANKO_PROOF_TOO_LARGE');
  }
  let tuple: readonly unknown[];
  try {
    tuple = decodeHankoAbi(canonicalInput);
  } catch (error) {
    invalidHanko(`HANKO_ABI_DECODE_INVALID:${error instanceof Error ? error.message : String(error)}`);
  }
  if (tuple.length !== 4) invalidHanko('HANKO_ENVELOPE_LENGTH_INVALID');
  const placeholders = requireAbiArray(tuple[0], 'PLACEHOLDERS');
  const packedSignatures = tuple[1];
  const claims = requireAbiArray(tuple[2], 'CLAIMS');
  const memberSignatures = requireAbiArray(tuple[3], 'MEMBER_SIGNATURES');
  const envelope: HankoEnvelope = {
    placeholders: Object.freeze(placeholders.map((value, index) =>
      asHankoBytes32(requireAbiString(value, `PLACEHOLDER_${index}`), `PLACEHOLDER_${index}`))),
    packedSignatures: asHex(requireAbiString(packedSignatures, 'PACKED_SIGNATURES'), 'PACKED_SIGNATURES'),
    claims: Object.freeze(claims.map((claim, index) => freezeClaim(decodeClaim(claim, index)))),
    memberSignatures: Object.freeze(memberSignatures.map((value, index) =>
      asHex(requireAbiString(value, `MEMBER_SIGNATURE_${index}`), `MEMBER_SIGNATURE_${index}`))),
  };
  assertContractHankoShape(envelope);
  if (encodeHankoEnvelope(envelope).toLowerCase() !== canonicalInput) {
    invalidHanko('HANKO_ABI_NON_CANONICAL');
  }
  return Object.freeze(envelope);
};

const signatureCount = (byteLength: number): number => {
  if (byteLength === 0) return 0;
  const candidate = Math.floor((byteLength * 8) / 513);
  const expected = candidate * 64 + Math.ceil(candidate / 8);
  if (candidate <= 0 || expected !== byteLength) {
    invalidHanko(`HANKO_PACKED_SIGNATURE_LENGTH_INVALID:${byteLength}`);
  }
  return candidate;
};

const SECP256K1_HALF_ORDER_BYTES = hexToBytes(`0x${SECP256K1_HALF_ORDER.toString(16).padStart(64, '0')}`);
const HEX_BYTE_TEXT = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, '0'));
const bytesToLowerHex = (bytes: Uint8Array): string => {
  let output = '0x';
  for (let index = 0; index < bytes.length; index += 1) output += HEX_BYTE_TEXT[bytes[index] ?? 0];
  return output;
};

/** Unsigned big-endian compare of two 32-byte scalars, no BigInt round trip. */
const compareScalarBytes = (bytes: Uint8Array, offset: number, reference: Uint8Array): number => {
  for (let index = 0; index < 32; index += 1) {
    const difference = (bytes[offset + index] ?? 0) - (reference[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

const isZeroScalar = (bytes: Uint8Array, offset: number): boolean => {
  for (let index = 0; index < 32; index += 1) if (bytes[offset + index] !== 0) return false;
  return true;
};

// Hub frames pack hundreds of signatures; parsing r and s through hex text
// and BigInt for the low-s rule was most of Hanko encoding time.
const assertCanonicalSignature = (signature: Uint8Array, index: number): void => {
  if (signature.length !== 65) invalidHanko(`HANKO_SIGNATURE_LENGTH_INVALID:${index}`);
  const recovery = signature[64];
  if (recovery !== 27 && recovery !== 28) invalidHanko(`HANKO_SIGNATURE_RECOVERY_INVALID:${index}`);
  if (
    isZeroScalar(signature, 0)
    || isZeroScalar(signature, 32)
    || compareScalarBytes(signature, 32, SECP256K1_HALF_ORDER_BYTES) > 0
  ) {
    invalidHanko(`HANKO_SIGNATURE_NON_CANONICAL:${index}`);
  }
};

export const packHankoSignatures = (signatures: readonly Uint8Array[]): HankoHex => {
  if (signatures.length === 0) return '0x';
  signatures.forEach(assertCanonicalSignature);
  const recoveryBits = new Uint8Array(Math.ceil(signatures.length / 8));
  const packed = new Uint8Array(signatures.length * 64 + recoveryBits.length);
  signatures.forEach((signature, index) => {
    packed.set(signature.subarray(0, 64), index * 64);
    if (signature[64] === 28) {
      const byteIndex = Math.floor(index / 8);
      const current = recoveryBits[byteIndex];
      if (current === undefined) throw new Error(`HANKO_RECOVERY_BIT_INDEX_INVALID:${byteIndex}`);
      recoveryBits[byteIndex] = current | (1 << (index % 8));
    }
  });
  packed.set(recoveryBits, signatures.length * 64);
  return bytesToLowerHex(packed) as HankoHex;
};

export const unpackHankoSignatures = (packed: string): readonly HankoHex[] => {
  const bytes = ethers.getBytes(asHex(packed, 'PACKED_SIGNATURES'));
  const count = signatureCount(bytes.length);
  if (count === 0) return [];
  const recoveryOffset = count * 64;
  const usedBits = count % 8;
  const finalRecoveryByte = bytes.at(-1);
  if (finalRecoveryByte === undefined) invalidHanko('HANKO_PACKED_SIGNATURE_BYTES_MISSING');
  if (usedBits !== 0 && (finalRecoveryByte >> usedBits) !== 0) {
    invalidHanko('HANKO_PACKED_SIGNATURE_PADDING_NONZERO');
  }
  return Array.from({ length: count }, (_, index) => {
    const recoveryByte = bytes[recoveryOffset + Math.floor(index / 8)];
    if (recoveryByte === undefined) invalidHanko(`HANKO_RECOVERY_BYTE_MISSING:${index}`);
    const recovery = ((recoveryByte >> (index % 8)) & 1) === 0 ? 27 : 28;
    const signature = new Uint8Array(65);
    signature.set(bytes.subarray(index * 64, (index + 1) * 64), 0);
    signature[64] = recovery;
    assertCanonicalSignature(signature, index);
    return bytesToLowerHex(signature) as HankoHex;
  });
};

export const recoverHankoSignatures = (
  digest: string,
  packed: string,
): readonly HankoRecoveredSignature[] => {
  const key = `${digest}|${packed}`;
  const memoized = recoveredSignatures.get(key);
  if (memoized) return memoized;
  return memoSet(recoveredSignatures, key, recoverHankoSignaturesUncached(digest, packed));
};

const recoverHankoSignaturesUncached = (
  digest: string,
  packed: string,
): readonly HankoRecoveredSignature[] => {
  const canonicalDigest = asHankoBytes32(digest, 'DIGEST');
  const digestBytes = ethers.getBytes(canonicalDigest);
  const signerIds = new Set<string>();
  return Object.freeze(unpackHankoSignatures(packed).map((signature, index) => {
    const signatureBytes = ethers.getBytes(signature);
    const recovery = signatureBytes[64];
    const address = recovery === 27 || recovery === 28
      ? recoverAddressFromDigestSignature(
          digestBytes,
          signatureBytes.slice(0, 64),
          recovery - 27,
        )
      : null;
    if (!address) {
      invalidHanko(`HANKO_SIGNATURE_RECOVERY_FAILED:${index}`);
    }
    const signerEntityId = ethers.zeroPadValue(address, 32).toLowerCase() as HankoHex;
    if (signerIds.has(signerEntityId)) invalidHanko(`HANKO_DUPLICATE_SIGNER:${signerEntityId}`);
    signerIds.add(signerEntityId);
    return Object.freeze({ signerEntityId, signature });
  }));
};

/**
 * Warm `recoverHankoSignatures` for many (digest, hanko) pairs at once on the
 * worker pool. Pure acceleration: entries that fail to unpack or recover are
 * simply left out, and the synchronous verifier reproduces the exact error
 * later. Never changes what is accepted, only where the curve math runs.
 */
export const primeRecoveredHankoSignatures = async (
  items: ReadonlyArray<Readonly<{ digest: string; hanko: string }>>,
): Promise<number> => {
  type Planned = { key: string; signatures: readonly HankoHex[]; first: number };
  const planned: Planned[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const item of items) {
    let signatures: readonly HankoHex[];
    try {
      const digest = asHankoBytes32(item.digest, 'DIGEST');
      const packed = decodeHankoEnvelope(item.hanko as HankoString).packedSignatures;
      const key = `${digest}|${packed}`;
      if (seen.has(key) || recoveredSignatures.has(key)) continue;
      seen.add(key);
      signatures = unpackHankoSignatures(packed);
      planned.push({ key, signatures, first: total });
    } catch {
      continue;
    }
    total += signatures.length;
  }
  if (total === 0) return 0;
  const records = new Uint8Array(total * ECDSA_RECOVER_RECORD_BYTES);
  for (const plan of planned) {
    const digestBytes = ethers.getBytes(plan.key.slice(0, 66));
    plan.signatures.forEach((signature, index) => {
      const base = (plan.first + index) * ECDSA_RECOVER_RECORD_BYTES;
      const bytes = ethers.getBytes(signature);
      records.set(digestBytes, base);
      records.set(bytes.subarray(0, 64), base + 32);
      records[base + 96] = bytes[64]! - 27;
    });
  }
  const addresses = await recoverAddressesBatch(records);
  countOp(addresses ? 'hanko.prime.batch' : 'hanko.prime.noPool', total);
  if (!addresses) return 0;
  let primed = 0;
  for (const plan of planned) {
    if (recoveredSignatures.has(plan.key)) continue;
    const signerIds = new Set<string>();
    let valid = true;
    const recovered = plan.signatures.map((signature, index) => {
      const offset = (plan.first + index) * ECDSA_RECOVER_RESULT_BYTES;
      const address = addresses.subarray(offset, offset + ECDSA_RECOVER_RESULT_BYTES);
      if (address.every(byte => byte === 0)) valid = false;
      const signerEntityId = ethers.zeroPadValue(address, 32).toLowerCase() as HankoHex;
      if (signerIds.has(signerEntityId)) valid = false;
      signerIds.add(signerEntityId);
      return Object.freeze({ signerEntityId, signature });
    });
    if (!valid) continue;
    memoSet(recoveredSignatures, plan.key, Object.freeze(recovered));
    primed += 1;
  }
  countOp('hanko.prime.primed', primed);
  return primed;
};

const signAndPackHankoDigest = (
  digest: string,
  privateKeys: readonly Uint8Array[],
): HankoHex => {
  const digestBytes = ethers.getBytes(asHankoBytes32(digest, 'DIGEST'));
  return packHankoSignatures(privateKeys.map((privateKey) => {
    const signed = signDigestBytesWithPrivateKey(privateKey, digestBytes);
    return ethers.getBytes(ethers.concat([
      signed.signature,
      Uint8Array.of(27 + signed.recovery),
    ]));
  }));
};

export const encodeSignedHanko = (input: Readonly<{
  digest: string;
  privateKeys: readonly Uint8Array[];
  placeholders: HankoEnvelope['placeholders'];
  claims: HankoEnvelope['claims'];
  memberSignatures?: HankoEnvelope['memberSignatures'];
}>): HankoString => encodeHankoEnvelope({
  placeholders: input.placeholders,
  packedSignatures: signAndPackHankoDigest(input.digest, input.privateKeys),
  claims: input.claims,
  memberSignatures: input.memberSignatures ?? [],
});
