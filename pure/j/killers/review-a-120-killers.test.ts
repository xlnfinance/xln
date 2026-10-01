// Reviewer A: tests that kill the mutants of PR 120 (head 43a00f5c2) its own tests let live. Belongs in pure/j/.
import { describe, expect, test } from "bun:test";
import { deployment } from "../../chain/proof/deployment.ts";
import { unwrapOr } from "../../kernel/core/result.ts";
import { MIN_GAS_BUDGET } from "../batch/sealed.ts";
import { observe } from "../batch/answer.ts";
import { openJBatch, queue, type JBatch, type SealContext } from "../batch/jbatch.ts";
import { POST_CALL_RESERVE, calldataGas } from "../gas/gas.ts";
import { stepFor, type Gas } from "../gas/simulate.ts";
import { encodedBytes } from "../plan/fit.ts";
import { APPLY_GAS, GAS, ME, LEFT_PEER, counter, drive, holdings, reserveToReserve } from "../fixtures.ts";

const chain = unwrapOr(deployment(31337n, `0x${"0b".repeat(20)}`), (e) => expect.unreachable(JSON.stringify(e)));
const base = { deployment: chain, entity: ME, nonce: 4n };
const ctx: SealContext = { deployment: chain, treasury: holdings([1n, 1_000n, 0n]), gas: GAS, answers: [] };
const ops = [reserveToReserve(1n)];

describe("R-SIMULATE the final simulation is a simulation: a revert at the final budget is never signed", () => {
  test("the probe lands, the batch at the sized budget reverts: held with that reason", () => {
    const probe = stepFor(base, GAS, [], ops);
    if (probe._tag !== "simulate") return expect.unreachable(probe._tag);
    const afterProbe = [{ digest: probe.candidate.digest, outcome: { _tag: "ok", applyGas: APPLY_GAS } } as const];
    const final = stepFor(base, GAS, afterProbe, ops);
    if (final._tag !== "simulate") return expect.unreachable(final._tag);
    expect(final.candidate.gasBudget).not.toBe(probe.candidate.gasBudget);
    const reverted = [...afterProbe, { digest: final.candidate.digest, outcome: { _tag: "reverts", reason: "0x00000004" } } as const];
    expect(stepFor(base, GAS, reverted, ops)).toEqual({ _tag: "hold", why: { _tag: "would_revert", reason: "0x00000004" } });
  });
});

describe("R-SIMULATE the probe's budget bounds: exactly the minimum is a probe, one gas less holds", () => {
  const bytes = encodedBytes(ops);
  const carried = bytes.ok ? calldataGas(bytes.value) : 0n;
  // room = txGasCap - prelude - calldata - reserve; the largest budget is room * 63 / 64 rounded down.
  const capFor = (room: bigint): Gas => ({ prelude: 0n, txGasCap: carried + POST_CALL_RESERVE + room });
  test("room for exactly the minimum budget: the probe is asked", () => {
    const room = (MIN_GAS_BUDGET * 64n + 62n) / 63n;
    expect(stepFor(base, capFor(room), [], ops)._tag).toBe("simulate");
  });
  test("one gas less of room: nothing fits, held", () => {
    const room = (MIN_GAS_BUDGET * 64n + 62n) / 63n - 1n;
    expect(stepFor(base, capFor(room), [], ops)._tag).toBe("hold");
  });
});

describe("answers: a counter skip names the counter kind; a failure never moves the chain nonce down", () => {
  const sent = (j: JBatch) => {
    const out = drive(j, ctx);
    return out._tag === "sealed" ? out : expect.unreachable(out._tag);
  };
  test("a skip of a start at the counter's nonce is not the counter's skip", () => {
    const c = counter(LEFT_PEER, 3n);
    const batch = sent(queueAll(openJBatch(ME, 0n), c));
    const seen = observe(batch.jbatch, { _tag: "landed", nonce: batch.batch.nonce, batchHash: batch.batch.digest,
      skipped: [{ op: 0, counterentity: LEFT_PEER, reason: 1, nonce: 3n }] });
    expect(seen.skipped).toEqual([]);
  });
  test("an old failure arriving late leaves the chain nonce where it was", () => {
    const first = sent(queueAll(openJBatch(ME, 0n), reserveToReserve(1n)));
    const ahead = { ...first.jbatch, chainNonce: 9n };
    const seen = observe(ahead, { _tag: "failed", nonce: first.batch.nonce, reason: "0x00000004" });
    expect(seen.jbatch.chainNonce).toBe(9n);
  });
});

const queueAll = (j: JBatch, ...more: Parameters<typeof queue>[1][]): JBatch =>
  more.reduce((acc, op) => { const o = queue(acc, op); return o._tag === "refused" ? expect.unreachable("refused") : o.jbatch; }, j);
