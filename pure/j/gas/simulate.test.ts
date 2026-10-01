// R-SIMULATE: a batch is signed only after it was simulated at its own budget; too big is split, a revert is held.
import { describe, expect, test } from "bun:test";
import { deployment } from "../../chain/proof/deployment.ts";
import { unwrapOr } from "../../kernel/core/result.ts";
import { sealBatch, MIN_GAS_BUDGET, type SealedBatch } from "../batch/sealed.ts";
import { MAX_ENCODED_BYTES } from "../op/limits.ts";
import type { JOp } from "../op/ops.ts";
import { APPLY_GAS, GAS, ME, RIGHT_PEER, finalize, idOf, reserveToReserve, settle } from "../fixtures.ts";
import { budgetFor, fitsCap, maxBudget, requirement } from "./gas.ts";
import { stepFor, type Simulation, type Step } from "./simulate.ts";

const chain = unwrapOr(deployment(31337n, `0x${"0b".repeat(20)}`), (e) => expect.unreachable(JSON.stringify(e)));
const base = { deployment: chain, entity: ME, nonce: 4n };
const payments = (n: number): readonly JOp[] => Array.from({ length: n }, (_, i) => reserveToReserve(BigInt(i + 1)));

const ok = (digest: string, applyGas = APPLY_GAS): Simulation => ({ digest, outcome: { _tag: "ok", applyGas } });
const reverts = (digest: string, reason = "0xdeadbeef"): Simulation =>
  ({ digest, outcome: { _tag: "reverts", reason } });

const asked = (step: Step): SealedBatch =>
  step._tag === "simulate" ? step.candidate : expect.unreachable(`expected a simulation request, got ${step._tag}`);
const signed = (step: Step): SealedBatch =>
  step._tag === "sign" ? step.candidate : expect.unreachable(`expected a signable batch, got ${step._tag}`);

/** The Host's loop for these ops: answer every request with `answer(candidate)`. */
const settled = (ops: readonly JOp[], answer: (b: SealedBatch) => Simulation, gas = GAS): Step => {
  const go = (answers: readonly Simulation[]): Step => {
    const step = stepFor(base, gas, answers, ops);
    return step._tag === "simulate" ? go([...answers, answer(step.candidate)]) : step;
  };
  return go([]);
};

describe("R-SIMULATE nothing is signed before the Host has answered a simulation of the exact batch", () => {
  const ops = payments(2);
  test("with no answer the first step is a probe at the largest budget the gas cap allows", () => {
    const probe = asked(stepFor(base, GAS, [], ops));
    expect(probe.gasBudget).toBe(maxBudget(GAS.txGasCap, GAS.prelude));
    expect(probe.ops).toEqual(ops);
  });
  test("a successful probe is not enough: the batch is simulated again at the budget it will be signed with", () => {
    const probe = asked(stepFor(base, GAS, [], ops));
    const final = asked(stepFor(base, GAS, [ok(probe.digest)], ops));
    expect(final.gasBudget).toBe(budgetFor(APPLY_GAS));
    expect(final.digest).not.toBe(probe.digest);
  });
  test("it is signable once the final batch simulated, and what is signed is what was simulated", () => {
    const step = settled(ops, (b) => ok(b.digest));
    const final = signed(step);
    expect(final.gasBudget).toBe(budgetFor(APPLY_GAS));
    expect(final.nonce).toBe(base.nonce);
  });
  test("a simulation of another budget, nonce or ops is no simulation of this batch", () => {
    const probe = asked(stepFor(base, GAS, [], ops));
    const final = asked(stepFor(base, GAS, [ok(probe.digest)], ops));
    const digestOf = (nonce: bigint, gasBudget: bigint, those: readonly JOp[]): string =>
      unwrapOr(sealBatch({ ...base, nonce, gasBudget }, those), () => expect.unreachable("sealed")).digest;
    const others = [
      digestOf(base.nonce, final.gasBudget + 1n, ops), digestOf(5n, final.gasBudget, ops),
      digestOf(base.nonce, final.gasBudget, payments(1)),
    ];
    const answers = [ok(probe.digest), ...others.map((digest) => ok(digest))];
    expect(stepFor(base, GAS, answers, ops)).toEqual({ _tag: "simulate", candidate: final });
  });
  test("a probe that reverts stops the batch there: it is held without a second simulation", () => {
    const probe = asked(stepFor(base, GAS, [], ops));
    expect(stepFor(base, GAS, [reverts(probe.digest)], ops)._tag).toBe("hold");
  });
});

describe("R-SIMULATE the final simulation runs at the final budget (a gasleft() reader answers by budget)", () => {
  test("a batch that lands at the probe budget and reverts at the sized one is held, not signed", () => {
    const ops = payments(1);
    const probeBudget = maxBudget(GAS.txGasCap, GAS.prelude);
    const step = settled(ops, (b) => b.gasBudget === probeBudget ? ok(b.digest) : reverts(b.digest, "0x00000004"));
    expect(step).toEqual({ _tag: "hold", why: { _tag: "would_revert", reason: "0x00000004" } });
  });
  test("a batch that reverts at the probe is held with the chain's reason, and nothing is signed", () => {
    const step = settled(payments(1), (b) => reverts(b.digest, "0x00000009"));
    expect(step).toEqual({ _tag: "hold", why: { _tag: "would_revert", reason: "0x00000009" } });
  });
  test("a finalize whose gate is closed reverts in simulation and is never signed (R-SIMULATE, J6)", () => {
    expect(settled([finalize(idOf(2))], (b) => reverts(b.digest, "0x00000002"))._tag).toBe("hold");
  });
});

describe("R-SIMULATE never sign above the chain's transaction gas cap: split instead", () => {
  const heavy = (b: SealedBatch): Simulation => ok(b.digest, 5_000_000n * BigInt(b.ops.length));

  test("a batch whose budget would not fit is halved until it does", () => {
    const final = signed(settled(payments(4), heavy));
    expect(final.ops.length).toBe(2);
    expect(final.gasBudget).toBe(budgetFor(10_000_000n));
    expect(fitsCap(GAS.txGasCap, GAS.prelude, final.gasBudget)).toBe(true);
  });
  test("the half is the front of the draft: oldest first", () => {
    const ops = payments(4);
    expect(signed(settled(ops, heavy)).ops).toEqual(ops.slice(0, 2));
  });
  test("the split is a halving: the larger half is tried first, so few simulations are asked", () => {
    const ops = payments(5);
    const light = (b: SealedBatch): Simulation => ok(b.digest, 3_000_000n * BigInt(b.ops.length));
    expect(signed(settled(ops, light)).ops).toEqual(ops.slice(0, 3));
  });
  test("whatever the cap, a signable batch's transaction fits it", () => {
    [2_000_000n, 5_000_000n, 16_777_216n, 40_000_000n].forEach((txGasCap) => {
      const gas = { txGasCap, prelude: 300_000n };
      const step = settled(payments(6), (b) => ok(b.digest, 700_000n * BigInt(b.ops.length)), gas);
      if (step._tag !== "sign") return expect(step._tag).toBe("hold");
      return expect(requirement(gas.prelude, step.candidate.gasBudget)).toBeLessThanOrEqual(txGasCap);
    });
  });
  test("one op that alone needs more than the cap is held, not signed and not split further", () => {
    const step = settled(payments(1), (b) => ok(b.digest, 20_000_000n));
    expect(step).toEqual({ _tag: "hold", why: { _tag: "one_op_over_limit", limit: "gas" } });
  });
  test("a cap that cannot carry the minimum budget holds everything", () => {
    const gas = { txGasCap: 400_000n, prelude: 100_000n };
    expect(stepFor(base, gas, [], payments(1))).toEqual({
      _tag: "hold", why: { _tag: "cap_below_minimum", txGasCap: 400_000n, prelude: 100_000n },
    });
  });
  test("the budget at the cap itself is allowed: the probe budget is the largest one that fits", () => {
    const step = settled(payments(1), (b) => ok(b.digest, maxBudget(GAS.txGasCap, GAS.prelude) * 10n / 11n));
    expect(step._tag).toBe("sign");
    expect(MIN_GAS_BUDGET <= maxBudget(GAS.txGasCap, GAS.prelude)).toBe(true);
  });
});

describe("the byte limit splits too", () => {
  const big = (sigBytes: number): JOp => {
    const op = settle(RIGHT_PEER, -1n);
    return op._tag === "settle" ? { ...op, settlement: { ...op.settlement, sig: `0x${"ab".repeat(sigBytes)}` } } : op;
  };
  test("two settlements that fit apart and not together go one at a time", () => {
    const half = Math.floor(MAX_ENCODED_BYTES * 0.6);
    const step = settled([big(half), big(half)], (b) => ok(b.digest));
    expect(signed(step).ops.length).toBe(1);
  });
  test("one op above the byte limit is held with that reason", () => {
    const step = settled([big(MAX_ENCODED_BYTES)], (b) => ok(b.digest));
    expect(step).toEqual({ _tag: "hold", why: { _tag: "one_op_over_limit", limit: "bytes" } });
  });
});
