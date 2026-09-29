// Q20a/Q20b — eager-oracle opt-out/demotion law (docs/PROVENANCE.md §4 "the eager
// stamp path is a TEST-ONLY oracle"; the sampler case, and the production-default flip).
//
// Q20a (LANDED 54e6347418) wired `setEagerProvenanceOracleEnabled(false)` as a
// process-wide opt-OUT for provenance NON-consumers with real-time budgets
// (arrival-sampler's oracle loop), default UNCHANGED (true).
//
// Q20b (this file's current shape) flips the DEFAULT itself: production hot paths no
// longer accumulate eager stamps unless something explicitly asks for them (an opt-IN
// now, not an opt-out) — docs/PROVENANCE.md §4 C12: "the eager stamp path is a
// TEST-ONLY oracle... compiled out of production hot paths." The law now has FIVE
// clauses:
//   1. The DEFAULT is OFF — a fresh process (or a test that hasn't touched the flag)
//      accumulates ZERO stamps, even from stamped operands.
//   2. Flag OFF does NOT skip BOXING — R1's boxed-value discipline is semantics, not
//      provenance payload: raw scalars still exit `withInputProvenance` boxed.
//   3. Flag OFF collapses boolean verdicts to the eq?-stable flyweights (allocation-
//      free hot loop) — same as Q20a's original clause, now the DEFAULT behavior.
//   4. Turning the flag ON (the CI agreement oracle's own opt-in, `wireframe-
//      agreement.law.test.ts`/`w1-harness.ts`/`q16-harness.ts`) restores full
//      accumulation — the oracle still exists, on demand.
//   5. Round-trip: OFF → ON → OFF restores the (new) default exactly.
//
// W4 ACCUMULATION DEATH (P10's own exit-gate phrase: "eager mode
// demoted to oracle; 186MB failure mode gone" — docs/PROVENANCE.md §4 "the eager stamp
// path is a TEST-ONLY oracle"): the last test below runs a REAL
// program through the REAL interpreter (`execState`, not a direct `withInputProvenance`
// call) with the DEFAULT flags untouched, and asserts the egress carries EMPTY
// provenance end-to-end — the production demotion is provable through the whole
// pipeline, not just at op-helpers.ts's own boundary. See src/__tests__/ledger/
// index.law.test.ts's GAPS section for the retirement note.
//
// Granularity note: the flag is module-global by ruling (V, 2026-07-09: sampler is an
// experimental package running in its own processes). If a process ever needs stamped
// and unstamped envs simultaneously, upgrade path = RunContext-carried flag.
import { describe, it, expect, afterEach } from "vitest";
import type { EnvWithInternals, ResolvingAmbient } from "../../env/AmbientRuntime.js";
import {
  isEagerProvenanceOracleEnabled,
  setEagerProvenanceOracleEnabled,
  withInputProvenance,
  mintVerdict,
} from "../../values/op-helpers.js";
import { schemeTrue, schemeFalse } from "../../values/primitives/ABool.js";
import { AValue } from "../../values/primitives/AValue.js";
import { fromJs } from "../../membrane/boxing.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { execStateOverFrame as execState } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { jsToScheme } from "../../membrane/rosetta.js";

const stamped = (v: number, id: number): AValue => fromJs(CONSTANT_CTX, v, new Set([id])) as AValue;

// Restore to the CURRENT default (OFF, Q20b) after every test — never hardcode the
// pre-Q20b value here, or a future default change silently desyncs this file from the
// module it's testing.
afterEach(() => setEagerProvenanceOracleEnabled(false));

describe("Q20b — eager-oracle demotion (@ledger: Q20b — LANDED)", () => {
  it("default is OFF: production hot path accumulates nothing, even from stamped operands", () => {
    expect(isEagerProvenanceOracleEnabled()).toBe(false);
    const out = withInputProvenance([stamped(1, 7), stamped(2, 9)], 3);
    expect(out).toBeInstanceOf(AValue); // clause 2: boxing survives regardless
    expect((out as unknown as AValue).provenance.size).toBe(0); // clause 1
  });

  it("default OFF collapses verdicts to the eq?-stable flyweights even from stamped operands", () => {
    expect(mintVerdict([stamped(1, 7)], true)).toBe(schemeTrue);
    expect(mintVerdict([stamped(1, 7)], false)).toBe(schemeFalse);
  });

  it("default OFF leaves already-boxed results untouched (no strip, no re-wrap)", () => {
    const boxed = stamped(5, 7);
    expect(withInputProvenance([stamped(1, 9)], boxed)).toBe(boxed);
  });

  it("turning the oracle ON restores full accumulation (the CI agreement opt-in)", () => {
    setEagerProvenanceOracleEnabled(true);
    const out = withInputProvenance([stamped(1, 7), stamped(2, 9)], 3);
    expect(out).toBeInstanceOf(AValue);
    expect([...(out as unknown as AValue).provenance].sort()).toEqual([7, 9]);
  });

  it("round-trip: ON then OFF again restores the (new) default of zero accumulation", () => {
    setEagerProvenanceOracleEnabled(true);
    setEagerProvenanceOracleEnabled(false);
    const out = withInputProvenance([stamped(1, 7)], 2);
    expect((out as unknown as AValue).provenance.size).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // W4 — the accumulation death, proven through a REAL exec (not a direct
  // op-helpers.ts call). P10's own exit-gate phrase (docs/PROVENANCE.md §4 "the eager
  // stamp path is a TEST-ONLY oracle"): "eager mode
  // demoted to oracle; 186MB failure mode gone (R3 benchmark)" — this is that demotion,
  // asserted end-to-end at the production default, no flag touched anywhere in this
  // test.
  // ─────────────────────────────────────────────────────────────────────────────
  it("W4 — a real program run with DEFAULT flags accumulates ZERO stamps end-to-end", async () => {
    expect(isEagerProvenanceOracleEnabled()).toBe(false); // untouched — this run rides the true default
    const env = inferenceEnv.child("w4-accumulation-death") as EnvWithInternals<ResolvingAmbient>;
    env.bind("a", jsToScheme(CONSTANT_CTX, 10, {}, new Set([100])));
    env.bind("b", jsToScheme(CONSTANT_CTX, 20, {}, new Set([200])));
    // A program shaped exactly like the pre-Q20 eager goldens (golden-prov-arithmetic's
    // merge case) — under the OLD always-on default this produced provenance {100,200}.
    // Under Q20b's default, the merge, the nested arithmetic, AND the string collapse
    // all accumulate nothing: the whole pipeline (parser → evaluator → op-helpers) never
    // touches the accumulation branch.
    const [result] = (await execState(`(string-append "sum=" (number->string (+ a (* b 2))))`, { env })).values;
    expect(result).toBeInstanceOf(AValue);
    expect((result as AValue).provenance.size).toBe(0);
  });
});
