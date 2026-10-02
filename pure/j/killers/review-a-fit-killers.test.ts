// Reviewer A: tests that kill the fit.ts mutants the PR's own tests let live (PR 114, head 533895352).
import { describe, expect, test } from "bun:test";
import { openJBatch, queue, type JBatch } from "../batch/jbatch.ts";
import { MAX_ENCODED_BYTES } from "../op/limits.ts";
import type { JOp } from "../op/ops.ts";
import { encodedBytes } from "../plan/fit.ts";
import { ME, LEFT_PEER, RIGHT_PEER, bigStart, idOf, reserveToReserve, settle } from "../fixtures.ts";

const queued = (j: JBatch, ...ops: readonly JOp[]): JBatch =>
  ops.reduce((acc, op) => {
    const outcome = queue(acc, op);
    return outcome._tag === "refused" ? expect.unreachable(JSON.stringify(outcome.fault)) : outcome.jbatch;
  }, j);
const empty = openJBatch(ME, 0n);

describe("R-J3 every group of the draft is judged, not the first or the last", () => {
  test("a too-large urgent group is refused while a finalize group comes first and a soft group last", () => {
    const j = queued(empty, reserveToReserve(1n, RIGHT_PEER), bigStart(LEFT_PEER, 1n, 140));
    // finalize-free draft: groups are [urgent starts], [soft]. A third group (a deposit leg) sits after them.
    const refused = queue(j, bigStart(RIGHT_PEER, 1n, 140));
    expect(refused._tag).toBe("refused");
  });
  test("a group in the middle: four co-signed Accounts, the second one over the per-kind limit", () => {
    const j = queued(empty, ...[idOf(2), idOf(3), idOf(4), idOf(6)].map((p) => settle(p, 0n, 1n)));
    const full = queued(j, ...Array.from({ length: 31 }, (_, i) => settle(idOf(3), 0n, BigInt(i + 2))));
    expect(queue(full, settle(idOf(3), 0n, 40n))._tag).toBe("refused");
  });
});

describe("R-J3 the size limit is inclusive: exactly 256 KiB is one batch, 32 bytes more is not", () => {
  const sized = (kib: number): JOp => bigStart(LEFT_PEER, 1n, kib);
  const clauseBytes = (n: number): JOp => {
    const op = sized(0);
    if (op._tag !== "dispute_start") return op;
    const clause = { transformerAddress: `0x${"22".repeat(20)}`, encodedBatch: `0x${"ab".repeat(n)}`, allowances: [] };
    const initialProofbody = { ...op.start.initialProofbody, transformers: [clause] };
    return { ...op, start: { ...op.start, initialProofbody } };
  };
  const size = (n: number): number => {
    const r = encodedBytes([clauseBytes(n)]);
    return r.ok ? r.value : expect.unreachable("encode");
  };
  test("find the clause size whose batch is exactly the limit", () => {
    // Each size is an ABI encoding of about 256 KiB, so the clause size is corrected by what is missing, four encodings
    // at most, not found by trying a couple of hundred sizes (which took seconds on a loaded machine).
    const mend = (m: number): number => m + MAX_ENCODED_BYTES - size(m);
    const n = Array.from({ length: 4 }).reduce<number>((m) => mend(m), MAX_ENCODED_BYTES - size(0));
    expect(size(n)).toBe(MAX_ENCODED_BYTES);
    expect(queue(empty, clauseBytes(n))._tag).toBe("queued");
    expect(size(n + 32)).toBe(MAX_ENCODED_BYTES + 32);
    expect(queue(empty, clauseBytes(n + 32))._tag).toBe("refused");
  });
});
