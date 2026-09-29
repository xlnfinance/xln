// @inhuman.tools/arrival/polyglot-racket — the Racket dialect pack (see
// polyglot.ts's header for the sibling-pack map).
//
// Two families:
//   THREADING — `~>`/`~>>` (Racket's thread-first/thread-last spellings), ALIASES
//   expanding to Clojure's `->`/`->>` (polyglot-clojure.ts): this pack DEPENDS
//   ON polyglot-clojure rather than re-implementing the expansion independently.
//   `->`/`->>` are referenced only as quasiquoted DATA inside `~>`/`~>>`'s own
//   macro bodies (`\`(-> ,x ,@forms)`), so the static bake FV walker does NOT
//   force this edge (quasiquote space is data except under unquote) — but the
//   RESULTING expansion is a runtime Unbound-variable trap unless `->`/`->>` are
//   actually bound, so the edge is declared anyway for honest standalone
//   composition. Consequence: base-packs.ts positions this pack BEFORE
//   polyglot-clojure in the C3 tail (dependents before dependencies).
//   DICT ACCESSOR FAMILY (Racket's dict library) — grain-completion: models
//   reach for `dict-ref` to read a field off a dict-shaped tool result and get
//   stranded (Unbound variable). `@`/`:key` already read ANYTHING member-shaped
//   (dict / membrane-foreign / array — origin-agnostic, see polyglot.ts's
//   header), but a model trained on Racket's dict library reaches for its
//   actual name. This family is that name, PLUS the value `@` doesn't have:
//   dict-ref/dict-keys/… are dict-SPECIFIC — they guard the dict shape (see
//   %dict-guard) so a wrong-shaped argument fails loudly (door: fact + why +
//   action) instead of silently reading nil through `@`'s origin-agnostic
//   fallback. `assoc-ref` (Guile/Emacs Lisp) rides with this family — an
//   accessor-name alias of `dict-ref`, not a second read convention.
//
// %dict-guard — lives here rather than the shared core: its only consumers are
// this pack's own dict-* family, so it travels with them rather than sitting in
// core as a single-consumer helper.
//
// CONTRACT JUDGMENT for the whole dict-* family: `d` is `z.schemeValue` ON PURPOSE,
// never `z.dict()` — the %dict-guard TEACHING DOOR is this pack's own
// errors-as-doors surface (fact + why + action, naming `@` as the origin-agnostic
// alternative), and a `z.dict()` input contract would preempt it with a bare zod
// boundary error, destroying the door. The guard IS the validator here; the
// contract stays out of its way.
//
// DEPS: cross-capability free names (the FV-locality rule is stated once in
// polyglot.ts's header) —
//   scheme/polyglot-clojure — ~>/~>> expand to ->/->> (runtime binding reason)
//   scheme/polyglot (core)  — @ @? @keys dict nil %interleave str (door messages)
//   equality                — dict? pair? string? null? procedure?
//   numeric                 — number?
//   vectors                 — vector? vector->list
//   lists                   — map cons length apply
//   exceptions              — error
// deps order matches base-packs.ts's C3 tail-block order (dependents before
// dependencies) — see base-packs.ts's own header.

import { EnvCapability } from "../../common/capability.js";
import polyglotClojure from "./polyglot-clojure.js";
import polyglot from "./polyglot.js";
import equality from "../r7rs/equality.js";
import numeric from "../r7rs/numeric.js";
import vectors from "../r7rs/vectors.js";
import lists from "../r7rs/lists.js";
import exceptions from "../r7rs/exceptions.js";

export default EnvCapability.define("scheme/polyglot-racket", {
  deps: [polyglotClojure, polyglot, equality, numeric, exceptions, vectors, lists],
  symbols: (symbol, z) => ({
    // ═══════════════════════════════════════════════════════════════════════════
    // THREADING MACROS (Racket ~> ~>>) — aliases expanding to Clojure's -> ->>
    // ═══════════════════════════════════════════════════════════════════════════
    "~>": symbol.defineSyntax`~>: Racket's thread-first — an alias expanding to (-> …)`(
      `(lambda (x . forms) \`(-> ,x ,@forms))`,
      { macroAttribute: "expression" },
    ),
    "~>>": symbol.defineSyntax`~>>: Racket's thread-last — an alias expanding to (->> …)`(
      `(lambda (x . forms) \`(->> ,x ,@forms))`,
      { macroAttribute: "expression" },
    ),

    // ═══════════════════════════════════════════════════════════════════════════
    // RACKET — dict accessor family (Racket's dict library) — grain-completion
    // ═══════════════════════════════════════════════════════════════════════════
    "%dict-guard":
      symbol.define`%dict-guard: the dict? teaching guard shared by the dict-* family — returns d when dict-shaped, else throws the fact+why+action door (private helper)`(
        { input: [z.string, z.schemeValue], output: [z.dict()] },
        `(lambda (who d)
         (if (dict? d)
             d
             (error (str who ": expected a dict (native {…} / (dict …) record), got "
                         (cond ((pair? d) "a pair/list")
                               ((vector? d) "a vector")
                               ((string? d) "a string")
                               ((number? d) "a number")
                               ((null? d) "'() (empty list)")
                               ((procedure? d) "a procedure")
                               (else "a foreign/membrane value"))
                         " — " who " guards the dict shape so a wrong-shaped argument "
                         "fails loudly instead of silently reading nil; use @ for an "
                         "origin-agnostic read across dict/array/foreign values instead"))))`,
      ),
    // dict-ref — Racket: read the value at key, with an optional failure-result
    // when key is missing. Same missing-key convention as get-in/@ (nil when no
    // default is given — NOT a second convention); key may be a keyword (:key), a
    // quoted symbol, or a string, normalized identically to @/:key. `@?` (not a
    // bare `@` nil-check) distinguishes "key truly missing" from "key present with
    // a nil/'() value" before falling back. The optional default rides inputRest
    // (0-or-1 rest arg — the scheme rest-parameter shape).
    "dict-ref":
      symbol.define`dict-ref: Racket — the value at key in d, or the optional default (nil when absent and no default); keys normalize like @/:key`(
        { input: [z.schemeValue, z.schemeValue], inputRest: z.schemeValue, output: [z.schemeValue] },
        `(lambda (d key . default)
         (%dict-guard "dict-ref" d)
         (if (@? d key)
             (@ d key)
             (if (null? default) nil (car default))))`,
      ),
    // dict-has-key? — Racket: #t iff key resolves in d. A dict-guarded alias of @?
    // (whose verdict is the boxed schemeBool — hence a real z.boolean output).
    "dict-has-key?": symbol.define`dict-has-key?: Racket — #t iff key resolves in d; a dict-guarded alias of @?`(
      { input: [z.schemeValue, z.schemeValue], output: [z.boolean] },
      `(lambda (d key)
         (%dict-guard "dict-has-key?" d)
         (@? d key))`,
    ),
    // dict-keys — Racket: d's own keys as a proper scheme list. `@keys` alone
    // returns a raw JS array — composes with length, but not map/filter (see
    // %dict-set's comment in polyglot-clojure.ts) — so this lifts it via
    // vector->list once, the same move %dict-set already makes. Elements are the
    // boxed AString keys `@keys` mints → z.list(z.string).
    "dict-keys":
      symbol.define`dict-keys: Racket — d's own keys as a proper scheme list (the @keys array lifted via vector->list)`(
        { input: [z.schemeValue], output: [z.list(z.string)] },
        `(lambda (d)
         (%dict-guard "dict-keys" d)
         (vector->list (@keys d)))`,
      ),
    "dict-values": symbol.define`dict-values: Racket — the value at each of d's keys, in dict-keys order`(
      { input: [z.schemeValue], output: [z.list()] },
      `(lambda (d)
         (%dict-guard "dict-values" d)
         (map (lambda (k) (@ d k)) (dict-keys d)))`,
    ),
    // dict-count — Racket: the number of keys in d. `length` over a proper list
    // always yields an exact count (its own term boxes an AExact) → z.exact.
    "dict-count": symbol.define`dict-count: Racket — the number of keys in d`(
      { input: [z.schemeValue], output: [z.exact] },
      `(lambda (d)
         (%dict-guard "dict-count" d)
         (length (dict-keys d)))`,
    ),
    "dict->alist":
      symbol.define`dict->alist: d's entries as an alist of (key . value) pairs, in dict-keys order — the inverse of alist->dict`(
        { input: [z.schemeValue], output: [z.list(z.pair)] },
        `(lambda (d)
         (%dict-guard "dict->alist" d)
         (map (lambda (k) (cons k (@ d k))) (dict-keys d)))`,
      ),
    // alist->dict — the inverse of dict->alist: build a dict from an alist of
    // (key . value) pairs. Each key may be a keyword/symbol/string — the same
    // normalization `dict` itself already applies to its own :key args. The one
    // dict-family input that IS a real typed spine: a proper list of pairs.
    "alist->dict":
      symbol.define`alist->dict: build a dict from an alist of (key . value) pairs — the inverse of dict->alist; keys normalize like dict's own`(
        { input: [z.list(z.pair)], output: [z.dict()] },
        `(lambda (alist)
         (apply dict (%interleave (map car alist) (map cdr alist))))`,
      ),
    // dict-set / dict-update — DOORS, not functions. This env is immutable, and
    // a "set"/"update" VERB reads as in-place mutation: a pure implementation
    // returning a new dict is a trap — the model believes it mutated d, nothing
    // changed, and the failure is silent. So the verbs exist only to teach the
    // sanctioned pure path: assoc-in/update-in + (define …). Same family as the
    // SRFI-69 hash-table immutable-redirect stubs. SHAPELESS contracts (one line
    // each): the body unconditionally throws, so no input shape is ever
    // consumed and no output is ever produced — a fixed contract would be fiction.
    "dict-set":
      symbol.define`dict-set: a teaching DOOR — dicts are immutable here; build a NEW dict via assoc-in and bind it`(
        { input: [], inputRest: z.schemeValue, output: [z.schemeValue] },
        `(lambda _args
         (error (str "dict-set is not provided — dicts are immutable here, and a 'set' "
                     "verb implies in-place mutation, which never happens. Build a NEW "
                     "dict and bind it: (define d2 (assoc-in d (list :key) value)) — "
                     "the original d is unchanged.")))`,
      ),
    "dict-update":
      symbol.define`dict-update: a teaching DOOR — dicts are immutable here; build a NEW dict via update-in and bind it`(
        { input: [], inputRest: z.schemeValue, output: [z.schemeValue] },
        `(lambda _args
         (error (str "dict-update is not provided — dicts are immutable here, and an "
                     "'update' verb implies in-place mutation, which never happens. "
                     "Build a NEW dict and bind it: "
                     "(define d2 (update-in d (list :key) updater)) — "
                     "the original d is unchanged.")))`,
      ),

    // ═══════════════════════════════════════════════════════════════════════════
    // GUILE / EMACS LISP — accessor-name alias (rides with the dict family)
    // ═══════════════════════════════════════════════════════════════════════════
    // assoc-ref — Guile/Emacs Lisp: read by key, same polyglot-idiom principle as
    // the threading family — a model reaches for whichever accessor name it
    // already knows) — an alias of dict-ref, not a second read convention. Mirrors
    // dict-ref's contract exactly (including the z.schemeValue door-preserving d).
    "assoc-ref":
      symbol.define`assoc-ref: Guile/Emacs Lisp — read by key with an optional default; an alias of dict-ref, not a second read convention`(
        { input: [z.schemeValue, z.schemeValue], inputRest: z.schemeValue, output: [z.schemeValue] },
        `(lambda (d key . default)
         (apply dict-ref (cons d (cons key default))))`,
      ),
  }),
});
