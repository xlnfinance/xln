// A file of records on a disk (R-DURABLE): open it, which cuts a torn tail, and keep one record, which completes only
// when the record is synced. The Host reports a row durable (`persisted`) only from the completion of `keep`; every
// `send` and `chain` effect follows that, so nothing leaves on a row that a crash could still take back. The WAL and
// the chain journal are such files.
import type { Row } from "../../runtime/model.ts";
import { flatMap, map, mapErr, ok, type Result } from "../../kernel/core/result.ts";
import type { Tagged } from "../../kernel/core/tagged.ts";
import type { Disk, DiskFault, DiskOp } from "./disk.ts";
import { frame } from "./records.ts";
import { scanWal, type WalFault } from "./wal.ts";
import type { ValueFault } from "./value.ts";

export type Unwritable = Tagged<"unwritable", { fault: ValueFault }>;

export type StoreFault = DiskFault | WalFault | Unwritable;

/** The operations that make one record durable: its bytes, then a sync. */
export const appendOps = (item: unknown): Result<readonly DiskOp[], ValueFault> =>
  flatMap(frame(item), (bytes): Result<readonly DiskOp[], ValueFault> =>
    ok([{ _tag: "write", bytes }, { _tag: "sync" }]));

/** The record is on the medium when this completes with `ok`; on a fault nothing is believed. */
export const keep = (disk: Disk, item: unknown): Promise<Result<void, DiskFault | Unwritable>> => {
  const ops = appendOps(item);
  return ops.ok
    ? disk.run(ops.value)
    : Promise.resolve(mapErr(ops, (fault): Unwritable => ({ _tag: "unwritable", fault })));
};

/** What a file's scan says it holds: the items, and how many bytes of the file are whole records. */
export type Held<T> = Readonly<{ items: readonly T[]; valid: number }>;

/**
 * The durable items, in order. A torn tail (the one record a crash can cut) is cut off the file and the cut synced
 * before any record is appended after it; a damaged file is a fault and nothing is read from it.
 */
export const openRecords = async <T, E>(
  disk: Disk, scan: (bytes: Uint8Array) => Result<Held<T>, E>,
): Promise<Result<readonly T[], DiskFault | E>> => {
  const bytes = await disk.read();
  if (!bytes.ok) return bytes;
  const held = scan(bytes.value);
  if (!held.ok) return held;
  if (held.value.valid === bytes.value.length) return ok(held.value.items);
  const cut = await disk.run([{ _tag: "truncate", length: held.value.valid }, { _tag: "sync" }]);
  return cut.ok ? ok(held.value.items) : cut;
};

/** The durable rows of a WAL, in order. */
export const openWal = (disk: Disk): Promise<Result<readonly Row[], StoreFault>> =>
  openRecords(disk, (bytes) => map(scanWal(bytes), (scanned) => ({ items: scanned.rows, valid: scanned.valid })));
