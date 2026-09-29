// ─────────────────────────────────────────────────────────────────────────────
// `zero?`, `even?`, `odd?`, `null?`, `empty?`, `not`, `equal?`, `eq?`
//   — predicate family.
//
// Scheme semantics:
//   (zero? n)     → #t iff n is 0
//   (even? n)     → #t iff n is even
//   (odd? n)      → #t iff n is odd
//   (null? xs)    → #t iff xs is the empty list / nil
//   (empty? xs)   → #t iff xs is the empty list / nil
//   (not v)       → #t iff v is #f (R7RS: only #f is falsy)
//   (equal? a b)  → #t iff a and b are structurally equal
//   (eq? a b)     → #t iff a and b are identical (reference equal)
//
// // ─────────────────────────────────────────────────────────────────────────────

declare function zero$qmark$(n: number): boolean;
declare function even$qmark$(n: number): boolean;
declare function odd$qmark$(n: number): boolean;
declare function null$qmark$(xs: List<unknown>): boolean;
declare function empty$qmark$(xs: List<unknown>): boolean;
declare function not(v: unknown): boolean;
declare function equal$qmark$(a: unknown, b: unknown): boolean;
declare function eq$qmark$(a: unknown, b: unknown): boolean;
