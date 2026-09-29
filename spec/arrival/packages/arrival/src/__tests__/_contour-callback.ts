/**
 * Test helpers — mint ANativeProcedure callbacks for direct tagless-term calls.
 *
 * W8: bare host functions are not scheme-applicable (`applyCallback` refuses them).
 * Seq-ops (`map`/`filter`/`reduce`) take `ACallable` only; tests that used to pass
 * bare lambdas mint through here instead.
 */
import { ANativeProcedure } from "../values/primitives/ANativeProcedure.js";
import type { CallResult } from "../values/primitives/ACallable.js";
import type { CallCtx } from "../run/CallCtx.js";
import type { SchemeValue } from "../values/types.js";
import { schemeTrue, schemeFalse } from "../values/primitives/ABool.js";

export function contourCallback(
  impl: (args: readonly SchemeValue[], callCtx: CallCtx) => CallResult,
  name = "test-cb",
): ANativeProcedure {
  return new ANativeProcedure({
    name,
    arity: { min: 0, max: null },
    contract: undefined,
    impl,
  });
}

export function unaryContour(f: (x: SchemeValue) => SchemeValue | CallResult, name = "unary-cb"): ANativeProcedure {
  return contourCallback((args) => f(args[0]), name);
}

/** Identity map callback — preserves the element box. */
export const idContour = unaryContour((x) => x, "id");

export const keepAllContour = contourCallback(() => schemeTrue, "keep-all");

export function filterContour(pred: (x: SchemeValue) => boolean, name = "filter-pred"): ANativeProcedure {
  return contourCallback((args) => (pred(args[0]) ? schemeTrue : schemeFalse), name);
}

/** Reduce callback: scheme convention `fn(element, acc)`. Acc may be a host value. */
export function reduceContour<Acc>(f: (element: SchemeValue, acc: Acc) => Acc, name = "reduce-cb"): ANativeProcedure {
  return contourCallback((args) => f(args[0] as SchemeValue, args[1] as Acc) as CallResult, name);
}
