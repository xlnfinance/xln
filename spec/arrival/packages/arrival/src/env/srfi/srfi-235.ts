// SRFI-235 — Combinators. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `base-packs.ts` assembles this pack (via allSrfi), so this module is
// the sole definition site.
//
// DEPS: `compose` (scheme/polyglot), `not` (scheme/equality), `length`/`apply`/
// `append` (scheme/lists), `>=` (scheme/numeric) are every cross-capability free
// name the define bodies below reach — `deps: [equality, numeric, lists, polyglot]`
// below is the complete set, each a declared edge.
//
// The combinators this pack owns:
//   • complement  — SRFI-235: the boolean negation of a predicate.
//   • constantly  — SRFI-235: K combinator (ignore args, return constant).
//   • always      — SRFI-235: ignore args, return #t (NOT constantly).
//   • never       — SRFI-235: ignore args, return #f.
//   • curry       — not SRFI-235; arity-aware partial application + procedure-min-arity.
import { EnvCapability } from "../../common/capability.js";
import dedent from "dedent";
import type { CallCtx } from "../../run/CallCtx.js";
import { is_callable_value } from "../../values/value-guards.js";
import { AExact } from "../../values/primitives/AExact.js";
import polyglot from "../polyglot/polyglot.js";
import equality from "../r7rs/equality.js";
import lists from "../r7rs/lists.js";
import numeric from "../r7rs/numeric.js";

export default EnvCapability.define("scheme/srfi-235", {
  // See the file header's DEPS note. Array order matters beyond readability:
  // this is a C3 merge input, so it must agree with base-packs.ts's tail-block
  // order — `polyglot` leads (it declares deps of its own, and a dependent's
  // linearization always heads with itself), `lists` trails. See base-packs.ts's
  // own header for the full C3 rule.
  deps: [polyglot, equality, numeric, lists],
  symbols: (symbol, z) => ({
    // complement — the boolean negation of fn: (compose not fn). `not` (native, is_false)
    // handles a boxed SchemeBool, and the evaluator unwraps an async generator-lambda
    // result before `not` sees it — so this pure-scheme form needs no JS maybeThen/is_false
    // closure. `compose` is `scheme/polyglot`'s, a declared dep (see the file header).
    complement: symbol.define`complement: SRFI-235 — the boolean negation of fn`(
      {
        input: [z.lambda],
        output: [z.lambda],
        type: dedent`
          {
            <A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => boolean;
          }
        `,
      },
      `(lambda (fn) (compose not fn))`,
    ),

    // constantly — the K combinator: ignore the arguments and always return x. (SRFI-235's
    // `constantly` is variadic over values; arrival only ever uses the single-value form.)
    constantly: symbol.define`constantly: SRFI-235 — the K combinator (ignore args, return the constant x)`(
      {
        input: [z.schemeValue],
        output: [z.lambda],
        type: dedent`
          {
            <T>(x: T): (...args: unknown[]) => T;
          }
        `,
      },
      `(lambda (x) (lambda args x))`,
    ),

    // SRFI-235 always / never — the binding IS the predicate (not a constructor).
    always: symbol.define`always: SRFI-235 — ignore args, return #t`(
      {
        input: [],
        inputRest: z.schemeValue,
        output: [z.boolean],
        type: dedent`
          (...args: unknown[]) => boolean
        `,
      },
      `(lambda args #t)`,
    ),
    never: symbol.define`never: SRFI-235 — ignore args, return #f`(
      {
        input: [],
        inputRest: z.schemeValue,
        output: [z.boolean],
        type: dedent`
          (...args: unknown[]) => boolean
        `,
      },
      `(lambda args #f)`,
    ),

    // curry — arrival's arity-aware partial application (NOT SRFI-235 itself, combinator kin).
    // Accumulates `args` across successive calls until `(length args)` reaches fn's minimum
    // arity (`procedure-min-arity` — the one native this needs; arity introspection off
    // ACallable.arity isn't expressible in pure scheme), then applies. The not-yet-enough-args
    // branch returns a `lambda` — a real ALambda minted through evalLambda, so every recursive
    // partial application is a first-class scheme value with the reverse membrane's guarantees
    // (ctx, trampoline, print repr), not a bare JS closure escaping into value space.
    // `fn` is the fixed head; `args`/`more` are genuinely variadic (`inputRest: z.schemeValue`) —
    // curry's own return is either fn's (arbitrary) result or a new lambda continuation, so
    // the output stays the honest shapeless `z.schemeValue` (a SRFI-235-adjacent polyglot alias,
    // not a fixed-shape procedure — some polyglot aliases ARE genuinely shapeless).
    curry: symbol.define`curry: arrival's arity-aware partial application (combinator kin, not SRFI-235 itself)`(
      {
        input: [z.lambda],
        inputRest: z.schemeValue,
        output: [z.schemeValue],
        type: dedent`
          {
            <A, R>(fn: (a: A) => R): (a: A) => R;
            <A, B, R>(fn: (a: A, b: B) => R): (a: A) => (b: B) => R;
            <A, B, C, R>(fn: (a: A, b: B, c: C) => R): (a: A) => (b: B) => (c: C) => R;
            <R>(fn: (...args: unknown[]) => R, ...args: unknown[]): R | ((...more: unknown[]) => unknown);
          }
        `,
      },
      `(lambda (fn . args)
         (if (>= (length args) (procedure-min-arity fn))
             (apply fn args)
             (lambda more (apply curry fn (append args more)))))`,
    ),

    // `procedure-min-arity` — curry's remaining native: arity introspection off
    // `ACallable.arity`, or JS `Function.length` when the value is a bare host function.
    // No recursion, no invocation — no `this: CallCtx` / runCtx thread.
    "procedure-min-arity":
      symbol.native`procedure-min-arity: the minimum argument count fn accepts (arity introspection for scheme-authored combinators like curry)`(
        {
          input: [z.lambda],
          output: [z.exact],
          type: dedent`
          {
            (fn: (...args: unknown[]) => unknown): number;
          }
        `,
        },
        function (this: CallCtx, fn: unknown): AExact {
          const min = is_callable_value(fn) ? fn.arity.min : (fn as (...args: unknown[]) => unknown).length;
          return new AExact(min);
        },
      ),
  }),
});
