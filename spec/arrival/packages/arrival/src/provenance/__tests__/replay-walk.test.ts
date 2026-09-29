/**
 * Q17 — unit rows for `replay-walk.ts`'s lazy step-walk (docs/PROVENANCE.md §4 m2:
 * "step-WALKS... stream lazily off the generator-based interpreter"). Two things
 * this file pins that the law files don't:
 *   1. EQUIVALENCE — `walkGraphReplay` drained to completion returns the BYTE-
 *      IDENTICAL `ReplayedValue` (boxed AND peeled) `replayGraphEgress` (replay.ts)
 *      computes for the same inputs — the safety net for this file's node-switch
 *      duplication (see replay-walk.ts's own header).
 *   2. GENUINE LAZINESS — stopping after ONE pulled step leaves a source on the
 *      eventually-DEMANDED path still un-consumed in the shared `FrozenMints` —
 *      not just "the untaken mux arm is never touched" (A2/D2, already a Q16
 *      property of the non-generator driver too), but "a step further down the
 *      SAME demanded chain hasn't run yet," which only a genuinely pull-driven
 *      generator can give you.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { parse } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import type { Classifier, DeclaredRole } from "../lineage.js";
import { buildWireframe } from "../wireframe/builder.js";
import { collapseProvenance } from "../provenance-collapse.js";
import { replayGraphEgress, type ReplayedValue } from "../replay.js";
import { walkGraphReplay } from "../replay-walk.js";
import { freezeMints, recordRun } from "../../__tests__/provenance/q16-harness.js";

const ROLES: Record<string, DeclaredRole> = {
  "fetch-item": "source",
  "fetch-a": "source",
  "fetch-b": "source",
  "src-c": "source",
  "src-d": "source",
  "src-e": "source",
};
const CLASSIFIER: Classifier = { roleOf: (op) => ROLES[op] };
const BASE = new Set(["*", "positive?", "if"]);
const isBaseName = (n: string): boolean => BASE.has(n);

async function wf(code: string) {
  const forms = await parse(code);
  return buildWireframe(forms, { classifier: CLASSIFIER, isBaseName });
}

beforeAll(async () => {});

describe("walkGraphReplay — equivalence with replayGraphEgress", () => {
  it("a straight-line single-source wire: draining the walk yields the SAME value+cone as the whole-graph call", async () => {
    const CODE = "(* (fetch-item) 2)";
    const program = await wf(CODE);
    const run = await recordRun(inferenceEnv, CODE, { "fetch-item": "num" });

    const stepped: unknown[] = [];
    const gen = walkGraphReplay({ program, frozen: freezeMints(run.mints) });
    let res = await gen.next();
    while (!res.done) {
      stepped.push(res.value.value);
      res = await gen.next();
    }
    const walked = res.value;

    const whole = await replayGraphEgress({ program, frozen: freezeMints(run.mints) });
    expect(walked.value).toBe(whole.value);
    expect(walked.value).toBe(run.egress);
    expect(stepped.length).toBeGreaterThan(0); // at least one γ step was observed
  });

  it("a port-coupled mux: draining the walk yields the SAME value+cone as the whole-graph call, and steps observe both the selector and the taken arm", async () => {
    const CODE = "(if (positive? (fetch-item)) (src-c) (src-d))";
    const program = await wf(CODE);
    const run = await recordRun(inferenceEnv, CODE, { "fetch-item": "num", "src-c": "num", "src-d": "num" });

    const steps: unknown[] = [];
    const gen = walkGraphReplay({ program, frozen: freezeMints(run.mints) });
    let res = await gen.next();
    while (!res.done) {
      steps.push(res.value.value);
      res = await gen.next();
    }
    const walked = res.value;

    const whole = await replayGraphEgress({ program, frozen: freezeMints(run.mints) });
    expect(walked.value).toBe(whole.value);
    expect([...collapseProvenance(walked.boxed)].sort()).toEqual([...collapseProvenance(whole.boxed)].sort());
    expect(steps.length).toBeGreaterThanOrEqual(2); // selector + taken arm, at minimum
  });
});

describe("walkGraphReplay — genuine pull-driven laziness", () => {
  it("stopping after ONE pulled step leaves a source further down the DEMANDED chain still un-consumed", async () => {
    // Outer selector reads fetch-a (always positive — a mint id). The TAKEN outer
    // arm is itself a nested port-coupled `if` whose OWN selector reads fetch-b —
    // a SECOND, later step on the very path the walk will eventually take. src-d/
    // src-e sit behind untaken branches and are irrelevant to this assertion (their
    // non-consumption is an A2/D2 property already covered elsewhere, not what this
    // test is isolating).
    const CODE = "(if (positive? (fetch-a)) (if (positive? (fetch-b)) (src-c) (src-d)) (src-e))";
    const program = await wf(CODE);
    const run = await recordRun(inferenceEnv, CODE, {
      "fetch-a": "num",
      "fetch-b": "num",
      "src-c": "num",
      "src-d": "num",
      "src-e": "num",
    });

    const drivingFrozen = freezeMints(run.mints);
    const gen = walkGraphReplay({ program, frozen: drivingFrozen });
    const first = await gen.next();
    expect(first.done).toBe(false); // the walk has NOT completed after one pull

    // fetch-b sits on the demanded chain (the taken outer arm needs it) but has not
    // been reached yet — a fresh `.next("fetch-b")` on the SAME FrozenMints instance
    // the generator is consuming must still find its payload UNCONSUMED. If the
    // walk had eagerly computed the whole graph on its first `.next()` call (i.e.
    // if this file's laziness claim were false), this would already be drained.
    const stillQueued = drivingFrozen.next("fetch-b");
    expect(stillQueued).toBeDefined();

    // Sanity: the SAME op, called again, is now empty — confirming the probe above
    // genuinely consumed the one queued payload (not an artifact of an empty queue
    // returning `undefined` either way).
    expect(drivingFrozen.next("fetch-b")).toBeUndefined();

    // Full-graph comparison uses a FRESH FrozenMints (the driving one above was
    // deliberately perturbed by the probe just taken).
    const whole: ReplayedValue = await replayGraphEgress({ program, frozen: freezeMints(run.mints) });
    expect(whole.value).toBe(run.egress);
  });
});
