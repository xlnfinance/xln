// capability-rosetta-symbol.test.ts — the SECOND lower() path: a rosetta SymbolDef.
//
// The equality pilot (equality.ts) is native-only, so it exercises only the `kind:"native"`
// arm of EnvCapability.lower(). This file proves the `kind:"rosetta"` arm end-to-end:
//   declare (symbol.rosetta) → put in an EnvCapability → lower() → apply() → call the bound verb,
// asserting BOTH halves of the contract:
//   1. the CODEC MEMBRANE — decode scheme→JS, run impl, encode JS→scheme (+ validation rejection);
//   2. the PROVENANCE MINT (the former TODO, now resolved) — the bound `run` is `__withCtx`, so the
//      evaluator appends ctx; given a ctx.currentInvocation the wrapper MARKS the point and stamps
//      the output with `pointProvenance(inv.id)` — the same source-mint behavior as `symbol.rosetta`.
//
// The mint is driven here by a SYNTHETIC ctx (a POJO invocation), exactly the
// direct-JS shape the host-fn lens tests use — no full evaluator needed to prove the wiring.
import { describe, expect, it } from "vitest";
import { CONSTANT_CTX, RunContext } from "../../run/RunContext.js";
import { EnvCapability } from "../capability.js";
import { applyCapability } from "../../__tests__/_fresh-env.js";
import { symbol } from "../../symbol/index.js";
import { makeCallCtx, type CallCtx } from "../../run/CallCtx.js";
import * as z from "../scheme-zod/index.js";
import { ResolvingAmbient } from "../../env/AmbientRuntime.js";
import { AString } from "../../values/primitives/AString.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { AValue } from "../../values/primitives/AValue.js";
import type { InvocationLike } from "../../membrane/rosetta.js";
import { ARosettaProcedure } from "../../values/primitives/ARosettaProcedure.js";
import { withDynamicCallSite } from "../../eval/dynamic-call-site.js";
import { tf } from "../../values/tagless-final.js";
import type { SchemeValue } from "../../values/types.js";

/** A SchemeEnv that records every `set` binding (native + rosetta SymbolDefs route through set). */
function recordingEnv(): { env: ResolvingAmbient; verbs: Record<string, ARosettaProcedure> } {
  // A REAL frame (hermetic-Environment ruling: capability apply narrows to the concrete
  // `AmbientRuntime`); `verbs` reads the frame's own storage record — same boundary narrow
  // the old synthetic recorder did.
  const env = ResolvingAmbient.root("rosetta-symbol-recording");
  const verbs = new Proxy({} as Record<string, ARosettaProcedure>, { get: (_t, n) => env.__env__[n as string] });
  return { env, verbs };
}

/** A synthetic invocation carrying a provenance-point marker (the shape the wrapper reads
 *  off `this.invocation.currentInvocation`). */
function invocationWithId(id: number): { invocation: InvocationLike; marked: () => boolean } {
  let didMark = false;
  const invocation: InvocationLike = {
    id,
    isProvenancePoint: false,
    markProvenancePoint() {
      didMark = true;
      this.isProvenancePoint = true;
    },
  };
  return { invocation, marked: () => didMark };
}

async function wireRosetta(def: ARosettaProcedure): Promise<ARosettaProcedure> {
  // Stage A2's key-name gate (SymbolKeyMismatchError, common/capability.ts) demands the
  // record key match the value's own mint-time name — bind it under ITS OWN name, then
  // `symbol.alias` it to the harness's stable "verb" accessor (the alias arm is exempt
  // from the gate by design: dissolution is a duplicate binding under a DIFFERENT name).
  const name = (def.contract as { name: string }).name;
  const cap = EnvCapability.define("test/rosetta", {
    symbols: (symbol) => ({ [name]: def, verb: symbol.alias`${name}` }),
  });
  const { env, verbs } = recordingEnv();
  await applyCapability(env, [cap]);
  expect(verbs.verb).toBeInstanceOf(ARosettaProcedure);
  return verbs.verb;
}

/** Invoke a bound verb the way the REAL evaluator does post-binder-cut: build the whole
 *  `CallCtx` (runCtx + invocation) ONCE and thread it through the apply term — the binder
 *  adapter no longer reconstructs it from ambient state (reverse-membrane-for-callables.md
 *  §9, option (c) is retired; Stage 1a threads the invocation explicitly instead). Still
 *  publishes the invocation on the evaluator-owned ambient dynamic call site too, matching
 *  what a real dispatch does for nested lambda re-entry. */
function invoke(
  verb: ARosettaProcedure,
  opts: { runCtx?: RunContext; currentInvocation?: InvocationLike } | undefined,
  ...args: unknown[]
): unknown {
  return withDynamicCallSite(opts?.currentInvocation, () =>
    verb[tf("apply")](args as SchemeValue[], makeCallCtx(opts?.runCtx ?? CONSTANT_CTX, opts?.currentInvocation)),
  );
}

describe("the rosetta SymbolDef arm — bound via the vocabulary build", () => {
  it("decodes scheme→JS, runs impl, encodes JS→scheme through the bound verb", async () => {
    const def = symbol.rosetta`strlen: length of a string`({ input: [z.string], output: [z.number] }, (s) => s.length);
    const verb = await wireRosetta(def);
    // No ctx (a direct/test call) — proves the codec membrane in isolation.
    const out = await invoke(verb, undefined, new AString("hello"));
    expect(out).toBeInstanceOf(AInexact); // z.number encode → inexact
    expect((out as AInexact).real).toBe(5);
  });

  it("rejects a bad arg via the input codec (errors-as-doors) through the bound verb", async () => {
    const def = symbol.rosetta`strlen: length of a string`({ input: [z.string], output: [z.number] }, (s) => s.length);
    const verb = await wireRosetta(def);
    // A SchemeExact is not a SchemeString → the z.string codec's instanceof guard doors.
    await expect(invoke(verb, undefined, new AExact(3))).rejects.toThrow();
  });

  it("MINTS provenance off ctx.currentInvocation — marks the point + stamps the output", async () => {
    const def = symbol.rosetta`strlen: length of a string`({ input: [z.string], output: [z.number] }, (s) => s.length);
    const verb = await wireRosetta(def);

    const { invocation, marked } = invocationWithId(42);
    const out = (await invoke(verb, { currentInvocation: invocation }, new AString("hello"))) as AInexact;

    expect(out).toBeInstanceOf(AInexact);
    expect(out.real).toBe(5);
    expect([...out.provenance]).toEqual([42]);
    expect(marked()).toBe(true);
    expect(invocation.isProvenancePoint).toBe(true);
  });

  it("DEEP-STAMPS a structured (list) output — every element carries the minted origin", async () => {
    // A rosetta returning a JS array → a scheme list (Pair-chain). The mint must reach every
    // element (spec §5.3: element-only lineage), exactly like jsToScheme's deep stamp.
    const def = symbol.rosetta`split: chars of a string`({ input: [z.string], output: [z.array(z.string)] }, (s) => [
      ...s,
    ]);
    const verb = await wireRosetta(def);

    const { invocation } = invocationWithId(7);
    const out = (await invoke(verb, { currentInvocation: invocation }, new AString("ab"))) as AValue;
    const seen: number[][] = [];
    const walk = (v: unknown): void => {
      if (v instanceof AValue) {
        seen.push([...v.provenance]);
        const anyV = v as unknown as { car?: unknown; cdr?: unknown };
        if ("car" in anyV) {
          walk(anyV.car);
          walk(anyV.cdr);
        }
      }
    };
    walk(out);
    expect(seen.length).toBeGreaterThan(0);
    for (const p of seen) expect(p).toEqual([7]);
  });

  it("WITHOUT a ctx invocation, forwards the inputs' provenance (mint is ctx-gated, not unconditional)", async () => {
    const def = symbol.rosetta`echo: identity string`({ input: [z.string], output: [z.string] }, (s) => s);
    const verb = await wireRosetta(def);

    // An input string carrying a known origin; no ctx → resultProvenance falls back to the input union.
    const tagged = new AString("x", new Set([99]));
    const out = (await invoke(verb, undefined, tagged)) as AString;
    expect(out["arrival/toJS"]()).toBe("x");
    expect([...out.provenance]).toEqual([99]);
  });

  it("invocation-`this`: a `function` impl reads run-state off `this.runCtx` (signal / aborted)", async () => {
    // A ctx-coupled verb declares a `function` impl (NOT an arrow) and reads the run's abort
    // state off the flat `CallCtx` `this`. The wrapper forwards that `this` as-is.
    const def = symbol.rosetta`probe: report the run's abort state`(
      { input: [z.string], output: [z.string] },
      function (this: CallCtx, s: string) {
        const tag = this.runCtx.signal ? (this.runCtx.signal.aborted ? "aborted" : "live") : "no-signal";
        return `${s}:${tag}`;
      },
    );
    const verb = await wireRosetta(def);

    // runCtx carrying a (not-yet-aborted) AbortSignal — the shape a real exec() mints.
    const ac = new AbortController();
    const runCtx = new RunContext({ signal: ac.signal });
    const out = (await invoke(verb, { runCtx }, new AString("x"))) as AString;
    expect(out["arrival/toJS"]()).toBe("x:live");

    // After abort, the SAME signal reference reads as aborted (read on access).
    ac.abort();
    const out2 = (await invoke(verb, { runCtx }, new AString("y"))) as AString;
    expect(out2["arrival/toJS"]()).toBe("y:aborted");
  });

  it("invocation-`this`: a pure ARROW impl is unaffected — `this` is ignored, run behavior byte-identical", async () => {
    // The 50+ pure verbs are arrows: they ignore `this` entirely, so `impl.call(this, …)` is
    // exactly `impl(…)`. Proven both WITH a runCtx (signal present) and direct-JS (no ctx).
    const def = symbol.rosetta`strlen: length of a string`({ input: [z.string], output: [z.number] }, (s) => s.length);
    const verb = await wireRosetta(def);

    // direct-JS (no ctx → CallCtx defaults to CONSTANT_CTX; the arrow never looks)
    const direct = (await invoke(verb, undefined, new AString("hello"))) as AInexact;
    expect(direct.real).toBe(5);

    // with a runCtx carrying an aborted signal — a pure arrow STILL ignores it (no early-out, same value)
    const ac = new AbortController();
    ac.abort();
    const withCtx = (await invoke(
      verb,
      { runCtx: new RunContext({ signal: ac.signal }) },
      new AString("world"),
    )) as AInexact;
    expect(withCtx.real).toBe(5);
  });

  it("pure: true FORWARDS input provenance even WITH a ctx invocation (transform, not source — never mints)", async () => {
    // The contrast to the mint test above: SAME ctx.currentInvocation(42) + SAME tagged input {99},
    // but `pure: true` makes it a TRANSFORM — the output carries the FORWARDED input union {99},
    // NOT pointProvenance(42), and the invocation is NOT marked a point. (Minting here would
    // fabricate a fresh origin — the seal-laundering class of bug `pure` exists to prevent.)
    const def = symbol.rosetta`echo: identity string`(
      { input: [z.string], output: [z.string], provenance: "pipe" },
      (s) => s,
    );
    const verb = await wireRosetta(def);

    const { invocation, marked } = invocationWithId(42);
    const tagged = new AString("x", new Set([99]));
    const out = (await invoke(verb, { currentInvocation: invocation }, tagged)) as AString;
    expect(out["arrival/toJS"]()).toBe("x");
    expect([...out.provenance]).toEqual([99]);
    expect(marked()).toBe(false);
    expect(invocation.isProvenancePoint).toBe(false);
  });
});
