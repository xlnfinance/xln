// ─────────────────────────────────────────────────────────────────────────────
// the point-free / control combinators that are ACTUALLY LIVE in
// the inference env: `always`, `clone`, `repr`, `when`, `unless`.
//
// Scheme semantics:
//   (always x)          → a thunk returning x
//   (clone xs)          → a structural copy of the list/pair xs
//   (repr obj [quote])  → a printed-representation string of obj
//   (when test e ...)   → last e if test is truthy, else nil   (a macro)
//   (unless test e ...) → last e if test is falsy, else nil    (a macro)
//
// Only symbols that are actually bound at runtime are typed here — typing an
// unbound symbol would make the lens advertise a completion that fails at
// runtime. `when` / `unless` are macros; their honest return type is `T | null`
// (the last body value when the gate passes, else nil — NOT `void`).
//
// // ─────────────────────────────────────────────────────────────────────────────

declare function always<T>(x: T): () => T;
declare function clone<T>(xs: List<T>): List<T>;
declare function repr(obj: unknown, quote?: unknown): string;
declare function when<T>(test: unknown, ...body: T[]): T | null;
declare function unless<T>(test: unknown, ...body: T[]): T | null;
