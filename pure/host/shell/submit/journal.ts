// The chain journal (R-DURABLE): what the shell has signed and what the chain answered, kept in a file of its own so a
// restart does not make a second deposit. The Runtime asks for every committed chain action again after a crash; the
// journal says which of them are already in a batch that is on its way or landed. A record holds no op, only the rows
// the ops came from (the WAL has them) and the batch's nonce, budget and digest, so the batch is rebuilt from the WAL
// and must come out with the digest that was signed.
//
//   sealed    a batch was signed. It is written, and synced, BEFORE it is sent: a batch that may be on the chain is
//             never one the journal does not know.
//   answered  the chain said what became of it: it landed, or it failed (and spent its nonce).
import { all, flatMap, map, ok, traverse, type Result } from "../../../kernel/core/result.ts";
import type { Tagged } from "../../../kernel/core/tagged.ts";
import type { RowId } from "../../model.ts";
import { bad, big, count, field, record, text, type Fields, type ReadFault } from "../codec/read.ts";
import { scanRecords, type RecordFault } from "../disk/records.ts";
import type { Held } from "../disk/store.ts";

export type Answer = "landed" | "failed";

export type Sealed = Tagged<"sealed", { nonce: bigint; gasBudget: bigint; digest: string; rows: readonly RowId[] }>;
export type Answered = Tagged<"answered", { nonce: bigint; digest: string; outcome: Answer }>;
export type JournalRecord = Sealed | Answered;

const DIGEST = /^0x[0-9a-f]{64}$/;

const digest = (at: string, v: unknown): Result<string, ReadFault> =>
  (typeof v === "string" && DIGEST.test(v) ? ok(v) : bad(at, "digest"));

const outcome = (at: string, v: unknown): Result<Answer, ReadFault> =>
  (v === "landed" || v === "failed" ? ok(v) : bad(at, "landed|failed"));

const rowId = (at: string, v: unknown): Result<RowId, ReadFault> =>
  flatMap(record(at, v, ["height", "index"]), (o) =>
    all({ height: field(at, o, "height", big), index: field(at, o, "index", count) }));

const rowsAt = (at: string, v: unknown): Result<readonly RowId[], ReadFault> =>
  (Array.isArray(v) ? traverse(v, (r, i) => rowId(`${at}[${i}]`, r)) : bad(at, "rows"));

const sealed = (o: Fields): Result<JournalRecord, ReadFault> =>
  map(all({
    nonce: field("$", o, "nonce", big), gasBudget: field("$", o, "gasBudget", big),
    digest: field("$", o, "digest", digest), rows: field("$", o, "rows", rowsAt),
  }), (s): JournalRecord => ({ _tag: "sealed", ...s }));

const answered = (o: Fields): Result<JournalRecord, ReadFault> =>
  map(all({
    nonce: field("$", o, "nonce", big), digest: field("$", o, "digest", digest),
    outcome: field("$", o, "outcome", outcome),
  }), (a): JournalRecord => ({ _tag: "answered", ...a }));

const KEYS: Readonly<Record<string, readonly string[]>> = {
  sealed: ["nonce", "gasBudget", "digest", "rows"], answered: ["nonce", "digest", "outcome"],
};

const tagOf = (value: unknown): Result<string, ReadFault> =>
  (typeof value === "object" && value !== null && "_tag" in value ? text("$._tag", value._tag) : bad("$", "tagged"));

/** What a value in the journal file is: a record of one of the two kinds, with exactly its keys. */
export const journalRecord = (value: unknown): Result<JournalRecord, ReadFault> =>
  flatMap(tagOf(value), (tag) => {
    const keys = Object.hasOwn(KEYS, tag) ? KEYS[tag] : undefined;
    if (keys === undefined) return bad("$._tag", "sealed|answered");
    return flatMap(record("$", value, ["_tag", ...keys]), (o) => (tag === "sealed" ? sealed(o) : answered(o)));
  });

export type JournalFault = RecordFault<ReadFault>;

/** The records a journal file holds, how many bytes of it are whole, and how it ended. */
export const scanJournal = (bytes: Uint8Array): Result<Held<JournalRecord>, JournalFault> =>
  map(scanRecords(bytes, journalRecord), (scanned) => ({ items: scanned.items, valid: scanned.valid }));
