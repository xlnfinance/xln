// ─────────────────────────────────────────────────────────────────────────────
// the SRFI-1-adjacent list family bound in the inference env: `take`,
// `drop`, `fold`, `nth`, `for-each`, `count`, `remove`.
// (`concat` deleted — use R7RS string-append / SRFI-13 string-join; `flatten` not bound.)
//
// NOT typed here, despite SRFI-1-familiar names — unbound in the inference env,
// so typing them would advertise symbols the sampler can select but the
// compiled program can't call:
//   • `head` / `tail` / `rest` / `init`.
//   • the SRFI-1 bootstrap procedures (`take-while` `drop-while` `span`
//     `partition` `find-tail` `fold-right` `concatenate` …) — defined into
//     user_env, but the inference env's own surface does not re-home them.
//
// `remove` is the inverse-filter (drop the elements matching pred) — a
// predicate-filter, NOT an index splice.
//
// The lens models a Scheme list as PRE's `List<T>` = `T[]`. Semantics that
// change the signatures:
//   • take / drop  — COUNT-first, list-LAST: prefix / suffix of length n.

// Prefix / suffix by count. Count-first, list-last; element type preserved.
declare function take<T>(n: number, xs: List<T>): List<T>;
declare function drop<T>(n: number, xs: List<T>): List<T>;

// Deep recursive flatten. Depth unbounded → element type collapses to `unknown`;
// the argument is still pinned to a list so a non-list bites.
declare function flatten(xs: List<unknown>): List<unknown>;

// Left fold (fn, init, list) with callback (element, acc) — Scheme order.
// NoInfer on init so empty `[]` seed does not pin B to never[] before the body.
declare function fold<A, B>(f: (x: A, acc: B) => B, init: NoInfer<B>, xs: List<A>): B;

// Indexed element read. Index-first, list-last; out-of-range is the miss value.
declare function nth<T>(index: number, xs: List<T>): T | undefined;

// Side-effecting iteration. Callback param bound to the element type; yields void.
declare function for$dash$each<A>(f: (a: A) => unknown, xs: List<A>): void;

// Count elements satisfying a predicate. Pred-first, list-last; result is a number.
declare function count<A>(pred: (a: A) => unknown, xs: List<A>): number;

// Inverse filter — drop the elements matching pred.
declare function remove<T>(pred: (x: T) => boolean, xs: List<T>): List<T>;
