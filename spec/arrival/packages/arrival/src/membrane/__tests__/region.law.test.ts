/**
 * LAW F5 — region discipline for re-entrant crossings (P6).
 *
 * Written BEFORE its code: these are the acceptance tests for the
 * reverse-membrane migration (the reverse-membrane-for-callables design
 * §7c). Every row is it.todo gated on that
 * landing; the migration is done when this file's todos become green tests.
 *
 * B3 landed §7c's reverse wrapper (`toJS`'s ACallable branch in
 * rosetta.ts, `z.procedure().decode` in scheme-zod.ts) — see
 * `src/membrane/region-scope.ts` for the scope token + doors this
 * file exercises. Row 8 stays `it.todo`: its own title tags it
 * `[STAGED: post-migration]` — a NAMED persistent-handler capability granting
 * a detached scope is explicitly future work, not part of the reverse-wrapper
 * landing these other seven rows gate.
 *
 * openRegionScope-gap Ruling A (2026-07-11): the capability/`symbol.rosetta` bind path
 * once lacked region-scope on — `createRosettaWrapper`
 * (rosetta.ts) opened a region scope around every call; the baked `symbol.rosetta` `run`
 * wrapper (common/symbols/rosetta.ts) did not, so a `z.procedure` slot's decode fell back to
 * the shared, never-closing `DETACHED_SCOPE` (`DETACHED_SCOPE.runCtx = CONSTANT_CTX`) for
 * every capability verb. That gap is CLOSED: `run` now opens a region scope itself, gated on
 * `contractMayCarryCallable` (_bake.ts) — a bake-time check for a `z.procedure`/`z.dynamic`
 * input slot — with `runCtx: this.runCtx` (the invocation's LIVE context). The
 * "region-law-trace-nesting" row below is uses
 * `EnvCapability` + `symbol.rosetta` accordingly; a new "burst-bypass" row pins the concrete
 * regression this gap caused (a lambda calling a sink verb used to fire it inline instead of
 * enqueueing under an armed `effects` log).
 */
import { describe, expect, it } from "vitest";
import * as z from "../../common/scheme-zod/index.js";
import { toJS } from "../rosetta.js";
import { ANativeProcedure } from "../../values/primitives/ANativeProcedure.js";
import { closeRegionScope, openRegionScope, withRegionScope } from "../region-scope.js";
import { CONSTANT_CTX, RunContext } from "../../run/RunContext.js";
import type { SchemeValue } from "../../values/types.js";
import { exec, execState } from "../../eval/generator-exec.js";
import { EvalTrace, type Invocation } from "../../provenance/trace.js";
import { EnvCapability } from "../../common/capability.js";
import { MemoryEffectLog } from "../../run/effect-log.js";

/** A trivial one-arg echo callable — enough surface for the door/identity/
 *  abort rows, which don't care what the callable actually computes. */
function makeEcho(): ANativeProcedure {
  return new ANativeProcedure({
    name: "echo",
    arity: { min: 1, max: 1 },
    contract: undefined,
    impl: (args) => args[0],
  });
}

/** A callable whose impl never settles — lets the abort row prove the
 *  SIGNAL wins the race, not the underlying call completing on its own. */
function makeHangingProc(): ANativeProcedure {
  return new ANativeProcedure({
    name: "hang",
    arity: { min: 0, max: 0 },
    contract: undefined,
    impl: () => new Promise<never>(() => {}),
  });
}

describe("a reverse lambda is region-bound to its invocation", () => {
  it("calling the wrapper AFTER the symbol returned throws the escape door (educational, names the capability path)", async () => {
    const scope = openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined });
    const wrapper = withRegionScope(scope, () => toJS(makeEcho()) as (...a: unknown[]) => Promise<unknown>);
    closeRegionScope(scope); // simulates the exporting symbol invocation returning
    await expect(wrapper(1)).rejects.toThrow(/region-bound to the calling symbol/);
    // The door also names what to do instead — a real capability, not a relaxation.
    await expect(wrapper(1)).rejects.toThrow(/explicit capability/);
  });

  it("the symbol returning while wrapper calls are IN FLIGHT throws (pending > 0 at settle)", async () => {
    const scope = openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined });
    const wrapper = withRegionScope(scope, () => toJS(makeEcho()) as (...a: unknown[]) => Promise<unknown>);
    // `wrapper(1)` runs synchronously up to its first await (`withRegionCall`'s own
    // `pending++` fires before any `await`), so `scope.pending` is already 1 the
    // instant this call returns — no need to await it first.
    const call = wrapper(1);
    expect(scope.pending).toBe(1);
    expect(() => closeRegionScope(scope)).toThrow(/1 reverse-lambda call incomplete/);
    expect(scope.open).toBe(false); // rule 1 still applies even though the throw is rule 2's
    await call; // let the in-flight call settle so nothing lingers as an unhandled rejection
  });

  it("run abort cancels in-flight re-entries via the scope's derived signal", async () => {
    const controller = new AbortController();
    const runCtx = new RunContext({ signal: controller.signal });
    const scope = openRegionScope({ runCtx, dynSite: undefined });
    const wrapper = withRegionScope(scope, () => toJS(makeHangingProc()) as (...a: unknown[]) => Promise<unknown>);
    const call = wrapper();
    controller.abort(new Error("region-law abort probe"));
    await expect(call).rejects.toThrow("region-law abort probe");
  });

  it("wrapper identity is per-(callable, scope): same lambda, same invocation → ===; new invocation → new wrapper", () => {
    const echo = makeEcho();
    const scopeA = openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined });
    const w1 = withRegionScope(scopeA, () => toJS(echo));
    const w2 = withRegionScope(scopeA, () => toJS(echo));
    expect(w1).toBe(w2);

    const scopeB = openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined });
    const w3 = withRegionScope(scopeB, () => toJS(echo));
    expect(w3).not.toBe(w1);
  });

  it("each re-entry opens a child trace scope of the enclosing invocation — lineage nests, never attributes flat to the run root", async () => {
    const trace = new EvalTrace();
    let capturedInv: Invocation | undefined;
    let capturedWrapper: ((...a: unknown[]) => Promise<unknown>) | undefined;

    let before = 0;
    let result: unknown;
    // A z.procedure() arg's decode must close over a live per-invocation scope, not DETACHED_SCOPE.
    const cap = EnvCapability.define("test/region-law-trace-nesting", {
      symbols: (symbol, z) => ({
        "region-law-capture": symbol.rosetta`region-law-capture: `(
          { input: [z.procedure()], output: [z.undefinedResult] },
          // `this.invocation.currentInvocation` is the run wrapper's own receiver shape
          // (common/symbols/rosetta.ts's `run`, reached via `common/capability.ts`'s
          // `rosettaCtx(runCtx)` adapter) — the SAME invocation the region scope opened
          // against (`scope.dynSite`). Calling the wrapper HERE, inside the impl, awaited
          // before the impl itself returns, keeps the re-entry INSIDE the exporting
          // invocation's open scope window — the region-bound contract this row is testing,
          // not a post-return escape (that's row 1's job).
          async function (lambdaWrapper: (...args: unknown[]) => unknown) {
            capturedInv = this.invocation.currentInvocation as Invocation | undefined;
            capturedWrapper = lambdaWrapper as (...a: unknown[]) => Promise<unknown>;
            before = trace.invocationLog.length;
            result = await capturedWrapper(41);
            return undefined;
          },
        ),
      }),
    });

    await execState("(region-law-capture (lambda (x) (+ x 1)))", { capabilities: [cap], tap: trace });
    expect(capturedInv).toBeDefined();
    expect(capturedWrapper).toBeDefined();
    // `z.procedure()` declared with no output type keeps "honest untransformed passthrough"
    // (scheme-zod.ts's own doc on the untyped HOF-callback case) — `result` is the raw scheme
    // AExact, not a plain JS number (unlike the retired bare-callable wrapper, which always
    // ran the result back through `toJS`). `Number(...)` (valueOf) is the sanity check
    // that actually matters here: the re-entry ran the lambda body and produced 42.
    expect(Number(result)).toBe(42);

    const newInvocations = trace.invocationLog.slice(before);
    expect(newInvocations.length).toBeGreaterThan(0);
    // At least one invocation minted DURING the re-entry walks back (via `.parent`)
    // to the invocation that exported the wrapper — nesting, not a flat run-root
    // attribution.
    const nestsUnderCapture = newInvocations.some((inv) => {
      for (let p: Invocation | null = inv; p; p = p.parent) if (p === capturedInv) return true;
      return false;
    });
    expect(nestsUnderCapture).toBe(true);
  });

  it("z.procedure decode adopts the same scope token — one discipline, typed and untyped paths", async () => {
    const echo = makeEcho();
    const scope = openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined });
    const untyped = withRegionScope(scope, () => toJS(echo));
    const typed = withRegionScope(scope, () => z.procedure().parse(echo));
    // DISTINCT wrappers by law (the two-level (callable, scope, FAMILY) cache — see
    // RegionScope.cache's doc): the typed wrapper carries z.procedure's marshalling,
    // the untyped one is the plain passthrough. The old single-slot `toBe` here pinned
    // the first-caller-wins collision (whichever path crossed first served ITS wrapper
    // to the other — typed marshalling silently lost or gained). Each family is stable
    // within itself, and BOTH adopt the same scope token — one discipline.
    expect(typed).not.toBe(untyped);
    expect(withRegionScope(scope, () => toJS(echo))).toBe(untyped);
    expect(withRegionScope(scope, () => z.procedure().parse(echo))).toBe(typed);

    closeRegionScope(scope);
    // The shared discipline: the CLOSED scope doors BOTH families' wrappers.
    await expect((typed as (...a: unknown[]) => Promise<unknown>)(1)).rejects.toThrow(
      /region-bound to the calling symbol/,
    );
    await expect((untyped as (...a: unknown[]) => Promise<unknown>)(1)).rejects.toThrow(
      /region-bound to the calling symbol/,
    );
  });

  it.todo(
    "a persistent handler is a NAMED capability with a detached scope, not a relaxation [STAGED: post-migration]",
  );

  it("BURST-BYPASS CLOSED: a lambda taken via z.procedure re-enters under the LIVE runCtx — a sink it calls ENQUEUES under an armed effects log, never fires inline", async () => {
    // This is the concrete regression the openRegionScope gap caused: before Ruling A, a
    // `z.procedure` slot's decode fell back to `DETACHED_SCOPE` (`runCtx: CONSTANT_CTX`, no
    // `effects`) whenever no OTHER machinery happened to have a region scope ambient — so a
    // lambda handed to a capability verb, when it called a `sink`-role verb, re-entered under
    // `CONSTANT_CTX` and hit the run-cache/effects fast path (`runCache === undefined &&
    // runEffects === undefined`), firing the sink IMMEDIATELY instead of enqueueing it onto
    // the run's `effects` log — the burst arm's whole discipline (run/run-cache.ts's
    // `penetrateThroughCache`, arrival-plexus-effect-burst.md §2.3) silently bypassed for any
    // sink reached through a reverse-lambda re-entry. Sound after the fix because the scope
    // opened around "call-with-lambda"'s own invocation carries `runCtx: this.runCtx` — the
    // SAME RunContext the outer `exec(..., { effects })` call minted — so the lambda's body
    // (evaluated via `applyCallback(callable, args, scope.runCtx)`, region-scope.ts) threads
    // that live context down to "sink!"'s own `this.runCtx`.
    let sinkFires = 0;
    const effects = new MemoryEffectLog();
    const cap = EnvCapability.define("test/region-law-burst-bypass", {
      symbols: (symbol, z) => ({
        "sink!": symbol.rosetta`sink!: an effect a lambda re-entry may reach`(
          { input: [z.number], output: [z.undefinedResult], provenance: "sink" },
          async (_n: number) => {
            sinkFires++;
            return undefined;
          },
        ),
        "call-with-lambda": symbol.rosetta`call-with-lambda: invoke the lambda arg once`(
          { input: [z.procedure()], output: [z.undefinedResult] },
          async (lambdaWrapper: (...args: unknown[]) => unknown) => {
            await lambdaWrapper();
            return undefined;
          },
        ),
      }),
    });

    await exec("(call-with-lambda (lambda () (sink! 1)))", { capabilities: [cap], effects });

    expect(sinkFires).toBe(0);
    // toMatchObject (not toEqual): the entry also carries `rawArgs` (§5), additive and not
    // pinned by this row (mirrors effect-log.law.test.ts's own convention).
    expect(effects.entries).toMatchObject([{ verbName: "sink!", decodedArgs: [1] }]);
  });
});
