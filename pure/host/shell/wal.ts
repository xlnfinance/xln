// The WAL's bytes (R-DURABLE): one record per row, `length | text | check`, appended in row order. A crash can leave
// the last record cut short or half written, and only the last: records are appended in order and each is synced before
// the next row is staged. So the tail of the file is the one place a bad record is a tear, and it is cut off: a record
// that runs past the end of the file, a last record whose check fails, and a file that ends in zeros where a record
// should be. A bad record with more bytes after it is not a tear but a damaged file, and nothing after it is
// believed. That fails closed: a tear that garbles the length of the last record into a shorter one reads as damage,
// and the shell does not start until the file is looked at, because dropping a synced row is worse than not starting.
//
//   record  = u32 length (big endian) of the text | the text of the row (value.ts, utf-8) | 8 bytes of keccak256 over
//             the length and the text
import type { Row } from "../../runtime/model.ts";
import { err, flatMap, mapAccumResult, ok, type Result } from "../../kernel/core/result.ts";
import type { Tagged } from "../../kernel/core/tagged.ts";
import { concat, keccak256, utf8 } from "../../kernel/encoding/bytes.ts";
import { decodeValue, encodeValue, type ValueFault } from "./value.ts";

export type WalFault =
  | Tagged<"corrupt", { offset: number }>
  | Tagged<"bad_row", { offset: number; fault: ValueFault | Tagged<"not_a_row"> }>;

const HEADER = 4;
const CHECK = 8;

const checkOf = (framed: Uint8Array): Uint8Array => keccak256(framed).slice(0, CHECK);

const lengthBytes = (length: number): Uint8Array => {
  const header = new Uint8Array(HEADER);
  new DataView(header.buffer).setUint32(0, length);
  return header;
};

/** The bytes to append for one row. */
export const recordOf = (row: Row): Result<Uint8Array, ValueFault> =>
  flatMap(encodeValue(row), (text) => {
    const body = utf8(text);
    const framed = concat([lengthBytes(body.length), body]);
    return ok(concat([framed, checkOf(framed)]));
  });

const isRow = (v: unknown): v is Row => {
  const row = v as Partial<Record<keyof Row, unknown>> | null;
  const input = row?.input as { _tag?: unknown } | undefined;
  return typeof row === "object" && row !== null && typeof row.height === "bigint" && typeof row.stamp === "bigint"
    && (input?._tag === "entity" || input?._tag === "j_height")
    && Array.isArray(row.outputs) && Array.isArray(row.chain) && Array.isArray(row.notices);
};

type Over = "clean" | "torn";

type Read = Tagged<"over", { over: Over }> | Tagged<"row", { row: Row; end: number }>;

const rowAt = (bytes: Uint8Array, at: number, end: number): Result<Row, WalFault> => {
  const text = new TextDecoder().decode(bytes.subarray(at + HEADER, end - CHECK));
  const value = decodeValue(text);
  if (!value.ok) return err({ _tag: "bad_row", offset: at, fault: value.error });
  return isRow(value.value) ? ok(value.value) : err({ _tag: "bad_row", offset: at, fault: { _tag: "not_a_row" } });
};

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** A file that grew before its data landed ends in zeros: that is a tear too, whatever the length there claims. */
const unwritten = (bytes: Uint8Array, at: number): boolean => bytes.subarray(at).every((byte) => byte === 0);

const readAt = (bytes: Uint8Array, at: number): Result<Read, WalFault> => {
  if (at === bytes.length) return ok({ _tag: "over", over: "clean" });
  if (bytes.length - at < HEADER) return ok({ _tag: "over", over: "torn" });
  const end = at + HEADER + new DataView(bytes.buffer, bytes.byteOffset + at, HEADER).getUint32(0) + CHECK;
  if (end > bytes.length) return ok({ _tag: "over", over: "torn" });
  if (same(checkOf(bytes.subarray(at, end - CHECK)), bytes.subarray(end - CHECK, end))) {
    return flatMap(rowAt(bytes, at, end), (row): Result<Read, WalFault> => ok({ _tag: "row", row, end }));
  }
  const tail = end === bytes.length || unwritten(bytes, at);
  return tail ? ok({ _tag: "over", over: "torn" }) : err({ _tag: "corrupt", offset: at });
};

/** Where the scan is: the offset of the next record, and how the file ended once it has. */
type Cursor = Readonly<{ at: number; over: Over | undefined }>;

const SLOTS = 1024;
const SLOT_LIST = Array.from({ length: SLOTS }, (_, i) => i);

const step = (bytes: Uint8Array) => (cursor: Cursor): Result<readonly [Cursor, Row | undefined], WalFault> =>
  (cursor.over !== undefined
    ? ok([cursor, undefined])
    : flatMap(readAt(bytes, cursor.at), (read): Result<readonly [Cursor, Row | undefined], WalFault> =>
      ok(read._tag === "over"
        ? [{ ...cursor, over: read.over }, undefined]
        : [{ at: read.end, over: undefined }, read.row])));

export type Scanned = Readonly<{ rows: readonly Row[]; valid: number; tail: Over }>;

// Records have no fixed size, so each one's place depends on the one before: a fold per batch of SLOTS records, and one
// call per batch, so a WAL of a million rows is a thousand frames deep, not a million.
type Batches = readonly (readonly Row[])[];

const scanFrom = (bytes: Uint8Array, cursor: Cursor, batches: Batches): Result<Scanned, WalFault> => {
  const read = mapAccumResult(SLOT_LIST, cursor, (c) => step(bytes)(c));
  if (!read.ok) return err(read.error);
  const [after, slots] = read.value;
  const kept = [...batches, slots.filter((row): row is Row => row !== undefined)];
  return after.over === undefined
    ? scanFrom(bytes, after, kept)
    : ok({ rows: kept.flat(), valid: after.at, tail: after.over });
};

/**
 * The rows a file holds, how many bytes of it are whole records, and whether it ended cleanly or on a tear. A tear is
 * for the shell to cut off before it appends; a damaged file is a fault and the shell does not start.
 */
export const scanWal = (bytes: Uint8Array): Result<Scanned, WalFault> =>
  scanFrom(bytes, { at: 0, over: undefined }, []);
