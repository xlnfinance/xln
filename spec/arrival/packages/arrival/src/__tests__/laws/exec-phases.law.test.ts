/**
 * LAW — the exec PHASE PRODUCTS (exec-phases-and-dynamic-metadata.md Part III).
 * STAGE C CUT 3b (docs/plans/stage-c-corpse-deletion.md) retired the ambient-phase products
 * (`assembleAmbient`/`AssembledAmbient`/`validateAgainstAmbient`/glass) along with the ambient
 * path itself; this file re-pins what survives on the self-hosted vocabulary path
 * (`exec`/`execState`, both routing through `env/vocabulary.ts`/`env/assemble-run.ts`) and drops
 * the rows that pinned the deleted machinery specifically (see each describe block for what
 * changed and why):
 *
 *   • the OWNERSHIP TABLE, row by row (phase 5 — dispose exactly what the call minted): a
 *     per-call `{ capabilities }` run tears its own RunContext (and every capability resource
 *     spawned against it) down at run end INCLUDING throw paths; a caller-supplied `runCtx`
 *     (REPL continuity) is never disposed by exec.
 *   • RUNCTX REUSE — resources are keyed by RunContext (docs/execution.md §HERMETIC), not by
 *     any ambient/tuple identity: warmth follows a REPL's RunContext continuity
 *     (`ExecOptions.runCtx`); two runs with no shared runCtx spawn independently.
 *   • PARSE-ONCE-RUN-MANY — one `ParsedProgram`, N runs, same results; the reader mode is a
 *     stamped program identity fact.
 *   • VALIDATION WITHOUT EXECUTION — `staticValidation: "on"` throws `StaticValidationError`
 *     (carrying the complete diagnostic list) before the first form ever evaluates — zero side
 *     effects fired.
 *
 * DROPPED (no vocabulary-path equivalent — see docs/plans/stage-c-corpse-deletion.md's Cut 3b
 * status entry): the realm-default `ExecState.ambient` row (`ExecState` carries no `ambient`
 * field at all anymore — ownership of "the shared default" was the retired realm singleton's own
 * concept, and the cornerstone rules that hermetic violation out); the glass "`ExecState.ambient` is
 * absent" row (glass itself is gone — `ExecOptions` has no `env`).
 */
import { describe, expect, it } from "vitest";

import { EnvCapability } from "../../common/capability.js";
import type { Resource } from "../../common/resources.js";
import * as z from "../../common/scheme-zod/index.js";
import { symbol } from "../../symbol/index.js";
import type { CallCtx } from "../../run/CallCtx.js";
import { LexicalScope } from "../../eval/LexicalScope.js";
import { parseProgram } from "../../eval/exec-phases.js";
import { exec, execState, execInFrame } from "../../eval/generator-exec.js";
import { assembleRun } from "../../env/assemble-run.js";
import { BASE_ROSTER } from "../../env/base-roster.js";
import { isAmbientRuntime } from "../../env/AmbientRuntime.js";
import { StaticValidationError } from "../../static-validation/validate-program.js";
import { RunContext } from "../../run/RunContext.js";
import { disposeRunContext } from "../../run/run-lifecycle.js";

/** A spy-instrumented port: counts acquisitions + teardowns. */
function spyResource(): { resource: Resource<{ tag: string }>; counts: { acquired: number; disposed: number } } {
  const counts = { acquired: 0, disposed: 0 };
  return {
    counts,
    resource: {
      kind: "law/spy-port",
      async acquire() {
        counts.acquired += 1;
        return {
          tag: "live",
          [Symbol.asyncDispose]: async () => {
            counts.disposed += 1;
          },
        };
      },
    },
  };
}

/** A capability owning ONE spy port + a verb that touches it (spawning it). */
function spyCapability() {
  const { resource, counts } = spyResource();
  const capability = new EnvCapability("law/exec-phases-spy", {
    resources: { port: resource },
    symbols: {
      // 1d: resources are lazy — a verb spawns the port by READING it (async `.get()`), not by
      // mere symbol touch (the eager pre-spawn gate is retired). Reading here is what drives the
      // acquire/dispose the ownership laws below assert.
      "spy/touch": symbol.rosetta`spy/touch: read the spy port's tag`(
        { input: [], output: [z.string] },
        async function (this: CallCtx): Promise<string> {
          const resources = this.resources as { port: { get(): Promise<{ tag: string }> } };
          await resources.port.get();
          return "touched";
        },
      ),
    },
  });
  return { capability, counts };
}

/** The same `isAmbientRuntime`-narrowed bake seam generator-exec.ts's own private
 *  `capabilityEvalScheme`/`preludeEvalScheme` use — `spyCapability()` declares neither
 *  `symbol.define` nor a prelude, so neither ever actually fires; required only to satisfy
 *  `AssembleRunOptions`' shape when this file mints a shareable RunContext directly. */
const testEvalScheme = (env: unknown, source: string): Promise<unknown[]> => {
  if (!isAmbientRuntime(env)) throw new Error("expected a concrete AmbientRuntime");
  return execInFrame(source, env);
};
const testEvalPrelude = (env: unknown, source: string, ctx: Parameters<typeof execInFrame>[2]): Promise<unknown[]> => {
  if (!isAmbientRuntime(env)) throw new Error("expected a concrete AmbientRuntime");
  return execInFrame(source, env, ctx);
};

describe("ownership table — phase 5 disposes exactly what the call minted", () => {
  it("per-call { capabilities }: resource teardown fires at run end", async () => {
    const { capability, counts } = spyCapability();
    const [out] = await exec(`(spy/touch)`, { capabilities: [capability] });
    expect(out).toBe("touched");
    expect(counts.acquired).toBe(1); // the verb's first touch spawned it
    expect(counts.disposed).toBe(1); // exec OWNED its self-minted RunContext — wind-down fired
  });

  it("per-call { capabilities }: teardown fires on the THROW path too", async () => {
    const { capability, counts } = spyCapability();
    await expect(exec(`(spy/touch) (car 1)`, { capabilities: [capability] })).rejects.toThrow();
    expect(counts.acquired).toBe(1);
    expect(counts.disposed).toBe(1); // finally — teardown on every exit, not just success
  });

  it("caller-supplied runCtx: exec never disposes it; resources warm across passes SHARING it", async () => {
    const { capability, counts } = spyCapability();
    // Minted OUTSIDE any exec call (the designed REPL idiom): a caller-owned RunContext survives
    // across passes, threaded back in via `ExecOptions.runCtx` on every one.
    // `exec`'s own internal fold is `[...capabilities, ...BASE_ROSTER]` (env/base-roster.ts) —
    // a pre-mint wanting to interoperate with its `runCtx` reuse must fold the SAME roster in,
    // so the tuple-identity check (`assembleRun`'s own header) matches.
    const runCtx = await assembleRun({
      capabilities: [capability, ...BASE_ROSTER],
      evalScheme: testEvalScheme,
      evalPrelude: testEvalPrelude,
    });
    const [a] = await exec(`(spy/touch)`, { capabilities: [capability], runCtx });
    const [b] = await exec(`(spy/touch)`, { capabilities: [capability], runCtx });
    expect([a, b]).toEqual(["touched", "touched"]);
    expect(counts.acquired).toBe(1); // warm reuse — spawned once, shared across passes of ONE RunContext
    expect(counts.disposed).toBe(0); // exec did NOT dispose a caller-supplied runCtx
    await disposeRunContext(runCtx); // the caller's own deliberate session end
    expect(counts.disposed).toBe(1);
    await disposeRunContext(runCtx);
    expect(counts.disposed).toBe(1); // single-flight — idempotent
    // `await using` support: a `new RunContext()`-minted RunContext is AsyncDisposable by
    // construction (`assembleRun` returns the same class).
    expect(typeof runCtx[Symbol.asyncDispose]).toBe("function");
  });

  it("two SEPARATE exec() calls with NO runCtx continuity spawn TWICE — per-run isolation", async () => {
    const { capability, counts } = spyCapability();
    const [a] = await exec(`(spy/touch)`, { capabilities: [capability] }); // mints + disposes its OWN runCtx
    const [b] = await exec(`(spy/touch)`, { capabilities: [capability] }); // a SECOND, unrelated runCtx
    expect([a, b]).toEqual(["touched", "touched"]);
    expect(counts.acquired).toBe(2); // no shared RunContext ⇒ no shared resource
    expect(counts.disposed).toBe(2); // each call's self-minted runCtx tore its own spawn down
  });
});

describe("scope reuse — REPL continuity without any ambient handle", () => {
  it("defines ride the scope: fresh scopes with the SAME capabilities stay isolated", async () => {
    const { capability } = spyCapability();
    const a = LexicalScope.fresh("law/session-a");
    await exec(`(define x 41)`, { capabilities: [capability], scope: a });
    const [cont] = await exec(`(+ x 1)`, { capabilities: [capability], scope: a }); // same scope — REPL continuity
    expect(cont).toBe(42);
    const b = LexicalScope.fresh("law/session-b");
    await expect(exec(`x`, { capabilities: [capability], scope: b })).rejects.toThrow(/x/); // other scope — unbound
  });
});

describe("parse-once-run-many (§3.5)", () => {
  it("one ParsedProgram, N runs — the designed idiom (code argument ignored)", async () => {
    const program = await parseProgram(`(+ 1 2) (* 3 4)`);
    expect(program.strict).toBe(false); // reader mode — a stamped identity fact
    expect(program.forms).toHaveLength(2);
    const first = await exec(``, { program });
    const second = await exec(`(this is ignored)`, { program });
    expect(first).toEqual([3, 12]);
    expect(second).toEqual([3, 12]);
  });
});

describe("validation without execution (§3.5) — the complete diagnostic list, zero side effects", () => {
  it("StaticValidationError carries every diagnostic; nothing runs", async () => {
    const { capability, counts } = spyCapability();
    let caught: unknown;
    try {
      await execState(`(spy/touch) (definitely-not-bound-anywhere 1)`, {
        capabilities: [capability],
        staticValidation: "on",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StaticValidationError);
    const diagnostics = (caught as StaticValidationError).diagnostics;
    expect(diagnostics.some((d) => d.severity === "error")).toBe(true); // the unbound ref reported
    expect(diagnostics.some((d) => d.message.includes("definitely-not-bound-anywhere"))).toBe(true);
    expect(counts.acquired).toBe(0); // ZERO side effects fired — no eval, no resource touch
  });
});
