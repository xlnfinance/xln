// Promise utilities for the trampoline's async seams.
//
// Structures hold promise-valued members INERT — the membrane's Promise row is "raw
// passthrough, the trampoline awaits". The interpreter awaits lazily at the seams
// where a value is actually NEEDED: the trampoline's settle points, the HOF
// result-collection sites (`promise_all` below), and the op-return seam. Eager
// traversal of structures to hunt promises is exactly the work this design avoids —
// a scheme callable structurally cannot return a raw array or plain object (an
// AValue has a class prototype), so the only live callers ever hand these utilities
// boxed SchemeValues (or promises thereof), never a structure to walk.
//
// Cross-cutting leaf (hermeticity audit P5): consumed by values/primitives
// (APair/AVector/pending-entry), env/*, and eval/call-function.ts alike, so it
// stays in utils/ rather than moving into any one layer — moving it into eval/
// (its pre-P3 import origin for is_promise) would reintroduce exactly the
// values→eval edge P3 closed. `is_promise` now imports from the true
// value-kernel leaf (values/value-guards.ts), so this module's only dependency
// is a value-type predicate — no eval or membrane edge remains.

import { is_promise } from "../values/value-guards.js";

/** HOF result-collection awaits one level when the whole collection is needed. */
export function promise_all(arg: unknown[]): Promise<unknown[]> | unknown[] {
  if (Array.isArray(arg)) {
    return Promise.all(arg);
  }
  return arg;
}

/** Sync-fast-path `then`: apply `fn` to a maybe-promise WITHOUT taxing the sync
 *  case with a microtask. A synchronous value stays synchronous (the trampoline's
 *  performance contract); a promise chains. The single-promise seam for "the
 *  callback might be async". */
export function maybeThen(
  value: unknown,
  fn: (x: unknown) => unknown,
  error: ((e: unknown) => void) | null = null,
): unknown {
  if (is_promise(value)) {
    const ret = (value as Promise<unknown>).then(fn);
    return error === null ? ret : ret.catch(error);
  }
  return fn(value);
}
