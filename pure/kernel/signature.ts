// secp256k1 signatures over 32-byte digests, and the Ethereum address a public key stands for.
//
// A signature is low-s with a recovery bit, so a signed digest has exactly one valid spelling.
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, concat, keccak256, utf8 } from "./bytes.ts";

export type RawSignature = Readonly<{ r: bigint; s: bigint; recovery: number; publicKey: Uint8Array }>;

export const HALF_ORDER = secp256k1.CURVE.n >> 1n;

export const signDigest = (digest: Uint8Array, privateKey: Uint8Array): RawSignature => {
  const signature = secp256k1.sign(digest, privateKey, { prehash: false, lowS: true });
  const publicKey = signature.recoverPublicKey(digest).toRawBytes(false);
  return { r: signature.r, s: signature.s, recovery: signature.recovery, publicKey };
};

/**
 * The uncompressed public key that signed `digest`, or nothing when r, s and the bit name no point on the curve.
 * The library signals that with an exception; this is the one place it is caught (registered in style/README.md).
 */
export const recoverPublicKey = (
  digest: Uint8Array, r: Uint8Array, s: Uint8Array, recoveryBit: number,
): Uint8Array | null => {
  try {
    const signature = secp256k1.Signature.fromCompact(concat([r, s])).addRecoveryBit(recoveryBit);
    return signature.recoverPublicKey(digest).toRawBytes(false);
  } catch {
    return null;
  }
};

/** EIP-55: a hex letter is upper case when the matching nibble of the address hash is 8 or more. */
export const checksum = (address: string): string => {
  const hex = address.slice(2).toLowerCase();
  const hash = keccak256(utf8(hex));
  const nibbleAt = (i: number): number => ((hash[i >> 1] ?? 0) >> (i % 2 === 0 ? 4 : 0)) & 0xf;
  return `0x${[...hex].map((c, i) => (nibbleAt(i) >= 8 ? c.toUpperCase() : c)).join("")}`;
};

/** The checksummed address of an uncompressed public key: the last 20 bytes of the hash of its 64 coordinate bytes. */
export const addressOf = (publicKey: Uint8Array): string =>
  checksum(bytesToHex(keccak256(publicKey.slice(1)).slice(12)));
