/**
 * Equality / identity predicates pack: the R7RS equivalence-and-identity
 * predicates — `boolean=?` and `symbol=?` (typed equivalence over the boxed
 * boolean/symbol towers), `equal?` (structural recursion delegated to
 * `structuralEqual`, the single representation-blind equality home), and the
 * `procedure?` type predicate.
 *
 * Each op declares a zod contract and an impl working on the contract's SCHEME
 * face (`Impl<…,"scheme">`): a `z.boolean` output demands an ABool, so every
 * predicate returns the shared `schemeTrue`/`schemeFalse` FLYWEIGHTS (eq?-stable,
 * empty-provenance; `structuralEqual` treats them identically). Inputs stay
 * REPRESENTATION-BLIND by design (a boxed SchemeBool/SchemeSymbol OR a raw JS
 * value that arrived via rosetta unwrapping — see laws/equality.law.test.ts),
 * so the honest input term is `z.schemeValue`.
 *
 * ALSO HOLDS the R7RS TYPE predicates `string?` / `pair?` / `null?` / `boolean?` /
 * `symbol?` / `list?` — the value-domain-agnostic type tests (a string/pair/symbol
 * test belongs with `procedure?`, not in any one cluster). `list?` inlines the
 * proper-list-with-cycle-detection walk over the canonical `is_pair`/`is_nil`/
 * `isCircularList` primitives. (`number?`/`real?` stay OUT — the numbers pack
 * already binds them.)
 */

import { AJSArray } from "../../membrane/AJSArray.js";
import { strictGate } from "../../errors.js";
import dedent from "dedent";
import { withContractFields } from "../../common/symbols/_bake.js";
import type { CallCtx } from "../../run/CallCtx.js";
import { ABool, schemeFalse, schemeTrue } from "../../values/primitives/ABool.js";
import { AJSObject } from "../../membrane/AJSObject.js";
import { ADict } from "../../values/primitives/ADict.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { eq, eqv, structuralEqual } from "../../values/structural-equal.js";
import { EnvCapability } from "../../common/capability.js";
import { is_false } from "../../values/value-guards.js";
import { is_callable, is_macro } from "../../eval/guards.js";
import { ANil } from "../../values/primitives/ANil.js";
import { AString } from "../../values/primitives/AString.js";
import { APair, isCircularList } from "../../values/primitives/APair.js";
import { schemeBool as bool, mintVerdict, stringValue, withInputProvenance } from "../../values/op-helpers.js";
import { printValue } from "../../values/print.js";
import { SchemeValue } from "../../values/types.js";
// TYPE-ONLY import of the compiler-facing Contract.emit surface.
import type { EmitCtx, EmitRule } from "../../emit/emit-rule.js";
import { Bin, Call, Lit, Member, Un, type R } from "../../emit/residual-lite.js";

// ════════════════════════════════════════════════════════════════════════════
// Contract.emit — not / null? / pair? / equal?
// Residual selection keys on ARGUMENT facts (Law A), never result types or syntax.
//
// null?/pair? carry the FULL Law-N package: `emit` + `narrows` + `refPolicy` travel
// together on the harvested row (narrowsMembersOf reads them capability-agnostic).
// pair? is tagless-guard — those fields land via declaration-site object-spread.
// ════════════════════════════════════════════════════════════════════════════

/** Fixed-arity refusal: wrong arity → `ctx.door`, not a walker crash on undefined. */
function exactly<T>(ctx: EmitCtx<R>, sym: string, args: readonly T[], n: number): readonly T[] {
  if (args.length !== n) ctx.door(`\`${sym}\` wants exactly ${n} argument${n === 1 ? "" : "s"}, got ${args.length}`);
  return args;
}

// ─── Law T: not ────────────────────────────────────────────────────────────────────
// `!c` when operand is provably boolean (or read-register); else `c === false`
// (Scheme truthiness — only #f is false; 0/"" are truthy).
const notEmitRule: EmitRule<R> = {
  call: (args, ctx) => {
    const [c] = exactly(ctx, "not", args, 1);
    return ctx.config.register === "read" || ctx.argFacts[0]?.boolean === true
      ? Un("!", c!)
      : Bin("===", c!, Lit(false));
  },
};

// ─── null? / pair? — fact-gated .length, Law-N self-witnessed ──────────────────────
// TOTAL over ANY value — bare `.length` is wrong-code: `(null? "")` would be true
// (strings carry .length). Clean form only when argFacts PROVE array representation;
// unproven → runtime shim (Array.isArray).
const provesArray = (f: { list?: true; pair?: true; nonEmptyList?: true } | undefined): boolean =>
  f?.list === true || f?.pair === true || f?.nonEmptyList === true;

const nullQEmitRule: EmitRule<R> = {
  call: (args, ctx) => {
    const [xs] = exactly(ctx, "null?", args, 1);
    return provesArray(ctx.argFacts[0]) ? Bin("===", Member(xs!, "length"), Lit(0)) : Call(ctx.runtime("null?"), [xs!]);
  },
};

const pairQEmitRule: EmitRule<R> = {
  call: (args, ctx) => {
    const [xs] = exactly(ctx, "pair?", args, 1);
    return provesArray(ctx.argFacts[0]) ? Bin(">", Member(xs!, "length"), Lit(0)) : Call(ctx.runtime("pair?"), [xs!]);
  },
};

// ── equal? — primitive-proven gate (Law A) ─────────────────────────────────────────
// Deep structural equality, not ===. For compounds, === is reference identity and
// wrongly says #f for `(equal? '(1) '(1))`. So === is NEVER residual when BOTH sides
// could be compound.
//
// When EITHER side proves bare JS primitive (numeric/stringy/boolean), === agrees with
// equal? for any other side: a primitive only equal?-matches same type+value, and
// never a compound. Check is deliberately asymmetric (`||`, not `&&`).
// Both unproven → structuralEqual shim (collapsing to === flips distinct-but-equal
// compounds to #f).
const provesPrimitive = (f: { numeric?: true; stringy?: true; boolean?: true } | undefined): boolean =>
  f?.numeric === true || f?.stringy === true || f?.boolean === true;

const equalQEmitRule: EmitRule<R> = {
  call: (args, ctx) => {
    const [a, b] = exactly(ctx, "equal?", args, 2);
    return provesPrimitive(ctx.argFacts[0]) || provesPrimitive(ctx.argFacts[1])
      ? Bin("===", a!, b!)
      : Call(ctx.runtime("equal?"), [a!, b!]);
  },
};

export default EnvCapability.define("scheme/equality", {
  symbols: (symbol, z) => ({
    // R7RS 6.3 Booleans
    "boolean=?": symbol.native`boolean=?: typed equivalence over booleans`(
      // z.schemeValue BY DESIGN: unwrap accepts raw JS boolean OR boxed ABool.
      // z.boolean would reject the raw half. Output is always ABool flyweight.
      { input: [], inputRest: z.schemeValue, output: [z.boolean] },
      function (this: CallCtx, ...bools) {
        if (bools.length < 2) return schemeTrue;
        // Representation-blind: raw JS boolean OR boxed ABool (rosetta membrane).
        const unwrap = (b: SchemeValue): boolean | undefined => {
          if (typeof b === "boolean") return b;
          if (b instanceof ABool) return b.value;
          return undefined;
        };
        const first = unwrap(bools[0]);
        if (first === undefined) return schemeFalse;
        return new ABool(bools.every((b) => unwrap(b) === first));
      },
    ),

    // R7RS 6.5 — NOT representation-blind: only ASymbol (no plain-JS symbol codec).
    "symbol=?": symbol.native`symbol=?: typed equivalence over symbols`(
      { input: [z.symbol, z.symbol], inputRest: z.symbol, output: [z.boolean] },
      function (this: CallCtx, ...syms) {
        if (syms.length < 2) return schemeTrue;
        const first = syms[0];
        if (!(first instanceof ASymbol)) return schemeFalse;
        const firstName = first.__name__;
        return new ABool(syms.every((s) => s instanceof ASymbol && s.__name__ === firstName));
      },
    ),

    // R7RS 6.5 — symbol/string conversion. NATIVE (below the membrane): they touch the
    // SchemeSymbol host type directly, so they join symbol=? here.
    // Provenance PLUMBING: forward the input's provenance via withInputProvenance, never mint.
    "symbol->string": symbol.native`symbol->string: the symbol's name as a string`(
      { input: [z.symbol], output: [z.string] },
      function (s) {
        const name = s.__name__;
        const str = typeof name === "string" ? name : (name as symbol).toString();
        return withInputProvenance([s], new AString(str));
      },
    ),
    "string->symbol": symbol.native`string->symbol: a symbol whose name is the string's characters`(
      { input: [z.string], output: [z.symbol] },
      function (s) {
        // deferred: ASymbol interns into the permanent global table (no per-run ctx on
        // AValue) — `(string->symbol unique)` mint-loops grow unbounded until ambient
        // run-context restores per-run scoping.
        return withInputProvenance([s], new ASymbol(stringValue(s)));
      },
    ),

    "procedure?": symbol.native`procedure?: callable, excluding macros`(
      {
        input: [z.schemeValue],
        output: [z.boolean],
        type: dedent`
          {
            (x: unknown): x is (...args: unknown[]) => unknown;
            <T>(x: T): x is Extract<T, (...args: unknown[]) => unknown>;
          }
        `,
      },
      // Callable excluding macros — includes membrane SchemeJSFunction (typeof "object").
      function (this: CallCtx, obj) {
        return new ABool(is_callable(obj) && !is_macro(obj));
      },
    ),

    // value→string print protocol (values/print.ts). deferred: 2-arg write-mode form.
    repr: symbol.native`repr: render a value to its external representation string`(
      { input: [z.schemeValue], output: [z.string] },
      function (this: CallCtx, obj) {
        return new AString(printValue(obj));
      },
    ),

    // R8 mint (RULINGS.md R8): lineage-derived verdict carries stamped operands' union;
    // provenance-free path uses bool's shared flyweight.
    "equal?": symbol.native`equal?: representation-blind structural equality`(
      { input: [z.schemeValue, z.schemeValue], output: [z.boolean], emit: equalQEmitRule },
      function (this: CallCtx, a, b) {
        return mintVerdict([a, b], structuralEqual(a, b));
      },
    ),

    // R7RS 6.1 — pointer/scalar identity; both delegate to structural-equal.ts.
    "eq?": symbol.native`eq?: pointer/scalar-grade identity`(
      { input: [z.schemeValue, z.schemeValue], output: [z.boolean] },
      function (this: CallCtx, x, y) {
        return mintVerdict([x, y], eq(x, y));
      },
    ),

    "eqv?": symbol.native`eqv?: eq? plus explicit number/char equality`(
      { input: [z.schemeValue, z.schemeValue], output: [z.boolean] },
      function (this: CallCtx, x, y) {
        return mintVerdict([x, y], eqv(x, y));
      },
    ),

    // R7RS 6.3 — only #f is falsy; is_false (not `!value` — ABool is truthy in JS).
    not: symbol.native`not: #t iff value is #f (the only scheme-falsy)`(
      { input: [z.schemeValue], output: [z.boolean], emit: notEmitRule },
      function (this: CallCtx, value) {
        return bool(is_false(value));
      },
    ),

    // ── R7RS type predicates ──────────────────────────────────────────────────
    // Runtime: representation-blind (boxed AValue OR raw membrane value).
    // Harvest: dual type-guards (inline type:) — unknown arm + Extract arm so
    // `string | List<number>` keeps List<number> after list?, not List<unknown>.
    "string?": symbol.native`string?: boxed-or-raw string test`(
      {
        input: [z.schemeValue],
        output: [z.boolean],
        type: dedent`
          {
            (x: unknown): x is string;
            <T>(x: T): x is Extract<T, string>;
          }
        `,
      },
      function (this: CallCtx, obj) {
        return bool(obj instanceof AString);
      },
    ),

    // tagless: receiver's own tf(pair?); default #f — no instanceof APair reach-around.
    // Law-N witness: runtime proves the narrowing. Fields via object-spread (tagless-guard).
    "pair?": withContractFields(symbol.taglessGuard`pair?: #t iff obj is a pair (cons cell)`, {
      // NonEmptyList — list generalizes pair; empty list is a list but not a pair.
      // (Fixed 2-products use Tuple elsewhere; pair? is the cons-cell / non-empty gate.)
      type: dedent`
          {
            (x: unknown): x is NonEmptyList<unknown>;
            <T>(x: T): x is Extract<T, NonEmptyList<any>>;
          }
        `,
      emit: pairQEmitRule,
      narrows: { witness: "pair?" },
      refPolicy: "eta",
    }),

    "null?": symbol.native`null?: empty-list test`(
      {
        input: [z.schemeValue],
        output: [z.boolean],
        type: dedent`
          {
            (x: unknown): x is null;
            <T>(x: T): x is Extract<T, null>;
          }
        `,
        // Law-N witness: runtime proves the narrowing.
        emit: nullQEmitRule,
        narrows: { witness: "null?" },
        refPolicy: "eta",
      },
      // ANil (and provenance clones). Raw JS null/undefined never arrive (membrane
      // boxes null→nil, undefined→theVoid).
      //
      // TOLERANCE (loose mode): an empty AJSArray — a borrowed JSON `[]`, which a required
      // data file or a tool result both produce — also answers #t. Genuine scheme vector
      // `(null? #())` stays #f: R7RS disjointness holds for values that were always vectors.
      // At the EMPTY value the vector and list charts converge on "no elements", and
      // answering #f makes `(if (null? results) … (car results))` take the else branch on
      // empty data, which is the reading nobody wants. Contracted list verbs never reach
      // here — they see nil through adoption.
      //
      // STRICT mode refuses instead of answering: the tolerance is a loose-mode convenience,
      // and a program declaring strict portability is asking to be told that this value is a
      // vector, not a list. The two modes disagree ON PURPOSE, which is what `strictGate`
      // exists to express — the cost of the loose answer is one value reading #t to both
      // `null?` and `vector?`, and strict declines to pay it.
      function (this: CallCtx, obj) {
        if (obj instanceof ANil) return bool(true);
        if (obj instanceof AJSArray && obj.source.length === 0) {
          strictGate(this.runCtx, {
            op: "null?",
            rule: "an empty borrowed JSON array is a VECTOR, and `null?` holds only of the empty LIST",
            alternative: "test `(vector? x)` / `(= 0 (vector-length x))`, or adopt the list chart first",
          });
          return bool(true);
        }
        return bool(false);
      },
    ),
    // Clojure / polyglot spelling — same empty-list test as null? (arrival's nil ≡ '()).
    // Alias stays in this pack (symbol.alias is same-capability only). Card teaches null?;
    // models that type nil? still run.
    "nil?": symbol.alias`null?`,

    "boolean?": symbol.native`boolean?: boxed-or-raw boolean test`(
      {
        input: [z.schemeValue],
        output: [z.boolean],
        type: dedent`
          {
            (x: unknown): x is boolean;
            <T>(x: T): x is Extract<T, boolean>;
          }
        `,
      },
      // harvest `type:` is the dual boolean guard
      function (this: CallCtx, obj) {
        return bool(obj instanceof ABool);
      },
    ),

    // Symbol prints as string in the harvest image (no separate ambient Symbol carrier).
    "symbol?": withContractFields(symbol.taglessGuard`symbol?: #t iff obj is an interned symbol`, {
      type: dedent`
          {
            (x: unknown): x is string;
            <T>(x: T): x is Extract<T, string>;
          }
        `,
    }),

    // `dict?` — Racket's dict predicate, the missing counterpart to our native `{…}` /
    // `(dict …)` open-key map (polyglot.ts). We ship the type but had no predicate for
    // it — a genuine gap, not a design omission (see `env/polyglot/polyglot-stubs.ts`'s
    // header for that distinction). A native dict is an `ADict` instance
    // (native-dict-provenance.md); the fallback below still recognizes a genuinely
    // foreign `AJSObject` (a borrowed JS object — arrays box separately as `AJSArray`,
    // so they never reach this branch), kept so a dict-shaped value from a tool result
    // still answers `dict?` without being an `ADict`. A scalar, an array, or any other
    // non-object foreign value is not a dict.
    "dict?":
      symbol.native`dict?: #t iff obj is a dict — a native open-key record ({…} / (dict …)), not a list, string, vector, or foreign class instance`(
        {
          input: [z.schemeValue],
          output: [z.boolean],
          type: dedent`
          {
            (x: unknown): x is Record<string, unknown>;
            <T>(x: T): x is Extract<T, Record<string, unknown>>;
          }
        `,
        },
        function (this: CallCtx, obj): ABool {
          return new ABool(obj instanceof AJSObject || obj instanceof ADict);
        },
      ),

    "list?": symbol.native`list?: proper-list test (cycle-safe)`(
      {
        input: [z.schemeValue],
        output: [z.boolean],
        type: dedent`
          {
            (x: unknown): x is List<unknown>;
            <T>(x: T): x is Extract<T, List<any>>;
          }
        `,
      },
      // A circular list is NOT a proper list (R7RS); detect runtime cycles too
      // (have_cycles below only catches reader #0= cycles).
      function (this: CallCtx, obj) {
        if (obj instanceof APair && isCircularList(obj)) {
          return schemeFalse;
        }
        let node: unknown = obj;
        while (true) {
          if (node instanceof ANil) {
            return schemeTrue;
          }
          if (!(node instanceof APair)) {
            return schemeFalse;
          }
          if (node.have_cycles("cdr")) {
            return schemeFalse;
          }
          node = node.cdr;
        }
      },
    ),
  }),
});
