// Reading ABI bytes with cursors.
//
// A cursor remembers what it points at: the head of a tuple, or the length word of a dynamic array or byte string. A
// head cannot be read as a length word. Reads past the end are zero words, as the EVM's calldata reads are; a caller
// that must refuse a short buffer asks `abiFits` first.
import { bytesToHex } from "./bytes.ts";
import type { Brand } from "./tagged.ts";

/** A cursor at the head of a tuple. */
export type AbiTuple = Brand<number, "AbiTuple">;
/** A cursor at the length word of a dynamic array or byte string. */
export type AbiLength = Brand<number, "AbiLength">;

const tupleAt = (n: number): AbiTuple => n as AbiTuple;
const lengthAt = (n: number): AbiLength => n as AbiLength;
const WORD = 32;

/** The 32-byte word at `at`; bytes past the end of the buffer read as zero. */
export const wordAt = (buf: Uint8Array, at: number): bigint =>
  BigInt(bytesToHex(Uint8Array.from({ length: WORD }, (_, i) => buf[at + i] ?? 0)));

const itemAt = (l: AbiLength, i: number): number => l + WORD + i * WORD;

export const abiRoot = (): AbiTuple => tupleAt(0);
export const abiCursorOk = (h: AbiTuple): boolean => Number.isFinite(h) && h >= 0;
export const abiTupleRef = (buf: Uint8Array, h: AbiTuple, slot: number): AbiTuple =>
  tupleAt(h + Number(wordAt(buf, h + slot)));
export const abiLengthRef = (buf: Uint8Array, h: AbiTuple, slot: number): AbiLength =>
  lengthAt(h + Number(wordAt(buf, h + slot)));
export const abiWord = (buf: Uint8Array, h: AbiTuple, slot: number): bigint => wordAt(buf, h + slot);
export const abiTupleBytes = (buf: Uint8Array, h: AbiTuple, slot: number): Uint8Array =>
  buf.subarray(h + slot, h + slot + WORD);
export const abiLengthWord = (buf: Uint8Array, l: AbiLength): bigint => wordAt(buf, l);
export const abiBytes = (buf: Uint8Array, l: AbiLength): Uint8Array =>
  buf.subarray(l + WORD, l + WORD + Number(wordAt(buf, l)));

/** Whether `count` items of `stride` bytes fit after the length word; none always fit. */
export const abiFits = (buf: Uint8Array, l: AbiLength, count: bigint, stride: number): boolean => {
  if (!Number.isFinite(l) || l < 0) return false;
  const start = l + WORD;
  return start > buf.length ? count === 0n : count * BigInt(stride) <= BigInt(buf.length - start);
};

export const abiBytesElement = (buf: Uint8Array, l: AbiLength, i: number): AbiLength =>
  lengthAt(l + WORD + Number(wordAt(buf, itemAt(l, i))));
export const abiTupleElement = (buf: Uint8Array, l: AbiLength, i: number): AbiTuple =>
  tupleAt(l + WORD + Number(wordAt(buf, itemAt(l, i))));
export const abiInlineTuple = (l: AbiLength, i: number, stride: number): AbiTuple =>
  tupleAt(l + WORD + i * stride);
export const abiStaticWord = (buf: Uint8Array, l: AbiLength, i: number): bigint =>
  wordAt(buf, itemAt(l, i));
export const abiStaticBytes = (buf: Uint8Array, l: AbiLength, i: number): Uint8Array =>
  buf.subarray(itemAt(l, i), itemAt(l, i) + WORD);
