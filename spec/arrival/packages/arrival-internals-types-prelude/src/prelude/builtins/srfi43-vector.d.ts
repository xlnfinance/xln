// ─────────────────────────────────────────────────────────────────────────────
// SRFI-43 vectors (pure ops only — arrival vectors are immutable).
//
// Scheme semantics:
//   (vector x …)                  → a vector of the given elements
//   (vector? x)                   → #t iff x is a vector
//   (vector-fold kons knil vec)   → left fold, (kons acc elt) across 0..n-1
//   (vector-fold-right kons knil vec) → right fold, across n-1..0
//   (vector-count pred vec)       → count of indices where (pred elt) is truthy
//   (vector-index pred vec)       → first index where (pred elt), else #f
//   (vector-any pred vec)         → first truthy (pred elt), else #f
//   (vector-every pred vec)       → last (pred elt) if all truthy, else #f
//   (vector-empty? vec)           → #t iff length 0
//   (vector-binary-search vec value cmp) → index where (cmp elt value)=0, else #f
//
// Runtime shape (the `any` impls these SHARPEN — do NOT import them):
//   • `vector` / `vector?` mint/test a BOXED SchemeVector. v1 MODELS A VECTOR AS
//     `List<T>` per the assignment — no distinct boxed brand is introduced here;
//     this is the documented coarse choice. (A `Vector<T>` brand wrapping
//     SchemeVector would be the v2 sharpening.)
//   • The pure SRFI-43 ops are define'd over vector-length/vector-ref:
//       vector-fold           — (kons acc elt), acc threads
//       vector-fold-right
//       vector-count          — pred → count (number)
//       vector-index          — first index | #f
//       vector-binary-search  — (vec value cmp), cmp→number, idx | #f
//       vector-empty?
//       vector-any            — first truthy (pred elt) | #f
//       vector-every          — last (pred elt) | #f
//
// Exposed to the inference env via SAFE_BUILTINS.
//
// MODELING (v1):
//   • vector V = `List<T>`. So vector-fold/any/etc. take `List<T>` and thread T into
//     the kons/pred callbacks exactly like the list-family leaves.
//   • Search/index ops return `number | boolean` (a real index, or #f on miss) — honest:
//     the impl returns #f, so a downstream use must account for the false case.
//   • vector-any/-every return the truthy callback result OR #f — typed as the
//     callback's result type unioned with boolean (the #f sentinel).
//
// `?`-names → bracketed string keys.
// ─────────────────────────────────────────────────────────────────────────────

// Construct a vector from its elements (v1: a List<T>). Variadic in elements.
declare function vector<T>(...elems: T[]): List<T>;
// Tag/type predicate — accepts any value, returns boolean.
declare function vector$qmark$(x: unknown): boolean;

// Folds — kons is (acc, elt) → acc'; the accumulator type A threads through.
declare function vector$dash$fold<A, T>(kons: (acc: A, elt: T) => A, knil: A, vec: List<T>): A;
declare function vector$dash$fold$dash$right<A, T>(kons: (acc: A, elt: T) => A, knil: A, vec: List<T>): A;

// Count of indices where the predicate holds → number.
declare function vector$dash$count<T>(pred: (elt: T) => unknown, vec: List<T>): number;
// First matching index, or #f → number | boolean.
declare function vector$dash$index<T>(pred: (elt: T) => unknown, vec: List<T>): number | boolean;

// Short-circuiting search — returns the truthy (pred elt) result, or #f.
declare function vector$dash$any<T, R>(pred: (elt: T) => R, vec: List<T>): R | boolean;
// Returns the last (pred elt) if all truthy, or #f.
declare function vector$dash$every<T, R>(pred: (elt: T) => R, vec: List<T>): R | boolean;

// Length-0 test → boolean.
declare function vector$dash$empty$qmark$<T>(vec: List<T>): boolean;

// Binary search — (vec, value, cmp) where cmp(elt, value) → number sign; index | #f.
declare function vector$dash$binary$dash$search<T>(
  vec: List<T>,
  value: T,
  cmp: (elt: T, value: T) => number,
): number | boolean;
