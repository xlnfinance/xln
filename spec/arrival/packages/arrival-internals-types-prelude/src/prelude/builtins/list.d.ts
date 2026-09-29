// ─────────────────────────────────────────────────────────────────────────────
// `list` — variadic list constructor.
//
// Scheme: (list x₀ … xₙ) → a proper list of the arguments.
//
// Fixed-arity overloads (arity ≥ 2) return TS tuples so `(apply f (list a b c))`
// unifies against `f`'s parameter list (apply.d.ts: `args: A` where A is the
// param tuple). Singleton `(list x)` is a homogeneous List — seeds/pools like
// `(iterate step (list seed) n)` must stay `List<T>`, not a 1-tuple that rejects
// recursive `step(pool)` results of variable length.
// Homogeneous rest (9+) falls through to `List<T>`.
// // ─────────────────────────────────────────────────────────────────────────────

declare function list(): [];
declare function list<A>(a: A): List<A>;
declare function list<A, B>(a: A, b: B): [A, B];
declare function list<A, B, C>(a: A, b: B, c: C): [A, B, C];
declare function list<A, B, C, D>(a: A, b: B, c: C, d: D): [A, B, C, D];
declare function list<A, B, C, D, E>(a: A, b: B, c: C, d: D, e: E): [A, B, C, D, E];
declare function list<A, B, C, D, E, F>(a: A, b: B, c: C, d: D, e: E, f: F): [A, B, C, D, E, F];
declare function list<A, B, C, D, E, F, G>(a: A, b: B, c: C, d: D, e: E, f: F, g: G): [A, B, C, D, E, F, G];
declare function list<A, B, C, D, E, F, G, H>(a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H): [A, B, C, D, E, F, G, H];
/** Homogeneous rest (9+ args or un-inferred). */
declare function list<T>(...xs: T[]): List<T>;
