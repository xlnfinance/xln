// ----------------------------------------------------------------------
// Function application chokepoint.
//
// `call_function` applies a Scheme function value (native builtin or
// generator-lambda) with a fresh call frame. A generator-lambda applied here
// via `fn.apply` returns `run(evalBegin(body))` itself (evaluator.ts —
// `canBounce === false`), so the generator drives the body. HOFs
// (map/filter/fold) work through this path — env/r7rs/lists.ts is the live
// consumer.
//
// `resolve_promises` collapses a tree of promises into a single promise, or
// returns the argument untouched when there are none.
//
// Both are self-contained (AmbientRuntime frame + LambdaContext + value
// kernel), so a stdlib pack can import the applier without the evaluator.
// ----------------------------------------------------------------------
import { is_promise, is_applyable } from "../values/value-guards.js";
import { type RunContext } from "../run/RunContext.js";
import { makeCallCtx } from "../run/CallCtx.js";
import { applyCallback, type ACallable } from "../values/primitives/ACallable.js";
import { APair } from "../values/primitives/APair.js";
import { DATA } from "../well-known/symbols.js";
import type { SchemeValue } from "../values/types.js";
import { promise_all } from "../utils/promises.js";

// `runCtx` is REQUIRED: an optional field let callers drop abort signal, heap
// meter, and strict mode silently. Required turns that into a compile error.
// Only ACallable (or any apply-term value) — bare host fns are doored.
export function call_function(fn: ACallable, args: SchemeValue[], { runCtx }: { runCtx: RunContext }) {
  if (!is_applyable(fn)) {
    throw new TypeError(
      typeof fn === "function"
        ? "call_function: bare host function refused — mint an ANativeProcedure / ARosettaProcedure"
        : "call_function: callee is not applyable",
    );
  }
  // Invocation is undefined here — only a bare `runCtx` reaches this chokepoint.
  return resolve_promises(applyCallback(fn, args, makeCallCtx(runCtx)) as SchemeValue);
}

// Collapse a tree that may contain Promises into a single Promise; if the tree
// holds none, return the argument untouched (the common no-await fast path).
function resolve_promises(arg: SchemeValue): SchemeValue {
  const promises: Promise<unknown>[] = [];
  traverse(arg);
  if (promises.length > 0) {
    return resolve(arg);
  }
  return arg;

  function traverse(node) {
    if (is_promise(node)) {
      promises.push(node);
    } else if (node instanceof APair) {
      if (!node.have_cycles("car")) {
        traverse(node.car);
      }
      if (!node.have_cycles("cdr")) {
        traverse(node.cdr);
      }
    } else if (Array.isArray(node)) {
      node.forEach(traverse);
    }
  }

  async function promise(node) {
    const pair = new APair(
      node.have_cycles("car") ? node.car : await resolve(node.car),
      node.have_cycles("cdr") ? node.cdr : await resolve(node.cdr),
    );
    if (node[DATA]) {
      pair[DATA] = true;
    }
    return pair;
  }

  function resolve(node) {
    if (Array.isArray(node)) {
      return promise_all(node.map(resolve));
    }
    if (node instanceof APair && promises.length > 0) {
      return promise(node);
    }
    return node;
  }
}
