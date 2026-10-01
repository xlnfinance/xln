// Records on a disk (R-DURABLE): one record per value, `length | text | check`, appended in order. A crash can leave
// the last record cut short or half written, and only the last: records are appended in order and each is synced before
// the next is staged. So the tail of the file is the one place a bad record is a tear, and it is cut off: a record
// that runs past the end of the file, a last record whose check fails, and a file that ends in zeros where a record
// should be. A bad record with more bytes after it is not a tear but a damaged file, and nothing after it is
// believed. That fails closed: a tear that garbles the length of the last record into a shorter one reads as damage,
// and the shell does not start until the file is looked at: dropping a synced record is worse than not starting.
//
//   record  = u32 length (big endian) of the text | 8 bytes of keccak256 over the length (the header check) |
//             the text of the value (value.ts, utf-8) | 8 bytes of keccak256 over the length and the text
//
// The header check is what lets a length be believed: a record that runs past the end of the file is a tear only if
// its header is whole and checks, or the file ends in zeros; a damaged length in the middle of the file fails the
// header check and the file is refused, never read as a short file and cut.
//
// The WAL (wal.ts) and the chain journal (journal.ts) are files of such records; each says what a value is.
import { err, flatMap, mapAccumResult, ok, type Result } from "../../kernel/core/result.ts";
import type { Tagged } from "../../kernel/core/tagged.ts";
import { concat, keccak256, utf8 } from "../../kernel/encoding/bytes.ts";
import { decodeValue, encodeValue, type ValueFault } from "./value.ts";

export type RecordFault<E> =
  | Tagged<"corrupt", { offset: number }>
  | Tagged<"bad_record", { offset: number; fault: ValueFault | E }>;

/** What a file's reader says a value is: the item it holds, or why it is none. */
export type Parse<T, E> = (value: unknown) => Result<T, E>;

const LENGTH = 4;
const CHECK = 8;
const HEADER = LENGTH + CHECK;

const checkOf = (framed: Uint8Array): Uint8Array => keccak256(framed).slice(0, CHECK);

const lengthBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(LENGTH);
  new DataView(bytes.buffer).setUint32(0, length);
  return bytes;
};

const headerOf = (length: number): Uint8Array => {
  const bytes = lengthBytes(length);
  return concat([bytes, checkOf(bytes)]);
};

/** The bytes to append for one value. */
export const frame = (value: unknown): Result<Uint8Array, ValueFault> =>
  flatMap(encodeValue(value), (text) => {
    const body = utf8(text);
    const framed = concat([lengthBytes(body.length), body]);
    return ok(concat([headerOf(body.length), body, checkOf(framed)]));
  });

type Over = "clean" | "torn";

type Read<T> = Tagged<"over", { over: Over }> | Tagged<"item", { item: T; end: number }>;

const itemAt = <T, E>(bytes: Uint8Array, at: number, end: number, parse: Parse<T, E>): Result<T, RecordFault<E>> => {
  const text = new TextDecoder().decode(bytes.subarray(at + HEADER, end - CHECK));
  const value = decodeValue(text);
  if (!value.ok) return err({ _tag: "bad_record", offset: at, fault: value.error });
  const item = parse(value.value);
  return item.ok ? ok(item.value) : err({ _tag: "bad_record", offset: at, fault: item.error });
};

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** A file that grew before its data landed ends in zeros: that is a tear too, whatever the length there claims. */
const unwritten = (bytes: Uint8Array, at: number): boolean => bytes.subarray(at).every((byte) => byte === 0);

const torn = <T, E>(): Result<Read<T>, RecordFault<E>> => ok({ _tag: "over", over: "torn" });

const readAt = <T, E>(bytes: Uint8Array, at: number, parse: Parse<T, E>): Result<Read<T>, RecordFault<E>> => {
  if (at === bytes.length) return ok({ _tag: "over", over: "clean" });
  if (bytes.length - at < HEADER) return torn();
  const length = bytes.subarray(at, at + LENGTH);
  if (!same(checkOf(length), bytes.subarray(at + LENGTH, at + HEADER))) {
    return unwritten(bytes, at) ? torn() : err({ _tag: "corrupt", offset: at });
  }
  const end = at + HEADER + new DataView(length.buffer, length.byteOffset, LENGTH).getUint32(0) + CHECK;
  if (end > bytes.length) return torn();
  const framed = concat([length, bytes.subarray(at + HEADER, end - CHECK)]);
  if (same(checkOf(framed), bytes.subarray(end - CHECK, end))) {
    return flatMap(itemAt(bytes, at, end, parse), (item): Result<Read<T>, RecordFault<E>> =>
      ok({ _tag: "item", item, end }));
  }
  return end === bytes.length ? torn() : err({ _tag: "corrupt", offset: at });
};

/** Where the scan is: the offset of the next record, and how the file ended once it has. */
type Cursor = Readonly<{ at: number; over: Over | undefined }>;

const SLOTS = 1024;
const SLOT_LIST = Array.from({ length: SLOTS }, (_, i) => i);

type Slot<T> = readonly [Cursor, T | undefined];

const step = <T, E>(bytes: Uint8Array, parse: Parse<T, E>) =>
  (cursor: Cursor): Result<Slot<T>, RecordFault<E>> => {
    if (cursor.over !== undefined) return ok([cursor, undefined]);
    return flatMap(readAt(bytes, cursor.at, parse), (read): Result<Slot<T>, RecordFault<E>> =>
      ok(read._tag === "over"
        ? [{ ...cursor, over: read.over }, undefined]
        : [{ at: read.end, over: undefined }, read.item]));
  };

export type Scanned<T> = Readonly<{ items: readonly T[]; valid: number; tail: Over }>;

// Records have no fixed size, so each one's place depends on the one before: a fold per batch of SLOTS records, and one
// call per batch, so a file of a million records is a thousand frames deep, not a million.
const scanFrom = <T, E>(
  bytes: Uint8Array, parse: Parse<T, E>, cursor: Cursor, batches: readonly (readonly T[])[],
): Result<Scanned<T>, RecordFault<E>> => {
  const read = mapAccumResult(SLOT_LIST, cursor, (c) => step(bytes, parse)(c));
  if (!read.ok) return err(read.error);
  const [after, slots] = read.value;
  const kept = [...batches, slots.filter((item): item is T => item !== undefined)];
  return after.over === undefined
    ? scanFrom(bytes, parse, after, kept)
    : ok({ items: kept.flat(), valid: after.at, tail: after.over });
};

/**
 * The items a file holds, how many bytes of it are whole records, and whether it ended cleanly or on a tear. A tear
 * is for the shell to cut off before it appends; a damaged file is a fault and the shell does not start.
 */
export const scanRecords = <T, E>(bytes: Uint8Array, parse: Parse<T, E>): Result<Scanned<T>, RecordFault<E>> =>
  scanFrom(bytes, parse, { at: 0, over: undefined }, []);
