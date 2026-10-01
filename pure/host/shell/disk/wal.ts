// The WAL's rows on a disk (R-DURABLE): records of rows, in row order (records.ts says what a record is and how a tear
// is told from damage). A row is what the Runtime wrote, so a value is a row only when it has a row's own fields; the
// rest of what a row says is judged when `recover` replays it.
import type { Row } from "../../../runtime/model.ts";
import { err, map, ok, type Result } from "../../../kernel/core/result.ts";
import type { Tagged } from "../../../kernel/core/tagged.ts";
import { frame, scanRecords, type RecordFault, type Scanned as Records } from "./records.ts";
import type { ValueFault } from "../codec/value.ts";

export type WalFault = RecordFault<Tagged<"not_a_row">>;

/** The bytes to append for one row. */
export const recordOf = (row: Row): Result<Uint8Array, ValueFault> => frame(row);

const isRow = (v: unknown): v is Row => {
  const row = v as Partial<Record<keyof Row, unknown>> | null;
  const input = row?.input as { _tag?: unknown } | undefined;
  return typeof row === "object" && row !== null && typeof row.height === "bigint" && typeof row.stamp === "bigint"
    && (input?._tag === "entity" || input?._tag === "j_height")
    && Array.isArray(row.outputs) && Array.isArray(row.chain) && Array.isArray(row.notices);
};

const rowOf = (value: unknown): Result<Row, Tagged<"not_a_row">> =>
  (isRow(value) ? ok(value) : err({ _tag: "not_a_row" }));

export type Scanned = Readonly<{ rows: readonly Row[]; valid: number; tail: Records<Row>["tail"] }>;

/** The rows a file holds, how many bytes of it are whole records, and how it ended. */
export const scanWal = (bytes: Uint8Array): Result<Scanned, WalFault> =>
  map(scanRecords(bytes, rowOf), (scanned) => ({ rows: scanned.items, valid: scanned.valid, tail: scanned.tail }));
