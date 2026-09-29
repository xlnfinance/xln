import { Macro } from "./Macro.js";
import { Syntax } from "./Syntax.js";
import { TF_EXPAND } from "../values/tagless-final.js";
// Leaf value-kernel predicates live in value-guards.ts (no AmbientRuntime/Macro dep)
// so Pair.ts can import them without the evaluator world. Import them from
// value-guards directly — this module is the evaluator-world guards (Macro/Syntax).
import { is_callable_value } from "../values/value-guards.js";

export function is_int(value: unknown): value is number {
  return typeof value === "number" && Number.parseInt(value.toString(), 10) === value;
}

// Syntax does not extend Macro, so both arms are listed (plus SRFI-139
// Syntax.Parameter). The evaluator expand hook narrows on this, then on
// `instanceof Syntax` — see evaluator.ts.
export function is_macro(o: unknown): o is Macro | Syntax {
  return o instanceof Macro || o instanceof Syntax || o instanceof Syntax.Parameter;
}

// Structural RAW-ARG discipline: any head carrying `TF_EXPAND` (a Macro or
// Syntax) — expand-time counterpart to `is_applyable`'s EVAL-ARG `tf("apply")`.
// Dispatch travels with the value's terms, not its class. Syntax.Parameter
// carries no term and is not a call head.
export function is_expandable(o: unknown): o is Macro | Syntax {
  return typeof (o as Record<PropertyKey, unknown> | null | undefined)?.[TF_EXPAND] === "function";
}

// A procedure: a callable VALUE (ALambda / ANativeProcedure / ARosettaProcedure /
// DoorProcedure) or a macro. Bare host functions are not env-resident; foreign
// host fns cross IN via hostFnToCallable as ARosettaProcedure
// (docs/membrane.md §CALLABLE-LENS). is_applyable is the structural call-head
// gate (admits self-applying keywords too).
export function is_callable(o: unknown): boolean {
  return is_macro(o) || is_callable_value(o);
}
