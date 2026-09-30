// Hex text and bytes. A hex string is `0x` and an even number of digits; both cases of a digit read the same, and
// text without the prefix is refused, so a bare 64-digit string is never taken for a bytes32 by accident.
//
// Nothing here throws. Text that is not hex is a value the caller can see: HexFault.
import { bytesToHex as nobleHex, concatBytes, hexToBytes as nobleBytes } from "@noble/hashes/utils";
import { keccak_256 } from "@noble/hashes/sha3";
import { err, ok, type Result } from "../core/result.ts";
import type { Tagged } from "../core/tagged.ts";

export type DigitsFault = Tagged<"odd_length", { digits: number }> | Tagged<"not_hex">;
export type HexFault = Tagged<"no_prefix"> | DigitsFault;

const HEX_DIGITS = /^[0-9a-fA-F]*$/;

export const hexBody = (hex: string): string => (/^0[xX]/.test(hex) ? hex.slice(2) : hex);

/** Bytes from bare hex digits, for text this code built itself. Text from outside goes through `hexToBytes`. */
export const digitsToBytes = (digits: string): Result<Uint8Array, DigitsFault> => {
  switch (true) {
    case !HEX_DIGITS.test(digits): return err({ _tag: "not_hex" });
    case digits.length % 2 !== 0: return err({ _tag: "odd_length", digits: digits.length });
    default: return ok(nobleBytes(digits));
  }
};

export const hexToBytes = (hex: string): Result<Uint8Array, HexFault> => {
  const body = hexBody(hex);
  return body === hex ? err({ _tag: "no_prefix" }) : digitsToBytes(body);
};

/** The big-endian bytes of a non-negative integer with no leading zero byte; zero is the one byte 0x00. */
export const minimalBytes = (value: bigint): Uint8Array => {
  const digits = value.toString(16);
  return nobleBytes(digits.length % 2 === 0 ? digits : `0${digits}`);
};

export const bytesToHex = (bytes: Uint8Array): string => `0x${nobleHex(bytes)}`;

export const concat = (parts: readonly Uint8Array[]): Uint8Array => concatBytes(...parts);

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export const keccak256 = (bytes: Uint8Array): Uint8Array => keccak_256(bytes);

/** keccak256 of the bytes, spelled as a hex string. */
export const keccakHex = (bytes: Uint8Array): string => bytesToHex(keccak256(bytes));
