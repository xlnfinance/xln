// SRFI-1 — list library *subset* for immutable Arrival. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `base-packs.ts` assembles this pack (via `allSrfi`) and evals it,
// so this module is the sole definition site for the names it owns.
//
// SCOPE (honest): NOT the full SRFI-1 export set. Agent-reached completion set +
// parallel-list utilities + arrival extras, under **implement-or-door**:
//   • Live: take/drop/take-while/drop-while, span/break/partition as (list a b),
//     first…tenth, last/last-pair, find/find-tail, filter/remove/delete*,
//     fold-right/reduce/reduce-right, concatenate/append-reverse, iota, zip,
//     any?/every?/some (honest booleans) + any/every (SRFI value-returning —
//     see DEVIATIONS), list-index, count, filter-map, append-map,
//     length+, list-tabulate, unfold (HISTORICAL protocol — see DEVIATIONS).
//   • Doored: remaining official exports — linear-update `!` purity doors; pure
//     unshipped names as subset doors; bare `fold` → reduce / fold-right.
//   • Peer-covered (scheme/lists + equality; not re-listed here): cons, list, map,
//     for-each, member/assoc family, set-car!/set-cdr!/append!/list-set! purity.
//   • Extras (not SRFI): first?, first-or, range; private %… helpers.
//
// DEVIATIONS FROM SRFI-1 (read before porting):
//   • Multi-return doored on binding; span/break/partition products are (list a b).
//   • any/every are split by name: `?`-suffixed (any?/every?) are the HONEST
//     #t/#f-only boolean predicates; bare any/every are SRFI-1's OWN value-returning
//     quantifiers — any → first truthy predicate RESULT or #f; every → LAST predicate
//     RESULT if every element-tuple is truthy, #t on empty, #f on first falsy. `some`
//     (Ramda-familiar name) aliases any? exactly, staying boolean.
//   • find miss → #f per SRFI-1; predicate verdicts use R7RS truthiness (only #f is
//     false — '() counts as a match, same as some/every/if).
//   • unfold is NOT SRFI's (p f g seed); historical (fn init) pair-or-#f protocol.
//   • take/drop/filter/reduce may be representation-polymorphic; SRFI is list-only.
//     take/drop reject non-collection receivers even at n=0.
//
// DEPS: the define bodies freely reference
//   • `not`/`equal?`/`eq?`/`pair?`/`null?`  → scheme/equality
//   • `<=`/`<`/`>=`/`=`/`+`/`-`/`*`         → scheme/numeric
//   • `error`                               → scheme/exceptions (BASE_PACKS)
//   • `cons`/`reverse`/`append`/`member`/`length`/`map`/`apply`/`list` → scheme/lists
// JS-native packs are not BASE_PACKS roots; deps is enough.
// `deps: [equality, numeric, exceptions, vectors, lists]` (B3: `vectors` for
// `%list-nth`'s `vector?`/`vector->list` normalization — see that helper's comment).
// `car`/`cdr`/`cadr` need no edge: cxr synth is a kernel resolver (define-bake CXR_RE).
//
// CONTRACT CONVENTIONS (judgment calls, so the next author doesn't re-derive them):
//   - list slots: `z.union([z.pair, z.nil])` — SHALLOW pair-or-nil (listAlike), NEVER
//     `z.list`: list codec walks the spine (O(n)) and throws on circular/improper, but
//     `length+` answers circular lists and SRFI-1 blesses dotted tails for take/drop.
//   - xs slots that tolerate ANY value by spec (%list-nth not-a-pair→error, first?/first-or):
//     `z.schemeValue`. take/drop also use `z.schemeValue` for tagless dispatch (not SRFI any-at-n=0).
//   - two-list products (span/break/partition): `output: [listAlike]` — `(list a b)`.
//   - fresh-list outputs via reverse/cons: `z.union([z.pair, z.nil])`. Tail-returning
//     (drop/drop-while/append-reverse/concatenate): `z.schemeValue` when embedding caller tails.
//   - counts/indices: `z.exact` from exact arithmetic; `z.schemeNumber` when re-exporting
//     another verb's numeric output (count ← length).
//   - any?/every?/some: `z.boolean` — HONEST #t/#f predicates. Bare any/every:
//     `z.schemeValue` — SRFI-1's own value-returning result (see DEVIATIONS).
//
// PERF PROTOCOL: contract costs one decode + async hop PER BOUND CALL. Named-let
// recursion never re-crosses the boundary (one cold decode per outer call). %list-nth /
// %any-null? / %some / %any / %every / %every-value / zip use that idiom. take/drop are
// tagless dispatchers. validate:false unused — evidence-gated only.
import { type CallCtx, makeCallCtx } from "../../run/CallCtx.js";
import { withContractFields, resolveMethod, withCallbackRoles } from "../../common/symbols/_bake.js";
import type { MaybePromise } from "../../types/utility.js";
import dedent from "dedent";
import { EnvCapability } from "../../common/capability.js";
import type { EmitCtx, EmitRule } from "../../emit/emit-rule.js";
import { Arrow, Bin, Call, Lit, Method, Ref, type Binding, type R } from "../../emit/residual-lite.js";
import { attachOffendingValue } from "../../errors.js";
import { is_false } from "../../values/value-guards.js";
import { ANil } from "../../values/primitives/ANil.js";
import { schemeFalse } from "../../values/primitives/ABool.js";
import { maybeThen } from "../../utils/promises.js";
import { applyCallback, type ACallable } from "../../values/primitives/ACallable.js";
import { type RunContext } from "../../run/RunContext.js";
import { tf } from "../../values/tagless-final.js";
import type { AListAlike, SchemeValue } from "../../values/types.js";
import equality from "../r7rs/equality.js";
import exceptions from "../r7rs/exceptions.js";
import lists from "../r7rs/lists.js";
import numeric from "../r7rs/numeric.js";
import vectors from "../r7rs/vectors.js";

// ── implement-or-door inventory (official SRFI-1 names not live above) ────────
// Shared purity wording mirrors scheme/lists set-car! / append! doors.
const PURITY =
  "every value is frozen by design — linear-update / mutating list ops would falsify the provenance lineage the spine carries; use the pure twin (drop the !) or rebuild with cons / append / filter / reverse / …";
const LSET =
  "list-as-set algebra is outside the shipped SRFI-1 subset; compose member / delete / delete-duplicates / filter instead";
const LSET_BANG = `${PURITY}; pure lset* algebra is also outside the shipped subset`;

/** name → reason. Sole inventory for silent→door coverage of the rest of SRFI-1. */
const DOORS = {
  // purity — linear-update / mutators (never implement under immutable subset)
  "take!": `${PURITY}; use take`,
  "drop-right!": `${PURITY}; use drop-right once live, or rebuild`,
  "split-at!": `${PURITY}; use pure split-at product once live, or (list (take xs n) (drop xs n))`,
  "concatenate!": `${PURITY}; use concatenate`,
  "reverse!": `${PURITY}; use reverse`,
  "append-reverse!": `${PURITY}; use append-reverse`,
  "append-map!": `${PURITY}; use append-map`,
  "map!": `${PURITY}; use map`,
  "filter!": `${PURITY}; use filter`,
  "partition!": `${PURITY}; use partition → (list yes no)`,
  "remove!": `${PURITY}; use remove`,
  "take-while!": `${PURITY}; use take-while`,
  "span!": `${PURITY}; use span`,
  "break!": `${PURITY}; use break`,
  "delete!": `${PURITY}; use delete`,
  "delete-duplicates!": `${PURITY}; use delete-duplicates`,
  "alist-delete!": `${PURITY}; filter by key with remove / filter`,
  "lset-union!": LSET_BANG,
  "lset-intersection!": LSET_BANG,
  "lset-difference!": LSET_BANG,
  "lset-xor!": LSET_BANG,
  "lset-diff+intersection!": LSET_BANG,

  // not-in-subset — pure but unshipped (doors, not silence)
  xcons: "tiny HOF sugar (lambda (d a) (cons a d)) — write cons flipped or a lambda",
  "cons*": "rest-as-tail constructor not shipped; nest cons / list with last cdr",
  "circular-list": "cycle construction is outside the immutable subset; circular *detection* is length+ → #f",
  "proper-list?": "not in shipped subset; use list? / pair-walk + null?",
  "circular-list?": "not shipped; length+ → #f is the cycle answer we expose",
  "dotted-list?": "not shipped; dotted tails only where SRFI blesses (take/drop/length+)",
  "not-pair?": "sugar for (not (pair? x)) — write that or compose not + pair?",
  "null-list?": "termination helper for proper/circular lists not shipped; use null? carefully",
  "list=": "element-wise n-ary list equality with custom elt= not shipped; use equal? or a fold",
  "car+cdr": "multi-return deconstructor — multi-return is doored; use (list (car p) (cdr p))",
  "take-right": "pure but unshipped; rebuild with length + drop / reverse-take pattern",
  "drop-right": "pure but unshipped; rebuild with length + take pattern",
  "split-at": "pure multi-product not shipped; use (list (take xs n) (drop xs n))",
  unzip1: "transpose inverse of zip not shipped; (map car lists) for the first column",
  unzip2: "n-way unzip multi-return not shipped; compose map car/cadr or door multi-return",
  unzip3: "n-way unzip multi-return not shipped; compose map over positions",
  unzip4: "n-way unzip multi-return not shipped; compose map over positions",
  unzip5: "n-way unzip multi-return not shipped; compose map over positions",
  "pair-fold": "fold over pairs (sublists) often paired with set-cdr!; not in agent grain",
  "pair-fold-right": "fold over pairs (sublists); not in agent grain — use fold-right on cars",
  "unfold-right": "iterative dual of SRFI unfold; not in grain (and our unfold is historical)",
  "map-in-order": "ordered map for effectful procs; pure map already walks L→R — use map",
  "pair-for-each": "side-effect walk of pairs; use for-each on cars or recurse on cdr",
  "alist-cons": "trivial (cons (cons key val) alist) — write that",
  "alist-copy": "spine copy of alist pairs not shipped; map list-copy / pair rebuild",
  "alist-delete": "filter by key not shipped; use remove / filter with equal? on cars",
  "lset<=": LSET,
  "lset=": LSET,
  "lset-adjoin": LSET,
  "lset-union": LSET,
  "lset-intersection": LSET,
  "lset-difference": LSET,
  "lset-xor": LSET,
  "lset-diff+intersection": `${LSET}; multi-return product would be (list diff intersection) if ever shipped`,
} as const satisfies Record<string, string>;

// reduce — SRFI-1's higher-order list fold, a pure `symbol.tagless` dispatcher: no impl,
// forwards to the receiver's own `arrival/tagless-final/reduce` term (APair/AVector left-fold;
// ANil returns the seed), threading the run ctx. Scheme places the collection LAST —
// `(reduce f ridentity xs)` — so the dispatcher's last-arg-is-receiver convention lands the
// list/vector/nil as the receiver and passes [f, ridentity] through. The element-first fold
// convention (`fn(element, acc)`, NOT the FL acc-first) lives ON the terms.
//
// find — SRFI-1 first-match search: a JS `symbol.native` (not a scheme `symbol.define` like
// `find-tail`) because it recurses over the predicate and unwraps an async generator-lambda
// result. Procedure-only matcher (no host RegExp).
//
// Precision-typed to match its own Contract (below): `arg` is `z.lambda` → `ACallable`
// (scheme-side callable VALUE; bare host fns refused — mint via hostFnToCallable).
// `list`'s car/cdr decode `unknown` off `z.pair`'s default `APair<unknown, unknown>`
// generic — every recursive/return site that hands a car/cdr back through this
// SchemeValue-returning fn casts it. findImpl carries no runtime pair-or-nil check
// of its own (`symbol.native` contracts are TYPE-ONLY and never validated at runtime),
// so the cast restates the TS-declared `AListAlike` shape, not a runtime-verified one.
// `runCtx` is a required parameter (not a defaulted CONSTANT_CTX) — a plain recursive
// call (not a dispatch-bound `this: CallCtx`) can't recover the live ctx any other
// way, so it's threaded explicitly through every recursive step. The `find` binding
// below is the thin dispatch-bound wrapper that supplies it from `this.runCtx`.
function findImpl(arg: ACallable, list: AListAlike, runCtx: RunContext): SchemeValue {
  if (list instanceof ANil) {
    // SRFI-1: `find` returns #f on no-match — '() is R7RS-truthy, so it can't double
    // as the miss sentinel the way it would in a nil-as-false dialect.
    return schemeFalse;
  }
  return maybeThen(applyCallback(arg, [list.car], makeCallCtx(runCtx)), function (value) {
    // R7RS truthiness: only #f is false — a '()-returning predicate IS a match
    // (matches some/every/if; nil is never treated as false here).
    if (!is_false(value)) {
      return list.car;
    }
    return findImpl(arg, list.cdr as AListAlike, runCtx);
  }) as SchemeValue;
}

// ════════════════════════════════════════════════════════════════════════════
// filter.emit — residual twin of the compiler-side filter rule (residual-lite).
// Drift pinned by srfi-1-emit.test.ts.
//
// INERT in production ambient: scheme/srfi-1 is not oracle-harvested; the
// compiler table row is the only pipeline-reachable copy. Forward-declared twin
// until that ambient gap closes.
//
// Law F / Law T: conservative `(x) => pred(x) !== false` (Scheme keeps all but
// #f; JS .filter drops Scheme-truthy 0/""). Read register: bare .filter(pred).
// Clean run branch needs pred RETURN facts — TypeFacts has none today.
// ════════════════════════════════════════════════════════════════════════════

function exactly<T>(ctx: EmitCtx<R>, sym: string, args: readonly T[], n: number): readonly T[] {
  if (args.length !== n) ctx.door(`\`${sym}\` wants exactly ${n} argument${n === 1 ? "" : "s"}, got ${args.length}`);
  return args;
}

/** `EmitCtx.fresh` typed `unknown` in core; cast once to Binding. */
function freshBinding(ctx: EmitCtx<R>, hint: string): Binding {
  return ctx.fresh(hint) as Binding;
}

// ── filter — Law T on the predicate's verdict ───────────────────────────────────────
// Conservative: `(x) => f(x) !== false`. Provably-boolean pred (or read register): bare f.
// Single-list only.
const filterEmitRule: EmitRule<R> = {
  call: (args, ctx) => {
    const [pred, xs] = exactly(ctx, "filter", args, 2);
    if (ctx.config.register === "read" || ctx.argFacts[0]?.boolean === true) {
      return Method(xs!, "filter", [pred!]);
    }
    const x = freshBinding(ctx, "x");
    return Method(xs!, "filter", [Arrow([x], Bin("!==", Call(pred!, [Ref(x)]), Lit(false)))]);
  },
};

export default EnvCapability.define("scheme/srfi-1", {
  // See the file header: the complete cross-capability free-name set of the define
  // bodies below, order-matched to base-packs.ts's C3 tail (exceptions, lists).
  // B3 (benchmark-defect-register.md): `vectors` added so `%list-nth` can normalize a
  // vector-shaped receiver (`vector?`/`vector->list`, both r7rs/vectors.ts) before
  // walking it as a pair spine — see that helper's own comment. Positioned BEFORE
  // `lists` (not appended) to match `polyglot-clojure.ts`'s own precedence
  // (`[…, vectors, lists]`) — appending it after `lists` here would contradict that
  // ordering and fail the C3 merge (`AssembleLinearizationError`) the first time both
  // packs are assembled together.
  deps: [equality, numeric, exceptions, vectors, lists],
  symbols: (symbol, z) => {
    // The list identity for every spine-walking verb below — the SHARED `z.listAlike`
    // (scheme-zod.ts), not a local union. It is spine-ADOPTING: a slot declared with it
    // takes the SPINE READING of its argument, so a borrowed JS array (every MCP tool's JSON
    // array arrives as one, `kind="vector"`) is projected onto an `AJSArrayList` view — same
    // backing store, same provenance, O(1) — before any body or impl sees it, and an EMPTY
    // array becomes `nil`.
    const listAlike = z.listAlike;
    // Sole inventory for silent→door coverage of the rest of SRFI-1 (see DOORS).
    const DOOR_SYMBOLS = Object.fromEntries(
      Object.entries(DOORS).map(([name, reason]) => [name, symbol.notImplemented`${name}: ${reason}`]),
    );
    return {
      // input is a plain FIXED 2-tuple (pred, seq) — NOT z.tuple([z.schemeValue], z.schemeValue)'s
      // unbounded rest (filter's impl is strictly binary: `const [pred, seq] = args`, always
      // exactly 2). pred uses the established callable-schema convention (z.custom<(...args)
      // => T>(), matching vector-map/vector-for-each); seq stays z.schemeValue — it's dispatched
      // via tf("filter") term-lookup, representation-agnostic. `symbol.sequence`'s impl signature
      // is always `(args: unknown[], runCtx)` regardless of the contract shape (see
      // SequenceImpl in _bake.ts), so this is a declaration-only fix — the impl is unchanged.
      filter: symbol.sequence`filter: keep elements matching a pred (or RegExp); term-dispatch, totalic`(
        // Output is `z.schemeValue` (the representation-BLIND scheme-value identity), NOT a "proper
        // list" type: `filter` is genuinely polymorphic over the RECEIVER's own representation
        // (list, vector, …) — it dispatches to whatever `arrival/tagless-final/filter` term the
        // `seq` operand implements and returns a value in THAT SAME representation, so there is
        // no single richer scheme-zod collection type honest for every call site.
        // callbackRoles OVERRIDE: filter's contract is shape-identical to map's (fan
        // host, lambda + value in, value out), so extraction's fan default would say
        // element-transformer — but the pred is a SELECTOR: its verdict decides
        // membership (a length-changing verb), the merged selector+decision role
        // this codebase calls `control`.
        {
          input: [z.lambda, z.schemeValue],
          output: [z.schemeValue],
          provenance: "fan",
          callbackRoles: ["control"],
          type: dedent`
          {
            <T, S extends T>(p: (x: T) => x is S, xs: List<T>): List<S>;
            <T>(p: (x: T) => unknown, xs: List<T>): List<T>;
            <T, S extends T>(p: (x: T) => x is S, xs: readonly T[]): readonly S[];
            <T>(p: (x: T) => unknown, xs: readonly T[]): readonly T[];
          }
        `,
          emit: filterEmitRule,
        },
        (args, runCtx) => {
          const [pred, seq] = args;
          const m = resolveMethod(seq, tf("filter"));
          if (m === undefined) {
            throw attachOffendingValue(
              new TypeError(
                `filter: the ${seq == null ? String(seq) : typeof seq} operand does not support filter (no ${tf("filter")}).`,
              ),
              seq,
            );
          }
          // `resolveMethod`'s own return type is `unknown` (it's a bare tagless-final term
          // lookup, possibly async) — the cast states what the `filter` term contract actually
          // guarantees (a scheme value, or a promise of one, in the receiver's own
          // representation), mirroring this file's established "typecheck is not a TS guard;
          // re-state it" idiom (see `findImpl` above).
          return m.call(seq, pred, runCtx) as MaybePromise<SchemeValue>;
        },
      ),
      // The DECLARED acc-chain marker ("fold declares acc chain"): reduce's f is the
      // fold-shaped `accumulator` callback,
      // the source of CHAINED track composition (`egress(Tᵢ) → ingress(Tᵢ₊₁)`, the only
      // sanctioned inter-track edge — the track-separation law's one exception). A tagless
      // def is contract-less (shapeless `z.array(z.schemeValue)` in), so declaration is the ONLY
      // channel — `withCallbackRoles`, not a Contract field.
      reduce: withCallbackRoles(
        withContractFields(
          symbol.tagless`reduce: left fold in scheme convention fn(element, acc); ridentity if empty`,
          {
            type: dedent`
          {
            <T, A>(f: (element: T, acc: A) => A, ridentity: A, xs: List<T>): A;
            <T, A>(f: (element: T, acc: A) => A, ridentity: A, xs: readonly T[]): A;
          }
        `,
          },
        ),
        ["accumulator"],
      ),
      // fold — SRFI-1's bare LEFT fold is deliberately NOT bound under this name: `reduce`
      // (above) IS the left fold here, same fn(element, acc) convention with an explicit
      // seed, and `fold-right` (symbol.define below) covers the right-associative shape. A
      // teaching door beside its family (errors-as-doors), not a silent absence: DECLARED
      // capability data resolving through the ordinary chain, which also makes it
      // typo-suggestible for free (see src/unbound-variable.ts).
      fold: symbol.notImplemented`fold: SRFI-1's bare fold is not bound under this name — use reduce (left fold, fn(element, acc) convention, explicit seed) or fold-right (right-associative); both are bound here`,
      find: symbol.native`find: first list element matching the predicate, else nil`(
        {
          input: [z.lambda, z.listAlike],
          output: [z.schemeValue],
          // harvest `type:` images miss as `null` with type-guard overloads
          type: dedent`
          {
            <T, S extends T>(p: (x: T) => x is S, xs: List<T>): S | null;
            <T>(p: (x: T) => unknown, xs: List<T>): T | null;
          }
        `,
          // callbackRoles DECLARED: the host is a pipe (not fan) with value egress, so
          // shape underdetermines the pred's role. It is `control` — a boolean-returning
          // selector deciding WHICH element egresses (the merged selector+decision role).
          callbackRoles: ["control"],
        },
        // Thin dispatch-bound wrapper: supplies the recursive findImpl with the live
        // `this.runCtx` (findImpl itself recurses via a plain call, so it cannot recover
        // ctx off `this`). `arg` is `z.lambda` → ACallable.
        function (this: CallCtx, arg: ACallable, list: AListAlike) {
          return findImpl(arg, list, this.runCtx);
        },
      ),

      // ============ SRFI-1 (list library completion) ============

      // take-while / drop-while — tagless-final dispatchers, NOT scheme-spine bodies: a
      // spine-walking `(and (pair? xs) …)` named-let is #f on a vector (`pair?` never
      // holds there), so a tool-result vector would silently answer '() instead of
      // raising. Receiver-LAST, exactly like `reduce` above (scheme surface is
      // `(take-while pred xs)`; symbol.tagless's convention takes the LAST scheme arg as
      // receiver, so `xs` lands there and `pred` passes through leading). The term
      // (`arrival/tagless-final/take-while` — AValue.ts) OWNS the algebra: list AND
      // vector both answer (list→fresh list; vector→fresh vector, same-kind), and a
      // receiver declaring NEITHER hits `symbol.tagless`'s own TaglessProtocolError door,
      // loud rather than a silent '(). pred's role is "control": a selector deciding
      // prefix membership, the same override reasoning as `filter`'s callbackRoles above.
      "take-while": withCallbackRoles(
        withContractFields(
          symbol.tagless`take-while: longest prefix of xs satisfying pred, in xs's own representation (list→fresh list, vector→fresh vector)`,
          {
            type: dedent`
          {
            <T>(p: (x: T) => unknown, xs: List<T>): List<T>;
            <T>(p: (x: T) => unknown, xs: readonly T[]): readonly T[];
          }
        `,
          },
        ),
        ["control"],
      ),
      // drop-while — the take-while remainder, same receiver-last/term-owns-algebra/loud-
      // crash reasoning as take-while directly above (see that comment).
      "drop-while": withCallbackRoles(
        withContractFields(
          symbol.tagless`drop-while: xs with the take-while prefix removed, in xs's own representation (list: a shared tail of xs)`,
          {
            type: dedent`
          {
            <T>(p: (x: T) => unknown, xs: List<T>): List<T>;
            <T>(p: (x: T) => unknown, xs: readonly T[]): readonly T[];
          }
        `,
          },
        ),
        ["control"],
      ),

      // take / drop — tagless-final dispatchers via symbol.sequence, NOT symbol.tagless:
      // scheme surface is `(take xs n)` — xs is FIRST, not last, so symbol.tagless's
      // last-arg-is-receiver convention cannot serve here. Mirrors this file's own
      // `filter` above / lists.ts's `map` instead: `resolveMethod`/`tf` term-lookup IS
      // the type gate — a receiver declaring no `arrival/tagless-final/take|drop` term
      // crashes loudly (TypeError), never a silent '() on a non-pair (`pair?` is #f on a
      // vector, the same hazard take-while/drop-while guard against above). The receiver
      // slot stays `z.schemeValue` (filter/map's representation-agnostic idiom): the result is
      // in the RECEIVER'S OWN representation (list or vector), so no richer scheme-zod
      // collection type is honest for every call site. `n` normalizes via `.valueOf()`,
      // the vectors.ts `vector-ref` idiom.
      //
      // Strict types over silent tolerance: SRFI-1's "lis may be any value once n hits 0"
      // tolerance is not honored — `(take xs 0)` on a non-collection receiver is a type
      // error, not '() (see the file header's DEVIATIONS).
      take: symbol.sequence`take: the first n elements of xs, in xs's own representation (list→fresh list, dotted tails tolerated per SRFI-1; vector→fresh vector)`(
        {
          input: [z.schemeValue, z.schemeNumber],
          output: [z.schemeValue],
          type: dedent`
          {
            <T>(xs: List<T>, n: number): List<T>;
            <T>(xs: readonly T[], n: number): readonly T[];
          }
        `,
        },
        (args, runCtx) => {
          const [xs, n] = args;
          const m = resolveMethod(xs, tf("take"));
          if (m === undefined) {
            throw attachOffendingValue(
              new TypeError(
                `take: the ${xs == null ? String(xs) : typeof xs} operand does not support take (no ${tf("take")}).`,
              ),
              xs,
            );
          }
          const k = typeof n === "number" ? n : (n as { valueOf(): number }).valueOf();
          return m.call(xs, k, runCtx) as MaybePromise<SchemeValue>;
        },
      ),

      // drop — the take remainder; same dispatcher/loud-crash/behavior-change reasoning
      // as take directly above (see that comment). Output stays z.schemeValue (not listAlike):
      // list drop returns the n-th cdr of xs ITSELF (shares structure), vector drop
      // returns a fresh vector — both are the receiver's own representation, never a
      // guaranteed pair-or-nil shape.
      drop: symbol.sequence`drop: xs after the first n elements, in xs's own representation (list: the n-th cdr — shares structure with xs; vector→fresh vector)`(
        {
          input: [z.schemeValue, z.schemeNumber],
          output: [z.schemeValue],
          type: dedent`
          {
            <T>(xs: List<T>, n: number): List<T>;
            <T>(xs: readonly T[], n: number): readonly T[];
          }
        `,
        },
        (args, runCtx) => {
          const [xs, n] = args;
          const m = resolveMethod(xs, tf("drop"));
          if (m === undefined) {
            throw attachOffendingValue(
              new TypeError(
                `drop: the ${xs == null ? String(xs) : typeof xs} operand does not support drop (no ${tf("drop")}).`,
              ),
              xs,
            );
          }
          const k = typeof n === "number" ? n : (n as { valueOf(): number }).valueOf();
          return m.call(xs, k, runCtx) as MaybePromise<SchemeValue>;
        },
      ),

      span: symbol.define`span: (list (take-while pred xs) (drop-while pred xs)) in one pass`(
        {
          input: [z.lambda, listAlike],
          output: [listAlike],
          type: dedent`
          {
            <T>(p: (x: T) => unknown, xs: List<T>): [List<T>, List<T>];
          }
        `,
        },
        `(lambda (pred xs)
         (let loop ((xs xs) (acc '()))
           (if (and (pair? xs) (pred (car xs)))
               (loop (cdr xs) (cons (car xs) acc))
               (list (reverse acc) xs))))`,
      ),

      break: symbol.define`break: span on the negation of pred — (list prefix-failing-pred rest)`(
        {
          input: [z.lambda, listAlike],
          output: [listAlike],
          type: dedent`
          {
            <T>(p: (x: T) => unknown, xs: List<T>): [List<T>, List<T>];
          }
        `,
        },
        `(lambda (pred xs)
         (let loop ((xs xs) (acc '()))
           (if (and (pair? xs) (not (pred (car xs))))
               (loop (cdr xs) (cons (car xs) acc))
               (list (reverse acc) xs))))`,
      ),

      partition: symbol.define`partition: (list yes no) splitting xs by pred, order-preserving`(
        {
          input: [z.lambda, listAlike],
          output: [listAlike],
          type: dedent`
          {
            <T>(p: (x: T) => unknown, xs: List<T>): [List<T>, List<T>];
          }
        `,
        },
        `(lambda (pred xs)
         (let loop ((xs xs) (yes '()) (no '()))
           (cond ((null? xs) (list (reverse yes) (reverse no)))
                 ((pred (car xs)) (loop (cdr xs) (cons (car xs) yes) no))
                 (else (loop (cdr xs) yes (cons (car xs) no))))))`,
      ),

      "find-tail": symbol.define`find-tail: first tail of xs whose car satisfies pred, else #f`(
        {
          input: [z.lambda, listAlike],
          output: [z.union([z.pair, z.booleanFalse])],
          type: dedent`
          {
            <T, S extends T>(p: (x: T) => x is S, xs: List<T>): List<S> | false;
            <T>(p: (x: T) => unknown, xs: List<T>): List<T> | false;
          }
        `,
        },
        `(lambda (pred xs)
         (let loop ((xs xs))
           (cond ((null? xs) #f)
                 ((pred (car xs)) xs)
                 (else (loop (cdr xs))))))`,
      ),

      // z.pair input (SRFI-1: non-empty list required) — `(last-pair '())` is an
      // out-of-domain call that fails at the contract boundary with a clear
      // message, never mid-body.
      "last-pair": symbol.define`last-pair: the last pair of a non-empty (possibly dotted) list`(
        {
          input: [z.pair],
          output: [z.pair],
          type: dedent`
          {
            <T>(xs: List<T>): Tuple<T, List<T> | T>;
          }
        `,
        },
        `(lambda (xs)
         (let loop ((xs xs))
           (if (pair? (cdr xs)) (loop (cdr xs)) xs)))`,
      ),

      last: symbol.define`last: the last element of a non-empty proper list`(
        {
          input: [z.pair],
          output: [z.schemeValue],
          type: dedent`
          {
            <T>(xs: List<T>): T;
          }
        `,
        },
        `(lambda (xs) (car (last-pair xs)))`,
      ),

      // %list-nth — private walker behind first…tenth: walks k cdrs, reports the
      // accessor's name on underflow. xs is z.schemeValue (its not-a-pair→error branch IS the
      // teaching surface first…tenth rely on). Named-let idiom (see the file header's
      // PERF PROTOCOL note); enforcement stays on.
      //
      // B3 (benchmark-defect-register.md) — a vector-shaped receiver (AVector/AJSArray)
      // normalizes to a genuine pair/nil list FIRST, via `vector->list` (array-length-
      // bounded — terminates by construction, never a cdr-walk). This is NOT the same
      // hazard the register's own load-bearing warning names: that warning is about
      // walking a vector's OWN loose `cdr` in a `(if (null? xs) … (loop (cdr xs)))` loop,
      // which never reaches `null?` because a vector's `cdr` never becomes `ANil`.
      // `vector->list` never cdr-walks a vector — it indexes `[0, length)` directly — so
      // it cannot exhibit that hazard; the loop below then walks the MATERIALIZED (real,
      // finite) pair/nil list exactly as it always did for a genuine list receiver. A
      // non-vector, non-pair, non-nil `xs` (a string, a number, …) is unaffected — still
      // the `(not (pair? xs))` teaching error, first…tenth's own error surface.
      "%list-nth":
        symbol.define`%list-nth: the k-th element of xs, or (error msg) when xs is too short (private walker for first…tenth)`(
          { input: [z.schemeValue, z.schemeNumber, z.string], output: [z.schemeValue] },
          `(lambda (xs k msg)
         (let loop ((xs (if (vector? xs) (vector->list xs) xs)) (k k))
           (cond ((not (pair? xs)) (error msg))
                 ((= k 0) (car xs))
                 (else (loop (cdr xs) (- k 1))))))`,
        ),

      // first … tenth — SRFI-1 positional accessors: the nth element of a proper list.
      // A list too short for the requested position is an error (mirroring srfi-189's
      // `(error …)` style in this pack). The element is returned AS-IS — accessors don't
      // stamp provenance (cf. `find`, which returns its match unchanged). Input is
      // listAlike (not z.pair): '() must REACH %list-nth so the teaching message
      // ("first: list has no elements") stays the error surface, not a zod boundary.
      // first…tenth share List<T> → T harvest (positional list-ref with teaching errors).
      first: symbol.define`first: the 1st element of a proper list (errors if too short)`(
        {
          input: [listAlike],
          output: [z.schemeValue],
          type: dedent`
          {
            <T>(xs: List<T>): T;
          }
        `,
        },
        `(lambda (xs) (%list-nth xs 0 "first: list has no elements"))`,
      ),
      second: symbol.define`second: the 2nd element of a proper list (errors if too short)`(
        {
          input: [listAlike],
          output: [z.schemeValue],
          type: dedent`
          {
            <T>(xs: List<T>): T;
          }
        `,
        },
        `(lambda (xs) (%list-nth xs 1 "second: list has fewer than 2 elements"))`,
      ),
      third: symbol.define`third: the 3rd element of a proper list (errors if too short)`(
        {
          input: [listAlike],
          output: [z.schemeValue],
          type: dedent`
          {
            <T>(xs: List<T>): T;
          }
        `,
        },
        `(lambda (xs) (%list-nth xs 2 "third: list has fewer than 3 elements"))`,
      ),
      fourth: symbol.define`fourth: the 4th element of a proper list (errors if too short)`(
        {
          input: [listAlike],
          output: [z.schemeValue],
          type: dedent`
          {
            <T>(xs: List<T>): T;
          }
        `,
        },
        `(lambda (xs) (%list-nth xs 3 "fourth: list has fewer than 4 elements"))`,
      ),
      fifth: symbol.define`fifth: the 5th element of a proper list (errors if too short)`(
        {
          input: [listAlike],
          output: [z.schemeValue],
          type: dedent`
          {
            <T>(xs: List<T>): T;
          }
        `,
        },
        `(lambda (xs) (%list-nth xs 4 "fifth: list has fewer than 5 elements"))`,
      ),
      sixth: symbol.define`sixth: the 6th element of a proper list (errors if too short)`(
        {
          input: [listAlike],
          output: [z.schemeValue],
          type: dedent`
          {
            <T>(xs: List<T>): T;
          }
        `,
        },
        `(lambda (xs) (%list-nth xs 5 "sixth: list has fewer than 6 elements"))`,
      ),
      seventh: symbol.define`seventh: the 7th element of a proper list (errors if too short)`(
        {
          input: [listAlike],
          output: [z.schemeValue],
          type: dedent`
          {
            <T>(xs: List<T>): T;
          }
        `,
        },
        `(lambda (xs) (%list-nth xs 6 "seventh: list has fewer than 7 elements"))`,
      ),
      eighth: symbol.define`eighth: the 8th element of a proper list (errors if too short)`(
        {
          input: [listAlike],
          output: [z.schemeValue],
          type: dedent`
          {
            <T>(xs: List<T>): T;
          }
        `,
        },
        `(lambda (xs) (%list-nth xs 7 "eighth: list has fewer than 8 elements"))`,
      ),
      ninth: symbol.define`ninth: the 9th element of a proper list (errors if too short)`(
        {
          input: [listAlike],
          output: [z.schemeValue],
          type: dedent`
          {
            <T>(xs: List<T>): T;
          }
        `,
        },
        `(lambda (xs) (%list-nth xs 8 "ninth: list has fewer than 9 elements"))`,
      ),
      tenth: symbol.define`tenth: the 10th element of a proper list (errors if too short)`(
        {
          input: [listAlike],
          output: [z.schemeValue],
          type: dedent`
          {
            <T>(xs: List<T>): T;
          }
        `,
        },
        `(lambda (xs) (%list-nth xs 9 "tenth: list has fewer than 10 elements"))`,
      ),

      "list-tabulate": symbol.define`list-tabulate: (list (f 0) (f 1) … (f (- n 1)))`(
        {
          input: [z.schemeNumber, z.lambda],
          output: [listAlike],
          type: dedent`
          {
            <B>(n: number, f: (i: number) => B): List<B>;
          }
        `,
        },
        `(lambda (n f)
         (let loop ((i (- n 1)) (acc '()))
           (if (< i 0) acc (loop (- i 1) (cons (f i) acc)))))`,
      ),

      "fold-right": symbol.define`fold-right: right-associative fold — (f x0 (f x1 … (f xn knil)))`(
        {
          input: [z.lambda, z.schemeValue, listAlike],
          output: [z.schemeValue],
          type: dedent`
          {
            <T, A>(f: (x: T, acc: A) => A, knil: A, xs: List<T>): A;
          }
        `,
        },
        `(lambda (f knil xs)
         (let loop ((xs xs))
           (if (null? xs) knil (f (car xs) (loop (cdr xs))))))`,
      ),

      "reduce-right": symbol.define`reduce-right: fold-right with the last element as the seed; ridentity if empty`(
        // Same f/knil/xs shape as fold-right for the non-empty path; empty uses ridentity.
        {
          input: [z.lambda, z.schemeValue, listAlike],
          output: [z.schemeValue],
          type: dedent`
          {
            <T, A>(f: (x: T, acc: A) => A, knil: A, xs: List<T>): A;
          }
        `,
        },
        `(lambda (f ridentity xs)
         (if (null? xs)
             ridentity
             (let loop ((xs xs))
               (if (null? (cdr xs))
                   (car xs)
                   (f (car xs) (loop (cdr xs)))))))`,
      ),

      // Output z.schemeValue: append's R7RS contract lets the LAST list be improper (the
      // result then embeds that tail) — the shallow input union can't rule it out.
      concatenate: symbol.define`concatenate: append a list of lists into one list`(
        {
          input: [listAlike],
          output: [z.schemeValue],
          type: dedent`
          {
            <T>(lists: List<List<T>>): List<T>;
          }
        `,
        },
        `(lambda (lists) (apply append lists))`,
      ),

      // Output z.schemeValue: the result is (reverse rev) grafted onto the caller's tail —
      // tail-typed, and SRFI-1 allows any tail object.
      "append-reverse": symbol.define`append-reverse: (append (reverse rev) tail), accumulator-friendly`(
        {
          input: [listAlike, z.schemeValue],
          output: [z.schemeValue],
          type: dedent`
          {
            <T, U>(rev: List<T>, tail: U): List<T> | U;
          }
        `,
        },
        `(lambda (rev tail)
         (let loop ((rev rev) (tail tail))
           (if (null? rev) tail (loop (cdr rev) (cons (car rev) tail)))))`,
      ),

      delete: symbol.define`delete: remove all elements equal? to x from xs, as a fresh list`(
        {
          input: [z.schemeValue, listAlike],
          output: [listAlike],
          type: dedent`
          {
            <T>(x: T, xs: List<T>): List<T>;
          }
        `,
        },
        `(lambda (x xs)
         (let loop ((xs xs) (acc '()))
           (cond ((null? xs) (reverse acc))
                 ((equal? x (car xs)) (loop (cdr xs) acc))
                 (else (loop (cdr xs) (cons (car xs) acc))))))`,
      ),

      // remove — SRFI-1: keep the elements that do NOT satisfy pred (the predicate twin of
      // delete). The base sandbox carries no external collection library, so this is the sole
      // remove binding; the inference plane copies it by name (bridge.ts). Contract mirrors
      // `filter`'s representation-BLIND shape (z.schemeValue seq/out), NOT listAlike: the body
      // delegates to filter's term dispatch, so remove inherits filter's polymorphism over
      // the receiver's own representation — narrowing here would break what delegation buys.
      remove:
        symbol.define`remove: keep the elements NOT satisfying pred (predicate twin of delete; delegates to filter's term dispatch)`(
          {
            input: [z.lambda, z.schemeValue],
            output: [z.schemeValue],
            type: dedent`
          {
            <T, S extends T>(p: (x: T) => x is S, xs: List<T>): List<S>;
            <T>(p: (x: T) => unknown, xs: List<T>): List<T>;
            <T, S extends T>(p: (x: T) => x is S, xs: readonly T[]): readonly S[];
            <T>(p: (x: T) => unknown, xs: readonly T[]): readonly T[];
          }
        `,
          },
          `(lambda (pred xs)
         (filter (lambda (x) (not (pred x))) xs))`,
        ),

      // first? / first-or — safe list-head accessors: the head, or a falsy / default sentinel
      // on empty.
      //
      // NOT redundant with loose `car`, though both dodge the (car '()) crash: loose car on an
      // empty list projects to nil — an ANil OBJECT, which is Scheme-TRUTHY — so a guard like
      // (let ((p (car xs))) (if p …)) takes the present-branch on empty and then crashes on the
      // field access. first? returns #f (FALSY), so the same guard correctly skips. That falsy-
      // on-empty contract is the load-bearing semantics, and car cannot supply it — these are
      // the safe twins of SRFI-1 `first`, not crash-avoidance vestiges. (first-or is the
      // defaulted twin; it earns the same one-line home rather than a wrong (or (car xs) default)
      // derivation, which would mask a genuinely-falsy first element.) xs is z.schemeValue — TOTAL
      // tolerance (any non-pair → the sentinel) is the whole point, so it is the contract.
      "first?":
        symbol.define`first?: the head of xs, or #f (falsy!) when xs is not a pair — the safe guard twin of first`(
          {
            input: [z.schemeValue],
            output: [z.schemeValue],
            type: dedent`
          {
            <T>(xs: List<T> | unknown): T | false;
          }
        `,
          },
          `(lambda (xs) (if (pair? xs) (car xs) #f))`,
        ),
      "first-or":
        symbol.define`first-or: the head of xs, or default when xs is not a pair — the defaulted twin of first?`(
          {
            input: [z.schemeValue, z.schemeValue],
            output: [z.schemeValue],
            type: dedent`
          {
            <T, D>(xs: List<T> | unknown, default: D): T | D;
          }
        `,
          },
          `(lambda (xs default) (if (pair? xs) (car xs) default))`,
        ),

      // The shallow listAlike input is LOAD-BEARING here: z.list's spine-walking decode
      // would throw on exactly the circular lists this verb exists to answer.
      "length+": symbol.define`length+: list length, or #f for a circular list (Floyd cycle detection)`(
        {
          input: [listAlike],
          output: [z.union([z.exact, z.booleanFalse])],
          type: dedent`
          {
            (xs: List<unknown>): number | false;
          }
        `,
        },
        `(lambda (xs)
         (let loop ((slow xs) (fast xs) (n 0))
           (cond ((null? fast) n)
                 ((not (pair? fast)) n)
                 ((null? (cdr fast)) (+ n 1))
                 ((not (pair? (cdr fast))) (+ n 1))
                 (else
                   (let ((slow2 (cdr slow)) (fast2 (cdr (cdr fast))))
                     (if (eq? slow2 fast2) #f (loop slow2 fast2 (+ n 2))))))))`,
      ),

      // ============ SRFI-1 (the missing third + parallel-list utilities) ============

      // (iota count [start step]) — start/step genuinely optional ⇒ inputRest. Elements
      // are (+ start (* i step)) — inexact whenever start/step are ⇒ the honest element
      // is a number, but the LIST shape is guaranteed fresh-proper.
      iota: symbol.define`iota: (iota count [start step]) — a list of count numbers from start by step`(
        {
          input: [z.schemeNumber],
          inputRest: z.schemeNumber,
          output: [listAlike],
          type: dedent`
          {
            (count: number, start?: number, step?: number): List<number>;
          }
        `,
        },
        `(lambda (count . rest)
         (let ((start (if (null? rest) 0 (car rest)))
               (step (if (or (null? rest) (null? (cdr rest))) 1 (cadr rest))))
           (let loop ((i 0) (acc '()))
             (if (>= i count) (reverse acc)
                 (loop (+ i 1) (cons (+ start (* i step)) acc))))))`,
      ),

      // range — arrival's [0, stop) integer list: exactly (iota stop). The single-arg form
      // is the only one used in practice (every spec site calls (range n)).
      range: symbol.define`range: arrival's [0, stop) integer list — exactly (iota stop)`(
        {
          input: [z.schemeNumber],
          output: [listAlike],
          type: dedent`
          {
            (stop: number): List<number>;
          }
        `,
        },
        `(lambda (stop) (iota stop))`,
      ),

      "delete-duplicates":
        symbol.define`delete-duplicates: order-preserving dedup by equal? (retires the hand-rolled O(n²) dedupe)`(
          { input: [listAlike], output: [listAlike] },
          `(lambda (xs)
         (let loop ((xs xs) (seen '()) (acc '()))
           (if (null? xs) (reverse acc)
               (if (member (car xs) seen)
                   (loop (cdr xs) seen acc)
                   (loop (cdr xs) (cons (car xs) seen) (cons (car xs) acc))))))`,
        ),

      "filter-map": symbol.define`filter-map: map then drop the falsy results, in one pass the model can't mismatch`(
        {
          input: [z.lambda],
          inputRest: listAlike,
          output: [listAlike],
          type: dedent`
          {
            <T, B>(f: (x: T) => B | false | null, xs: List<T>): List<Exclude<B, false | null>>;
            <A, B, R>(f: (a: A, b: B) => R | false | null, as: List<A>, bs: List<B>): List<Exclude<R, false | null>>;
          }
        `,
        },
        `(lambda (fn . lists)
         (filter (lambda (x) x) (apply map fn lists)))`,
      ),

      // Output z.schemeNumber, not z.exact: the value IS `length`'s return, and length's
      // own declared output is z.schemeNumber — match the verb we delegate to.
      count: symbol.define`count: how many element-tuples across the parallel lists satisfy pred`(
        {
          input: [z.lambda],
          inputRest: listAlike,
          output: [z.schemeNumber],
          type: dedent`
          {
            <T>(p: (x: T) => unknown, xs: List<T>): number;
            <A, B>(p: (a: A, b: B) => unknown, as: List<A>, bs: List<B>): number;
          }
        `,
        },
        `(lambda (pred . lists)
         (length (filter (lambda (b) b) (apply map pred lists))))`,
      ),

      // Output z.schemeValue, as concatenate: the appended results may embed an improper tail.
      "append-map": symbol.define`append-map: map then append the result lists`(
        {
          input: [z.lambda],
          inputRest: listAlike,
          output: [z.schemeValue],
          type: dedent`
          {
            <T, B>(f: (x: T) => List<B>, xs: List<T>): List<B>;
            <A, B, R>(f: (a: A, b: B) => List<R>, as: List<A>, bs: List<B>): List<R>;
          }
        `,
        },
        `(lambda (fn . lists)
         (apply append (apply map fn lists)))`,
      ),

      // any?/every? — honest #t/#f quantifiers; bare any/every are SRFI-1 value-returning
      // (see DEVIATIONS). some aliases any? (symbol.alias, not a wrapper). Private helpers
      // below; bodies use #t/#f literals (not core true/false — would force deps:[core]
      // on the C3 floor). Value-returning helpers bind the pred result in `let` so a
      // '()-returning pred propagates '() (R7RS-truthy), not #t.
      "%any-null?":
        symbol.define`%any-null?: #t iff any of the parallel lists is exhausted (private helper for %some/%any/%every/%every-value)`(
          { input: [listAlike], output: [z.boolean] },
          `(lambda (lst)
         (let loop ((lst lst))
           (if (null? lst)
               #f
               (if (null? (car lst))
                   #t
                   (loop (cdr lst))))))`,
        ),

      "%some":
        symbol.define`%some: #t iff fn holds for some element-tuple of the parallel lists (private helper for any?, aliased as some)`(
          { input: [z.lambda, listAlike], output: [z.boolean] },
          `(lambda (fn lists)
         (let loop ((lists lists))
           (if (or (null? lists) (%any-null? lists))
               #f
               (if (apply fn (map car lists))
                   #t
                   (loop (map cdr lists))))))`,
        ),

      "any?":
        symbol.define`any?: #t iff pred holds for some element-tuple across the parallel lists (HONEST boolean predicate — SRFI-1's own \`any\` returns the predicate's truthy RESULT instead; see bare \`any\`)`(
          {
            input: [z.lambda],
            inputRest: listAlike,
            output: [z.boolean],
            type: dedent`
          {
            <T>(p: (x: T) => unknown, xs: List<T>): boolean;
            <A, B>(p: (a: A, b: B) => unknown, as: List<A>, bs: List<B>): boolean;
            <A, B, C>(p: (a: A, b: B, c: C) => unknown, as: List<A>, bs: List<B>, cs: List<C>): boolean;
          }
        `,
          },
          `(lambda (fn . lists)
         (%some fn lists))`,
        ),
      // Ramda-familiar name for any? — #t/#f; dissolves to any? byte-for-byte via
      // symbol.alias (never its own wrapper).
      some: symbol.alias`any?`,

      "%any":
        symbol.define`%any: first truthy predicate RESULT across the parallel lists, or #f (private helper for any)`(
          { input: [z.lambda, listAlike], output: [z.schemeValue] },
          `(lambda (fn lists)
         (let loop ((lists lists))
           (if (or (null? lists) (%any-null? lists))
               #f
               (let ((r (apply fn (map car lists))))
                 (if r r (loop (map cdr lists)))))))`,
        ),

      // Bare `any` is SRFI-1's OWN `any` — the first truthy predicate RESULT (not the
      // element, not a collapsed #t), or #f. See any?/some for the honest boolean twin.
      any: symbol.define`any: SRFI-1's \`any\` — the first truthy predicate RESULT across the parallel lists (not the element!), or #f; R7RS truthiness means a '()-returning predicate yields '() itself (see any? / some for the honest boolean)`(
        {
          input: [z.lambda],
          inputRest: listAlike,
          output: [z.schemeValue],
          type: dedent`
          {
            <T, R>(p: (x: T) => R, xs: List<T>): R | false;
            <A, B, R>(p: (a: A, b: B) => R, as: List<A>, bs: List<B>): R | false;
            <A, B, C, R>(p: (a: A, b: B, c: C) => R, as: List<A>, bs: List<B>, cs: List<C>): R | false;
          }
        `,
        },
        `(lambda (fn . lists)
         (%any fn lists))`,
      ),

      "%every":
        symbol.define`%every: #t iff fn holds for every element-tuple of the parallel lists (private helper for every?)`(
          { input: [z.lambda, listAlike], output: [z.boolean] },
          `(lambda (fn lists)
         (let loop ((lists lists))
           (if (or (null? lists) (%any-null? lists))
               #t
               (if (apply fn (map car lists))
                   (loop (map cdr lists))
                   #f))))`,
        ),

      "every?":
        symbol.define`every?: #t iff pred holds for every element-tuple across the parallel lists (HONEST boolean predicate; vacuously #t on empty — SRFI-1's own \`every\` returns the LAST predicate's RESULT instead; see bare \`every\`)`(
          {
            input: [z.lambda],
            inputRest: listAlike,
            output: [z.boolean],
            type: dedent`
          {
            <T>(p: (x: T) => unknown, xs: List<T>): boolean;
            <A, B>(p: (a: A, b: B) => unknown, as: List<A>, bs: List<B>): boolean;
            <A, B, C>(p: (a: A, b: B, c: C) => unknown, as: List<A>, bs: List<B>, cs: List<C>): boolean;
          }
        `,
          },
          `(lambda (fn . lists)
         (%every fn lists))`,
        ),

      "%every-value":
        symbol.define`%every-value: the LAST predicate RESULT if every element-tuple is truthy, #t on the empty list, #f on the first falsy result (private helper for every)`(
          { input: [z.lambda, listAlike], output: [z.schemeValue] },
          `(lambda (fn lists)
         (let loop ((lists lists) (last #t))
           (if (or (null? lists) (%any-null? lists))
               last
               (let ((r (apply fn (map car lists))))
                 (if r
                     (loop (map cdr lists) r)
                     #f)))))`,
        ),

      // Bare `every` is SRFI-1's OWN `every` — the LAST predicate RESULT once every
      // element-tuple has been truthy, #t on the empty list (vacuous truth, matches
      // every?), #f on the first falsy result (short-circuits, same as every?). See
      // every? for the honest boolean twin.
      every:
        symbol.define`every: SRFI-1's \`every\` — the LAST predicate RESULT if every element-tuple across the parallel lists is truthy, #t on the empty list, #f on the first falsy result (see every? for the honest boolean)`(
          {
            input: [z.lambda],
            inputRest: listAlike,
            output: [z.schemeValue],
            type: dedent`
          {
            <T, R>(p: (x: T) => R, xs: List<T>): R | boolean;
            <A, B, R>(p: (a: A, b: B) => R, as: List<A>, bs: List<B>): R | boolean;
            <A, B, C, R>(p: (a: A, b: B, c: C) => R, as: List<A>, bs: List<B>, cs: List<C>): R | boolean;
          }
        `,
          },
          `(lambda (fn . lists)
         (%every-value fn lists))`,
        ),

      // Named-let idiom (see the file header's PERF PROTOCOL note) — a
      // self-recursive body would otherwise re-enter its own wrapper via
      // (apply zip …) per element. The loop's (some null? ls) sibling call still
      // crosses the boundary once per element — negligible against interpretation
      // cost; the validate:false valve stays unused.
      zip: symbol.define`zip: transpose parallel lists into a list of tuples; stops at the shortest`(
        {
          input: [],
          inputRest: listAlike,
          output: [listAlike],
          type: dedent`
          {
            <A>(as: List<A>): List<List<A>>;
            <A, B>(as: List<A>, bs: List<B>): List<[A, B]>;
            <A, B, C>(as: List<A>, bs: List<B>, cs: List<C>): List<[A, B, C]>;
          }
        `,
        },
        `(lambda lists
         (let loop ((ls lists))
           (if (or (null? ls) (some null? ls))
               '()
               (cons (map car ls) (loop (map cdr ls))))))`,
      ),

      "list-index": symbol.define`list-index: index of the first element-tuple satisfying pred, or #f`(
        {
          input: [z.lambda],
          inputRest: listAlike,
          output: [z.union([z.exact, z.booleanFalse])],
          type: dedent`
          {
            <T>(p: (x: T) => unknown, xs: List<T>): number | false;
            <A, B>(p: (a: A, b: B) => unknown, as: List<A>, bs: List<B>): number | false;
          }
        `,
        },
        `(lambda (pred . lists)
         (let loop ((i 0) (ls lists))
           (if (some null? ls) #f
               (if (apply pred (map car ls)) i
                   (loop (+ i 1) (map cdr ls))))))`,
      ),

      // NOT SRFI-1's four-procedure unfold — arrival's historical shape (fn returns
      // (head . next) or #f to stop), preserved 1:1.
      unfold: symbol.define`unfold: build a list by iterating fn from init; fn returns (head . next) or #f to stop`(
        {
          input: [z.lambda, z.schemeValue],
          output: [listAlike],
          type: dedent`
          {
            <S, T>(f: (state: S) => [T, S] | false | null, init: S): List<T>;
          }
        `,
        },
        `(lambda (fn init)
         (let iter ((pair (fn init)) (result '()))
           (if (not pair)
               (reverse result)
               (iter (fn (cdr pair)) (cons (car pair) result)))))`,
      ),

      // Official SRFI-1 names not live above — purity / subset doors (see DOORS).
      ...DOOR_SYMBOLS,
    };
  },
});
