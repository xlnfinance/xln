// ─────────────────────────────────────────────────────────────────────────────
// `append` — concatenate zero or more lists into a single list.
//
// Scheme semantics: (append list …) → a list containing all elements of each
// input list in order. Every argument must be a list of the same element type T;
// the result is `List<T>`. Zero arguments yields an empty list (null ≡ List<never>).
//
// Rest is `List<T>[]` — same array dialect as List itself, so
// `(apply append (map …))` with a List<List<T>> args list unifies.
// ─────────────────────────────────────────────────────────────────────────────

declare function append<T>(...xs: List<T>[]): List<T>;
