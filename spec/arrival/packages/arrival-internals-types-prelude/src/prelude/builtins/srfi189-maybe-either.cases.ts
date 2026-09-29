// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for SRFI-189 Maybe & Either (srfi189-maybe-either.d.ts) — expect-type
// assertions over the ambient global functions. Maybe/Either are the FAITHFUL tagged-list
// unions  ['just',T]|['nothing']  and  ['left',L]|['right',R]  (written INLINE —
// PRE forbids a top-level Maybe/Either alias). Constructors over WIDENED literal
// inputs thread a LITERAL through their type var, so the literal-returning
// positives are pinned by the PAIR `.toExtend<Brand>()` + `.not.toBeAny()`; where
// the result is an exact brand (callback-typed map results, number-param binds,
// explicit-type-arg swaps, boolean predicates) a single `.toEqualTypeOf<T>()` holds.
//
// ★ Leaf caveats (carried, do not "fix"):
//   • maybe-map / either-map are function-FIRST (f m) / (f e); maybe-bind /
//     either-bind are container-FIRST (m f) / (e f) — impl arg order.
//   • maybe-bind unions the bound result with the passed-through Nothing.
//   • maybe-ref/default and either-ref/default honestly union value | default.
//   • either-swap flips the sides — explicit <L,R> args make the swap observable.
// Base vocab (`List`/`number`/`string`/`boolean`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// constructors keep the tag + payload type (literal through the type var)
expectTypeOf(just(1)).toExtend<["just", number]>();
expectTypeOf(just(1)).not.toBeAny();
expectTypeOf(nothing()).toEqualTypeOf<["nothing"]>();
expectTypeOf(left("err")).toExtend<["left", string]>();
expectTypeOf(left("err")).not.toBeAny();
expectTypeOf(right(42)).toExtend<["right", number]>();
expectTypeOf(right(42)).not.toBeAny();

// tag predicates accept any value, return boolean
expectTypeOf(just$qmark$(just(1))).toEqualTypeOf<boolean>();
expectTypeOf(maybe$qmark$("anything")).toEqualTypeOf<boolean>();
expectTypeOf(right$qmark$(right(1))).toEqualTypeOf<boolean>();

// maybe-map threads the wrapped type through the callback (T → B) → exact brand
expectTypeOf(maybe$dash$map((x: number): string => `${x}`, just(1))).toEqualTypeOf<["just", string] | ["nothing"]>();
// maybe-bind: function returns a Maybe; result unions with Nothing (number bind → exact)
expectTypeOf(maybe$dash$bind(just(1), (x: number) => just(x))).toEqualTypeOf<["just", number] | ["nothing"]>();
// maybe-ref unwraps to the wrapped value type (literal through T)
expectTypeOf(maybe$dash$ref(just(7))).toExtend<number>();
expectTypeOf(maybe$dash$ref(just(7))).not.toBeAny();
// maybe-ref/default honest union of value | default
expectTypeOf(maybe$dash$ref$slash$default(just(7), "fallback")).toExtend<number | string>();
expectTypeOf(maybe$dash$ref$slash$default(just(7), "fallback")).not.toBeAny();
// maybe->either flips into Either with payload preserved
expectTypeOf(maybe$dash$$greater$either(just(1), "no")).toExtend<["right", number] | ["left", string]>();
expectTypeOf(maybe$dash$$greater$either(just(1), "no")).not.toBeAny();
// maybe->list collects to a list of the wrapped type
expectTypeOf(maybe$dash$$greater$list(just(1))).toExtend<List<number>>();
expectTypeOf(maybe$dash$$greater$list(just(1))).not.toBeAny();
// list->maybe wraps the element type (widened list → exact brand)
expectTypeOf(list$dash$$greater$maybe([1, 2, 3])).toEqualTypeOf<["just", number] | ["nothing"]>();
// either-map threads the Right payload through (R → B), Left preserved → exact brand
expectTypeOf(
  either$dash$map((x: number): boolean => x > 0, right(1) as ["left", string] | ["right", number]),
).toEqualTypeOf<["left", string] | ["right", boolean]>();
// either-ref unwraps the Right value type (literal through R)
expectTypeOf(either$dash$ref(right(5))).toExtend<number>();
expectTypeOf(either$dash$ref(right(5))).not.toBeAny();
// either-swap swaps the sides (explicit type args pin L/R so the swap is observable)
expectTypeOf(either$dash$swap<string, number>(left("x"))).toEqualTypeOf<["right", string] | ["left", number]>();
// either->list collects the Right payload (literal through R)
expectTypeOf(either$dash$$greater$list(right(9))).toExtend<List<number>>();
expectTypeOf(either$dash$$greater$list(right(9))).not.toBeAny();

// @ts-expect-error just's payload type is captured: a Just<number> is not assignable to Just<string>
const bad: ["just", string] = just(1);
// @ts-expect-error maybe-map callback param must match the wrapped element type (string param over Just<number>)
maybe$dash$map((x: string): string => x, just(1));
// @ts-expect-error maybe-ref result is the wrapped number, not assignable to string
const w: string = maybe$dash$ref(just(7));
// @ts-expect-error either-map callback must consume the Right payload type (string param over Right<number>)
either$dash$map((x: string): string => x, right(1) as ["left", string] | ["right", number]);
// @ts-expect-error maybe->list returns a list of the wrapped type, not List<string>
const wl: List<string> = maybe$dash$$greater$list(just(1));
