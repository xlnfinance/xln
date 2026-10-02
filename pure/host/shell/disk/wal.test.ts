// The bytes of the WAL: records in order, the tear a crash leaves at the tail cut off, a damaged file refused.
import { describe, expect, test } from "bun:test";
import { ok } from "../../../kernel/core/result.ts";
import { concat } from "../../../kernel/encoding/bytes.ts";
import { holdOf, secretOf } from "../../../account/fixtures.ts";
import type { Row } from "../../../runtime/model.ts";
import { entityOf, GOLD } from "../../../runtime/fixtures.ts";
import { aliceRun, ALICE, walOf } from "../fixtures.ts";
import { frame } from "./records.ts";
import { scanWal } from "./wal.ts";

const rows = walOf(aliceRun, ALICE);

const record = (row: Row): Uint8Array => {
  const made = frame(row);
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
    [12, 13, 40, final.length - 9, final.length - 1].forEach((at) => {
      expect(scanWal(flipped(at))).toEqual({ ok: true, value: { rows: before, valid: prior.length, tail: "torn" } });
    });
  });

  test("R-DURABLE a bit wrong in a record's header is a damaged file, last record or not: it is never a tear", () => {
    const flipped = (at: number) => concat([prior, final.map((byte, i) => (i === at ? byte ^ 1 : byte))]);
    Array.from({ length: 12 }, (_, at) => at).forEach((at) => {
      expect(scanWal(flipped(at))).toMatchObject({ ok: false, error: { _tag: "corrupt", offset: prior.length } });
    });
  });

  test("R-DURABLE a length garbled to run past the file in a MIDDLE record is damage: no record is cut", () => {
    const [first, second, third] = rows.slice(-3).map(record);
    const huge = concat([Uint8Array.of(0x7f, 0xff, 0xff, 0xff), (second as Uint8Array).slice(4)]);
    const file = concat([first as Uint8Array, huge, third as Uint8Array]);
    const offset = (first as Uint8Array).length;
    expect(scanWal(file)).toMatchObject({ ok: false, error: { _tag: "corrupt", offset } });
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
    const stray = frame(Object.assign({}, last, { height: "not a bigint" }));
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
    expect(frame(Object.assign({}, last, { notices: [new Map()] }))).toMatchObject({ ok: false });
  });
  test("R-LOCK-ROUTE a row that holds a lock with a route and the paybook's commands comes back unchanged", () => {
    const hashlock = `0x${"cd".repeat(32)}`;
    const inputs = [
      { _tag: "lock", peer: ALICE, token: GOLD, hold: holdOf("left", 30n, 1n, 115n, 1), route: [ALICE, entityOf(3)] },
      { _tag: "forward", hashlock, from: ALICE, to: entityOf(3) },
      { _tag: "expect", hashlock, from: ALICE, token: GOLD, amount: 7n, secret: secretOf(1) },
    ];
    const routed = Object.assign({}, last, { input: { _tag: "entity", at: 5n, to: ALICE, inputs } });
    expect(scanWal(file(routed as Row))).toMatchObject({ ok: true, value: { rows: [routed], tail: "clean" } });
  });
});
