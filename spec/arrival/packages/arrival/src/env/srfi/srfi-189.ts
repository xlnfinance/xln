// SRFI-189 — Maybe & Either (tagged-list values). Scheme-bootstrap capability.
//
// DEPS: every body below reaches for `list`/`car`/`cdr`/`null?` (list construction/
// access), `pair?`/`eq?` (equality), and `error` (the exception-handling `error`
// procedure) — `deps: [equality, exceptions, lists]` below is the complete set,
// each a declared edge. `car`/`cdr` are the ONE exception: the resolver-synth
// `c[ad]+r` family needs no dep at all, bare or nested (`(car (cdr m))`).
//   - `equality` (r7rs/equality.ts, `pair?`/`eq?`) is a JS-native pack —
//     not a BASE_PACKS root; deps is enough.
//   - `lists` (r7rs/lists.ts, `list`) and `exceptions` (r7rs/exceptions.ts,
//     `error`) ARE BASE_PACKS members, positioned in base-packs.ts's C3 tail
//     block for exactly this kind of edge (a dependency must rank BELOW every
//     dependent naming it) — see base-packs.ts's own header.
//   - The `deps` ARRAY ORDER also matters: `c3Linearize` feeds a pack's declared
//     `deps` order in as a merge input beside the root array's own order, so
//     this array is `[equality, exceptions, lists]` to AGREE with base-packs.ts's
//     tail-block order (`exceptions` before `lists`).
//
// Faithfulness note: `error`'s scheme-level `error` procedure (not a bare JS throw)
// is used deliberately — `maybe-ref`/`either-ref`/`either-swap`'s failure path
// integrates with `with-exception-handler`'s handler-stack machinery (raise pops/
// dispatches the current handler; a JS-native throw would bypass that entirely) —
// see r7rs/exceptions.ts. A program that wraps `(with-exception-handler h (lambda
// () (maybe-ref (nothing))))` must see its handler invoked exactly as any other
// raise would; a real `deps` edge on `exceptions` is the honest way to keep that.
//
// Contract choices:
//   - Maybe/Either VALUES themselves (the tagged lists `(just x)`/`(nothing)`/
//     `(left x)`/`(right x)` build and every predicate/accessor/combinator reads) are
//     `z.schemeValue` — scheme-zod.ts has no dedicated "tagged variant" vocabulary item (the
//     same "no dedicated vocabulary item" reasoning r7rs/exceptions.ts's own
//     `%current-handlers` stack slot documents), and a fixed-heads `z.list([z.symbol,
//     z.schemeValue])` would force a symbol-codec round-trip (JS `symbol` ↔ `ASymbol`) onto
//     a purely-internal tag no consumer ever needs decoded — `z.schemeValue`'s
//     representation-blind identity is the honest ceiling here, matching every other
//     "no vocabulary item" slot in this codebase.
//   - `maybe->list`/`either->list` are the one place a TIGHTER contract than `z.schemeValue`
//     is both correct and free: their body ALWAYS returns a genuine 0-or-1-element
//     proper scheme list (`(list …)` or `'()`) — `z.list(z.schemeValue)` (scheme-zod.ts's own
//     `AListAlike` codec) documents that honestly. Contract enforcement is VALIDATE-
//     ONLY (`define-bake.ts`'s `buildDefineProcedure`: `z.decode`'s result is discarded,
//     the original scheme value flows through unchanged) — `z.list`'s codec never
//     actually converts the returned value to a JS array at the call boundary, so this
//     tightening costs nothing but a spine-shape check.
//   - `list->maybe`'s `lst` input is `z.list(z.schemeValue)` for the same reason (the body's
//     own `null?`/`car` calls already assume a proper list; only the FIRST element is
//     read, so no fixed-length constraint, just "proper list").
//   - `maybe-ref`/`either-ref`'s optional `failure` procedure is `inputRest: z.lambda`
//     (0-or-1 in practice — the body only ever reads `(car failure)` once — but SRFI-
//     189's own signature is variadic-rest shaped, matching `error`'s own `inputRest`
//     convention in r7rs/exceptions.ts).
//   - Every `f`/callback slot (`maybe-bind`/`maybe-map`/`either-bind`/`either-map`) is
//     `z.lambda` — a real procedure value, contract-enforced: a non-callable `f`
//     rejects at the contract boundary, not with a raw scheme apply-error deep
//     inside the call.
import { EnvCapability } from "../../common/capability.js";
import equality from "../r7rs/equality.js";
import exceptions from "../r7rs/exceptions.js";
import lists from "../r7rs/lists.js";

export default EnvCapability.define("scheme/srfi-189", {
  // See the file header's DEPS note — deps order agrees with base-packs.ts's
  // tail-block order (exceptions before lists) so the two C3 merge inputs never
  // contradict.
  deps: [equality, exceptions, lists],
  symbols: (symbol, z) => ({
    // ── constructors ──────────────────────────────────────────────────────────
    just: symbol.define`just: SRFI-189 — wrap x as a Just (the present/success case of Maybe)`(
      { input: [z.schemeValue], output: [z.schemeValue] },
      `(lambda (x) (list 'just x))`,
    ),
    nothing: symbol.define`nothing: SRFI-189 — the absent Maybe (Nothing); a 0-argument constructor`(
      { input: [], output: [z.schemeValue] },
      `(lambda () (list 'nothing))`,
    ),
    left: symbol.define`left: SRFI-189 — wrap x as a Left (conventionally the failure/error case of Either)`(
      { input: [z.schemeValue], output: [z.schemeValue] },
      `(lambda (x) (list 'left x))`,
    ),
    right: symbol.define`right: SRFI-189 — wrap x as a Right (conventionally the success case of Either)`(
      { input: [z.schemeValue], output: [z.schemeValue] },
      `(lambda (x) (list 'right x))`,
    ),

    // ── predicates ────────────────────────────────────────────────────────────
    "just?": symbol.define`just?: #t iff m is a Just`(
      { input: [z.schemeValue], output: [z.boolean] },
      `(lambda (m) (and (pair? m) (eq? (car m) 'just)))`,
    ),
    "nothing?": symbol.define`nothing?: #t iff m is Nothing`(
      { input: [z.schemeValue], output: [z.boolean] },
      `(lambda (m) (and (pair? m) (eq? (car m) 'nothing)))`,
    ),
    "maybe?": symbol.define`maybe?: #t iff m is a Just or Nothing`(
      { input: [z.schemeValue], output: [z.boolean] },
      `(lambda (m) (or (just? m) (nothing? m)))`,
    ),
    "left?": symbol.define`left?: #t iff e is a Left`(
      { input: [z.schemeValue], output: [z.boolean] },
      `(lambda (e) (and (pair? e) (eq? (car e) 'left)))`,
    ),
    "right?": symbol.define`right?: #t iff e is a Right`(
      { input: [z.schemeValue], output: [z.boolean] },
      `(lambda (e) (and (pair? e) (eq? (car e) 'right)))`,
    ),
    "either?": symbol.define`either?: #t iff e is a Left or Right`(
      { input: [z.schemeValue], output: [z.boolean] },
      `(lambda (e) (or (left? e) (right? e)))`,
    ),

    // ── Maybe accessors / combinators ────────────────────────────────────────
    "maybe-ref": symbol.define`maybe-ref: unwrap a Just; on Nothing call the optional failure thunk (default: error)`(
      { input: [z.schemeValue], inputRest: z.lambda, output: [z.schemeValue] },
      `(lambda (m . failure)
         (cond ((just? m) (car (cdr m)))
               ((pair? failure) ((car failure)))
               (else (error "maybe-ref: Nothing"))))`,
    ),
    "maybe-ref/default": symbol.define`maybe-ref/default: unwrap a Just, or return default on Nothing`(
      { input: [z.schemeValue, z.schemeValue], output: [z.schemeValue] },
      `(lambda (m default) (if (just? m) (car (cdr m)) default))`,
    ),
    "maybe-bind": symbol.define`maybe-bind: monadic bind — apply f to the wrapped value; Nothing short-circuits`(
      { input: [z.schemeValue, z.lambda], output: [z.schemeValue] },
      `(lambda (m f) (if (just? m) (f (car (cdr m))) m))`,
    ),
    "maybe-map": symbol.define`maybe-map: map f over the wrapped value, preserving Nothing`(
      { input: [z.lambda, z.schemeValue], output: [z.schemeValue] },
      `(lambda (f m) (if (just? m) (just (f (car (cdr m)))) m))`,
    ),
    "maybe->list": symbol.define`maybe->list: a Just becomes a 1-element list; Nothing becomes '()`(
      { input: [z.schemeValue], output: [z.list(z.schemeValue)] },
      `(lambda (m) (if (just? m) (list (car (cdr m))) '()))`,
    ),
    "list->maybe": symbol.define`list->maybe: the empty list becomes Nothing; else Just of the first element`(
      { input: [z.list(z.schemeValue)], output: [z.schemeValue] },
      `(lambda (lst) (if (null? lst) (nothing) (just (car lst))))`,
    ),
    "maybe->either": symbol.define`maybe->either: a Just becomes Right; Nothing becomes Left of no-just`(
      { input: [z.schemeValue, z.schemeValue], output: [z.schemeValue] },
      `(lambda (m no-just) (if (just? m) (right (car (cdr m))) (left no-just)))`,
    ),

    // ── Either accessors / combinators ───────────────────────────────────────
    "either-ref":
      symbol.define`either-ref: unwrap a Right; on Left call the optional failure procedure with the left value (default: error)`(
        { input: [z.schemeValue], inputRest: z.lambda, output: [z.schemeValue] },
        `(lambda (e . failure)
         (cond ((right? e) (car (cdr e)))
               ((pair? failure) ((car failure) (car (cdr e))))
               (else (error "either-ref: Left"))))`,
      ),
    "either-ref/default": symbol.define`either-ref/default: unwrap a Right, or return default on Left`(
      { input: [z.schemeValue, z.schemeValue], output: [z.schemeValue] },
      `(lambda (e default) (if (right? e) (car (cdr e)) default))`,
    ),
    "either-bind": symbol.define`either-bind: monadic bind — apply f to the Right value; Left short-circuits`(
      { input: [z.schemeValue, z.lambda], output: [z.schemeValue] },
      `(lambda (e f) (if (right? e) (f (car (cdr e))) e))`,
    ),
    "either-map": symbol.define`either-map: map f over a Right, preserving Left`(
      { input: [z.lambda, z.schemeValue], output: [z.schemeValue] },
      `(lambda (f e) (if (right? e) (right (f (car (cdr e)))) e))`,
    ),
    "either->list": symbol.define`either->list: a Right becomes a 1-element list; Left becomes '()`(
      { input: [z.schemeValue], output: [z.list(z.schemeValue)] },
      `(lambda (e) (if (right? e) (list (car (cdr e))) '()))`,
    ),
    "either-swap": symbol.define`either-swap: swap a Left and a Right (errors on a non-Either)`(
      { input: [z.schemeValue], output: [z.schemeValue] },
      `(lambda (e)
         (cond ((left? e) (right (car (cdr e))))
               ((right? e) (left (car (cdr e))))
               (else (error "either-swap: not an Either"))))`,
    ),
  }),
});
