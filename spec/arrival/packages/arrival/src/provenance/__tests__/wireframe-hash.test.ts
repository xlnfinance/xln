/**
 * Q8b — hashes, paths, order rows (docs/PROVENANCE.md §5 D3,
 * §1 D6). Unit rows for `wireframe/hash.ts`'s `hashGraph`/`siteHash`/`rootOrdinalPath` —
 * mirrors `wireframe-builder.test.ts`'s harness (same synthetic classifier/base-name
 * shape). The template-store's OWN rows (put/get, the reverse-index amendment) live in
 * `store/__tests__/template-store.test.ts`; `OrdinalPath` composition ops' rows live in
 * `store/__tests__/ordinal-path.test.ts` — this file is the WIREFRAME-side hasher only.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { parse } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import type { Classifier, DeclaredRole } from "../lineage.js";
import { buildWireframe } from "../wireframe/builder.js";
import { hashGraph, siteHash, rootOrdinalPath, siteOf, MAIN_PROGRAM_SITE } from "../wireframe/hash.js";
import type { WireframeProgram } from "../wireframe/types.js";

const ROLES: Record<string, DeclaredRole> = {
  "src-a": "source",
  "src-b": "source",
  "fetch-item": "source",
  "emit!": "sink",
  map: "fan",
};
const CLASSIFIER: Classifier = { roleOf: (op) => ROLES[op] };
const BASE = new Set(["+", "-", "*", ">", "positive?", "car", "cdr", "cons", "list"]);
const isBaseName = (n: string): boolean => BASE.has(n);

async function wf(code: string): Promise<WireframeProgram> {
  const forms = await parse(code);
  return buildWireframe(forms, { classifier: CLASSIFIER, isBaseName });
}

beforeAll(async () => {});

describe("templateHash (§5 D3: spans STRIPPED — dedup and store identity)", () => {
  it("building the SAME program twice from source text yields IDENTICAL hashes", async () => {
    const code = "(+ (src-a) (emit! (src-b)))";
    const p1 = await wf(code);
    const p2 = await wf(code);
    expect(hashGraph(p1.main)).toBe(hashGraph(p2.main));
    // sanity: the graphs actually have designated content to hash, not two empties
    // agreeing vacuously.
    expect(p1.main.nodes.length).toBeGreaterThan(0);
  });

  it("two structurally-identical wires at two DIFFERENT program sites share ONE templateHash — the dedup half of §5 D3", async () => {
    // Two separate top-level forms, each an identical shape `(emit! (src-a))` — the
    // per-graph `templateHash` is computed over the WHOLE main graph, so this row
    // instead demonstrates dedup at the GRAPH level: a `map` fan's private template
    // (one graph per fan node) is byte-identical when the callback bodies are, however
    // many distinct `map` call sites embed it.
    const p = await wf("(list (map (lambda (v) (src-a v)) xs) (map (lambda (v) (src-a v)) ys))");
    const fans = p.main.nodes.filter((n) => n.kind === "fan");
    expect(fans).toHaveLength(2);
    const [fanA, fanB] = fans;
    if (fanA.kind !== "fan" || fanB.kind !== "fan" || !fanA.template || !fanB.template) {
      throw new Error("expected both fans to carry a private template");
    }
    // Two DIFFERENT program sites (two distinct `map` calls) whose callback bodies are
    // structurally identical share ONE templateHash — the store dedups their content.
    expect(hashGraph(fanA.template)).toBe(hashGraph(fanB.template));
    // ...but their SITES are distinct (different spans on the fan nodes themselves) —
    // proven in the siteHash describe block below.
    expect(fanA.span).not.toBe(fanB.span);
  });

  it("is NOT α-invariant — a program renamed to different (but structurally identical) bound-variable spelling hashes DIFFERENTLY (the documented conservative ruling)", async () => {
    const p1 = await wf("(map (lambda (v) (src-a v)) xs)");
    const p2 = await wf("(map (lambda (w) (src-a w)) xs)");
    const fan1 = p1.main.nodes.find((n) => n.kind === "fan");
    const fan2 = p2.main.nodes.find((n) => n.kind === "fan");
    if (fan1?.kind !== "fan" || fan2?.kind !== "fan" || !fan1.template || !fan2.template) {
      throw new Error("expected both programs to designate a fan with a template");
    }
    // The callback bodies are α-equivalent (same structure, different bound-variable
    // spelling: v vs w) but hash DIFFERENTLY — `hash.ts`'s documented LIMIT: wire
    // `source`/`params` text carries the literal spelling, and this file rules
    // conservative-position-inclusive-of-naming rather than risk a canonicalization bug.
    expect(hashGraph(fan1.template)).not.toBe(hashGraph(fan2.template));
  });

  it("structurally DIFFERENT graphs hash differently (sanity: the hash is not a constant)", async () => {
    const p1 = await wf("(emit! (src-a))");
    const p2 = await wf("(emit! (src-b))");
    expect(hashGraph(p1.main)).not.toBe(hashGraph(p2.main));
  });
});

describe('siteHash (§5 D3: spans KEPT — plane identity; "the two sites render as two wires")', () => {
  it("two sites sharing one templateHash mint TWO DIFFERENT siteHashes — one per span", async () => {
    const p = await wf("(list (map (lambda (v) (src-a v)) xs) (map (lambda (v) (src-a v)) ys))");
    const fans = p.main.nodes.filter((n) => n.kind === "fan");
    const [fanA, fanB] = fans;
    if (fanA.kind !== "fan" || fanB.kind !== "fan" || !fanA.template || !fanB.template) {
      throw new Error("expected both fans to carry a private template");
    }
    const shared = hashGraph(fanA.template);
    expect(hashGraph(fanB.template)).toBe(shared); // dedup precondition for this row
    const siteA = siteHash(shared, siteOf(fanA));
    const siteB = siteHash(shared, siteOf(fanB));
    expect(siteA).not.toBe(siteB); // "the two sites render as two wires"
  });

  it("the same (templateHash, site) pair is deterministic — re-hashing agrees with itself", async () => {
    const p = await wf("(emit! (src-a))");
    const t = hashGraph(p.main);
    expect(siteHash(t, MAIN_PROGRAM_SITE)).toBe(siteHash(t, MAIN_PROGRAM_SITE));
  });
});

describe("rootOrdinalPath (§1 D6: root-binder program order owns top-level sequencing)", () => {
  it("assigns each designated node its position in the graph's own build order, in program order", async () => {
    const p = await wf("(list (src-a) (src-b))");
    // Two designated `source` nodes, discovered left-to-right — their root ordinals
    // are 0 and 1, matching program order, NOT alphabetical/hash order.
    const sourceIdxs = p.main.nodes.reduce<number[]>((acc, n, i) => (n.kind === "source" ? [...acc, i] : acc), []);
    expect(sourceIdxs).toHaveLength(2);
    expect(sourceIdxs.map(rootOrdinalPath)).toEqual([[sourceIdxs[0]], [sourceIdxs[1]]]);
    expect(sourceIdxs[0]).toBeLessThan(sourceIdxs[1]); // src-a's call precedes src-b's
  });

  it("keeps two structurally-identical designated nodes at different sites collision-free — the reason root ordinals exist at all", async () => {
    // Two IDENTICAL top-level calls: same op, same (empty) argument shape — their
    // per-graph templateHash-relevant content is indistinguishable by structure alone,
    // yet they occupy different program positions and so get different root ordinals.
    const p = await wf("(list (src-a) (src-a))");
    const sourceIdxs = p.main.nodes.reduce<number[]>((acc, n, i) => (n.kind === "source" ? [...acc, i] : acc), []);
    expect(sourceIdxs).toHaveLength(2);
    const [pathA, pathB] = sourceIdxs.map(rootOrdinalPath);
    expect(pathA).not.toEqual(pathB);
  });
});
