// Reviewer A: tests that kill the mutants of pure/j the PR's own tests let live (PR 114, head 2d6da44a9).
import { describe, expect, test } from "bun:test";
import { assemble } from "../op/assemble.ts";
import { requestKey, type JOp } from "../op/ops.ts";
import { fundedFirst } from "../plan/funded.ts";
import { openJBatch, queue, type JBatch } from "../batch/jbatch.ts";
import { MIN_GAS_BUDGET } from "../batch/sealed.ts";
import {
  ME, LEFT_PEER, RIGHT_PEER, counter, finalize, holdings, reserveToReserve, reveal, settle, start, withdraw,
} from "../fixtures.ts";

const queued = (j: JBatch, ...ops: readonly JOp[]): JBatch =>
  ops.reduce((acc, op) => {
    const outcome = queue(acc, op);
    return outcome._tag === "refused" ? expect.unreachable(JSON.stringify(outcome.fault)) : outcome.jbatch;
  }, j);
const empty = openJBatch(ME, 0n);

describe("every field of a request's key tells two requests apart", () => {
  test("a withdrawal at another nonce, a start in another epoch, a finalize or a counter at another nonce", () => {
    expect(queue(queued(empty, withdraw(LEFT_PEER, 3n, 1n)), withdraw(LEFT_PEER, 3n, 2n))._tag).toBe("queued");
    const s = start(LEFT_PEER, 1n);
    const later = s._tag === "dispute_start" ? { ...s, start: { ...s.start, ondeltaEpoch: 1n } } : s;
    expect(queue(queued(empty, s), later)._tag).toBe("queued");
    expect(requestKey(finalize(LEFT_PEER, 1n))).not.toEqual(requestKey(finalize(LEFT_PEER, 2n)));
    expect(queue(queued(empty, counter(LEFT_PEER, 3n)), counter(LEFT_PEER, 4n))._tag).toBe("queued");
  });
  test("a reveal of another secret is another request, and the key of one reveal is stable", () => {
    expect(queue(queued(empty, reveal(1)), reveal(2))._tag).toBe("queued");
    expect(requestKey(reveal(1))).toEqual(requestKey(reveal(1)));
  });
});

describe("the contract reads each list in the order it was queued", () => {
  test("two starts keep their queue order", () => {
    const batch = assemble(MIN_GAS_BUDGET, [start(LEFT_PEER, 1n), start(RIGHT_PEER, 2n)]);
    expect(batch.disputeStarts.map((d) => d.nonce)).toEqual([1n, 2n]);
  });
});

describe("R-FUNDED a withdrawal's inflow is applied before the settlement it funds", () => {
  test("a settlement that spends what a withdrawal of the same Account pays in is funded in the same batch", () => {
    const plan = fundedFirst(ME, holdings([1n, 0n, 0n]), [withdraw(LEFT_PEER, 5n, 2n), settle(LEFT_PEER, -5n, 3n)]);
    expect(plan.funded.map((op) => op._tag)).toEqual(["collateral_to_reserve", "settle"]);
    expect(plan.waiting).toEqual([]);
  });
});

describe("R-FUNDED a payment that does not fit never blocks the younger ones", () => {
  test("80, 50, 10 against 100: 80 and 10 go, 50 waits", () => {
    const [a, b, c] = [reserveToReserve(80n), reserveToReserve(50n), reserveToReserve(10n)] as const;
    const plan = fundedFirst(ME, holdings([1n, 100n, 0n]), [a, b, c]);
    expect(plan.funded).toEqual([a, c]);
    expect(plan.waiting).toEqual([b]);
  });
});
