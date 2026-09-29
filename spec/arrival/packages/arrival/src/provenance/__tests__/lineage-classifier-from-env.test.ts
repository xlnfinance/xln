/**
 * `classifierFromEnv` reads the ONE declared `provenance` role stamped onto each
 * bound callable (`.provenanceRole` — `common/capability.ts`, resolved from
 * `Contract.provenance` at bake time, `common/symbols/_bake.ts`). Q3
 * (docs/PROVENANCE.md §2) retired the caller-supplied `sources: ReadonlySet<string>`
 * seam this test used to exercise via an explicit rosetta source
 * list — that heuristic no longer exists (docs/PROVENANCE.md §2 EXCLUDED). These
 * cases bind plain marker values directly (`.provenanceRole` stamped, no real
 * rosetta wrapper needed — `classify()` never calls the bound value, it only
 * reads the role off it), proving the classifier follows the DECLARATION alone.
 */
import { describe, it, expect } from "vitest";
import type { EnvWithInternals, ResolvingAmbient } from "../../env/AmbientRuntime.js";
import { parse } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { classify, fullCone, type DeclaredRole, type LineageNode } from "../../provenance/lineage.js";
import { classifierFromEnv } from "../../provenance/lineage-classifier-from-env.js";
import { ANativeProcedure } from "../../values/primitives/ANativeProcedure.js";
import { theVoid } from "../../values/primitives/AVoid.js";

let seq = 0;
const env = () => inferenceEnv.child(`cfe-${seq++}`);

/** A marker value carrying ONLY a declared role — classify() never invokes the bound
 *  value, so a stamped ANativeProcedure is enough to exercise the declaration read. W8. */
const declared = (role: DeclaredRole): ANativeProcedure =>
  new ANativeProcedure({
    name: "declared",
    arity: { min: 0, max: null },
    contract: undefined,
    impl: () => theVoid,
    provenanceRole: role,
  });

const node = async (src: string, e: ReturnType<typeof env>): Promise<LineageNode> =>
  classify((await parse(src))[0], classifierFromEnv(e));

describe("classifierFromEnv — reads the declared `.provenanceRole` off the bound value", () => {
  it("a declared `pipe` propagates; a declared `source` mints, regardless of NAME", async () => {
    const e = env() as EnvWithInternals<ResolvingAmbient>;
    // Names picked to defeat any residual name-based guess — a "pure"-sounding name
    // declared `source`, and a name with no semantic hint declared `pipe`.
    e.bind("dedent", declared("pipe"));
    e.bind("infer-x", declared("source"));

    const dedented = await node("(dedent s)", e);
    expect(dedented.kind).toBe("pipe"); // declared pipe propagates → pass-through
    expect(fullCone(dedented, { s: [100] })).toEqual([100]); // mints nothing

    const inferred = await node("(infer-x p)", e);
    expect(inferred.kind).toBe("source"); // declared source mints a fresh leaf
    expect(fullCone(inferred, { "infer-x": [42] })).toEqual([42]);
  });

  it("the declared role is visible through env inheritance (chain-walk is env.get's, not the classifier's)", async () => {
    const parent = env() as EnvWithInternals<ResolvingAmbient>;
    parent.bind("dedent", declared("pipe"));
    const child = parent.child("cfe-child");
    // classified on the CHILD, but `dedent` is bound on the PARENT → still a pipe.
    const n = await node("(dedent s)", child);
    expect(n.kind).toBe("pipe");
  });

  it("declared `fan`: map/filter classify to a fan (map length-preserving, filter not)", async () => {
    const e = env() as EnvWithInternals<ResolvingAmbient>;
    e.bind("infer-x", declared("source"));
    e.bind("map", declared("fan"));
    e.bind("filter", declared("fan"));

    const mapped = await node("(map infer-x xs)", e);
    expect(mapped.kind).toBe("fan");
    if (mapped.kind !== "fan") return;
    expect(mapped.introduces).toBe(true); // the per-element transform is a declared source
    expect(mapped.lengthPreserving).toBe(true);

    const filtered = await node("(filter pred xs)", e);
    expect(filtered.kind).toBe("fan");
    if (filtered.kind !== "fan") return;
    expect(filtered.lengthPreserving).toBe(false);
  });

  it("an UNDECLARED name (no `.provenanceRole` at all — an unbound name or a plain Scheme lambda) classifies as a pure application, never a source or opaque", async () => {
    const e = env() as EnvWithInternals<ResolvingAmbient>;
    const n = await node("(* val1 (+ 1 val2))", e); // "*"/"+" carry no declared role in this bare test env
    expect(n.kind).toBe("merge");
    expect(fullCone(n, { val1: [100], val2: [200] })).toEqual([100, 200]);
  });

  it("declared `sink`/`transparent`/`opaque` reach their matching graph-layer kinds", async () => {
    const e = env() as EnvWithInternals<ResolvingAmbient>;
    e.bind("log!", declared("sink"));
    e.bind("passthrough", declared("transparent"));
    e.bind("ext-call", declared("opaque"));

    const sunk = await node("(log! v)", e);
    expect(sunk.kind).toBe("sink");

    const crossed = await node("(passthrough v)", e);
    expect(crossed.kind).toBe("transparent");
    expect(fullCone(crossed, { v: [7] })).toEqual([7]); // cone-identical to pipe

    const opaque = await node("(ext-call a b)", e);
    expect(opaque.kind).toBe("opaque");
    expect(fullCone(opaque, { a: [1], b: [2] })).toEqual([1, 2]);
  });
});
