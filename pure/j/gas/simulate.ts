// R-SIMULATE: a batch is signed only after it was simulated at the head, at the budget it will be signed with.
//
// The Host does the simulating (an eth_call is not a value this layer can make) and answers with a `Simulation` of a
// named batch. This file decides what to ask next, from the answers so far, and is a function of them alone, so the
// Host may call it again after every answer:
//   1. a probe at the largest budget the chain's gas cap allows measures the gas of the self-call,
//   2. the budget is that gas plus the margin, and the batch at that budget is simulated again, because an answer that
//      reads `gasleft()` differs by budget (the final simulation is at the final budget),
//   3. only then is the batch signable.
// A batch over the byte limit or over the chain's transaction gas cap is split, never signed; one that would revert is
// held (a finalize before its gate opens, a paused token), never signed.
import { match, type Tagged } from "../../kernel/core/tagged.ts";
import { sealBatch, MIN_GAS_BUDGET, type SealedBatch, type Sealing, type SealFault } from "../batch/sealed.ts";
import type { JOp } from "../op/ops.ts";
import { budgetFor, fitsCap, maxBudget } from "./gas.ts";

/** What the Host measured for one batch, named by its digest (which holds the nonce, the ops and the budget). */
export type Simulation = Readonly<{
  digest: string;
  outcome: Tagged<"ok", { applyGas: bigint }> | Tagged<"reverts", { reason: string }>;
}>;

/** The chain's transaction gas cap, and what the outer Hanko check of this Entity's board costs before the budget. */
export type Gas = Readonly<{ txGasCap: bigint; prelude: bigint }>;

export type HoldReason =
  | Tagged<"would_revert", { reason: string }>
  | Tagged<"cap_below_minimum", { txGasCap: bigint; prelude: bigint }>
  | Tagged<"one_op_over_limit", { limit: "bytes" | "gas" }>
  | Tagged<"unsealable", { fault: SealFault }>;

export type Step =
  | Tagged<"simulate", { candidate: SealedBatch }>
  | Tagged<"sign", { candidate: SealedBatch }>
  | Tagged<"hold", { why: HoldReason }>;

type Base = Omit<Sealing, "gasBudget">;

const hold = (why: HoldReason): Step => ({ _tag: "hold", why });

const answerFor = (answers: readonly Simulation[], batch: SealedBatch): Simulation | undefined =>
  answers.find((answer) => answer.digest === batch.digest);

/** A larger batch is split by halving its ops: a prefix of a funded group is funded and stays in one group. */
const smaller = (base: Base, gas: Gas, answers: readonly Simulation[], ops: readonly JOp[], limit: "bytes" | "gas"):
  Step => ops.length > 1
  ? stepFor(base, gas, answers, ops.slice(0, Math.ceil(ops.length / 2)))
  : hold({ _tag: "one_op_over_limit", limit });

const afterMeasure = (base: Base, gas: Gas, answers: readonly Simulation[], ops: readonly JOp[], applyGas: bigint):
  Step => {
  const budget = budgetFor(applyGas);
  if (!fitsCap(gas.txGasCap, gas.prelude, budget)) return smaller(base, gas, answers, ops, "gas");
  const final = sealBatch({ ...base, gasBudget: budget }, ops);
  if (!final.ok) return hold({ _tag: "unsealable", fault: final.error });
  const answer = answerFor(answers, final.value);
  if (answer === undefined) return { _tag: "simulate", candidate: final.value };
  return match(answer.outcome, {
    reverts: ({ reason }) => hold({ _tag: "would_revert", reason }),
    ok: () => ({ _tag: "sign", candidate: final.value }),
  });
};

/** What to do next for these ops: simulate a named batch, sign one that was simulated, or hold. */
export const stepFor = (base: Base, gas: Gas, answers: readonly Simulation[], ops: readonly JOp[]): Step => {
  const probeBudget = maxBudget(gas.txGasCap, gas.prelude);
  if (probeBudget < MIN_GAS_BUDGET) {
    return hold({ _tag: "cap_below_minimum", txGasCap: gas.txGasCap, prelude: gas.prelude });
  }
  const probe = sealBatch({ ...base, gasBudget: probeBudget }, ops);
  if (!probe.ok) {
    return probe.error._tag === "batch_too_large"
      ? smaller(base, gas, answers, ops, "bytes")
      : hold({ _tag: "unsealable", fault: probe.error });
  }
  const answer = answerFor(answers, probe.value);
  if (answer === undefined) return { _tag: "simulate", candidate: probe.value };
  return match(answer.outcome, {
    reverts: ({ reason }) => hold({ _tag: "would_revert", reason }),
    ok: ({ applyGas }) => afterMeasure(base, gas, answers, ops, applyGas),
  });
};
