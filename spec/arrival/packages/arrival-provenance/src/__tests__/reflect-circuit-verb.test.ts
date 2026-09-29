// circuit-verb.test.ts — T6b: `(circuit h)` after `extract` landed; #23: live via host injection.
//
// `extract` (CoreForm → StaticProv) shipped in @inhuman.tools/arrival-mercury, and that package's
// own circuitToSexpr renders a StaticProv as homoiconic sexpr — tested over there
// (arrival-mercury/src/__tests__/model/circuit-sexpr.test.ts) against every StaticProv kind.
//
// This file covers the OTHER half: the verb itself, over a ResultHandle, on this
// `/reflect` subpath. The seam T6b actually needs is real — `h.teleological()` →
// `buildSlice(trace, outputNode).program` is the SAME source text `(how h)` returns, and
// from there parseSexprs→desugar→classify→extractProgram→circuitToSexpr is a straight
// line. This analysis plane does not import the compiler (see handle-provenance.ts's
// `circuitOf` doc). NEVER fabricate a circuit to route around a missing provider.
//
// #23 wires the seam via HOST INJECTION: `inhuman-mcp-worker` already depends on both
// this package and arrival-mercury, and hands a REAL `ResultHandle` a
// `capabilities.circuitProvider` closure at construction time (discovery-run.ts). This
// file can only ever test the CONSUMING side of that seam, so the "provider present"
// cases below inject a FIXTURE closure standing in for mcp-worker's real one — proving
// `circuitOf` calls it verbatim and skips the door. The "no provider" cases still
// exercise the honest door: it is a well-formed rejection (matching every other reflect
// verb's async contract) that names the real blocker, for BOTH a traceable handle and
// an untraceable one — the same door either way, since the block without an injected
// provider is architectural, not per-handle.
//
// Handle-construction idiom copied from grounding-verbs.test.ts (same fixtures, not re-derived).
import { EnvCapability, LexicalScope, execState } from "@inhuman.tools/arrival";
import { lastTopLevelForm } from "../analysis.js";
import { EvalTrace } from "../index.js";
import { describe, expect, it } from "vitest";

import { circuitOf } from "../reflect/handle-provenance.js";
import { ResultHandle } from "../reflect/result-handle.js";

let seq = 0;

const evidenceReadCapability = EnvCapability.define("test/evidence-read", {
  symbols: (symbol, z) => ({
    "evidence-read": symbol.rosetta`evidence-read: deterministic Rosetta-IN fixture source`(
      { input: [z.string], output: [z.string] },
      (q: string) => `SRC:${q}`,
    ),
  }),
});

/** Same fixture idiom as grounding-verbs.test.ts: a deterministic Rosetta-IN source under a real
 *  traced execState, so a "traceable" handle here is genuinely traceable (real provenance), not
 *  hand-waved. */
async function tracedRun(source: string): Promise<{ trace: EvalTrace; outputNode: unknown; value: unknown }> {
  const scope = LexicalScope.fresh(`circuit-verb-test-${seq++}`);
  const trace = new EvalTrace();
  const { values } = await execState(source, { scope, tap: trace, capabilities: [evidenceReadCapability] });
  const value = values.at(-1);
  if (value === undefined) throw new Error("fixture ran zero forms");
  return { trace, outputNode: lastTopLevelForm(trace), value };
}

/** A handle whose teleological build succeeds — a run `(how h)`/`(dag h)` can already fully
 *  describe. If the seam existed, THIS is the handle `circuit` would render for real. */
async function traceableHandle(): Promise<ResultHandle> {
  const { trace, outputNode, value } = await tracedRun(`(evidence-read "who")`);
  return new ResultHandle(value, async () => ({ trace, outputNode }));
}

/** A handle with no `build` at all — the causal run never finished, `teleological()` throws
 *  immediately (result-handle.ts's own contract). No execState needed: nothing here reaches a
 *  trace. */
function untraceableHandle(): ResultHandle {
  return new ResultHandle("some-value", undefined);
}

/** A handle carrying an injected `circuitProvider` (#23) — a FIXTURE stand-in for mcp-worker's
 *  real one (built over arrival-mercury's extract/circuitToSexpr, which this package can never
 *  import — see this file's header). Whether the handle is otherwise traceable or not is
 *  irrelevant to this capability: `circuitOf` only ever asks "is a provider present", never
 *  touches `teleological()` to answer it. */
function handleWithCircuitProvider(rendered: string): ResultHandle {
  return new ResultHandle("some-value", undefined, { circuitProvider: () => rendered });
}

describe("circuit — a door, never a fabricated circuit, on EITHER handle shape", () => {
  it("a traceable handle (teleological build succeeds): still a door, not a rendered circuit", async () => {
    const h = await traceableHandle();
    // Confirms the premise: this handle really is traceable — (how h)'s own seam works — so the
    // door below is the DEPENDENCY blocker, not a symptom of an untraceable handle.
    const { trace, outputNode } = await h.teleological();
    expect(trace).toBeDefined();
    expect(outputNode).toBeDefined();
    await expect(circuitOf(h)).rejects.toThrow(TypeError);
    await expect(circuitOf(h)).rejects.toThrow(/extract \+ circuitToSexpr/);
    await expect(circuitOf(h)).rejects.toThrow(/does not import the compiler/);
    await expect(circuitOf(h)).rejects.toThrow(/host-injected circuitProvider/);
  });

  it("an untraceable handle (no build at all): the SAME door — the block is architectural, not per-handle", async () => {
    const h = untraceableHandle();
    await expect(circuitOf(h)).rejects.toThrow(TypeError);
    await expect(circuitOf(h)).rejects.toThrow(/extract \+ circuitToSexpr/);
    await expect(circuitOf(h)).rejects.toThrow(/does not import the compiler/);
  });

  it("routes to what this wave DOES offer", async () => {
    await expect(circuitOf(untraceableHandle())).rejects.toThrow(/\(dag h\)/);
    await expect(circuitOf(untraceableHandle())).rejects.toThrow(/\(why h\)/);
  });

  it("never fabricates — the door text names the real artifacts, not a placeholder", async () => {
    try {
      await circuitOf(untraceableHandle());
      expect.fail("circuitOf should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      const message = error instanceof Error ? error.message : String(error);
      // The message NAMES the verb in prose ("(circuit h) — ..."), same convention as every
      // other door in this file (e.g. blastOf's "(blast … …)"). It must never leak a RENDERED
      // circuit node (circuitToSexpr's own shape — ":site N", "(opaque ...)", "(mint ...)") as
      // if a real one had been produced.
      expect(message).not.toContain(":site");
      expect(message).not.toContain("(opaque ");
      expect(message).not.toContain("(mint ");
    }
  });
});

describe("circuit — LIVE via an injected provider (#23, host-injection capability)", () => {
  it("a handle with a circuitProvider capability returns the provider's rendering verbatim — no door", async () => {
    const h = handleWithCircuitProvider('(input :site 0 :name "q")');
    await expect(circuitOf(h)).resolves.toBe('(input :site 0 :name "q")');
  });

  it("the provider is called fresh on every ask (no memoization hiding a stale render)", async () => {
    let n = 0;
    const h = new ResultHandle("some-value", undefined, { circuitProvider: () => `(const :site ${n++})` });
    expect(await circuitOf(h)).toBe("(const :site 0)");
    expect(await circuitOf(h)).toBe("(const :site 1)");
  });

  it("still doors when no provider is injected — the fix is per-capability, not a global flip", async () => {
    await expect(circuitOf(untraceableHandle())).rejects.toThrow(/host-injected circuitProvider capability/);
  });
});
