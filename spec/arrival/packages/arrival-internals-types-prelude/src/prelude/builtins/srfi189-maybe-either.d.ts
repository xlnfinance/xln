// ─────────────────────────────────────────────────────────────────────────────
// SRFI-189 Maybe & Either — the CONTAINER family.
//
// Scheme semantics (constructors/accessors/combinators over Maybe and Either):
//   (just x)              → a Just wrapping x
//   (nothing)             → the empty Maybe
//   (left x) / (right x)  → the two sides of an Either
//   just? / nothing? / maybe? / left? / right? / maybe?  → tag predicates → #t/#f
//   maybe-bind / maybe-map / either-bind / either-map     → monadic combinators
//   maybe-ref / maybe-ref/default / either-ref / …        → unwrap (precise value)
//   maybe->either / maybe->list / either->list / either-swap / list->maybe → coercions
//
// Runtime truth — Maybe/Either are TAGGED LISTS, not opaque boxes
// (the `any` impls these SHARPEN — do NOT import them):
//     (just x)    = (list 'just x)     → JS runtime value  ['just', x]
//     (nothing)   = (list 'nothing)    → ['nothing']
//     (left x)    = (list 'left x)     → ['left', x]
//     (right x)   = (list 'right x)    → ['right', x]
//     just?  m  = (and (pair? m) (eq? (car m) 'just))
//     maybe? m  = (or (just? m) (nothing? m))
//     maybe-ref m         = (car (cdr m)) on Just
//     maybe-bind m f      = (f (car (cdr m))) on Just, else m
//     maybe-map  f m      = (just (f val)) on Just, else m
//     either-bind e f     = (f val) on Right, else e
//     either-swap e       = (left x)<->(right x)
//
// Exposed to the inference env via SAFE_BUILTINS.
//
// MODELING (v1, FAITHFUL-PRECISE — the tagged-list repr is statically expressible):
//   A Maybe<T>  is the literal-tagged tuple  ['just', T] | ['nothing'].
//   An Either   is                            ['left', L] | ['right', R].
// These are EXACTLY the runtime values, so the tags discriminate and T/L/R thread
// through map/bind/ref precisely. Because PRE forbids a top-level `Maybe<T>` alias
// (declaration-merge collision), the union is written INLINE in every signature
// (verbose but honest). A shared `Maybe<T>`/`Either<L,R>` brand in PRE would
// collapse the verbosity — deferred, NOT added here (a PRE-level change).
//
// Tags are written as the runtime symbol strings ('just'/'nothing'/'left'/'right').
// `?`/`>`/`/`-bearing names → bracketed string keys.
// ─────────────────────────────────────────────────────────────────────────────

// ── Maybe constructors ──────────────────────────────────────────────────────
declare function just<T>(x: T): ["just", T];
declare function nothing(): ["nothing"];

// ── Either constructors ─────────────────────────────────────────────────────
declare function left<L>(x: L): ["left", L];
declare function right<R>(x: R): ["right", R];

// ── Tag predicates — accept any value (impl guards with pair?), return boolean ─
// Arg typed `unknown`: these are GUARDS, valid to call on a non-Maybe (→ #f).
declare function just$qmark$(m: unknown): boolean;
declare function nothing$qmark$(m: unknown): boolean;
declare function maybe$qmark$(m: unknown): boolean;
declare function left$qmark$(e: unknown): boolean;
declare function right$qmark$(e: unknown): boolean;

// ── Maybe combinators ───────────────────────────────────────────────────────
// maybe-bind: Nothing short-circuits (returns the Nothing). Result unions the
// bound function's Maybe with the passed-through Nothing — faithful to the impl.
declare function maybe$dash$bind<T, R extends ["just", unknown] | ["nothing"]>(
  m: ["just", T] | ["nothing"],
  f: (x: T) => R,
): R | ["nothing"];
// maybe-map: maps the wrapped value, preserving Nothing. NOTE: impl arg order is
// (f m) — function FIRST, unlike maybe-bind's (m f).
declare function maybe$dash$map<T, B>(f: (x: T) => B, m: ["just", T] | ["nothing"]): ["just", B] | ["nothing"];
// maybe-ref: unwrap a Just to its value. (Nothing → calls failure thunk / errors;
// statically the success type is the wrapped T.)
declare function maybe$dash$ref<T>(m: ["just", T] | ["nothing"], ...failure: [(() => T)?]): T;
// maybe-ref/default: Just value, else the default D — honest union.
declare function maybe$dash$ref$slash$default<T, D>(m: ["just", T] | ["nothing"], dflt: D): T | D;

// ── Maybe ⇄ Either / List coercions ─────────────────────────────────────────
// maybe->either: Just x → (right x); Nothing → (left no-just).
declare function maybe$dash$$greater$either<T, N>(m: ["just", T] | ["nothing"], noJust: N): ["right", T] | ["left", N];
// maybe->list: Just x → (x); Nothing → ().
declare function maybe$dash$$greater$list<T>(m: ["just", T] | ["nothing"]): List<T>;
// list->maybe: () → Nothing; (x …) → (just x).
declare function list$dash$$greater$maybe<T>(lst: List<T>): ["just", T] | ["nothing"];

// ── Either combinators ──────────────────────────────────────────────────────
// either-bind: Left short-circuits. (e f) — Either FIRST.
declare function either$dash$bind<L, R, O extends ["left", unknown] | ["right", unknown]>(
  e: ["left", L] | ["right", R],
  f: (x: R) => O,
): O | ["left", L];
// either-map: maps a Right, preserving Left. (f e) — function FIRST.
declare function either$dash$map<L, R, B>(f: (x: R) => B, e: ["left", L] | ["right", R]): ["left", L] | ["right", B];
// either-ref: unwrap a Right to its value (Left → failure/error).
declare function either$dash$ref<L, R>(e: ["left", L] | ["right", R], ...failure: [((l: L) => R)?]): R;
// either-ref/default: Right value, else default D.
declare function either$dash$ref$slash$default<L, R, D>(e: ["left", L] | ["right", R], dflt: D): R | D;
// either-swap: (left x) ⇄ (right x) — sides flip, payload types swap roles.
declare function either$dash$swap<L, R>(e: ["left", L] | ["right", R]): ["right", L] | ["left", R];
// either->list: Right x → (x); Left → ().
declare function either$dash$$greater$list<L, R>(e: ["left", L] | ["right", R]): List<R>;
