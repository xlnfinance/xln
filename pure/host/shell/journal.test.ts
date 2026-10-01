// The chain journal's records as the file holds them: a sealed batch and an answer come back as written, a record that
// is not exactly one of the two is refused with the path that is wrong, and a tear at the tail is cut (R-DURABLE).
import { describe, expect, test } from "bun:test";
import { concat } from "../../kernel/encoding/bytes.ts";
import { frame } from "./records.ts";
import { journalRecord, scanJournal, type JournalRecord } from "./journal.ts";

const DIGEST = `0x${"ab".repeat(32)}`;
const SEALED: JournalRecord = {
  _tag: "sealed", nonce: 5n, gasBudget: 500_000n, digest: DIGEST,
  rows: [{ height: 7n, index: 0 }, { height: 9n, index: 2 }],
};
const ANSWERED: JournalRecord = { _tag: "answered", nonce: 5n, digest: DIGEST, outcome: "landed" };

const bytesOf = (...records: readonly unknown[]): Uint8Array =>
  concat(records.map((r) => {
    const framed = frame(r);
    return framed.ok ? framed.value : expect.unreachable("frame");
  }));

describe("host/shell/journal what the journal file says was signed and what the chain answered", () => {
  test("R-DURABLE a sealed record and an answer come back as written, in order, from a clean file", () => {
    const file = bytesOf(SEALED, ANSWERED);
    expect(scanJournal(file)).toEqual({ ok: true, value: { items: [SEALED, ANSWERED], valid: file.length } });
  });

  test("R-DURABLE a file cut inside its last record gives the records before it", () => {
    const whole = bytesOf(SEALED, ANSWERED);
    const first = bytesOf(SEALED).length;
    const cuts = Array.from({ length: whole.length - first - 1 }, (_, i) => first + i + 1);
    const seen = cuts.map((cut) => scanJournal(whole.slice(0, cut)));
    expect(seen.every((s) => s.ok && s.value.items.length === 1 && s.value.valid === first)).toBe(true);
  });

  test("a record with an unknown tag, a missing or extra key, or a bad digest is refused, with where", () => {
    const refused = (value: unknown) => journalRecord(value);
    expect(refused({ _tag: "paid" })).toMatchObject({ ok: false });
    ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"].forEach((tag) => {
      expect(refused({ _tag: tag })).toMatchObject({ ok: false, error: { at: "$._tag" } });
    });
    expect(refused({ ...ANSWERED, outcome: "pending" })).toMatchObject({ ok: false, error: { at: "$.outcome" } });
    expect(refused({ ...ANSWERED, digest: "0x12" })).toMatchObject({ ok: false, error: { at: "$.digest" } });
    expect(refused({ ...SEALED, extra: 1n })).toMatchObject({ ok: false });
    expect(refused({ _tag: "sealed", nonce: 5n, digest: DIGEST, rows: [] })).toMatchObject({ ok: false });
    expect(refused({ ...SEALED, rows: [{ height: 7n }] })).toMatchObject({ ok: false });
    expect(refused({ ...SEALED, rows: "all" })).toMatchObject({ ok: false, error: { at: "$.rows" } });
  });

  test("R-DURABLE a bad record that has bytes after it is a damaged journal, not a tear", () => {
    const bad = bytesOf({ _tag: "paid" });
    expect(scanJournal(concat([bad, bytesOf(SEALED)]))).toMatchObject({ ok: false, error: { _tag: "bad_record" } });
  });
});
