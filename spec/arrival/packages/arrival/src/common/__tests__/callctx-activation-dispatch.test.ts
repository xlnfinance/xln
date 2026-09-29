// callctx-activation-dispatch.test.ts — Stage 1b (docs/execution.md §CALLCTX): a baked
// native/rosetta/tagless(-guard)/sequence verb's `this.configuration`/`this.resources` now
// ALSO reach it through the `CallCtx` a REAL evaluator dispatch builds, not only through the
// historical outer-closure/builder-form channel (`common/capability.ts`'s `SymbolsSpec` builder
// arm) `capability.test.ts` already covers.
//
// This is a PARALLEL channel, additive: it proves `common/capability.ts`'s bind loop
// associates a bound proc with its own capability, and that `eval/evaluator.ts`'s dispatch
// sites thread the resolved callable VALUE into `makeCallCtx` so the enrichment lands on
// `this` — exercised through REAL scheme source via `exec()` (the actual `evaluatePair`
// dispatch path), not a synthetic direct-apply that would bypass the wiring under test
// entirely.
//
// CONFIGURATION RELOCATION (the association→run-table move): `this.configuration` now
// resolves off `runCtx.capabilityConfigurations`, filled ONCE at `assembleRun` mint time from
// the tuple's own `Vocabulary.configsByCapability` (env/vocabulary.ts) — never from the bind-
// time association anymore. So a dispatch sees a capability's configuration whenever the RUN
// was assembled through the self-hosted vocabulary path (`exec(code, { capabilities, config })`
// — every sanctioned exec entry, Stage C Cut 3b). The INTERNAL live-frame seam
// (`execOverFrame`/`execStateOverFrame`, generator-exec.ts's non-public glass replacement)
// mints a bare `RunContext` with NO such table at all — same posture `run/RunContext.ts`
// documents for `capabilityResources` on a producer-less run — which is what the "no
// associated activation" test below exercises on purpose.
import { describe, expect, it } from "vitest";

import { z } from "zod";

import { EnvCapability } from "../capability.js";
import { symbol } from "../../symbol/index.js";
import * as sz from "../scheme-zod/index.js";
import { port, type Resource } from "../resources.js";
import { exec, execOverFrame, execInFrame } from "../../eval/generator-exec.js";
import { assembleRun } from "../../env/assemble-run.js";
import { BASE_ROSTER } from "../../env/base-roster.js";
import { isAmbientRuntime } from "../../env/AmbientRuntime.js";
import { freshEnv } from "../../__tests__/_fresh-env.js";
import { disposeRunContext } from "../../run/run-lifecycle.js";
import type { CallCtx } from "../../run/CallCtx.js";

/** The same `isAmbientRuntime`-narrowed bake seam generator-exec.ts's own private
 *  `capabilityEvalScheme`/`preludeEvalScheme` use — this capability declares neither
 *  `symbol.define` nor a prelude, so neither ever actually fires; the shape is required only to
 *  satisfy `AssembleRunOptions`. */
const testEvalScheme = (env: unknown, source: string): Promise<unknown[]> => {
  if (!isAmbientRuntime(env)) throw new Error("expected a concrete AmbientRuntime");
  return execInFrame(source, env);
};
const testEvalPrelude = (env: unknown, source: string, ctx: Parameters<typeof execInFrame>[2]): Promise<unknown[]> => {
  if (!isAmbientRuntime(env)) throw new Error("expected a concrete AmbientRuntime");
  return execInFrame(source, env, ctx);
};

interface Shout {
  up(s: string): string;
}
let shoutSpawns = 0;
const shoutResource: Resource<Shout> = {
  kind: "shout",
  acquire: async () => {
    shoutSpawns++;
    return port({ up: (s: string) => s.toUpperCase() }, () => undefined);
  },
};

// A BAKED rosetta verb (the target authoring form — no `ThisType`/builder closure anywhere):
// its impl reads `this.configuration`/`this.resources` off the flat `CallCtx` itself.
const greeter = new EnvCapability("test/greeter-activation", {
  configuration: { tag: z.string() },
  resources: { shout: shoutResource },
  symbols: {
    greet: symbol.rosetta`greet: tag + shout the message, reading this call's activation off CallCtx`(
      { input: [sz.string], output: [sz.string] },
      // 1d: `this.resources.<key>` is read via async `.get()` (lazy per-cell spawn). `this.
      // configuration` (run-sourced since the CONFIGURATION relocation) stays synchronous —
      // a plain table lookup off `runCtx`, no `.get()` needed.
      async function (this: CallCtx, s: string): Promise<string> {
        const cfg = this.configuration as { tag: string } | undefined;
        const res = this.resources as { shout: { get(): Promise<Shout> } } | undefined;
        if (cfg === undefined || res === undefined) return `NO-ACTIVATION:${s}`;
        return `${cfg.tag}:${(await res.shout.get()).up(s)}`;
      },
    ),
  },
});

describe("CallCtx activation dispatch (Stage 1b)", () => {
  it("threads a capability's `configuration` onto `this` at real evaluator dispatch", async () => {
    const [out] = await exec('(greet "yo")', { capabilities: [greeter], config: { tag: "hi" } });
    expect(out).toBe("hi:YO");
  });

  // Resource cells are RunContext-keyed, not ambient/env.
  it("threads a capability's `resources` onto `this` — same cell, same spawn-once lifecycle ACROSS PASSES SHARING ONE RunContext", async () => {
    shoutSpawns = 0;
    // `exec`'s own internal fold is `[...capabilities, ...BASE_ROSTER]` (env/base-roster.ts) —
    // a pre-mint wanting to interoperate with its `runCtx` reuse must fold the SAME roster in.
    // `buildVocabulary`'s memo keys on `config` by REFERENCE identity, not deep equality — the
    // SAME `config` object (not just an equal-shaped literal) must ride every call sharing this
    // runCtx, or each call would rebuild a DIFFERENT memoized Vocabulary and trip the
    // tuple-identity check below.
    const config = { tag: "ok" };
    const runCtx = await assembleRun({
      capabilities: [greeter, ...BASE_ROSTER],
      config,
      evalScheme: testEvalScheme,
      evalPrelude: testEvalPrelude,
    });
    try {
      const [first] = await exec('(greet "a")', { capabilities: [greeter], config, runCtx });
      const [second] = await exec('(greet "b")', { capabilities: [greeter], config, runCtx });
      expect(first).toBe("ok:A");
      expect(second).toBe("ok:B");
      expect(shoutSpawns).toBe(1);
    } finally {
      await disposeRunContext(runCtx);
    }
  });

  it("gives a FRESH resource per RunContext when passes don't share one", async () => {
    shoutSpawns = 0;
    const [first] = await exec('(greet "a")', { capabilities: [greeter], config: { tag: "solo" } });
    const [second] = await exec('(greet "b")', { capabilities: [greeter], config: { tag: "solo" } });
    expect(first).toBe("solo:A");
    expect(second).toBe("solo:B");
    expect(shoutSpawns).toBe(2);
  });

  // INVARIANT: additive — a callable with NO associated activation dispatches exactly as
  // before; `this.configuration`/`this.resources` are simply absent, never a crash or a stub
  // value. Exercised over the INTERNAL live-frame seam (`execOverFrame`) on purpose: unlike the
  // vocabulary path (where every base builtin now has a real, if configless, owning capability —
  // see this file's own header), a run minted over a bare frame carries no
  // `capabilityConfigurations` table at all, so this is the one path that actually reproduces
  // "no associated activation" for a builtin.
  it("is additive: a callable with no associated activation dispatches unaffected", async () => {
    const env = await freshEnv();
    const [out] = await execOverFrame('(string-length "hello")', { env });
    expect(out).toBe(5);
  });
});
