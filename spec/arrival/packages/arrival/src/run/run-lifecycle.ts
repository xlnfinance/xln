/**
 * RunContext teardown — disposal half of docs/execution.md §HERMETIC's per-run identity
 * (RunContext mints; this module owns what happens when it ends).
 *
 * A RunContext is minted once per `exec()` by default, but a REPL-style caller may hand
 * the SAME RunContext to N successive passes (`ExecOptions.runCtx`). Anything scoped to
 * that RunContext (capability resources) must survive across those passes and tear down
 * exactly once, at the SESSION's end — never per pass, never twice.
 *
 * Two teardown paths:
 *   EXPLICIT — caller calls {@link disposeRunContext}, or `await using` a RunContext
 *     (`[Symbol.asyncDispose]` delegates here).
 *   BACKSTOP — a RunContext dropped without either is torn down via FinalizationRegistry
 *     once unreachable. Best-effort by spec; bounds leakage, does not replace explicit.
 *
 * Both funnel through one idempotency guard (`disposed`).
 */

import type { RunContext } from "./RunContext.js";

type Teardown = () => Promise<void>;

/** One RunContext's teardowns + double-run guard. Held OFF the RunContext (WeakMap
 *  side-table) so a plain RunContext carries no lifecycle plumbing until a resource
 *  actually accrues. */
interface RunLifecycle {
  teardowns: Teardown[];
  disposed: boolean;
}

const lifecycles = new WeakMap<RunContext, RunLifecycle>();

/** GC backstop. Held value is the RunLifecycle (not the RunContext — FinalizationRegistry
 *  contract: target may already be gone). `unregister` uses RunContext as token (caller of
 *  dispose still holds a live reference). */
const backstop = new FinalizationRegistry<RunLifecycle>((lifecycle) => {
  if (lifecycle.disposed) return;
  lifecycle.disposed = true;
  const pending = lifecycle.teardowns;
  lifecycle.teardowns = [];
  // Detached — nothing awaits a GC callback; swallow unhandled rejections.
  void Promise.allSettled(pending.map((fn) => fn()));
});

function lifecycleOf(runCtx: RunContext): RunLifecycle {
  let lifecycle = lifecycles.get(runCtx);
  if (lifecycle === undefined) {
    lifecycle = { teardowns: [], disposed: false };
    lifecycles.set(runCtx, lifecycle);
    backstop.register(runCtx, lifecycle, runCtx);
  }
  return lifecycle;
}

/** Register `teardown` to run once at `runCtx` disposal (explicit or backstop). Called on
 *  a resource's FIRST touch under a given RunContext. Already-disposed run accepts no
 *  further teardowns (silent) — nothing should still spawn resources against a ended session. */
export function onRunContextDispose(runCtx: RunContext, teardown: Teardown): void {
  const lifecycle = lifecycleOf(runCtx);
  if (lifecycle.disposed) return;
  lifecycle.teardowns.push(teardown);
}

/** Tear `runCtx` down: run every accumulated teardown (parallel, best-effort —
 *  capability resources are independent; no cross-capability order). Idempotent.
 *  ONE function every teardown path funnels through: exec's owned-runCtx finally,
 *  REPL session close, and `[Symbol.asyncDispose]`. */
export async function disposeRunContext(runCtx: RunContext): Promise<void> {
  const lifecycle = lifecycles.get(runCtx);
  if (lifecycle === undefined || lifecycle.disposed) return;
  lifecycle.disposed = true;
  backstop.unregister(runCtx);
  const pending = lifecycle.teardowns;
  lifecycle.teardowns = [];
  await Promise.allSettled(pending.map((fn) => fn()));
}
