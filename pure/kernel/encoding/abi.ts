// Solidity ABI: a value tree that encodes to the bytes the contracts decode, and typed cursors for reading them back.
//
// The model is `Abi`, one member per Solidity type the contracts use. Building a tree cannot fail; `encode` checks
// every leaf against its type (a uint16 above 65535, a bytes32 of 31 bytes) and names the first leaf that does not fit.
import { bytesToHex, concat, digitsToBytes, hexBody, hexToBytes, type HexFault } from "./bytes.ts";
import { err, flatMap, map, mapAccum, ok, traverse, type Result } from "../core/result.ts";
import { match, type Tagged } from "../core/tagged.ts";

export type UintBits = 8 | 16 | 32 | 64 | 256;
export type Abi =
  | Tagged<"uint", { bits: UintBits; value: bigint }>
  | Tagged<"int256", { value: bigint }>
  | Tagged<"bool", { value: boolean }>
  | Tagged<"address" | "bytes32" | "bytes", { value: string }>
  | Tagged<"array" | "tuple", { value: readonly Abi[] }>;

export type AbiFault =
  | HexFault
  | Tagged<"out_of_range", { type: `uint${UintBits}` | "int256" }>
  | Tagged<"wrong_size", { type: "address" | "bytes32"; bytes: number }>;

const uint = (bits: UintBits) => (value: bigint): Abi => ({ _tag: "uint", bits, value });
export const A = {
  u8: uint(8), u16: uint(16), u32: uint(32), u64: uint(64), u256: uint(256),
  i256: (value: bigint): Abi => ({ _tag: "int256", value }),
  bool: (value: boolean): Abi => ({ _tag: "bool", value }),
  address: (value: string): Abi => ({ _tag: "address", value }),
  b32: (value: string): Abi => ({ _tag: "bytes32", value }),
  bytes: (value: string): Abi => ({ _tag: "bytes", value }),
  array: (value: readonly Abi[]): Abi => ({ _tag: "array", value }),
  tuple: (value: readonly Abi[]): Abi => ({ _tag: "tuple", value }),
} as const;

/** `T[]` for any element type: the elements are encoded by `f`. */
export const arrayOf = <X>(xs: readonly X[], f: (x: X) => Abi): Abi => A.array(xs.map((x) => f(x)));

const WORD_DIGITS = 64;
const padLeft = (digits: string): string => digits.padStart(WORD_DIGITS, "0");

/** The hex digits of an unsigned value, left padded to `width` digits. */
const uintDigits = (value: bigint, bits: UintBits, width: number): Result<string, AbiFault> =>
  value >= 0n && value < 1n << BigInt(bits)
    ? ok(value.toString(16).padStart(width, "0"))
    : err({ _tag: "out_of_range", type: `uint${bits}` });
const uintWord = (value: bigint, bits: UintBits): Result<string, AbiFault> =>
  uintDigits(value, bits, WORD_DIGITS);

const INT256_LIMIT = 1n << 255n;
/** Two's complement: a negative n is written as 2^256 + n. */
const intWord = (value: bigint): Result<string, AbiFault> =>
  value >= -INT256_LIMIT && value < INT256_LIMIT
    ? ok(padLeft((value < 0n ? (1n << 256n) + value : value).toString(16)))
    : err({ _tag: "out_of_range", type: "int256" });

/** The bytes of a hex string that must be exactly `size` long. */
const sizedBytes = (hex: string, type: "address" | "bytes32", size: number): Result<Uint8Array, AbiFault> =>
  flatMap(hexToBytes(hex), (bytes) =>
    (bytes.length === size ? ok(bytes) : err({ _tag: "wrong_size", type, bytes: bytes.length })));

const isDynamic = (v: Abi): boolean => {
  switch (v._tag) {
    case "bytes": case "array": return true;
    case "tuple": return v.value.some(isDynamic);
    default: return false;
  }
};

const padRight = (bytes: Uint8Array): Uint8Array =>
  concat([bytes, new Uint8Array(Math.ceil(bytes.length / 32) * 32 - bytes.length)]);

const encodeValue = (v: Abi): Result<string, AbiFault> => match(v, {
  uint: (x) => uintWord(x.value, x.bits),
  int256: (x) => intWord(x.value),
  bool: (x) => uintWord(x.value ? 1n : 0n, 8),
  address: (x) => map(sizedBytes(x.value, "address", 20), (b) => padLeft(hexBody(bytesToHex(b)))),
  bytes32: (x) => map(sizedBytes(x.value, "bytes32", 32), (b) => hexBody(bytesToHex(b))),
  bytes: (x) => flatMap(hexToBytes(x.value), (b) =>
    map(uintWord(BigInt(b.length), 256), (length) => length + hexBody(bytesToHex(padRight(b))))),
  array: (x) => flatMap(uintWord(BigInt(x.value.length), 256), (length) =>
    map(encodeSequence(x.value), (items) => length + items)),
  tuple: (x) => encodeSequence(x.value),
});

type Part = Readonly<{ dynamic: boolean; hex: string }>;
/** Static values sit in the head; a dynamic value sits in the tail and its head holds the offset. */
const encodeSequence = (vs: readonly Abi[]): Result<string, AbiFault> => {
  const parts = traverse(vs, (v): Result<Part, AbiFault> =>
    map(encodeValue(v), (hex) => ({ dynamic: isDynamic(v), hex })));
  return flatMap(parts, (ps) => {
    const headSize = ps.reduce((n, p) => n + (p.dynamic ? 32 : p.hex.length / 2), 0);
    const [, offsets] = mapAccum(ps, headSize, (tailAt, p) =>
      (p.dynamic ? [tailAt + p.hex.length / 2, padLeft(tailAt.toString(16))] as const : [tailAt, p.hex] as const));
    const tails = ps.filter((p) => p.dynamic).map((p) => p.hex);
    return ok([...offsets, ...tails].join(""));
  });
};

/** `abi.encode(...values)`. */
export const encode = (values: readonly Abi[]): Result<Uint8Array, AbiFault> =>
  flatMap(encodeSequence(values), digitsToBytes);

export type Packed =
  | Tagged<"uint", { bits: UintBits; value: bigint }>
  | Tagged<"bool", { value: boolean }>
  | Tagged<"address" | "bytes32" | "bytes", { value: string }>;

export const P = {
  u32: (value: bigint): Packed => ({ _tag: "uint", bits: 32, value }),
  u256: (value: bigint): Packed => ({ _tag: "uint", bits: 256, value }),
  bool: (value: boolean): Packed => ({ _tag: "bool", value }),
  address: (value: string): Packed => ({ _tag: "address", value }),
  b32: (value: string): Packed => ({ _tag: "bytes32", value }),
  bytes: (value: string): Packed => ({ _tag: "bytes", value }),
} as const;

const packedPart = (p: Packed): Result<Uint8Array, AbiFault> => match(p, {
  uint: (x) => flatMap(uintDigits(x.value, x.bits, x.bits / 4), digitsToBytes),
  bool: (x) => ok(Uint8Array.of(x.value ? 1 : 0)),
  address: (x) => sizedBytes(x.value, "address", 20),
  bytes32: (x) => sizedBytes(x.value, "bytes32", 32),
  bytes: (x) => hexToBytes(x.value),
});

/** `abi.encodePacked(...values)`: each value at its own width, no padding, no offsets. */
export const encodePacked = (values: readonly Packed[]): Result<Uint8Array, AbiFault> =>
  map(traverse(values, packedPart), concat);
