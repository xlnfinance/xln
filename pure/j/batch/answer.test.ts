// What the chain says about a batch the Entity signed, and what it does when the chain says nothing (R-J5, J2).
import { describe, expect, test } from "bun:test";
import { deployment } from "../../chain/proof/deployment.ts";
import { unwrapOr } from "../../kernel/core/result.ts";
import type { JOp } from "../op/ops.ts";
import {
  GAS, ME, LEFT_PEER, RIGHT_PEER, deposit, drive, fund, holdings, reserveToReserve, reveal, settle, start,
} from "../fixtures.ts";
import { abort, landable, observe, type JAnswer } from "./answer.ts";
import { openJBatch, queue, type JBatch, type SealContext } from "./jbatch.ts";
import type { SealedBatch } from "./sealed.ts";

const chain = unwrapOr(deployment(31337n, `0x${"0b".repeat(20)}`), (e) => expect.unreachable(JSON.stringify(e)));
const ctx: SealContext = { deployment: chain, treasury: holdings([1n, 1_000n, 0n]), gas: GAS, answers: [] };

const queued = (j: JBatch, ...ops: readonly JOp[]): JBatch =>
  ops.reduce((acc, op) => {
    const outcome = queue(acc, op);
    return outcome._tag === "refused" ? expect.unreachable(JSON.stringify(outcome.fault)) : outcome.jbatch;
  }, j);

/** Seal what is queued: the Entity in flight with that batch. */
const inflight = (j: JBatch): { jbatch: JBatch; batch: SealedBatch } => {
  const outcome = drive(j, ctx);
  return outcome._tag === "sealed" ? outcome : expect.unreachable(outcome._tag);
};

const landedOf = (batch: SealedBatch, skipped: Extract<JAnswer, { _tag: "landed" }>["skipped"] = []): JAnswer =>
  ({ _tag: "landed", nonce: batch.nonce, batchHash: batch.digest, skipped });
const failedOf = (batch: SealedBatch, reason = "0x00000004"): JAnswer =>
  ({ _tag: "failed", nonce: batch.nonce, reason });

const tags = (ops: readonly JOp[]): readonly string[] => ops.map((op) => op._tag);

describe("observe: a landed batch is done", () => {
  test("the sent batch landing frees the Entity and moves the chain nonce to it", () => {
    const sent = inflight(queued(openJBatch(ME, 6n), deposit(5n)));
    const seen = observe(sent.jbatch, landedOf(sent.batch));
    expect(seen.jbatch.phase).toEqual({ _tag: "idle" });
    expect(seen.jbatch.chainNonce).toBe(7n);
    expect([seen.returned, seen.skipped]).toEqual([[], []]);
  });
  test("a landed deposit is not drafted again: the chain applied it and nothing of it comes back", () => {
    const sent = inflight(queued(openJBatch(ME, 0n), deposit(5n), reserveToReserve(1n)));
    const seen = observe(sent.jbatch, landedOf(sent.batch));
    expect(seen.jbatch.draft.map((op) => op._tag)).toEqual(["reserve_to_reserve"]);
  });
  test("a batch the Entity does not hold only syncs the chain nonce, and the nonce never goes down", () => {
    const j = openJBatch(ME, 6n);
    const foreign = (nonce: bigint): JAnswer =>
      ({ _tag: "landed", nonce, batchHash: `0x${"cd".repeat(32)}`, skipped: [] });
    const up = observe(j, foreign(9n)).jbatch;
    expect(up.chainNonce).toBe(9n);
    expect(observe(up, foreign(8n)).jbatch.chainNonce).toBe(9n);
  });
  test("the event's hash is matched without regard to case", () => {
    const sent = inflight(queued(openJBatch(ME, 0n), deposit(5n)));
    const upper: JAnswer = { _tag: "landed", nonce: sent.batch.nonce, skipped: [],
      batchHash: `0x${sent.batch.digest.slice(2).toUpperCase()}` };
    expect(observe(sent.jbatch, upper).jbatch.phase).toEqual({ _tag: "idle" });
  });
});

describe("J2: a dispute op the chain skipped is told to its Account, and the batch is done all the same", () => {
  test("DisputeOpSkipped names the op by kind, counterparty and nonce", () => {
    const sent = inflight(queued(openJBatch(ME, 0n), start(LEFT_PEER, 4n)));
    const fact = { op: 0, counterentity: LEFT_PEER, reason: 11, nonce: 4n };
    const seen = observe(sent.jbatch, landedOf(sent.batch, [fact]));
    expect(seen.skipped).toEqual([{ op: sent.batch.ops[0] as JOp, reason: 11 }]);
    expect(seen.jbatch.phase).toEqual({ _tag: "idle" });
  });
  test("a skip for another counterparty, nonce or kind is not this op", () => {
    const sent = inflight(queued(openJBatch(ME, 0n), start(LEFT_PEER, 4n)));
    const skip = (op: number, counterentity: string, nonce: bigint) => ({ op, counterentity, reason: 1, nonce });
    const others = [skip(0, RIGHT_PEER, 4n), skip(0, LEFT_PEER, 5n), skip(1, LEFT_PEER, 4n), skip(2, LEFT_PEER, 4n)];
    expect(observe(sent.jbatch, landedOf(sent.batch, others)).skipped).toEqual([]);
  });
});

describe("R-J5: a failed batch applied nothing and spent its nonce", () => {
  test("its payments go back to the front of the draft, in order, and the Entity is free to sign again", () => {
    const first = inflight(queued(openJBatch(ME, 0n), reserveToReserve(1n), reserveToReserve(2n)));
    const newer = queued(first.jbatch, reserveToReserve(3n));
    const seen = observe(newer, failedOf(first.batch));
    expect(seen.jbatch.phase).toEqual({ _tag: "idle" });
    const amounts = seen.jbatch.draft.map((op) => (op._tag === "reserve_to_reserve" ? op.transfer.amount : 0n));
    expect(amounts).toEqual([1n, 2n, 3n]);
    expect(seen.jbatch.chainNonce).toBe(first.batch.nonce);
  });
  test("the next batch is signed above the nonce the failure spent, never at it", () => {
    const first = inflight(queued(openJBatch(ME, 0n), reserveToReserve(1n)));
    const again = drive(observe(first.jbatch, failedOf(first.batch)).jbatch, ctx);
    expect(again._tag === "sealed" && again.batch.nonce).toBe(first.batch.nonce + 1n);
  });
  test("a co-signed op is returned to its Account with the reason: the same signature would fail again", () => {
    const sent = inflight(queued(openJBatch(ME, 0n), settle(LEFT_PEER, -1n), fund(LEFT_PEER, 1n)));
    const seen = observe(sent.jbatch, failedOf(sent.batch, "0x00000004"));
    expect(seen.returned.map((r) => r.op._tag)).toEqual(["settle"]);
    expect(seen.returned[0]?.because).toEqual({ _tag: "batch_failed", reason: "0x00000004" });
    expect(tags(seen.jbatch.draft)).toEqual(["reserve_to_collateral"]);
  });
  test("a settlement returned to its Account is no longer on its way, so it may be asked for again", () => {
    const sent = inflight(queued(openJBatch(ME, 0n), settle(LEFT_PEER, -1n)));
    const seen = observe(sent.jbatch, failedOf(sent.batch));
    expect(queue(seen.jbatch, settle(LEFT_PEER, -1n, 2n))._tag).toBe("queued");
  });
  test("what no longer fits the draft is returned too, never lost and never over the limit (R-J3)", () => {
    const first = inflight(queued(openJBatch(ME, 0n), reserveToReserve(99n)));
    const full = queued(first.jbatch, ...Array.from({ length: 50 }, (_, i) => reserveToReserve(BigInt(i + 1))));
    const seen = observe(full, failedOf(first.batch));
    expect(seen.returned.map((r) => r.because._tag)).toEqual(["draft_full"]);
    expect(seen.jbatch.draft.length).toBe(50);
  });
  test("a failure of a nonce the Entity never signed only syncs the chain nonce", () => {
    const sent = inflight(queued(openJBatch(ME, 0n), deposit(5n)));
    const seen = observe(sent.jbatch, { _tag: "failed", nonce: sent.batch.nonce + 3n, reason: "0x00000001" });
    expect([seen.jbatch.phase._tag, seen.jbatch.chainNonce]).toEqual(["inflight", sent.batch.nonce + 3n]);
  });
  test("BatchGasStarved took no nonce: nothing changes and the same batch is still the one to send", () => {
    const sent = inflight(queued(openJBatch(ME, 0n), reserveToReserve(1n)));
    const seen = observe(sent.jbatch, { _tag: "starved", nonce: sent.batch.nonce });
    expect(seen.jbatch).toEqual(sent.jbatch);
    expect(landable(seen.jbatch)).toEqual({ _tag: "some", value: sent.batch });
  });
});

describe("abort and R-FINAL-NONCE: a batch given up on stays signed and its nonce is never signed again", () => {
  const dispute = (): { jbatch: JBatch; batch: SealedBatch } =>
    inflight(queued(openJBatch(ME, 0n), start(LEFT_PEER, 2n)));

  test("the Entity is free to sign, the batch is kept, and its dispute op is drafted again", () => {
    const sent = dispute();
    const seen = abort(sent.jbatch);
    expect(seen.jbatch.phase).toEqual({ _tag: "idle" });
    expect(seen.jbatch.abandoned).toEqual([sent.batch]);
    expect(tags(seen.jbatch.draft)).toEqual(["dispute_start"]);
  });
  test("a replacement is signed at a fresh nonce above the abandoned one (F1)", () => {
    const sent = dispute();
    const next = drive(abort(sent.jbatch).jbatch, ctx);
    expect(next._tag === "sealed" && next.batch.nonce).toBe(sent.batch.nonce + 1n);
  });
  test("a deposit stays with the abandoned batch: drafting it again would apply it twice if that batch lands", () => {
    const sent = inflight(queued(openJBatch(ME, 0n), deposit(5n)));
    expect(abort(sent.jbatch).jbatch.draft).toEqual([]);
  });
  test("a secret reveal is idempotent on chain and goes back; a payment does not", () => {
    const pay = abort(inflight(queued(openJBatch(ME, 0n), reserveToReserve(1n))).jbatch).jbatch;
    const rev = abort(inflight(queued(openJBatch(ME, 0n), reveal(1))).jbatch).jbatch;
    expect([tags(pay.draft), tags(rev.draft)]).toEqual([[], ["reveal_secret"]]);
  });
  test("when the abandoned batch lands, the copy waiting in the draft is dropped", () => {
    const sent = dispute();
    const seen = observe(abort(sent.jbatch).jbatch, landedOf(sent.batch));
    expect(seen.jbatch.draft).toEqual([]);
    expect(seen.jbatch.abandoned).toEqual([]);
    expect(seen.jbatch.chainNonce).toBe(sent.batch.nonce);
  });
  test("an abandoned request is still on its way: asking for it again is a skip, not a second copy", () => {
    const sent = inflight(queued(openJBatch(ME, 0n), settle(LEFT_PEER, -1n)));
    expect(queue(abort(sent.jbatch).jbatch, settle(LEFT_PEER, -1n))._tag).toBe("skipped");
  });
  test("abort with nothing in flight changes nothing", () => {
    const idle = queued(openJBatch(ME, 0n), deposit(1n));
    expect(abort(idle).jbatch).toEqual(idle);
  });
  test("a failed abandoned batch frees its payments for a fresh nonce just as a sent one does", () => {
    const sent = inflight(queued(openJBatch(ME, 0n), reserveToReserve(1n)));
    const gone = abort(sent.jbatch).jbatch;
    const seen = observe(gone, failedOf(sent.batch));
    expect(seen.jbatch.abandoned).toEqual([]);
    expect(tags(seen.jbatch.draft)).toEqual(["reserve_to_reserve"]);
  });
});

describe("landable: the signed batch the chain accepts next", () => {
  test("the sent batch at the chain's next nonce is the one to resend", () => {
    const sent = inflight(queued(openJBatch(ME, 6n), deposit(1n)));
    expect(landable(sent.jbatch)).toEqual({ _tag: "some", value: sent.batch });
  });
  test("an abandoned batch below the sent one lands first: it is the one to push", () => {
    const first = inflight(queued(openJBatch(ME, 0n), deposit(1n)));
    const second = inflight(queued(abort(first.jbatch).jbatch, deposit(2n)));
    expect(second.batch.nonce).toBe(2n);
    expect(landable(second.jbatch)).toEqual({ _tag: "some", value: first.batch });
    const after = observe(second.jbatch, landedOf(first.batch)).jbatch;
    expect(landable(after)).toEqual({ _tag: "some", value: second.batch });
  });
  test("with nothing signed there is nothing to land", () => {
    expect(landable(openJBatch(ME, 3n))).toEqual({ _tag: "none" });
  });
});
