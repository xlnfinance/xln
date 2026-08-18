import { ethers } from 'ethers';
import { FailureDispositionError } from '../protocol/errors/failure-taxonomy';

import { decodeHankoAbi, encodeHankoAbi, type HankoAbiClaim } from './abi';
import type {
  HankoEnvelope,
  HankoHex,
  HankoRecoveredSignature,
  HankoString,
  HankoWireClaim,
} from '../types/hanko';
import {
  recoverAddressFromDigestSignature,
  signDigestBytesWithPrivateKey,
} from '../account/crypto';

// Wire type: tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256,uint32,uint32,uint32)[])
// laid out by the direct codec in ./abi (byte-identical to AbiCoder).
// Hanko strings are re-decoded several times per input (verify, proposer
// inspection, witness checks, ack validation). Decoding and signature recovery
// are pure functions of their string inputs, so bounded memos are exact.
const MEMO_MAX_ENTRIES = 2048;
const decodedEnvelopes = new Map<string, HankoEnvelope>();
const recoveredSignatures = new Map<string, readonly HankoRecoveredSignature[]>();
const memoSet = <T>(memo: Map<string, T>, key: string, value: T): T => {
  if (memo.size >= MEMO_MAX_ENTRIES) memo.clear();
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

export const encodeHankoEnvelope = (envelope: HankoEnvelope): HankoString => {
  assertContractHankoShape(envelope);
  const encoded = encodeHankoAbi([
    envelope.placeholders.map((value, index) => asHankoBytes32(value, `PLACEHOLDER_${index}`)),
    asHex(envelope.packedSignatures, 'PACKED_SIGNATURES'),
    envelope.claims.map(encodeClaim),
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
  if (tuple.length !== 3) invalidHanko('HANKO_ENVELOPE_LENGTH_INVALID');
  const placeholders = requireAbiArray(tuple[0], 'PLACEHOLDERS');
  const packedSignatures = tuple[1];
  const claims = requireAbiArray(tuple[2], 'CLAIMS');
  const envelope: HankoEnvelope = {
    placeholders: Object.freeze(placeholders.map((value, index) =>
      asHankoBytes32(requireAbiString(value, `PLACEHOLDER_${index}`), `PLACEHOLDER_${index}`))),
    packedSignatures: asHex(requireAbiString(packedSignatures, 'PACKED_SIGNATURES'), 'PACKED_SIGNATURES'),
    claims: Object.freeze(claims.map((claim, index) => freezeClaim(decodeClaim(claim, index)))),
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

const assertCanonicalSignature = (signature: Uint8Array, index: number): void => {
  if (signature.length !== 65) invalidHanko(`HANKO_SIGNATURE_LENGTH_INVALID:${index}`);
  const recovery = signature[64];
  if (recovery !== 27 && recovery !== 28) invalidHanko(`HANKO_SIGNATURE_RECOVERY_INVALID:${index}`);
  const r = BigInt(ethers.hexlify(signature.slice(0, 32)));
  const s = BigInt(ethers.hexlify(signature.slice(32, 64)));
  if (r === 0n || s === 0n || s > SECP256K1_HALF_ORDER) {
    invalidHanko(`HANKO_SIGNATURE_NON_CANONICAL:${index}`);
  }
};

export const packHankoSignatures = (signatures: readonly Uint8Array[]): HankoHex => {
  if (signatures.length === 0) return '0x';
  signatures.forEach(assertCanonicalSignature);
  const recoveryBits = new Uint8Array(Math.ceil(signatures.length / 8));
  signatures.forEach((signature, index) => {
    if (signature[64] === 28) recoveryBits[Math.floor(index / 8)]! |= 1 << (index % 8);
  });
  return ethers.hexlify(ethers.concat([
    ...signatures.map((signature) => signature.slice(0, 64)),
    recoveryBits,
  ])).toLowerCase() as HankoHex;
};

export const unpackHankoSignatures = (packed: string): readonly HankoHex[] => {
  const bytes = ethers.getBytes(asHex(packed, 'PACKED_SIGNATURES'));
  const count = signatureCount(bytes.length);
  if (count === 0) return [];
  const recoveryOffset = count * 64;
  const usedBits = count % 8;
  if (usedBits !== 0 && (bytes[bytes.length - 1]! >> usedBits) !== 0) {
    invalidHanko('HANKO_PACKED_SIGNATURE_PADDING_NONZERO');
  }
  return Array.from({ length: count }, (_, index) => {
    const recoveryByte = bytes[recoveryOffset + Math.floor(index / 8)]!;
    const recovery = ((recoveryByte >> (index % 8)) & 1) === 0 ? 27 : 28;
    const signature = ethers.getBytes(ethers.concat([
      bytes.slice(index * 64, (index + 1) * 64),
      Uint8Array.of(recovery),
    ]));
    assertCanonicalSignature(signature, index);
    return ethers.hexlify(signature).toLowerCase() as HankoHex;
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
}>): HankoString => encodeHankoEnvelope({
  placeholders: input.placeholders,
  packedSignatures: signAndPackHankoDigest(input.digest, input.privateKeys),
  claims: input.claims,
});
