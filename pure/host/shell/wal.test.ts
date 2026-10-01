// The bytes of the WAL: records in order, the tear a crash leaves at the tail cut off, a damaged file refused.
import { describe, expect, test } from "bun:test";
import { ok } from "../../kernel/core/result.ts";
import { concat } from "../../kernel/encoding/bytes.ts";
import type { Row } from "../../runtime/model.ts";
import { aliceRun, ALICE, walOf } from "./fixtures.ts";
import { recordOf, scanWal } from "./wal.ts";

const rows = walOf(aliceRun, ALICE);

const record = (row: Row): Uint8Array => {
  const made = recordOf(row);
  return made.ok ? made.value : expect.unreachable("record");
};

const file = (...of: readonly Row[]): Uint8Array => concat(of.map(record));

const last = rows[rows.length - 1] as Row;
const before = rows.slice(0, -1);
const prior = file(...before);
const final = record(last);

describe("host/shell/wal the rows of a file, and how it ended", () => {
  test("R-DURABLE the rows come back in order from a clean file, and an empty file has none", () => {
    expect(scanWal(file(...rows))).toEqual({ ok: true, value: { rows, valid: file(...rows).length, tail: "clean" } });
    expect(scanWal(new Uint8Array())).toEqual({ ok: true, value: { rows: [], valid: 0, tail: "clean" } });
  });

  test("R-DURABLE a file cut anywhere inside its last record gives the rows before it, and says where they end", () => {
    const cuts = Array.from({ length: final.length - 1 }, (_, i) => i + 1);
    cuts.forEach((cut) => {
      const scanned = scanWal(concat([prior, final.subarray(0, cut)]));
      expect(scanned).toEqual({ ok: true, value: { rows: before, valid: prior.length, tail: "torn" } });
    });
  });

  test("R-DURABLE a last record whole in length but wrong in its bytes is a tear, wherever the bit is", () => {
    const flipped = (at: number) => concat([prior, final.map((byte, i) => (i === at ? byte ^ 1 : byte))]);
    [4, 5, 40, final.length - 9, final.length - 1].forEach((at) => {
      expect(scanWal(flipped(at))).toEqual({ ok: true, value: { rows: before, valid: prior.length, tail: "torn" } });
    });
  });

  test("a file that grew and was never written (zeros where the last record should be) is a tear", () => {
    const zeros = new Uint8Array(final.length);
    const torn = ok({ rows: before, valid: prior.length, tail: "torn" as const });
    expect(scanWal(concat([prior, zeros]))).toEqual(torn);
  });

  test("R-DURABLE a bad record with a record after it is a damaged file: a fault, and no later row is believed", () => {
    const damaged = concat([prior, final.map((byte, i) => (i === 40 ? byte ^ 1 : byte)), record(last)]);
    expect(scanWal(damaged)).toEqual({ ok: false, error: { _tag: "corrupt", offset: prior.length } });
    const early = concat([record(rows[0] as Row).map((byte, i) => (i === 20 ? byte ^ 1 : byte)), prior]);
    expect(scanWal(early)).toMatchObject({ ok: false, error: { _tag: "corrupt", offset: 0 } });
  });

  test("a record whose check holds but whose text is not a row is a fault, not a tear", () => {
    const stray = recordOf(Object.assign({}, last, { height: "not a bigint" }));
    const scanned = stray.ok && scanWal(concat([prior, stray.value]));
    expect(scanned).toMatchObject({ ok: false, error: { _tag: "bad_record" } });
  });

  test("a WAL longer than one batch of records is read through, in order", () => {
    const many = Array.from({ length: 2600 }, (_, i) => ({ ...last, height: BigInt(i) }));
    const scanned = scanWal(file(...many));
    expect(scanned.ok && scanned.value.rows.length).toBe(2600);
    expect(scanned.ok && scanned.value.rows.map((row) => row.height)).toEqual(many.map((row) => row.height));
  });

  test("a row that has no exact text is not written", () => {
    expect(recordOf(Object.assign({}, last, { notices: [new Map()] }))).toMatchObject({ ok: false });
  });
});
