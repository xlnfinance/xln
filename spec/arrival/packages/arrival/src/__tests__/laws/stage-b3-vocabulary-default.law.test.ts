/**
 * LAW — Stage B3 (docs/plans/stage-b-runcontext-absorbs-assembly.md, §Sub-stages "B3 —
 * consumers migrate") introduced the self-hosted vocabulary path as `exec`'s DEFAULT, alongside
 * a `{ ambient }` retired ambient escape hatch to the old `lower()`/`assembleEnv`/`instantiate`
 * ambient. STAGE C CUT 3b (docs/plans/stage-c-corpse-deletion.md, "the massacre") retired that
 * escape hatch along with the ambient path itself — the vocabulary path is now the ONLY path,
 * so this file's original LAW 1 ("default-path equivalence: vocabulary vs ambient") and the
 * router pin's retired ambient row have no surviving counterpart (there is nothing left to be
 * equivalent TO, and no second branch a router could route to) and are dropped. What survives,
 * unaffected by the router's collapse (neither pins ambient/glass at all):
 *
 *  LAW 2 (runCtx reuse — the run is authoritative): a supplied `runCtx` is returned verbatim.
 *    Assembly happens at SPAWN, so the run carries its own vocabulary and a reusing call
 *    rebuilds nothing: `capabilities`/`config` on that call are inert. Threading the same runCtx
 *    through two `execState` passes (the REPL-continuity idiom) skips a second prelude execution.
 *
 *  LAW 3 (static validation on the vocabulary path): `staticValidation: "on"` produces the
 *    `missing-configuration` diagnostic — thrown at parse phase, with ZERO side effects fired
 *    (not even a preceding form's own side effect runs).
 *
 * A cheap router-pin check confirms an ordinary `{ capabilities }` call carries a real
 * `RunContext.vocabulary` — the vocabulary path's own observable signature.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { EnvCapability } from "../../common/capability.js";
import type { EvalPreludeInto, EvalSchemeInto } from "../../common/scheme-env.js";
import { exec, execState, execInFrame } from "../../eval/generator-exec.js";
import { assembleRun } from "../../env/assemble-run.js";
import { BASE_ROSTER } from "../../env/base-roster.js";
import { isAmbientRuntime } from "../../env/AmbientRuntime.js";
import { disposeRunContext } from "../../run/run-lifecycle.js";
import { RunContext } from "../../run/RunContext.js";
import { StaticValidationError } from "../../static-validation/validate-program.js";
import { nil } from "../../values/primitives/ANil.js";

// The internal bake seam (Stage C Cut 3b) — never the public exec surface.
const realEvalScheme: EvalSchemeInto = (env, src) => {
  if (!isAmbientRuntime(env)) throw new Error("expected a concrete AmbientRuntime");
  return execInFrame(src, env);
};
const realEvalPrelude: EvalPreludeInto = (env, src, runCtx) => {
  if (!isAmbientRuntime(env)) throw new Error("expected a concrete AmbientRuntime");
  return execInFrame(src, env, runCtx);
};

describe("LAW 2 — runCtx reuse: the run is authoritative", () => {
  it("a supplied runCtx comes back verbatim; this call's capabilities are not consulted", async () => {
    const capA = EnvCapability.define("law/b3-runctx-a", { symbols: () => ({}) });
    const capB = EnvCapability.define("law/b3-runctx-b", { symbols: () => ({}) });

    const runA = await assembleRun({ capabilities: [capA], evalScheme: realEvalScheme });
    try {
      // Assembly is a SPAWN act: `runA` carries the vocabulary it was built against, so a reusing
      // call rebuilds nothing and compares nothing. A different capability set here is inert, not
      // an error — `capabilities`/`config` are spawn inputs, and the run already holds their product.
      const reused = await assembleRun({ capabilities: [capB], evalScheme: realEvalScheme, runCtx: runA });
      expect(reused).toBe(runA);
      expect(reused.vocabulary).toBe(runA.vocabulary);
    } finally {
      await disposeRunContext(runA);
    }
  });

  it("a bare-minted RunContext, carrying no vocabulary of its own, is reused verbatim too", async () => {
    const cap = EnvCapability.define("law/b3-runctx-empty", { symbols: () => ({}) });
    // Bare `new RunContext(...)` — not spawned here, so it holds no vocabulary. Reuse still returns
    // it: the caller named this run, and reuse does not second-guess that.
    const bareRunCtx = new RunContext({});
    const reused = await assembleRun({ capabilities: [cap], evalScheme: realEvalScheme, runCtx: bareRunCtx });
    expect(reused).toBe(bareRunCtx);
    expect(reused.vocabulary).toBeUndefined();
  });

  it("threading the SAME tuple's RunContext through two execState passes skips a second prelude run", async () => {
    let bumps = 0;
    const cap = EnvCapability.define("law/b3-runctx-repl", {
      resources: (): { count: number } => ({ count: 0 }),
      prelude: "(prelude/bump!)",
      symbols: (symbol, sz) => ({
        "prelude/bump!": symbol.rosetta`prelude/bump!: bump this run's counter`(
          { input: [], output: [sz.string], preludeOnly: true },
          function (this: { resources: { count: number } }) {
            this.resources.count += 1;
            bumps++;
            return "ok";
          },
        ),
      }),
    });
    const capabilities = [cap];
    const config = {};

    // The REPL idiom: pre-mint via the exported `assembleRun` (the vocabulary-path counterpart
    // of `new RunContext(...)`), then thread it through every pass. `execState`'s own fold
    // (`env/base-roster.ts`'s `BASE_ROSTER`) means a REUSED `runCtx`'s tuple-identity check
    // compares against THAT effective tuple, so a pre-mint wanting to interoperate with
    // `execState`'s reuse must fold the SAME roster in.
    const runCtx = await assembleRun({
      capabilities: [...capabilities, ...BASE_ROSTER],
      config,
      evalScheme: realEvalScheme,
      evalPrelude: realEvalPrelude,
    });
    expect(bumps).toBe(1); // the pre-mint's own prelude pass

    try {
      const first = await execState("(+ 1 1)", { capabilities, config, runCtx });
      const second = await execState("(+ 2 2)", { capabilities, config, runCtx });

      expect(bumps).toBe(1); // NEITHER execState pass re-ran the prelude
      expect(first.runCtx).toBe(runCtx);
      expect(second.runCtx).toBe(runCtx);
      expect((runCtx.capabilityResources?.get(cap) as { count: number }).count).toBe(1);
    } finally {
      await disposeRunContext(runCtx);
    }
  });
});

describe("LAW 3 — static validation on the vocabulary path", () => {
  it("an absent requiresConfig key reports missing-configuration at parse phase, zero side effects fired", async () => {
    let ran = false;
    const cap = EnvCapability.define("law/b3-static-validation", {
      configuration: { fs: z.custom<{ x: number }>(() => true).optional() },
      symbols: (symbol, sz) => ({
        "probe!": symbol.native`probe!: JS-side effect marker`({ input: [], output: [sz.schemeValue] }, () => {
          ran = true;
          return nil;
        }),
        "gated/verb": symbol.native`gated/verb: requires fs`(
          { input: [], output: [sz.schemeValue], requiresConfig: ["fs"] },
          () => nil,
        ),
      }),
    });

    let caught: unknown;
    try {
      await exec("(probe!) (gated/verb)", { capabilities: [cap], config: {}, staticValidation: "on" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StaticValidationError);
    expect(ran).toBe(false); // the FIRST form's own side effect never fired either
    const err = caught as StaticValidationError;
    expect(err.diagnostics.some((d) => d.code === "missing-configuration")).toBe(true);
  });

  it("present config: the SAME program runs clean on the vocabulary path (no false positive)", async () => {
    const cap = EnvCapability.define("law/b3-static-validation-satisfied", {
      configuration: { fs: z.custom<{ x: number }>(() => true).optional() },
      symbols: (symbol, sz) => ({
        "gated/verb": symbol.native`gated/verb: requires fs`(
          { input: [], output: [sz.schemeValue], requiresConfig: ["fs"] },
          () => nil,
        ),
      }),
    });
    await expect(
      exec("(gated/verb)", { capabilities: [cap], config: { fs: { x: 1 } }, staticValidation: "on" }),
    ).resolves.toBeDefined();
  });
});

describe("router pin — an ordinary { capabilities } call carries a real vocabulary", () => {
  it("RunContext.vocabulary is present", async () => {
    const cap = EnvCapability.define("law/b3-router-pin", { symbols: () => ({}) });
    const state = await execState("(+ 1 1)", { capabilities: [cap] });
    expect(state.runCtx.vocabulary).toBeDefined();
  });
});
