// grounding-verbs.test.ts — circuit / grounded? / attest (T6a), the grounding trichotomy.
//
// THE STAGING LAW under test: soundness is never staged. On the FALLBACK path — a handle the live
// static∧probe conjunction (T6c) cannot run for, which is every fixture in this package (no
// host-injected attest capability) — `grounded?`/`attest` must NEVER render a positive attestation
// (`content-attested`/`selection-attested`): every leaf verdict is `not-attestable`, carrying a
// per-leaf, trace-based ADVISORY only. The verdict is per
// VALUE-POSITION-LEAF (never a whole-result rollup): a mixed grounded/fabricated pair must attest
// and refuse each leaf INDEPENDENTLY (the F22 mispairing row — `mixedHandle` below is exactly the
// `(cons (number->string (:v e)) "FABRICATED")` shape).
//
// Fixture idiom mirrors arrival-provenance's own verdict.test.ts: a deterministic Rosetta-IN
// source (`evidence-read`) under a real traced `execState`, so leaves are genuinely grounded
// (real provenance), not hand-waved.
import { EnvCapability, LexicalScope, execState } from "@inhuman.tools/arrival";
import { APair, AString } from "@inhuman.tools/arrival/reflect-internals";
import { lastTopLevelForm } from "../analysis.js";
import { EvalTrace } from "../index.js";
import { describe, expect, it } from "vitest";

import { REFLECT_VERBS, attestOf, circuitOf, groundedOf } from "../reflect/handle-provenance.js";
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

/** Run `source` under a fresh traced env with one deterministic Rosetta-IN source,
 *  `(evidence-read q)` → `"SRC:q"` — same fixture idiom as arrival-provenance's verdict.test.ts.
 *  Returns the trace + the run's own output node (`buildSlice`'s anchor, matching how a real
 *  `ResultHandle.teleological()` build closure resolves it) + the causal (grounded) value. */
async function tracedRun(source: string) {
  const scope = LexicalScope.fresh(`grounding-verbs-test-${seq++}`);
  const trace = new EvalTrace();
  const { values } = await execState(source, { scope, tap: trace, capabilities: [evidenceReadCapability] });
  const groundedValue = values.at(-1);
  if (groundedValue === undefined) throw new Error("fixture ran zero forms");
  return { trace, outputNode: lastTopLevelForm(trace), groundedValue };
}

/** A ResultHandle whose value is ONE genuinely grounded leaf (a real evidence-read result) and
 *  whose teleological build succeeds — the "working build" case. */
async function groundedHandle(): Promise<ResultHandle> {
  const { trace, outputNode, groundedValue } = await tracedRun(`(evidence-read "who")`);
  return new ResultHandle(groundedValue, async () => ({ trace, outputNode }));
}

/** A ResultHandle whose value is an IMPROPER pair of two value-position leaves — one genuinely
 *  grounded (the real evidence-read result), one FABRICATED (a freshly-minted, provenance-empty
 *  string cons'd on after the run — the exact laundering verdict.test.ts's own tamper tests use).
 *  The F22 mispairing fixture: `(cons grounded "FABRICATED")`. */
async function mixedHandle(): Promise<ResultHandle> {
  const { trace, outputNode, groundedValue } = await tracedRun(`(evidence-read "who")`);
  const mixedValue = new APair(groundedValue, new AString("FABRICATED"));
  return new ResultHandle(mixedValue, async () => ({ trace, outputNode }));
}

/** A ResultHandle whose causal run never finished (no `build`) — `teleological()` throws
 *  immediately, matching result-handle.ts's own "provenance unavailable" contract. Cheap: no
 *  execState needed since nothing here ever reaches the trace. */
function unfinishedHandle(): ResultHandle {
  return new ResultHandle("some-value", undefined);
}

describe("REFLECT_VERBS — the three grounding verbs are registered", () => {
  const byName = (name: string) => REFLECT_VERBS.find((v) => v.name === name);

  it("circuit: (h: ResultHandle, at?: field-path): sexpr, no required args", () => {
    expect(byName("circuit")).toMatchObject({
      name: "circuit",
      type: "(h: ResultHandle, at?: field-path): sexpr",
      args: [],
    });
  });

  it("grounded?: (h: ResultHandle, at?: field-path): sexpr, no required args", () => {
    expect(byName("grounded?")).toMatchObject({
      name: "grounded?",
      type: "(h: ResultHandle, at?: field-path): sexpr",
      args: [],
    });
  });

  it("attest: (h: ResultHandle, at?: field-path): sexpr, no required args", () => {
    expect(byName("attest")).toMatchObject({
      name: "attest",
      type: "(h: ResultHandle, at?: field-path): sexpr",
      args: [],
    });
  });
});

describe("circuit — no injected circuitProvider on this handle: the door routes to (dag h)/(why h)", () => {
  it("throws a door routing to (dag h)/(why h), regardless of the handle", async () => {
    await expect(circuitOf(unfinishedHandle())).rejects.toThrow(/extract \+ circuitToSexpr/);
    await expect(circuitOf(unfinishedHandle())).rejects.toThrow(/\(dag h\)/);
    await expect(circuitOf(unfinishedHandle())).rejects.toThrow(/\(why h\)/);
  });
});

describe("grounded? — the fallback advisory when the live conjunction can't run: fail-closed, per leaf", () => {
  it("a handle with a working teleological build: not-attestable + a trace-based advisory", async () => {
    const h = await groundedHandle();
    const sexpr = await groundedOf(h);
    expect(sexpr.startsWith("(grounding ")).toBe(true);
    expect(sexpr).toContain(':reason "live-conjunction-unavailable"');
    expect(sexpr).toContain("(leaf :path 0");
    expect(sexpr).toContain(":verdict not-attestable");
    expect(sexpr).toContain('(advisory :from "trace-based-grounding"');
    expect(sexpr).toMatch(/:verdict (signable|scoped|unsigned)/);
    expect(sexpr).toContain("cannot distinguish content from selection — NOT an attestation");
  });

  it("a handle whose build throws (trace unavailable): not-attestable, nil leaves, door text in reason", async () => {
    const h = unfinishedHandle();
    const sexpr = await groundedOf(h);
    expect(sexpr.startsWith("(grounding ")).toBe(true);
    expect(sexpr).toContain(":leaves nil");
    expect(sexpr).toContain("live-conjunction-unavailable; trace unavailable:");
    expect(sexpr).toContain("provenance unavailable"); // teleological()'s own door text, verbatim
  });

  it("a MIXED result (grounded leaf beside a fabricated one) attests/refuses each leaf INDEPENDENTLY", async () => {
    const h = await mixedHandle();
    const sexpr = await groundedOf(h);
    // Two leaves, each still fail-closed at the outer verdict…
    expect((sexpr.match(/\(leaf :path/g) ?? []).length).toBe(2);
    expect((sexpr.match(/:verdict not-attestable/g) ?? []).length).toBe(2);
    expect(sexpr).toContain("(leaf :path 0");
    expect(sexpr).toContain("(leaf :path 1");
    // …but the per-leaf ADVISORY genuinely distinguishes them: the grounded leaf reads
    // differently from the fabricated one — never rolled up into one whole-result scalar.
    expect(sexpr).toContain(":verdict signable"); // leaf 0 — the real evidence-read result
    expect(sexpr).toContain(":verdict unsigned"); // leaf 1 — "FABRICATED", no read behind it
  });
});

describe("attest — same fail-closed discipline, the full artifact shape, per leaf", () => {
  it("a handle with a working teleological build: not-attestable artifact + advisory", async () => {
    const h = await groundedHandle();
    const sexpr = await attestOf(h);
    expect(sexpr.startsWith("(attestation ")).toBe(true);
    expect(sexpr).toContain("(leaf :path 0");
    expect(sexpr).toContain(":verdict not-attestable");
    expect(sexpr).toContain(":static pending");
    expect(sexpr).toContain(":probe pending");
    expect(sexpr).toContain('(advisory :from "trace-based-grounding"');
  });

  it("a handle whose build throws: not-attestable artifact, nil leaves", async () => {
    const h = unfinishedHandle();
    const sexpr = await attestOf(h);
    expect(sexpr.startsWith("(attestation ")).toBe(true);
    expect(sexpr).toContain(":leaves nil");
    expect(sexpr).toContain("live-conjunction-unavailable; trace unavailable:");
  });

  it("a MIXED result: static/probe/verdict are reported per leaf, independently", async () => {
    const h = await mixedHandle();
    const sexpr = await attestOf(h);
    expect((sexpr.match(/\(leaf :path/g) ?? []).length).toBe(2);
    expect((sexpr.match(/:static pending/g) ?? []).length).toBe(2);
    expect((sexpr.match(/:probe pending/g) ?? []).length).toBe(2);
    expect(sexpr).toContain(":verdict signable");
    expect(sexpr).toContain(":verdict unsigned");
  });
});

describe("the no-fake-positives gate", () => {
  it("neither grounded? nor attest EVER renders a positive attestation, on any handle shape", async () => {
    const handles = await Promise.all([groundedHandle(), mixedHandle()]);
    handles.push(unfinishedHandle());
    for (const h of handles) {
      const g = await groundedOf(h);
      const a = await attestOf(h);
      for (const sexpr of [g, a]) {
        expect(sexpr).not.toContain("content-attested");
        expect(sexpr).not.toContain("selection-attested");
      }
    }
  });
});
