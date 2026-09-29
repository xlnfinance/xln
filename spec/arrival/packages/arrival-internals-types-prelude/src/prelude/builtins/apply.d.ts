// ─────────────────────────────────────────────────────────────────────────────
// `apply` — spread a list as the arguments of a function.
//
// Scheme semantics: (apply f args-list) → (f . args-list), i.e. call `f` with the
// elements of `args-list` spread as its positional arguments.
// The list spread back into parameters is the bite: `args` must be the function's
// own parameter tuple `A` (a `List<A[number]>` view), and the call yields `R`. A
// wrong-element-typed list (`apply` of a numeric fn over a list of strings) or a
// non-function first arg fails.
// // ─────────────────────────────────────────────────────────────────────────────

// `(apply + xs)` with xs: List<number> unifies cleanly against rest `number[]`.
declare function apply<A extends unknown[], R>(f: (...a: A) => R, args: A): R;
