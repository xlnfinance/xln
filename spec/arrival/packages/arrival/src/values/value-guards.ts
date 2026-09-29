// Leaf value-kernel predicates.
//
// Depend ONLY on the value kernel (Pair, Nil, native scalar wrappers) — never on
// AmbientRuntime / Macro / Syntax. Carved out of guards.ts so Pair.ts can import
// without dragging the evaluator world into the value kernel. Import leaf predicates
// from here, not via guards.ts.
//
// The residual Pair ↔ value-guards 2-cycle is intentional and harmless: both live
// inside the values package; ESM resolves it because instanceof is call-time only.
import { AString } from "./primitives/AString.js";
import { AExact } from "./primitives/AExact.js";
import { AInexact } from "./primitives/AInexact.js";
import { ABool } from "./primitives/ABool.js";
import { APair } from "./primitives/APair.js";
import { ANil } from "./primitives/ANil.js";
import { ACharacter } from "./primitives/ACharacter.js";
import { ALambda, DoorProcedure, type ACallable } from "./primitives/ACallable.js";
import { ANativeProcedure } from "./primitives/ANativeProcedure.js";
import { ARosettaProcedure } from "./primitives/ARosettaProcedure.js";
import { tf } from "./tagless-final.js";
// Type-only — erases at compile; no value→eval runtime edge.
import type { Macro } from "../eval/Macro.js";
import type { Syntax } from "../eval/Syntax.js";

export function is_plain_object(object: unknown): object is Record<string, unknown> {
  return object !== null && typeof object === "object" && object.constructor === Object;
}

/**
 * `nil` is the module-load singleton with empty provenance. `nil.withProvenance(p)`
 * mints a FRESH Nil so the singleton's empty set is preserved. Control-flow
 * re-stamping does exactly this when a nil arm carries non-empty provenance, so
 * `=== nil` would silently report false on those clones. Match by class instead.
 */
export function is_nil(value: unknown): value is ANil {
  return value instanceof ANil;
}

export function is_pair(o: unknown): o is APair<any, any> {
  return o instanceof APair;
}

/**
 * Scheme falsiness — ONLY `#f` is falsy (R7RS §6.3): raw JS `false`, JS `null`
 * (membrane's #f sibling), or boxed `ABool(false)`. Everything else — nil, 0, "",
 * empty list — is TRUTHY. Not JS falsiness; `!x` would wrongly treat 0/"" as false.
 */
export function is_false(o: unknown): o is false | null | ABool {
  return o === false || o === null || (o instanceof ABool && o.value === false);
}

export const is_native = (obj: unknown): obj is AString | ACharacter | AExact | AInexact =>
  obj instanceof AString || obj instanceof ACharacter || obj instanceof AExact || obj instanceof AInexact;

/**
 * Macro/Syntax detection without an import edge into the evaluator. Macro / Syntax /
 * Syntax.Parameter each carry `readonly ["arrival/is-macro"] = true` (declared on
 * AValue for the protocol's typing home; none of the three extends AValue). Duck test,
 * not `instanceof`: a forged object would pass — acceptable for the shadow-cone skip
 * (false positive only records a form as macro-headed; never a soundness break).
 */
export function is_macro_value(o: unknown): o is Macro | Syntax {
  if (o === null || (typeof o !== "object" && typeof o !== "function")) return false;
  return (o as { ["arrival/is-macro"]?: unknown })["arrival/is-macro"] === true;
}

// Pure structural predicates — live here so leaf utilities avoid guards.ts → AmbientRuntime.
export function is_function(o: unknown): o is Function {
  return typeof o === "function";
}

/** Thenable test stays in the value kernel; eval/guards only re-exports. */
export function is_promise(o: unknown): o is Promise<unknown> {
  if (o instanceof Promise) {
    return true;
  }
  return !!o && typeof o === "object" && "then" in o && is_function(o.then);
}

// Callable-as-value guards. instanceof is call-time; no init-time cycle.
export function is_lambda(o: unknown): o is ALambda {
  return o instanceof ALambda;
}
export function is_callable_value(o: unknown): o is ACallable {
  return (
    o instanceof ALambda ||
    o instanceof ANativeProcedure ||
    o instanceof ARosettaProcedure ||
    o instanceof DoorProcedure
  );
}

/** Structural, not nominal — admits ANY value answering `arrival/tagless-final/apply`
 *  (e.g. a self-applying keyword `ASymbol`). Used only at call-dispatch gates that must
 *  recognize such values; consumers relying on `ACallable`'s `.arity` stay on `is_callable_value`. */
export function is_applyable(o: unknown): o is ACallable {
  return typeof (o as Record<PropertyKey, unknown> | null | undefined)?.[tf("apply")] === "function";
}

export const has_own_symbol = (obj: unknown, symbol: symbol): boolean =>
  obj !== null && typeof obj === "object" ? Object.hasOwn(obj, symbol) : false;

export function is_iterator(obj: unknown, symbol: symbol): boolean {
  if (obj === null || typeof obj !== "object") return false;
  if (has_own_symbol(obj, symbol) || has_own_symbol(Object.getPrototypeOf(obj), symbol)) {
    return is_function((obj as Record<symbol, unknown>)[symbol]);
  }
  return false;
}
