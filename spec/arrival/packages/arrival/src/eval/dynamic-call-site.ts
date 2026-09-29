/**
 * Ambient "dynamic call site" holder — a leaf so modules below evaluator.ts
 * can install one without creating a cycle.
 *
 * WHY EXTRACTED: the reverse-membrane crossing (`rosetta.ts` ACallable branch,
 * `scheme-zod.ts` `z.procedure().decode`) installs a dynamic call site around a
 * re-entrant scheme call so a lambda invoked from host JS nests under the
 * symbol invocation that exported it, not the definition-time lexical parent.
 * `evaluator.ts` already imports `AmbientRuntime.ts` → `rosetta.ts`, so
 * `rosetta.ts` importing back from `evaluator.ts` would cycle. Both sides import
 * this dependency-free leaf instead (same rationale as CallCtx.ts's extraction).
 *
 * Single-threaded JS makes a module-level holder safe; save/restore around each
 * apply handles nesting — see evaluator.ts `wrapLambdaArgs`/`wrapLambdaValue`
 * and evaluatePair's direct-dispatch sites.
 *
 * A second evaluation of this file in the same isolate would split the holder
 * (reverse re-entry would nest under the wrong invocation). That is a bundler
 * bug — detected at load, not papered over by pinning the holder on globalThis.
 */

import { assertSingleLoad } from "../single-load.js";

assertSingleLoad("eval/dynamic-call-site");

/** Opaque tag for one dynamic evaluation of an AST node. The tap implementation
 *  (`provenance/trace.ts` Invocation) owns the real shape; this leaf and
 *  evaluator.ts only thread it as an opaque parent pointer. */
export type Invocation = unknown;

let current: Invocation | undefined;

/** Read the current holder — the ALambda runner's prologue falls back to
 *  `ctx.currentInvocation` when unset (see evalLambda). */
export function currentDynamicCallSite(): Invocation | undefined {
  return current;
}

/** Raw write — for direct-dispatch sites (evaluatePair, applyArrowProc) that
 *  register a genuine NEW call site. Those sites save/restore by hand (no
 *  "prefer deeper candidate" comparison — the call IS the site). */
export function setDynamicCallSite(site: Invocation | undefined): void {
  current = site;
}

export function isStrictDescendant(a: Invocation | undefined, b: Invocation | undefined): boolean {
  if (!a || !b) return false;
  // Invocation is opaque here — the tap owns its shape; narrow structurally to walk parent.
  type ParentLinked = { parent: ParentLinked | null };
  for (let p = (a as ParentLinked).parent; p; p = p.parent) if (p === b) return true;
  return false;
}

/**
 * Install `dynSite` as the ambient dynamic call site for `fn`, preferring the
 * DEEPER of the current holder and `dynSite`. Keeping a deeper current holder
 * nests genuinely-deeper work under itself instead of scattering it to the
 * outer boundary (needed for a TCO loop calling a passed-in lambda — see
 * evaluator.ts wrapLambdaArgs).
 */
export function withDynamicCallSite<T>(dynSite: Invocation | undefined, fn: () => T): T {
  const saved = current;
  current = isStrictDescendant(saved, dynSite) ? saved : dynSite;
  try {
    return fn();
  } finally {
    current = saved;
  }
}
