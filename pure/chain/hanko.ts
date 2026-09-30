// Hanko: an Entity's signature, as the EntityProvider reads it (HankoVerifier.sol).
//
// A Hanko carries packed ECDSA signatures, placeholders for board members who did not sign, and claims. A claim is
// one Entity's board: members by index (placeholders, then signers, then earlier claims) with weights and a threshold.
// The last claim is the signing Entity; the claims before it are nested Entities that vote in it. A claim's board
// hashes to its Entity id when the Entity is lazy (one signer, threshold 1); otherwise the board must be registered.
import { A, arrayOf, encode, type Abi, type AbiFault } from "../kernel/abi.ts";
import { bytesToHex, concat, hexToBytes, keccakHex } from "../kernel/bytes.ts";
import { err, flatMap, map, ok, type Result } from "../kernel/result.ts";
import { HALF_ORDER, addressOf, recoverPublicKey } from "../kernel/signature.ts";
import { none, some, type Option } from "../kernel/option.ts";
import { match, type Tagged } from "../kernel/tagged.ts";
import { wordAt } from "../kernel/abi-read.ts";

export type Delays = Readonly<{ boardChangeDelay: bigint; controlChangeDelay: bigint; dividendChangeDelay: bigint }>;

/** EntityTypes.sol `Board`. */
export type Board = Delays & Readonly<{
  votingThreshold: bigint; entityIds: readonly string[]; votingPowers: readonly bigint[];
}>;

/** HankoVerifier.sol `HankoClaim`: one board's vote, its members named by index into placeholders, signers, claims. */
export type HankoClaim = Delays & Readonly<{
  entityId: string; entityIndexes: readonly bigint[]; weights: readonly bigint[]; threshold: bigint;
}>;

/** HankoVerifier.sol `HankoBytes`. A member signature (ERC-1271) lets a placeholder contract vote; Account Hankos
 * carry none. */
export type Hanko = Readonly<{
  placeholders: readonly string[]; packedSignatures: Uint8Array; claims: readonly HankoClaim[];
  memberSignatures: readonly Uint8Array[];
}>;

const boardAbi = (b: Board): Abi => A.tuple([
  A.u16(b.votingThreshold), arrayOf(b.entityIds, A.b32), arrayOf(b.votingPowers, A.u16),
  A.u32(b.boardChangeDelay), A.u32(b.controlChangeDelay), A.u32(b.dividendChangeDelay),
]);

/** `abi.encode(Board)`: the bytes an Entity registers its board with. */
export const boardBytes = (b: Board): Result<Uint8Array, AbiFault> => encode([boardAbi(b)]);

export const boardHash = (b: Board): Result<string, AbiFault> => map(boardBytes(b), keccakHex);

/** An address as the bytes32 id a board names a member by. */
export const addressAsId = (address: string): string => {
  const body = address.slice(2).toLowerCase();
  return `0x${body.padStart(64, "0")}`;
};

const LAZY_DELAYS: Delays = { boardChangeDelay: 0n, controlChangeDelay: 0n, dividendChangeDelay: 0n };

/** A lazy Entity's id is the hash of its one-signer board. */
export const lazyEntityId = (signer: string): Result<string, AbiFault> =>
  boardHash({ ...LAZY_DELAYS, votingThreshold: 1n, entityIds: [addressAsId(signer)], votingPowers: [1n] });

const claimAbi = (c: HankoClaim): Abi => A.tuple([
  A.b32(c.entityId), arrayOf(c.entityIndexes, A.u256), arrayOf(c.weights, A.u256), A.u256(c.threshold),
  A.u32(c.boardChangeDelay), A.u32(c.controlChangeDelay), A.u32(c.dividendChangeDelay),
]);

/** `abi.encode(HankoBytes)`: the envelope the EntityProvider decodes. */
export const encodeHanko = (h: Hanko): Result<string, AbiFault> =>
  map(encode([A.tuple([
    arrayOf(h.placeholders, A.b32),
    A.bytes(bytesToHex(h.packedSignatures)),
    arrayOf(h.claims, claimAbi),
    arrayOf(h.memberSignatures, (s) => A.bytes(bytesToHex(s))),
  ])]), bytesToHex);

// ---- signatures ----

/** A signature as the Hanko packs it: r and s as 32 bytes each, `v` as 27 or 28. */
export type PackableSignature = Readonly<{ r: Uint8Array; s: Uint8Array; v: number }>;

export type PackFault = Tagged<"non_canonical_signature", { index: number }>;

export const isZeroWord = (word: Uint8Array): boolean => word.every((byte) => byte === 0);
export const isLowS = (s: Uint8Array): boolean => wordAt(s, 0) <= HALF_ORDER;

const canonicalSignature = (sig: PackableSignature): boolean =>
  sig.r.length === 32 && sig.s.length === 32 && (sig.v === 27 || sig.v === 28)
  && !isZeroWord(sig.r) && !isZeroWord(sig.s) && isLowS(sig.s);

/** r and s of every signature, then one recovery bit per signature, eight to a byte. */
export const packSignatures = (sigs: readonly PackableSignature[]): Result<Uint8Array, PackFault> => {
  const offending = sigs.findIndex((sig) => !canonicalSignature(sig));
  if (offending >= 0) return err({ _tag: "non_canonical_signature", index: offending });
  const bitsByte = (byte: number): number => sigs.slice(byte * 8, byte * 8 + 8)
    .reduce((bits, sig, k) => (sig.v === 28 ? bits | (1 << k) : bits), 0);
  const bits = Uint8Array.from({ length: Math.ceil(sigs.length / 8) }, (_, byte) => bitsByte(byte));
  return ok(concat([...sigs.flatMap((sig) => [sig.r, sig.s]), bits]));
};

/** How many signatures a packed blob of this length holds; nothing when no count fits exactly. */
export const packedCount = (byteLength: number): Option<number> => {
  if (byteLength === 0) return some(0);
  const count = Math.floor((byteLength * 8) / 513);
  return count === 0 || count * 64 + Math.ceil(count / 8) !== byteLength ? none : some(count);
};

export type UnpackedSignature = Readonly<{ r: Uint8Array; s: Uint8Array; recoveryBit: number }>;

export const unpackSignature = (packed: Uint8Array, count: number, i: number): UnpackedSignature => ({
  r: packed.subarray(i * 64, i * 64 + 32),
  s: packed.subarray(i * 64 + 32, i * 64 + 64),
  recoveryBit: ((packed[count * 64 + (i >> 3)] ?? 0) >> (i & 7)) & 1,
});

/** Bits of the last byte beyond the last signature must be zero, or one Hanko has two spellings. */
export const paddingClear = (packed: Uint8Array, count: number): boolean =>
  count % 8 === 0 || ((packed[packed.length - 1] ?? 0) >> (count % 8)) === 0;

/** The recovery bit a signature byte `v` names: 0 or 27 is 0, 1 or 28 is 1, anything else is no bit. */
const RECOVERY_BITS: ReadonlyMap<number, number> = new Map([[0, 0], [27, 0], [1, 1], [28, 1]]);

export type RawFault = Tagged<"not_65_bytes" | "bad_hex" | "bad_recovery" | "high_s" | "no_signer">;

/** The signer of a raw 65-byte signature `r || s || v`, `v` 0, 1, 27 or 28, low-s only. */
export const recoverRawSigner = (digest: string, signature: string): Result<string, RawFault> => {
  const raw = hexToBytes(signature);
  const hash = hexToBytes(digest);
  if (!raw.ok || !hash.ok) return err({ _tag: "bad_hex" });
  if (raw.value.length !== 65 || hash.value.length !== 32) return err({ _tag: "not_65_bytes" });
  const bit = RECOVERY_BITS.get(raw.value[64] ?? 0);
  if (bit === undefined) return err({ _tag: "bad_recovery" });
  const s = raw.value.subarray(32, 64);
  if (!isLowS(s)) return err({ _tag: "high_s" });
  const key = recoverPublicKey(hash.value, raw.value.subarray(0, 32), s, bit);
  return match(key, { some: ({ value }) => ok(addressOf(value)), none: () => err({ _tag: "no_signer" }) });
};

export type LazyHankoFault = Tagged<"not_65_bytes" | "bad_recovery"> | PackFault | AbiFault;

/** A lazy Entity's Hanko: one signature, one claim of one member with weight and threshold 1. */
export const lazyHanko = (entityId: string, signature: string): Result<string, LazyHankoFault> =>
  flatMap(hexToBytes(signature), (raw): Result<string, LazyHankoFault> => {
    const bit = RECOVERY_BITS.get(raw[64] ?? 0);
    if (raw.length !== 65) return err({ _tag: "not_65_bytes" });
    if (bit === undefined) return err({ _tag: "bad_recovery" });
    const packed = packSignatures([{ r: raw.subarray(0, 32), s: raw.subarray(32, 64), v: 27 + bit }]);
    const claim: HankoClaim = { ...LAZY_DELAYS, entityId, entityIndexes: [0n], weights: [1n], threshold: 1n };
    return flatMap(packed, (packedSignatures) =>
      encodeHanko({ placeholders: [], packedSignatures, claims: [claim], memberSignatures: [] }));
  });

