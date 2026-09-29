// ─────────────────────────────────────────────────────────────────────────────
// `cons` — prepend an element onto a list (the canonical cons).
//
// Scheme semantics: (cons head tail) → a new list with head prepended to tail.
// // ─────────────────────────────────────────────────────────────────────────────

declare function cons<H, T>(head: H, tail: List<T>): List<H | T>;
