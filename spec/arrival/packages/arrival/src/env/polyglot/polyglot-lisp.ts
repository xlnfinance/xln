// @inhuman.tools/arrival/polyglot-lisp — the Common Lisp dialect pack (see
// polyglot.ts's header for the sibling-pack map).
//
// The smallest of the three dialect packs, by design: CL's list-manipulation
// surface overlaps almost entirely with R7RS/SRFI-1 (map IS mapcar's argument
// order; filter IS remove-if/remove-if-not with the sense flipped/kept), so only
// the NAME is missing, not the behavior. `type-of`, `setf`, `defun`, `loop`,
// `nreverse`, `gethash`, `getf`, `with-open-file` — the genuinely impure/
// reflective/macro-only CL cousins — are doored instead, in the Common Lisp
// section of env/polyglot-stubs.ts.
//
// DEPS: cross-capability free names (the FV-locality rule is stated once in
// polyglot.ts's header) —
//   srfi-1   — filter
//   equality — not
//   lists    — apply cons map
// deps order matches base-packs.ts's C3 tail-block order (dependents before
// dependencies) — see base-packs.ts's own header. This pack needs no dep on
// `scheme/polyglot` (core) at all — unlike its Clojure/Racket siblings, nothing
// here reaches `@`/`@?`/`@keys`/`dict`/`compose` — the cleanest of the three
// dialect packs to assemble standalone.

import { EnvCapability } from "../../common/capability.js";
import equality from "../r7rs/equality.js";
import lists from "../r7rs/lists.js";
import srfi1 from "../srfi/srfi-1.js";

// See polyglot.ts's own note: a one-line local const is cheaper than a cross-pack
// named export for a pure contract-vocabulary helper.
export default EnvCapability.define("scheme/polyglot-lisp", {
  deps: [srfi1, equality, lists],
  symbols: (symbol, z) => {
    const applicable = z.union([z.lambda, z.symbol]);
    return {
      // mapcar — Common Lisp: identical argument order to R7RS map (proc, then one
      // or more lists), so it is a direct alias. `f` passes through to map's own
      // dispatch (z.schemeValue); the lists are real list spines (CL mapcar is list-only,
      // and map over lists yields a list — the honest output).
      mapcar:
        symbol.define`mapcar: Common Lisp — identical argument order to R7RS map (proc, then one or more lists); a direct alias`(
          { input: [z.schemeValue], inputRest: z.list(), output: [z.list()] },
          `(lambda (f . lists) (apply map (cons f lists)))`,
        ),
      // remove-if / remove-if-not — Common Lisp: filter, with the sense of the
      // predicate flipped / kept. remove-if APPLIES pred itself (the negating
      // wrapper) → applicable; remove-if-not passes pred straight through to filter
      // (whose dispatch owns the callable-or-RegExp polymorphism) → z.schemeValue. The
      // sequence stays z.schemeValue both times: filter is term-dispatched (a vector is a
      // legal receiver returning a vector), so `z.list()` in/out would narrow it.
      "remove-if":
        symbol.define`remove-if: Common Lisp — keep the elements NOT satisfying pred (filter with the sense flipped)`(
          { input: [applicable, z.schemeValue], output: [z.schemeValue] },
          `(lambda (pred lst) (filter (lambda (x) (not (pred x))) lst))`,
        ),
      "remove-if-not": symbol.define`remove-if-not: Common Lisp — keep the elements satisfying pred (a filter alias)`(
        { input: [z.schemeValue, z.schemeValue], output: [z.schemeValue] },
        `(lambda (pred lst) (filter pred lst))`,
      ),
    };
  },
});
