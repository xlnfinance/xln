import { ethers } from 'ethers';

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

export const HANKO_ABI = [
  'tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256,uint32,uint32,uint32)[])',
] as const;

const ABI_CODER = ethers.AbiCoder.defaultAbiCoder();
const SECP256K1_HALF_ORDER = BigInt(
  '0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0',
);

type AbiClaim = readonly [
  entityId: string,
  entityIndexes: readonly bigint[],
  weights: readonly bigint[],
  threshold: bigint,
  boardChangeDelay: bigint,
  controlChangeDelay: bigint,
  dividendChangeDelay: bigint,
];

type AbiEnvelope = readonly [readonly [
  placeholders: readonly string[],
  packedSignatures: string,
  claims: readonly AbiClaim[],
]];

const asHex = (value: string, label: string): HankoHex => {
  if (!ethers.isHexString(value)) throw new Error(`HANKO_${label}_HEX_INVALID`);
  return ethers.hexlify(value).toLowerCase() as HankoHex;
};

export const asHankoBytes32 = (value: string, label: string): HankoHex => {
  if (!ethers.isHexString(value, 32)) throw new Error(`HANKO_${label}_BYTES32_INVALID`);
  return ethers.hexlify(value).toLowerCase() as HankoHex;
};

const assertUint256 = (value: bigint, label: string): void => {
  if (typeof value !== 'bigint' || value < 0n || value > ethers.MaxUint256) {
    throw new Error(`HANKO_${label}_UINT256_INVALID`);
  }
};

const assertUint32 = (value: bigint, label: string): void => {
  if (typeof value !== 'bigint' || value < 0n || value > 0xffff_ffffn) {
    throw new Error(`HANKO_${label}_UINT32_INVALID`);
  }
};

const encodeClaim = (claim: HankoWireClaim, index: number): readonly unknown[] => {
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

export const encodeHankoEnvelope = (envelope: HankoEnvelope): HankoString => ABI_CODER.encode(
  HANKO_ABI,
  [[
    envelope.placeholders.map((value, index) => asHankoBytes32(value, `PLACEHOLDER_${index}`)),
    asHex(envelope.packedSignatures, 'PACKED_SIGNATURES'),
    envelope.claims.map(encodeClaim),
  ]],
);

const decodeClaim = (claim: AbiClaim, index: number): HankoWireClaim => ({
  entityId: asHankoBytes32(claim[0], `CLAIM_${index}_ENTITY_ID`),
  entityIndexes: [...claim[1]],
  weights: [...claim[2]],
  threshold: claim[3],
  boardChangeDelay: claim[4],
  controlChangeDelay: claim[5],
  dividendChangeDelay: claim[6],
});

export const decodeHankoEnvelope = (encoded: HankoString): HankoEnvelope => {
  const canonicalInput = asHex(encoded, 'ENVELOPE');
  let decoded: AbiEnvelope;
  try {
    decoded = ABI_CODER.decode(HANKO_ABI, canonicalInput) as unknown as AbiEnvelope;
  } catch (error) {
    throw new Error(`HANKO_ABI_DECODE_INVALID:${error instanceof Error ? error.message : String(error)}`);
  }
  const [placeholders, packedSignatures, claims] = decoded[0];
  const envelope: HankoEnvelope = {
    placeholders: placeholders.map((value, index) => asHankoBytes32(value, `PLACEHOLDER_${index}`)),
    packedSignatures: asHex(packedSignatures, 'PACKED_SIGNATURES'),
    claims: claims.map(decodeClaim),
  };
  if (encodeHankoEnvelope(envelope).toLowerCase() !== canonicalInput) {
    throw new Error('HANKO_ABI_NON_CANONICAL');
  }
  return envelope;
};

const signatureCount = (byteLength: number): number => {
  if (byteLength === 0) return 0;
  const candidate = Math.floor((byteLength * 8) / 513);
  const expected = candidate * 64 + Math.ceil(candidate / 8);
  if (candidate <= 0 || expected !== byteLength) {
    throw new Error(`HANKO_PACKED_SIGNATURE_LENGTH_INVALID:${byteLength}`);
  }
  return candidate;
};

const assertCanonicalSignature = (signature: Uint8Array, index: number): void => {
  if (signature.length !== 65) throw new Error(`HANKO_SIGNATURE_LENGTH_INVALID:${index}`);
  const recovery = signature[64];
  if (recovery !== 27 && recovery !== 28) throw new Error(`HANKO_SIGNATURE_RECOVERY_INVALID:${index}`);
  const r = BigInt(ethers.hexlify(signature.slice(0, 32)));
  const s = BigInt(ethers.hexlify(signature.slice(32, 64)));
  if (r === 0n || s === 0n || s > SECP256K1_HALF_ORDER) {
    throw new Error(`HANKO_SIGNATURE_NON_CANONICAL:${index}`);
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
    throw new Error('HANKO_PACKED_SIGNATURE_PADDING_NONZERO');
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
  const canonicalDigest = asHankoBytes32(digest, 'DIGEST');
  const digestBytes = ethers.getBytes(canonicalDigest);
  const signerIds = new Set<string>();
  return unpackHankoSignatures(packed).map((signature, index) => {
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
      throw new Error(`HANKO_SIGNATURE_RECOVERY_FAILED:${index}`);
    }
    const signerEntityId = ethers.zeroPadValue(address, 32).toLowerCase() as HankoHex;
    if (signerIds.has(signerEntityId)) throw new Error(`HANKO_DUPLICATE_SIGNER:${signerEntityId}`);
    signerIds.add(signerEntityId);
    return { signerEntityId, signature };
  });
};

export const signAndPackHankoDigest = (
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
