// The WAL on a disk (R-DURABLE): open it, which cuts a torn tail, and keep one row, which completes only when the
// record is synced. The Host reports a row durable (`persisted`) only from the completion of `keep`; every `send` and
// `chain` effect follows that, so nothing leaves on a row that a crash could still take back.
import type { Row } from "../../runtime/model.ts";
import { flatMap, mapErr, ok, type Result } from "../../kernel/core/result.ts";
import type { Tagged } from "../../kernel/core/tagged.ts";
import type { Disk, DiskFault, DiskOp } from "./disk.ts";
import { recordOf } from "./wal.ts";
import { scanWal, type WalFault } from "./wal.ts";
import type { ValueFault } from "./value.ts";

export type StoreFault = DiskFault | WalFault | Tagged<"unwritable", { fault: ValueFault }>;

/** The operations that make one row durable: its record, then a sync. */
export const appendOps = (row: Row): Result<readonly DiskOp[], ValueFault> =>
  flatMap(recordOf(row), (bytes): Result<readonly DiskOp[], ValueFault> =>
    ok([{ _tag: "write", bytes }, { _tag: "sync" }]));

/** The row is on the medium when this completes with `ok`; on a fault nothing is believed. */
export const keep = (disk: Disk, row: Row): Promise<Result<void, StoreFault>> => {
  const ops = appendOps(row);
  return ops.ok
    ? disk.run(ops.value)
    : Promise.resolve(mapErr(ops, (fault): StoreFault => ({ _tag: "unwritable", fault })));
};

/**
 * The durable rows, in order. A torn tail (the one record a crash can cut) is cut off the file and the cut synced
 * before any row is appended after it; a damaged file is a fault and nothing is read from it.
 */
export const openWal = async (disk: Disk): Promise<Result<readonly Row[], StoreFault>> => {
  const bytes = await disk.read();
  if (!bytes.ok) return bytes;
  const scanned = scanWal(bytes.value);
  if (!scanned.ok) return scanned;
  if (scanned.value.valid === bytes.value.length) return ok(scanned.value.rows);
  const cut = await disk.run([{ _tag: "truncate", length: scanned.value.valid }, { _tag: "sync" }]);
  return cut.ok ? ok(scanned.value.rows) : cut;
};
