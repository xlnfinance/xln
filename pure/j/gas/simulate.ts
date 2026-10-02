// R-SIMULATE: a batch is signed only after it was simulated at the head, at the budget it will be signed with.
//
// The Host does the simulating (an eth_call is not a value this layer can make) and answers with a `Simulation` of a
// named batch. This file decides what to ask next, from the answers so far, and is a function of them alone, so the
// Host may call it again after every answer:
//   1. a probe at the largest budget the chain's gas cap allows measures the gas of the self-call,
//   2. the budget is that gas plus the margin, and the batch at that budget is simulated again, because an answer that
//      reads `gasleft()` differs by budget (the final simulation is at the final budget),
//   3. only then is the batch signable.
// The transaction pays for the batch's own bytes too (calldata), so the cap is judged on the prelude plus that plus the
// budget: a batch no transaction can carry would stall every batch signed above it (F1).
// A batch over the byte limit or over the chain's transaction gas cap is split, never signed; one that would revert is
// held (a finalize before its gate opens, a paused token), never signed.
import { match, type Tagged } from "../../kernel/core/tagged.ts";
import { sealBatch, MIN_GAS_BUDGET, type SealedBatch, type Sealing, type SealFault } from "../batch/sealed.ts";
import type { JOp } from "../op/ops.ts";
import { encodedBytes } from "../plan/fit.ts";
import { budgetFor, calldataGas, fitsCap, maxBudget } from "./gas.ts";

/**
 * Why a batch did not fully apply, as the chain says it. `error` is the Depository's own error that reverted the call
 * or failed the batch (`E4`, or its four bytes when the Host does not know the name); `skipped` is a dispute op the
 * batch skipped (op and reason are the contract's DISPUTE_OP_* and DISPUTE_SKIP_* codes). The Host decides from these
 * which refusals can heal and which are for good (R-DISPUTE-LAPSED).
 */
export type Cause =
  | Tagged<"error", { name: string }>
  | Tagged<"skipped", { op: number; reason: number }>;

/** What the Host measured for one batch, named by its digest (which holds the nonce, the ops and the budget). */
export type Simulation = Readonly<{
  digest: string;
  outcome: Tagged<"ok", { applyGas: bigint }> | Tagged<"reverts", { reason: string; causes: readonly Cause[] }>;
}>;

/** The chain's transaction gas cap, and what the outer Hanko check of this Entity's board costs before the budget. */
export type Gas = Readonly<{ txGasCap: bigint; prelude: bigint }>;

export type HoldReason =
  | Tagged<"would_revert", { reason: string; causes: readonly Cause[] }>
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

const afterMeasure = (
  base: Base, gas: Gas, carried: Gas, answers: readonly Simulation[], ops: readonly JOp[], applyGas: bigint,
): Step => {
  const budget = budgetFor(applyGas);
  if (!fitsCap(carried.txGasCap, carried.prelude, budget)) return smaller(base, gas, answers, ops, "gas");
  const final = sealBatch({ ...base, gasBudget: budget }, ops);
  if (!final.ok) return hold({ _tag: "unsealable", fault: final.error });
  const answer = answerFor(answers, final.value);
  if (answer === undefined) return { _tag: "simulate", candidate: final.value };
  return match(answer.outcome, {
    reverts: ({ reason, causes }) => hold({ _tag: "would_revert", reason, causes }),
    ok: () => ({ _tag: "sign", candidate: final.value }),
  });
};

/** What to do next for these ops: simulate a named batch, sign one that was simulated, or hold. */
export const stepFor = (base: Base, gas: Gas, answers: readonly Simulation[], ops: readonly JOp[]): Step => {
  const bytes = encodedBytes(ops);
  const carried = bytes.ok ? { ...gas, prelude: gas.prelude + calldataGas(bytes.value) } : gas;
  const probeBudget = maxBudget(carried.txGasCap, carried.prelude);
  if (probeBudget < MIN_GAS_BUDGET) {
    return ops.length > 1
      ? smaller(base, gas, answers, ops, "gas")
      : hold({ _tag: "cap_below_minimum", txGasCap: gas.txGasCap, prelude: carried.prelude });
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
    reverts: ({ reason, causes }) => hold({ _tag: "would_revert", reason, causes }),
    ok: ({ applyGas }) => afterMeasure(base, gas, carried, answers, ops, applyGas),
  });
};
