// boxed-leaf-enumeration.test.ts — #15: the injected `boxedValue` capability lifts leafRows'
// documented single-leaf limitation (handle-provenance.ts's `leafRows` doc; result-handle.ts's
// header). Today's production `ResultHandle.value` is the `schemeToJs`-PEELED projection — a
// peeled container is plain JS data (an array/object), not `APair`/`AVector`/`ADict`, so
// `verdictLeafValues` never descends it: ONE atomic leaf regardless of how many real leaves the
// underlying value had. mcp-worker's `discovery-run.ts` now also captures the RAW pre-peel
// AValue (`RunHandle.result`) and hands it to `ResultHandle` as `capabilities.boxedValue` — this
// file proves that when present, `grounded?`/`attest` enumerate the REAL leaf count.
//
// STILL advisory-only (T6a's staging law, unchanged by #15): every leaf below is STILL
// `not-attestable` — only what gets COUNTED improves, never the verdict. This file does not touch
// the no-fake-positives gate (grounding-verbs.test.ts owns that; left untouched per this wave's
// discipline).
//
// Fixture idiom copied from grounding-verbs.test.ts's `mixedHandle` (same deterministic Rosetta-IN
// source + hand-built APair cons of a grounded leaf beside a fabricated one), not re-derived.
import { EnvCapability, LexicalScope, execState } from "@inhuman.tools/arrival";
import { APair, AString } from "@inhuman.tools/arrival/reflect-internals";
import { lastTopLevelForm } from "../analysis.js";
import { EvalTrace } from "../index.js";
import { describe, expect, it } from "vitest";

import { attestOf, groundedOf } from "../reflect/handle-provenance.js";
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

/** Same fixture idiom as grounding-verbs.test.ts's `tracedRun`: a deterministic Rosetta-IN source
 *  under a real traced execState, so the grounded leaf is genuinely grounded, not hand-waved. */
async function tracedRun(source: string) {
  const scope = LexicalScope.fresh(`boxed-leaf-test-${seq++}`);
  const trace = new EvalTrace();
  const { values } = await execState(source, { scope, tap: trace, capabilities: [evidenceReadCapability] });
  const groundedValue = values.at(-1);
  if (groundedValue === undefined) throw new Error("fixture ran zero forms");
  return { trace, outputNode: lastTopLevelForm(trace), groundedValue };
}

describe("#15 — capabilities.boxedValue lifts the single-peeled-leaf limitation", () => {
  it("a boxed cons of 2 leaves enumerates 2 leaves via the capability, each still not-attestable", async () => {
    const { trace, outputNode, groundedValue } = await tracedRun(`(evidence-read "who")`);
    // The RAW boxed container — an improper pair of a genuinely grounded leaf and a fabricated
    // one, exactly the F22 mispairing shape grounding-verbs.test.ts's mixedHandle uses.
    const boxedValue = new APair(groundedValue, new AString("FABRICATED"));
    // The PEELED `.value` a real caller would hand ResultHandle without the capability — flattened
    // JS data, ONE atomic leaf (verdictLeafValues never descends a plain JS array).
    const peeledValue = [String(groundedValue), "FABRICATED"];
    const h = new ResultHandle(peeledValue, async () => ({ trace, outputNode }), { boxedValue });

    const grounded = await groundedOf(h);
    expect((grounded.match(/\(leaf :path/g) ?? []).length).toBe(2);
    expect((grounded.match(/:verdict not-attestable/g) ?? []).length).toBe(2);
    expect(grounded).toContain("(leaf :path 0");
    expect(grounded).toContain("(leaf :path 1");
    // The per-leaf ADVISORY still genuinely distinguishes them — enumeration improved, the
    // grounded/fabricated distinction was always there.
    expect(grounded).toContain(":verdict signable");
    expect(grounded).toContain(":verdict unsigned");

    const attested = await attestOf(h);
    expect((attested.match(/\(leaf :path/g) ?? []).length).toBe(2);
    expect((attested.match(/:static pending/g) ?? []).length).toBe(2);
    expect((attested.match(/:probe pending/g) ?? []).length).toBe(2);
  });

  it("without the capability, the SAME run's peeled value still enumerates as one leaf (the documented fallback)", async () => {
    const { trace, outputNode, groundedValue } = await tracedRun(`(evidence-read "who")`);
    const peeledValue = [String(groundedValue), "FABRICATED"];
    const h = new ResultHandle(peeledValue, async () => ({ trace, outputNode })); // no capabilities
    const grounded = await groundedOf(h);
    expect((grounded.match(/\(leaf :path/g) ?? []).length).toBe(1);
    expect(grounded).toContain(":verdict not-attestable");
  });

  it("a captured raw value that happens to be bare `undefined` still counts as PRESENT, not absent", async () => {
    // result-handle.ts's own contract: `Object.hasOwn`, never `!== undefined` — a captured raw
    // result CAN legitimately be plain JS `undefined` (e.g. `RunHandle.result` on a zero-form
    // program), so a capabilities object that OWNS the `boxedValue` key with an `undefined` value
    // must still be read as "the host captured this", never silently fall back to `h.value`.
    // Proof: `h.value` here is deliberately a real APair (2 leaves) — a naive `!== undefined`
    // presence check would wrongly treat `boxedValue: undefined` as absent and fall back to it,
    // reading 2 leaves; the correct `Object.hasOwn` check reads the OWNED `undefined` itself
    // (`verdictLeafValues(undefined)`: not an APair/AVector/ADict, so ONE atomic leaf), proving
    // the fallback did NOT fire.
    const { trace, outputNode, groundedValue } = await tracedRun(`(evidence-read "who")`);
    const twoLeafValue = new APair(groundedValue, new AString("FABRICATED"));
    const h = new ResultHandle(twoLeafValue, async () => ({ trace, outputNode }), {
      boxedValue: undefined,
    });
    const grounded = await groundedOf(h);
    expect((grounded.match(/\(leaf :path/g) ?? []).length).toBe(1);
    expect(grounded).toContain("(leaf :path 0");
  });
});
