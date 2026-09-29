// ─────────────────────────────────────────────────────────────────────────────
// `reduce` — left fold over a list with an explicit seed.
//
// Scheme / runtime: (reduce fn init list) — `fn` is **(element, acc) → acc**
// (SRFI-1 / arrival tagless: "scheme convention fn(element, acc)", NOT JS
// Array.reduce's (acc, element)). Arg order of reduce itself is (fn, init, xs).
// Polymorphic in element A and accumulator B (e.g. strings → number).
//
// `NoInfer<B>` on init: empty seed `[]` must not pin B to `never[]` before the
// callback return is known — otherwise (cons x acc) under `'()` fails.
// // ─────────────────────────────────────────────────────────────────────────────

declare function reduce<A, B>(fn: (x: A, acc: B) => B, init: NoInfer<B>, xs: List<A>): B;
