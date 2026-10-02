// The submit path as state: a chain effect is taken once however many times the Runtime asks for it, a signed batch
// carries the rows it was made from, and what a restart rebuilds from the journal and the WAL is what was in flight
// (R-DURABLE: a deposit is not made twice; F1: a signed batch is final at its nonce).
import { describe, expect, test } from "bun:test";
import type { JAction } from "../../../entity/model.ts";
import { seal, type JBatch, type SealContext } from "../../../j/batch/jbatch.ts";
import type { SealedBatch } from "../../../j/batch/sealed.ts";
import { unwrapOr } from "../../../kernel/core/result.ts";
import type { Row } from "../../../runtime/model.ts";
import type { RowId } from "../../model.ts";
import { aliceRun, ALICE, BOB, bobRun, DEPLOYED, GAS, TREASURY, walOf, WORLD } from "../fixtures.ts";
import type { JournalRecord } from "./journal.ts";
import { answeredBy, openSubmitter, sealedBy, take, type Chain, type Submitter } from "./submit.ts";

const CHAIN: Chain = { entity: ALICE, deployment: DEPLOYED, world: WORLD, chainNonce: 4n };

const aliceWal = walOf(aliceRun, ALICE);
const askingRow = aliceWal.findLast((row) => row.chain.some((a) => a._tag === "deposit")) as Row;
const deposit = askingRow.chain.find((a) => a._tag === "deposit") as JAction;
const ROW: RowId = { height: askingRow.height, index: askingRow.chain.indexOf(deposit) };
const OTHER: RowId = { height: ROW.height + 1000n, index: 0 };


const fresh = () => unwrapOr(openSubmitter(CHAIN, aliceWal, []), () => expect.unreachable("open"));

const queued = (s: Submitter, row: RowId, action: JAction = deposit): Submitter => {
  const out = take(s, { action, row });
  return out._tag === "queued" ? out.submitter : expect.unreachable(`take ${out._tag}`);
};

/** The builder asks for simulations; the Host answers each at once with room to spare. */
const sealed = (j: JBatch, answers: SealContext["answers"] = []): { jbatch: JBatch; batch: SealedBatch } => {
  const ctx: SealContext = { deployment: DEPLOYED, treasury: TREASURY, gas: GAS, answers };
  const out = seal(j, ctx);
  switch (out._tag) {
    case "sealed": return out;
    case "simulate":
      return sealed(j, [...answers, { digest: out.candidate.digest, outcome: { _tag: "ok", applyGas: 100_000n } }]);
    default: return expect.unreachable(`seal ${out._tag}`);
  }
};

const signedOne = (s: Submitter) => {
  const out = sealed(s.jbatch);
  const done = sealedBy(s, out.jbatch, out.batch);
  return done.ok ? { ...done.value, batch: out.batch } : expect.unreachable("sealedBy");
};

describe("host/shell/submit a chain effect is taken once, whoever asks again", () => {
  test("R-DURABLE a deposit's row is known once queued; another row with the same deposit is another deposit", () => {
    const one = queued(fresh(), ROW);
    expect(take(one, { action: deposit, row: ROW })).toEqual({ _tag: "known" });
    const two = queued(one, OTHER);
    expect(two.jbatch.draft).toHaveLength(2);
  });

  test("a counter, a C2R and a settlement hold signed material the Host lacks: they are named, not guessed", () => {
    const actions: readonly JAction[] = [
      { _tag: "counter", peer: BOB, nonce: 5n, head: `0x${"ab".repeat(32)}` as never },
      { _tag: "c2r", peer: BOB, serial: 1n, token: 1n as never, amount: 3n },
      { _tag: "settle", peer: BOB, serial: 1n, token: 1n as never, amount: 3n, folds: [] },
    ];
    const tags = actions.map((action) => take(fresh(), { action, row: ROW })._tag);
    expect(tags).toEqual(["needs_signature", "needs_signature", "needs_signature"]);
  });
});

describe("host/shell/submit a signed batch carries its rows; the chain's answer closes it", () => {
  test("R-DURABLE the rows of a signed batch are known; the sealed record names them, nonce, budget, digest", () => {
    const { submitter, record, batch } = signedOne(queued(fresh(), ROW));
    const { gasBudget, digest } = batch;
    expect(record).toEqual({ _tag: "sealed", nonce: 5n, gasBudget, digest, rows: [ROW] });
    expect(take(submitter, { action: deposit, row: ROW })).toEqual({ _tag: "known" });
    expect(submitter.jbatch.phase._tag).toBe("inflight");
    expect(submitter.waiting.size).toBe(0);
  });

  test("a landed batch is done and its rows stay known; the journal says it landed", () => {
    const { submitter, batch } = signedOne(queued(fresh(), ROW));
    const closed = answeredBy(submitter, { _tag: "landed", nonce: 5n, batchHash: batch.digest, skipped: [] });
    expect(closed.record).toEqual({ _tag: "answered", nonce: 5n, digest: batch.digest, outcome: "landed" });
    expect(closed.submitter.jbatch.phase._tag).toBe("idle");
    expect(take(closed.submitter, { action: deposit, row: ROW })).toEqual({ _tag: "known" });
  });

  test("R-DURABLE a failed batch spent its nonce and forgot nothing: its work is in the draft at a new nonce", () => {
    const { submitter, batch } = signedOne(queued(fresh(), ROW));
    const closed = answeredBy(submitter, { _tag: "failed", nonce: 5n, reason: "BatchFailed" });
    expect(closed.record).toEqual({ _tag: "answered", nonce: 5n, digest: batch.digest, outcome: "failed" });
    expect(closed.submitter.signed.size).toBe(0);
    expect(closed.submitter.jbatch.draft).toHaveLength(1);
    expect(take(closed.submitter, { action: deposit, row: ROW })).toEqual({ _tag: "known" });
    const again = signedOne(closed.submitter);
    expect(again.record).toMatchObject({ nonce: 6n, rows: [ROW] });
  });

  test("an answer about a batch the Host does not hold writes nothing", () => {
    const closed = answeredBy(fresh(), { _tag: "landed", nonce: 9n, batchHash: `0x${"00".repeat(32)}`, skipped: [] });
    expect(closed.record).toBeUndefined();
    expect(answeredBy(fresh(), { _tag: "failed", nonce: 9n, reason: "x" }).record).toBeUndefined();
  });
});

describe("host/shell/submit a restart rebuilds what was in flight from the journal and the WAL", () => {
  const first = signedOne(queued(fresh(), ROW));
  const sealedRecord = first.record;
  const landed: JournalRecord = { _tag: "answered", nonce: 5n, digest: first.batch.digest, outcome: "landed" };
  const failed: JournalRecord = { _tag: "answered", nonce: 5n, digest: first.batch.digest, outcome: "failed" };

  const reopened = (records: readonly JournalRecord[]) => {
    const opened = openSubmitter(CHAIN, aliceWal, records);
    return opened.ok ? opened.value : expect.unreachable(`open ${opened.error._tag}`);
  };

  test("R-DURABLE a batch signed and not answered is in flight again, byte for byte, and its row is known", () => {
    const back = reopened([sealedRecord]);
    expect(back.jbatch.phase).toEqual({ _tag: "inflight", sent: first.batch });
    expect(back.jbatch.signedMax).toBe(5n);
    expect(take(back, { action: deposit, row: ROW })).toEqual({ _tag: "known" });
  });

  test("R-DURABLE a landed batch is done after a restart and its row is still known: no second deposit", () => {
    const back = reopened([sealedRecord, landed]);
    expect(back.jbatch.phase._tag).toBe("idle");
    expect(back.jbatch.chainNonce).toBe(5n);
    expect(take(back, { action: deposit, row: ROW })).toEqual({ _tag: "known" });
  });

  test("a failed batch is back in the draft after a restart, as in the session, and signs at the next nonce", () => {
    const back = reopened([sealedRecord, failed]);
    expect(back.jbatch.draft).toHaveLength(1);
    expect(signedOne(back).record).toMatchObject({ nonce: 6n, rows: [ROW] });
  });

  describe("a deposit whose first batch failed and was sent again", () => {
    const live = answeredBy(first.submitter, { _tag: "failed", nonce: 5n, reason: "BatchFailed" }).submitter;
    const second = signedOne(live);
    const secondLanded: JournalRecord =
      { _tag: "answered", nonce: 6n, digest: second.batch.digest, outcome: "landed" };
    const history = [sealedRecord, failed, second.record];

    test("the session holds one deposit for the row, in the batch on its way, none in the draft", () => {
      expect(second.submitter.jbatch.draft).toHaveLength(0);
      expect(second.submitter.waiting.size).toBe(0);
    });

    test("R-DURABLE a restart while a failed deposit's second batch is on its way leaves nothing in the draft", () => {
      const back = reopened(history);
      expect(back.jbatch.phase).toEqual({ _tag: "inflight", sent: second.batch });
      expect(back.jbatch.draft).toHaveLength(0);
      expect(back.waiting.size).toBe(0);
      expect(take(back, { action: deposit, row: ROW })).toEqual({ _tag: "known" });
    });

    test("R-DURABLE a restart after a failed deposit's second batch landed makes no second deposit", () => {
      const back = reopened([...history, secondLanded]);
      expect(back.jbatch.phase._tag).toBe("idle");
      expect(back.jbatch.draft).toHaveLength(0);
      expect(back.waiting.size).toBe(0);
      expect(take(back, { action: deposit, row: ROW })).toEqual({ _tag: "known" });
    });
  });

  test("an action nobody journaled is new: the Runtime's ask after the restart queues it", () => {
    const back = reopened([sealedRecord, landed]);
    expect(take(back, { action: deposit, row: OTHER })._tag).toBe("queued");
  });

  test("a journal that does not rebuild is a fault that names why: a changed digest, a lacking row, a non-op", () => {
    expect(openSubmitter(CHAIN, aliceWal, [{ ...sealedRecord, digest: `0x${"11".repeat(32)}` }]))
      .toMatchObject({ ok: false, error: { _tag: "journal_digest", nonce: 5n } });
    expect(openSubmitter(CHAIN, aliceWal, [{ ...sealedRecord, rows: [OTHER] }]))
      .toEqual({ ok: false, error: { _tag: "journal_row", row: OTHER } });
    expect(openSubmitter(CHAIN, [], [sealedRecord])).toMatchObject({ ok: false, error: { _tag: "journal_row" } });
    const bobWal = walOf(bobRun, BOB);
    const reveal = bobWal.findLast((row) => row.chain.length > 0) as Row;
    const revealed = { ...sealedRecord, rows: [{ height: reveal.height, index: 0 }] };
    expect(openSubmitter({ ...CHAIN, entity: BOB }, bobWal, [revealed]))
      .toMatchObject({ ok: false, error: { _tag: "journal_digest" } });
  });
});
