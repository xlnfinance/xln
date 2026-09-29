/**
 * LAW — THE NEXT CUT (docs/plans/stage-b-runcontext-absorbs-assembly.md §"THE NEXT CUT"):
 * a closure's LEXICAL axis is definition-time (that is what a closure IS), but its RUN axis
 * — `runCtx` (strict, channels, capabilityConfigurations/Resources, signal, cache) —
 * swaps to the CALLING run at invocation. tf/apply is the sole meeting point of immutable
 * description and run state, and it must hand over the PRESENT: a closure minted in run A and
 * invoked in run B evaluates its body's DISPATCHES under B's run, while still resolving names
 * through A's lexical scope.
 *
 * The seam under test is `eval/evaluator.ts`'s ALambda runner: it now builds the body
 * `EvalContext` from the def-time `ctx` but substitutes `runCtx`/`strict`/`signal` from the
 * call-time `callCtx` (the CallCtx every dispatch site threads via `makeCallCtx(ctx.runCtx,…)`).
 *
 * The cross-run channel here is a JS-side holder (`held`): a `capture!` verb stashes a raw
 * scheme closure (`sz.schemeValue` — never crossing the membrane, so the stored value is the RAW
 * ALambda), and an `invoke-held` verb applies it through THIS dispatch's own CallCtx
 * (`applyCallback(held, [], this)` — the same seam every HOF uses). `capture!` runs in run A,
 * `invoke-held` in run B; the two verb impls close over the same JS `held`, so the closure
 * genuinely crosses runs.
 *
 * Before this cut the body ran under A's minting run — `read-config` read A's config, `car`
 * doored under A's tolerance. This suite pins that each now follows B.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { EnvCapability } from "../../common/capability.js";
import { exec } from "../../eval/generator-exec.js";
import { ACallable, applyCallback } from "../../values/primitives/ACallable.js";
import type { CallCtx } from "../../run/CallCtx.js";

/** A capability whose verbs (a) read this run's configured greeting, (b) stash a closure into a
 *  cross-run JS holder, and (c) apply the stashed closure through THIS dispatch's own runCtx. A
 *  fresh `held` per builder keeps the tests isolated. */
function crossRunCapability() {
  let held: ACallable | undefined;

  return EnvCapability.define("law/next-cut-cross-run", {
    configuration: { greeting: z.string().optional() },
    symbols: (symbol, sz) => ({
      "read-config": symbol.rosetta`read-config: this run's configured greeting, or "none"`(
        { input: [], output: [sz.string] },
        function (this: { configuration?: { greeting?: string } }) {
          return this.configuration?.greeting ?? "none";
        },
      ),
      "capture!": symbol.native`capture!: stash a raw scheme closure into a cross-run JS holder`(
        { input: [sz.lambda], output: [sz.schemeValue] },
        function (closure) {
          held = closure;
          return closure;
        },
      ),
      "invoke-held": symbol.native`invoke-held: apply the stashed closure through THIS dispatch's own runCtx`(
        { input: [], output: [sz.schemeValue] },
        function (this: CallCtx) {
          if (held === undefined) throw new Error("nothing held");
          return applyCallback(held, [], this);
        },
      ),
      // Immediately applies its lambda argument through THIS dispatch's own runCtx — used to
      // prove a lambda MINTED DURING run B's call (the arg is minted by run B's body) also
      // observes B (its def-time ctx.runCtx is the substituted bodyCtx = B).
      "apply-now": symbol.native`apply-now: apply the given lambda immediately through THIS dispatch's runCtx`(
        { input: [sz.lambda], output: [sz.schemeValue] },
        function (this: CallCtx, thunk) {
          return applyCallback(thunk, [], this);
        },
      ),
    }),
  });
}

describe("LAW — call-time runCtx: configuration follows the INVOKING run", () => {
  it("a closure minted in run A reads run B's config when invoked in run B", async () => {
    const cap = crossRunCapability();

    // Run A: mint + stash a closure whose body dispatches `read-config`.
    const [captured] = await exec("(capture! (lambda () (read-config)))", {
      capabilities: [cap],
      config: { greeting: "run-A" },
    });
    expect(captured).toBeDefined();

    // Run B: invoke it. The body's `read-config` must see B's config, not A's.
    const [viaB] = await exec("(invoke-held)", {
      capabilities: [cap],
      config: { greeting: "run-B" },
    });
    expect(viaB).toBe("run-B");
  });

  it("nested: a lambda minted DURING run B's call also observes B (def-time ctx.runCtx = substituted bodyCtx)", async () => {
    const cap = crossRunCapability();

    // Run A stashes an OUTER closure. When invoked in B, the outer body mints an INNER lambda
    // (its def-time ctx is B's substituted bodyCtx) and applies it immediately via `apply-now`.
    await exec("(capture! (lambda () (apply-now (lambda () (read-config)))))", {
      capabilities: [cap],
      config: { greeting: "run-A" },
    });

    const [viaB] = await exec("(invoke-held)", {
      capabilities: [cap],
      config: { greeting: "run-B" },
    });
    expect(viaB).toBe("run-B");
  });
});

describe("LAW — call-time runCtx: strict follows the INVOKING run", () => {
  it("a closure minted under tolerant run A doors STRICTLY when invoked under strict run B", async () => {
    const cap = crossRunCapability();

    // Minted under tolerant A: (car '()) would resolve to nil if the body kept A's run.
    await exec("(capture! (lambda () (car (quote ()))))", {
      capabilities: [cap],
      config: {},
      strict: false,
    });

    // Invoked under strict B: the body's car-of-nil must throw the R7RS pair typecheck.
    await expect(exec("(invoke-held)", { capabilities: [cap], config: {}, strict: true })).rejects.toThrow();
  });

  it("the SAME closure stays tolerant when invoked under tolerant run B (control)", async () => {
    const cap = crossRunCapability();
    await exec("(capture! (lambda () (car (quote ()))))", {
      capabilities: [cap],
      config: {},
      strict: false,
    });
    // Tolerant B: car-of-nil resolves to nil, no throw.
    await expect(exec("(invoke-held)", { capabilities: [cap], config: {}, strict: false })).resolves.toBeDefined();
  });
});
